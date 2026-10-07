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
 * Two variants ride on the same search (see ProtocolSpec): `binsPerTone` > 1 measures each tone
 * as the sum of that many fine bins (Q65-style spread tolerance), and `repeats` > 1 scores the
 * sync of all copies of the frame jointly and adds the copies' tone energies before decoding
 * (ISCAT-style), falling back to subsets of copies when the whole set does not decode.
 *
 * Timing resolution is one decimated sample (5 ms, 1/32 of a symbol) and the
 * frequency grid is 1 Hz, both far finer than non-coherent detection needs.
 *
 * Runs in a Web Worker, never the audio thread: it allocates and takes tens to
 * hundreds of milliseconds.
 */

import type { DecodedFrame, Demodulator, FrameCodec, SyncReport, UndecodedCandidate } from '../protocol';
import { binsPerTone, repeatCount, symbolDurationSec, transmitSymbolCount, windowLeadSec, type ProtocolSpec } from '../spec';

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

/** With repeated copies, subsets of copies are tried only up to this many copies (2^n attempts). */
const MAX_SUBSET_COPIES = 6;

/** The sliding DFT is recomputed in full this often (positions), so rounding cannot drift. */
const SDFT_REFRESH = 64;

/** Two candidates closer than a quarter symbol are the same frame. */
const SUPPRESS_SYMBOL_FRACTION = 0.25;

export class Gfsk8Demodulator implements Demodulator {
  lastSync: SyncReport | null = null;
  lastUndecoded: UndecodedCandidate[] = [];
  private readonly decimation: number;
  private readonly rateDecHz: number;
  private readonly taps: Float32Array;
  /** `taps` mixed down by the channel being decoded (scratch, refilled per call). */
  private readonly mixedTapsRe: Float64Array;
  private readonly mixedTapsIm: Float64Array;
  private readonly symbolSamples: number; // exact, fractional
  private readonly windowSamples: number; // integer DFT length
  private readonly hypothesesHz: Float64Array;
  private readonly toneCos: Float32Array[] = [];
  private readonly toneSin: Float32Array[] = [];
  /** Radians per decimated sample of each basis row, [hypothesis][row]. */
  private readonly rowOmega: Float64Array;
  private readonly symbolStart: Int32Array;
  private readonly syncStart: Int32Array;
  private readonly syncTone: Uint8Array;
  private readonly tones: number;
  private readonly bins: number;
  private readonly copies: number;
  private readonly suppressSamples: number;

  constructor(
    private readonly sampleRate: number,
    private readonly spec: ProtocolSpec,
    private readonly codec: FrameCodec,
  ) {
    this.tones = spec.toneCount;
    this.bins = binsPerTone(spec);
    this.copies = repeatCount(spec);
    if (this.bins % 2 !== 1 || Math.abs(spec.toneSpacingHz - this.bins * spec.baud) > 1e-9) {
      throw new RangeError('binsPerTone must be odd and toneSpacingHz = binsPerTone x baud');
    }
    const scale = spec.baud / REFERENCE_BAUD;
    this.decimation = Math.max(1, Math.round(sampleRate / (SAMPLES_PER_SYMBOL * spec.baud)));
    this.rateDecHz = sampleRate / this.decimation;
    let transitionHz = TRANSITION_HZ * scale;
    let cutoffHz = CUTOFF_HZ * scale;
    if (this.bins > 1) {
      // Wide tones: the channel is much wider than a plain one, so pass all of it (tones, their
      // fine bins and a symbol's skirt) and let the transition end where it would alias onto it.
      const halfBandHz = ((this.tones - 1) / 2) * spec.toneSpacingHz + (this.bins / 2 + 1) * spec.baud;
      transitionHz = this.rateDecHz - 2 * halfBandHz;
      if (transitionHz < 10) throw new RangeError('channel too wide for the decimated rate');
      cutoffHz = this.rateDecHz / 2;
    }
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
    this.mixedTapsRe = new Float64Array(length);
    this.mixedTapsIm = new Float64Array(length);

    // A faster protocol has wider tones, so a coarser grid loses no more; but the
    // search must still cover sound-card clock error, which does not scale.
    // Fine bins already absorb an offset of a bin or so, so the grid can be that much coarser.
    const stepHz = FREQ_STEP_HZ * scale * this.bins;
    const searchHz = Math.ceil(Math.max(FREQ_SEARCH_HZ, 2 * stepHz) / stepHz) * stepHz;
    const count = 2 * Math.round(searchHz / stepHz) + 1;
    this.hypothesesHz = Float64Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * stepHz);

    // Tone basis per frequency hypothesis: e^{-j 2 pi f n / rate} over one symbol.
    // With binsPerTone > 1 each tone has several basis functions, one per fine bin, `baud` apart
    // and centred on the tone: sub-bin s of tone t is row t * bins + s.
    const centreOffset = ((this.tones - 1) / 2) * spec.toneSpacingHz;
    const subTones = this.tones * this.bins;
    const rowOmega: number[] = [];
    for (const delta of this.hypothesesHz) {
      const cos = new Float32Array(subTones * this.windowSamples);
      const sin = new Float32Array(subTones * this.windowSamples);
      for (let t = 0; t < this.tones; t++) {
        for (let b = 0; b < this.bins; b++) {
          const f = t * spec.toneSpacingHz + (b - (this.bins - 1) / 2) * spec.baud - centreOffset + delta;
          const row = t * this.bins + b;
          rowOmega.push((2 * Math.PI * f) / this.rateDecHz);
          for (let n = 0; n < this.windowSamples; n++) {
            const a = (2 * Math.PI * f * n) / this.rateDecHz;
            cos[row * this.windowSamples + n] = Math.cos(a);
            sin[row * this.windowSamples + n] = Math.sin(a);
          }
        }
      }
      this.toneCos.push(cos);
      this.toneSin.push(sin);
    }
    this.rowOmega = Float64Array.from(rowOmega);

    // Every transmitted symbol, all copies of the frame: copy c starts at c * symbolCount.
    this.symbolStart = Int32Array.from({ length: transmitSymbolCount(spec) }, (_, k) => Math.round(k * this.symbolSamples));
    const syncStarts: number[] = [];
    const syncTones: number[] = [];
    for (let c = 0; c < this.copies; c++) {
      for (const start of spec.syncStarts) {
        spec.syncPattern.forEach((tone, i) => {
          syncStarts.push(this.symbolStart[c * spec.symbolCount + start + i]!);
          syncTones.push(tone);
        });
      }
    }
    this.syncStart = Int32Array.from(syncStarts);
    this.syncTone = Uint8Array.from(syncTones);
  }

  decode(window: Float32Array, baseFreqHz: number, leadSec = windowLeadSec(this.spec)): DecodedFrame[] {
    this.lastSync = null;
    this.lastUndecoded = [];
    const { baseband, count } = this.toBaseband(window, baseFreqHz);
    const positions = count - this.windowSamples + 1;
    const lastSymbolOffset = this.symbolStart[this.symbolStart.length - 1]!;
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
    const frameSize = this.spec.symbolCount * this.tones;
    const copyEnergies = Array.from({ length: this.copies }, () => new Float32Array(frameSize));
    const sum = new Float32Array(frameSize);
    for (const cand of candidates) {
      for (let c = 0; c < this.copies; c++) {
        const energies = copyEnergies[c]!;
        for (let k = 0; k < this.spec.symbolCount; k++) {
          const from = ((cand.hypothesis * positions) + cand.start + this.symbolStart[c * this.spec.symbolCount + k]!) * this.tones;
          energies.set(spectra.subarray(from, from + this.tones), k * this.tones);
        }
      }
      const found = this.decodeCopies(copyEnergies, cand.score >= UNDECODED_MIN_SCORE);
      if (!found) {
        // The strongest real-looking candidates that failed, for a later retransmission to be added to.
        if (this.lastUndecoded.length < MAX_UNDECODED && cand.score >= UNDECODED_MIN_SCORE) {
          this.sumCopies(copyEnergies, sum);
          this.lastUndecoded.push({
            energies: sum.slice(),
            score: cand.score,
            freqHz: baseFreqHz + this.hypothesesHz[cand.hypothesis]!,
            timeOffsetSec: cand.start / this.rateDecHz - leadSec,
          });
        }
        continue;
      }
      const key = found.payload.join('');
      if (seen.has(key)) continue;
      seen.add(key);
      this.sumCopies(found.used.map((c) => copyEnergies[c]!), sum);
      frames.push({
        payload: found.payload,
        freqHz: baseFreqHz + this.hypothesesHz[cand.hypothesis]!,
        timeOffsetSec: cand.start / this.rateDecHz - leadSec,
        snrDb: this.estimateSnrDb(sum, this.codec.encode(found.payload)),
        ...(found.used.length > 1 ? { copies: found.used.length } : {}),
      });
    }
    return frames;
  }

  /**
   * One candidate's copies of the frame -> payload. All copies added first; if that fails and the
   * sync looks real, every smaller subset (largest first), since a copy lost to a fade or a burst
   * of noise only pollutes the sum. `used` says which copies decoded it.
   */
  private decodeCopies(copies: readonly Float32Array[], tryAll: boolean): { payload: Uint8Array; used: number[] } | null {
    const n = copies.length;
    const everyone = Array.from({ length: n }, (_, i) => i);
    const first = this.codec.decodeCombined(copies);
    if (first) return { payload: first, used: everyone };
    if (n === 1 || n > MAX_SUBSET_COPIES || !tryAll) return null;
    const masks = Array.from({ length: (1 << n) - 2 }, (_, i) => i + 1).sort((a, b) => popcount(b) - popcount(a));
    for (const mask of masks) {
      const used = everyone.filter((i) => mask & (1 << i));
      const payload = this.codec.decodeCombined(used.map((i) => copies[i]!));
      if (payload) return { payload, used };
    }
    return null;
  }

  /** Copies added after scaling each to the same mean (what FrameCodec.decodeCombined does). */
  private sumCopies(copies: readonly Float32Array[], out: Float32Array): void {
    out.fill(0);
    for (const e of copies) {
      let total = 0;
      for (let i = 0; i < e.length; i++) total += e[i]!;
      const scale = total > 0 ? e.length / total : 0;
      for (let i = 0; i < e.length; i++) out[i]! += e[i]! * scale;
    }
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
    const length = taps.length;
    const half = (length - 1) / 2;
    // Centre of the tone range, so the channel sits on 0 Hz.
    const mixHz = baseFreqHz + ((this.tones - 1) / 2) * this.spec.toneSpacingHz;
    const w = (2 * Math.PI * mixHz) / this.sampleRate;

    // Mixing folded into the filter: output m (input sample c = m D) is
    //   sum_k h[k] x[c+k-half] e^{-jw(c+k-half)} = e^{-jwc} sum_k (h[k] e^{-jw(k-half)}) x[c+k-half],
    // so the taps are mixed once (taps.length rotations, not one per input sample) and
    // the real input is filtered directly, with no mixed copy of the whole window.
    const tapsRe = this.mixedTapsRe;
    const tapsIm = this.mixedTapsIm;
    for (let k = 0; k < length; k++) {
      const a = w * (k - half);
      tapsRe[k] = taps[k]! * Math.cos(a);
      tapsIm[k] = -taps[k]! * Math.sin(a);
    }

    // Only the decimated outputs are computed, so this is (n / D) x taps, not n x taps.
    const count = Math.floor(n / D);
    const re = new Float32Array(count);
    const im = new Float32Array(count);
    for (let m = 0; m < count; m++) {
      const c = m * D;
      const k0 = Math.max(0, half - c);
      const k1 = Math.min(length, n - c + half);
      let sr = 0;
      let si = 0;
      if (k0 === 0 && k1 === length) {
        // Whole filter inside the window. The taps are symmetric, so the mixed taps are
        // conjugate-symmetric (tap length-1-k = conj(tap k)), and a pair of samples costs
        // two multiplies: Re(tap)(x1 + x2) + j Im(tap)(x1 - x2).
        const first = c - half;
        for (let k = 0, j = c + half; k < half; k++, j--) {
          const x1 = window[first + k]!;
          const x2 = window[j]!;
          sr += tapsRe[k]! * (x1 + x2);
          si += tapsIm[k]! * (x1 - x2);
        }
        sr += tapsRe[half]! * window[c]!;
      } else {
        for (let k = k0, idx = c + k0 - half; k < k1; k++, idx++) {
          const x = window[idx]!;
          sr += tapsRe[k]! * x;
          si += tapsIm[k]! * x;
        }
      }
      const a = w * c;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // (sr + j si)(cos - j sin)
      re[m] = sr * cos + si * sin;
      im[m] = si * cos - sr * sin;
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
    const bins = this.bins;
    const subTones = tones * bins;
    const out = new Float32Array(this.hypothesesHz.length * positions * tones);
    for (let h = 0; h < this.hypothesesHz.length; h++) {
      const cos = this.toneCos[h]!;
      const sin = this.toneSin[h]!;
      for (let row = 0; row < subTones; row++) {
        // A tone is the sum of its fine bins (one bin unless binsPerTone > 1).
        const tone = Math.floor(row / bins);
        const o = row * L;
        // Sliding DFT: X(p) = sum_n x[p+n] e^{-jwn} gives
        //   X(p+1) = e^{jw} (X(p) - x[p]) + x[p+L] e^{-jw(L-1)},
        // a few operations per position instead of L. Recomputed in full every
        // SDFT_REFRESH positions so rounding cannot build up.
        const omega = this.rowOmega[h * subTones + row]!;
        const rotR = Math.cos(omega);
        const rotI = Math.sin(omega);
        const tailR = Math.cos(omega * (L - 1));
        const tailI = -Math.sin(omega * (L - 1));
        let sr = 0;
        let si = 0;
        for (let p = 0; p < positions; p++) {
          if (p % SDFT_REFRESH === 0) {
            sr = 0;
            si = 0;
            for (let n = 0; n < L; n++) {
              const xr = re[p + n]!;
              const xi = im[p + n]!;
              const c = cos[o + n]!;
              const s = sin[o + n]!;
              // (xr + j xi)(cos - j sin)
              sr += xr * c + xi * s;
              si += xi * c - xr * s;
            }
          } else {
            const ar = sr - re[p - 1]!;
            const ai = si - im[p - 1]!;
            const xr = re[p + L - 1]!;
            const xi = im[p + L - 1]!;
            sr = ar * rotR - ai * rotI + xr * tailR - xi * tailI;
            si = ar * rotI + ai * rotR + xr * tailI + xi * tailR;
          }
          out[(h * positions + p) * tones + tone]! += sr * sr + si * si;
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
    for (let b = 0; b < this.syncStart.length / length; b++) {
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
    // Energy of all tones at each (hypothesis, position), summed once instead of per sync symbol per start.
    const rowTotals = new Float64Array(hyps * positions);
    for (let r = 0; r < rowTotals.length; r++) {
      let total = 0;
      for (let t = 0; t < tones; t++) total += spectra[r * tones + t]!;
      rowTotals[r] = total;
    }
    const scores = new Float32Array(hyps * starts);
    const syncStart = this.syncStart;
    const syncTone = this.syncTone;
    for (let h = 0; h < hyps; h++) {
      for (let s = 0; s < starts; s++) {
        let hit = 0;
        let total = 0;
        for (let i = 0; i < syncStart.length; i++) {
          const r = h * positions + s + syncStart[i]!;
          hit += spectra[r * tones + syncTone[i]!]!;
          total += rowTotals[r]!;
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
  private estimateSnrDb(energies: Float32Array, transmitted: Uint8Array): number {
    // One copy's symbols: a repeating protocol's `energies` are the copies added together.
    const symbols = transmitted.subarray(0, this.spec.symbolCount);
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
    // One tone's energy collects `bins` fine bins of noise, each `baud` Hz wide.
    return 10 * Math.log10(ratio) - 10 * Math.log10(2500 / (this.spec.baud * this.bins));
  }
}

function popcount(x: number): number {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}
