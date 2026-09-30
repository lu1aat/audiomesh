/**
 * Receiver for one channel: finds 8-GFSK frames in a slot's worth of audio.
 *
 *  1. Mix the channel to complex baseband and low-pass/decimate to 32 samples per
 *     symbol (200 Hz at 6.25 baud). The channel is narrow, so everything after
 *     this is cheap. Every constant below is stated for 6.25 baud and scales with
 *     the baud rate, so a faster protocol costs the same per window.
 *  2. For every start position and a few small frequency offsets, measure the
 *     energy in each of the 8 tones over one symbol (a sliding DFT).
 *  3. Score every (start, frequency offset) by how much of the energy in the 21
 *     Costas sync symbols sits in the tones the sync pattern predicts. Pure noise
 *     scores about 1/8; a real frame scores far higher.
 *  4. Take the best few candidates, read all 79 symbols' tone energies at each,
 *     and hand them to the codec. The CRC and LDPC checks are the judge: a wrong
 *     candidate is simply refused.
 *
 * Timing resolution is one decimated sample (5 ms, 1/32 of a symbol) and the
 * frequency grid is 1 Hz, both far finer than non-coherent detection needs.
 *
 * Runs in a Web Worker, never the audio thread: it allocates and takes tens to
 * hundreds of milliseconds.
 */

import type { DecodedFrame, Demodulator, FrameCodec, SyncReport, UndecodedCandidate } from '../protocol';
import { symbolDurationSec, windowLeadSec, type ProtocolSpec } from '../spec';

/** Baseband samples per symbol after decimation: 200 Hz at 6.25 baud. */
const SAMPLES_PER_SYMBOL = 32;

/** The constants below are for this baud rate and are scaled by baud / REFERENCE_BAUD. */
const REFERENCE_BAUD = 6.25;

/**
 * The low-pass must pass the channel (+-~30 Hz around its centre) and reject the
 * neighbouring channel, which decimation would otherwise fold on top of it: with a
 * 200 Hz rate, a neighbour 170 Hz away aliases to 30 Hz. So: pass to 30 Hz, stop
 * from 170 Hz. A Blackman window's transition is ~5.5 / N of the sample rate wide.
 */
const TRANSITION_HZ = 140;
const CUTOFF_HZ = 100; // middle of that transition

/**
 * Frequency offsets tried, relative to the nominal channel. Sound cards run a
 * few hundred ppm apart, which is a Hz or two at 3 kHz. A 1 Hz grid keeps the
 * worst-case mismatch loss under 0.3 dB.
 */
const FREQ_SEARCH_HZ = 5;
const FREQ_STEP_HZ = 1;

/** Candidates handed to the codec per window. */
const MAX_CANDIDATES = 8;

/**
 * A candidate that did not decode is kept for combining with a retransmission only when its
 * sync is this far above noise (the best of a noise-only search is about 0.23).
 */
const UNDECODED_MIN_SCORE = 0.27;
/** At this weak, the true frame is often not the top sync peak, so a few are kept per channel and window. */
const MAX_UNDECODED = 3;

/** Two candidates closer than a quarter symbol are the same frame. */
const SUPPRESS_SYMBOL_FRACTION = 0.25;

export class Gfsk8Demodulator implements Demodulator {
  lastSync: SyncReport | null = null;
  lastUndecoded: UndecodedCandidate[] = [];
  private readonly decimation: number;
  private readonly rateDecHz: number;
  private readonly taps: Float32Array;
  private readonly symbolSamples: number; // exact, fractional
  private readonly windowSamples: number; // integer DFT length
  private readonly hypothesesHz: Float64Array;
  private readonly toneCos: Float32Array[] = [];
  private readonly toneSin: Float32Array[] = [];
  private readonly symbolStart: Int32Array;
  private readonly syncStart: Int32Array;
  private readonly syncTone: Uint8Array;
  private readonly tones: number;
  private readonly suppressSamples: number;

  constructor(
    private readonly sampleRate: number,
    private readonly spec: ProtocolSpec,
    private readonly codec: FrameCodec,
  ) {
    this.tones = spec.toneCount;
    const scale = spec.baud / REFERENCE_BAUD;
    const transitionHz = TRANSITION_HZ * scale;
    const cutoffHz = CUTOFF_HZ * scale;
    this.decimation = Math.max(1, Math.round(sampleRate / (SAMPLES_PER_SYMBOL * spec.baud)));
    this.rateDecHz = sampleRate / this.decimation;
    this.symbolSamples = this.rateDecHz * symbolDurationSec(spec);
    this.windowSamples = Math.round(this.symbolSamples);
    this.suppressSamples = Math.max(1, Math.round(SUPPRESS_SYMBOL_FRACTION * this.symbolSamples));

    // Blackman-windowed sinc, unity gain at DC. Odd length so it has a centre tap
    // and therefore no group delay once centred: timing needs no correction.
    const length = 2 * Math.ceil((5.5 * sampleRate) / transitionHz / 2) + 1;
    const half = (length - 1) / 2;
    this.taps = new Float32Array(length);
    let sum = 0;
    for (let k = 0; k < length; k++) {
      const x = (2 * cutoffHz * (k - half)) / sampleRate;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w =
        0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (length - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (length - 1));
      this.taps[k] = ((2 * cutoffHz) / sampleRate) * sinc * w;
      sum += this.taps[k]!;
    }
    for (let k = 0; k < length; k++) this.taps[k]! /= sum;

    // A faster protocol has wider tones, so a coarser grid loses no more; but the
    // search must still cover sound-card clock error, which does not scale.
    const stepHz = FREQ_STEP_HZ * scale;
    const searchHz = Math.ceil(Math.max(FREQ_SEARCH_HZ, 2 * stepHz) / stepHz) * stepHz;
    const count = 2 * Math.round(searchHz / stepHz) + 1;
    this.hypothesesHz = Float64Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * stepHz);

    // Tone basis per frequency hypothesis: e^{-j 2 pi f n / rate} over one symbol.
    const centreOffset = ((this.tones - 1) / 2) * spec.toneSpacingHz;
    for (const delta of this.hypothesesHz) {
      const cos = new Float32Array(this.tones * this.windowSamples);
      const sin = new Float32Array(this.tones * this.windowSamples);
      for (let t = 0; t < this.tones; t++) {
        const f = t * spec.toneSpacingHz - centreOffset + delta;
        for (let n = 0; n < this.windowSamples; n++) {
          const a = (2 * Math.PI * f * n) / this.rateDecHz;
          cos[t * this.windowSamples + n] = Math.cos(a);
          sin[t * this.windowSamples + n] = Math.sin(a);
        }
      }
      this.toneCos.push(cos);
      this.toneSin.push(sin);
    }

    this.symbolStart = Int32Array.from({ length: spec.symbolCount }, (_, k) => Math.round(k * this.symbolSamples));
    const syncStarts: number[] = [];
    const syncTones: number[] = [];
    for (const start of spec.syncStarts) {
      spec.syncPattern.forEach((tone, i) => {
        syncStarts.push(this.symbolStart[start + i]!);
        syncTones.push(tone);
      });
    }
    this.syncStart = Int32Array.from(syncStarts);
    this.syncTone = Uint8Array.from(syncTones);
  }

  decode(window: Float32Array, baseFreqHz: number, leadSec = windowLeadSec(this.spec)): DecodedFrame[] {
    this.lastSync = null;
    this.lastUndecoded = [];
    const { baseband, count } = this.toBaseband(window, baseFreqHz);
    const positions = count - this.windowSamples + 1;
    const lastSymbolOffset = this.symbolStart[this.spec.symbolCount - 1]!;
    // Frame start (decimated samples from window start) ranges over +-leadSec
    // around the nominal one, which sits leadSec into the window.
    const maxStart = Math.min(
      positions - 1 - lastSymbolOffset,
      Math.round(2 * leadSec * this.rateDecHz),
    );
    if (maxStart < 0) return [];

    const spectra = this.spectrogram(baseband, positions);
    const candidates = this.pickCandidates(spectra, positions, maxStart);
    if (candidates[0]) {
      this.lastSync = {
        score: candidates[0].score,
        timeOffsetSec: candidates[0].start / this.rateDecHz - leadSec,
        ...this.blockStats(spectra, positions, candidates[0]),
      };
    }

    const frames: DecodedFrame[] = [];
    const seen = new Set<string>();
    const energies = new Float32Array(this.spec.symbolCount * this.tones);
    for (const cand of candidates) {
      for (let k = 0; k < this.spec.symbolCount; k++) {
        const from = ((cand.hypothesis * positions) + cand.start + this.symbolStart[k]!) * this.tones;
        energies.set(spectra.subarray(from, from + this.tones), k * this.tones);
      }
      const payload = this.codec.decode(energies);
      if (!payload) {
        // The strongest real-looking candidates that failed, for a later retransmission to be added to.
        if (this.lastUndecoded.length < MAX_UNDECODED && cand.score >= UNDECODED_MIN_SCORE) {
          this.lastUndecoded.push({
            energies: energies.slice(),
            score: cand.score,
            freqHz: baseFreqHz + this.hypothesesHz[cand.hypothesis]!,
            timeOffsetSec: cand.start / this.rateDecHz - leadSec,
          });
        }
        continue;
      }
      const key = payload.join('');
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push({
        payload,
        freqHz: baseFreqHz + this.hypothesesHz[cand.hypothesis]!,
        timeOffsetSec: cand.start / this.rateDecHz - leadSec,
        snrDb: this.estimateSnrDb(energies, this.codec.encode(payload)),
      });
    }
    return frames;
  }

  snrDbOf(energies: Float32Array, payload: Uint8Array): number {
    return this.estimateSnrDb(energies, this.codec.encode(payload));
  }

  /** Channel to complex baseband at ~200 Hz. Returns interleaved-free re/im arrays. */
  private toBaseband(
    window: Float32Array,
    baseFreqHz: number,
  ): { baseband: { re: Float32Array; im: Float32Array }; count: number } {
    const n = window.length;
    const D = this.decimation;
    const taps = this.taps;
    const half = (taps.length - 1) / 2;
    // Centre of the tone range, so the channel sits on 0 Hz.
    const mixHz = baseFreqHz + ((this.tones - 1) / 2) * this.spec.toneSpacingHz;
    const w = (2 * Math.PI * mixHz) / this.sampleRate;

    const zr = new Float32Array(n);
    const zi = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = w * i;
      const x = window[i]!;
      zr[i] = x * Math.cos(a);
      zi[i] = -x * Math.sin(a);
    }

    // Only the decimated outputs are computed, so this is (n / D) x taps, not n x taps.
    const count = Math.floor(n / D);
    const re = new Float32Array(count);
    const im = new Float32Array(count);
    for (let m = 0; m < count; m++) {
      const c = m * D;
      const k0 = Math.max(0, half - c);
      const k1 = Math.min(taps.length, n - c + half);
      let sr = 0;
      let si = 0;
      for (let k = k0; k < k1; k++) {
        const idx = c + k - half;
        const h = taps[k]!;
        sr += h * zr[idx]!;
        si += h * zi[idx]!;
      }
      re[m] = sr;
      im[m] = si;
    }
    return { baseband: { re, im }, count };
  }

  /**
   * Tone energies at every start position, for every frequency hypothesis:
   * [hypothesis][position][tone], flattened.
   */
  private spectrogram(baseband: { re: Float32Array; im: Float32Array }, positions: number): Float32Array {
    const { re, im } = baseband;
    const L = this.windowSamples;
    const tones = this.tones;
    const out = new Float32Array(this.hypothesesHz.length * positions * tones);
    for (let h = 0; h < this.hypothesesHz.length; h++) {
      const cos = this.toneCos[h]!;
      const sin = this.toneSin[h]!;
      for (let p = 0; p < positions; p++) {
        const base = (h * positions + p) * tones;
        for (let t = 0; t < tones; t++) {
          let sr = 0;
          let si = 0;
          const o = t * L;
          for (let n = 0; n < L; n++) {
            const xr = re[p + n]!;
            const xi = im[p + n]!;
            const c = cos[o + n]!;
            const s = sin[o + n]!;
            // (xr + j xi)(cos - j sin)
            sr += xr * c + xi * s;
            si += xi * c - xr * s;
          }
          out[base + t] = sr * sr + si * si;
        }
      }
    }
    return out;
  }

  /** Each Costas block of one candidate on its own: its sync score, and how unevenly loud the blocks are (see SyncReport). */
  private blockStats(
    spectra: Float32Array,
    positions: number,
    cand: { start: number; hypothesis: number },
  ): { blocks: number[]; blockImbalanceDb: number } {
    const tones = this.tones;
    const length = this.spec.syncPattern.length;
    const blocks: number[] = [];
    const levels: number[] = [];
    for (let b = 0; b < this.spec.syncStarts.length; b++) {
      let hit = 0;
      let total = 0;
      for (let i = b * length; i < (b + 1) * length; i++) {
        const row = (cand.hypothesis * positions + cand.start + this.syncStart[i]!) * tones;
        hit += spectra[row + this.syncTone[i]!]!;
        for (let t = 0; t < tones; t++) total += spectra[row + t]!;
      }
      blocks.push(total > 0 ? hit / total : 0);
      levels.push(total);
    }
    const sorted = [...levels].sort((a, b) => a - b);
    const middle = sorted[sorted.length >> 1]!;
    const loudest = sorted[sorted.length - 1]!;
    return { blocks, blockImbalanceDb: middle > 0 ? 10 * Math.log10(loudest / middle) : 0 };
  }

  /** Best (start, hypothesis) pairs by sync score, at most MAX_CANDIDATES, best first. */
  private pickCandidates(
    spectra: Float32Array,
    positions: number,
    maxStart: number,
  ): { start: number; hypothesis: number; score: number }[] {
    const tones = this.tones;
    const hyps = this.hypothesesHz.length;
    const starts = maxStart + 1;
    const scores = new Float32Array(hyps * starts);
    for (let h = 0; h < hyps; h++) {
      for (let s = 0; s < starts; s++) {
        let hit = 0;
        let total = 0;
        for (let i = 0; i < this.syncStart.length; i++) {
          const row = (h * positions + s + this.syncStart[i]!) * tones;
          hit += spectra[row + this.syncTone[i]!]!;
          for (let t = 0; t < tones; t++) total += spectra[row + t]!;
        }
        scores[h * starts + s] = total > 0 ? hit / total : 0;
      }
    }

    const picked: { start: number; hypothesis: number; score: number }[] = [];
    for (let c = 0; c < MAX_CANDIDATES; c++) {
      let best = -1;
      let bestScore = 0;
      for (let i = 0; i < scores.length; i++) {
        if (scores[i]! > bestScore) {
          bestScore = scores[i]!;
          best = i;
        }
      }
      if (best < 0) break;
      const start = best % starts;
      picked.push({ start, hypothesis: Math.floor(best / starts), score: bestScore });
      // Retire this frame: every frequency hypothesis around the same start time.
      for (let h = 0; h < hyps; h++) {
        for (let s = Math.max(0, start - this.suppressSamples); s <= Math.min(starts - 1, start + this.suppressSamples); s++) {
          scores[h * starts + s] = 0;
        }
      }
    }
    return picked;
  }

  /**
   * SNR in a 2500 Hz reference bandwidth. Knowing the decoded symbols, the energy
   * in the right tone (less the noise in it) is the signal, and the energy in the
   * other seven tones is the noise. One tone bin is `baud` Hz wide.
   *
   * Measured against added white noise: within 0.3 dB from -19 to -14 dB, and the
   * test holds it within 3 dB up to -6. It saturates near +5 dB for strong signals,
   * because the modulator's own spectral skirts put a little energy in the other
   * tones, so a very strong signal reads about +5 however strong it is.
   * It also drops, correctly, when the audio itself is damaged (dropouts, clipping).
   */
  private estimateSnrDb(energies: Float32Array, symbols: Uint8Array): number {
    let signal = 0;
    let noise = 0;
    for (let k = 0; k < symbols.length; k++) {
      for (let t = 0; t < this.tones; t++) {
        const e = energies[k * this.tones + t]!;
        if (t === symbols[k]) signal += e;
        else noise += e;
      }
    }
    const signalMean = signal / symbols.length;
    const noiseMean = noise / (symbols.length * (this.tones - 1));
    const ratio = Math.max((signalMean - noiseMean) / noiseMean, 1e-2);
    return 10 * Math.log10(ratio) - 10 * Math.log10(2500 / this.spec.baud);
  }
}
