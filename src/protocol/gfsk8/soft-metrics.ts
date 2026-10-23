/**
 * Soft metrics: one candidate's tone measurements -> 174 soft bits (LLR, positive = 1) for the LDPC.
 * The plain decode uses log power (Gfsk8Codec.decode); these are the others tried on a candidate that
 * does not decode with it (Gfsk8Codec.decodeHarder):
 *
 *   magnitude  max-log over tone amplitudes instead of log power.
 *   exact      the Rician likelihood of each tone's energy, summed over every tone that carries the
 *              bit (log-sum-exp, not only the largest); noise and signal level from the Costas symbols.
 *   coh2/coh3  WSJT-X's multi-symbol metric (ft8b, nsym 2 and 3). The modulation is phase-continuous,
 *              so the complex tone values of 2 or 3 neighbouring symbols add up coherently for the right
 *              tone sequence, and a group's best sequence lifts every bit in it. Best in white noise;
 *              weak with room echo, which smears the phase.
 *
 * No metric wins everywhere; trying each and keeping the first the CRC accepts is what pays. Measured
 * through Demodulator.decode (48 kHz, unknown timing, white noise, 96 frames per point; log power alone
 * -> all): Fast (+-2 Hz off the channel) 69 -> 90 at -13 dB, 14 -> 47 at -14, 3 -> 12 at -15; Turbo
 * (+-4 Hz off, half its frequency step) 69 -> 89 at -10, 15 -> 40 at -11, 1 -> 10 at -12. Of those
 * rescues coh2 did about half, then mag, coh3, exact. With a room echo (8.7 ms, 0.6; a scratch version
 * of these metrics) the coherent ones fall below log power but the union still gains (Fast -13 dB:
 * 49 -> 59 of 64). 0 false decodes in 4800 noise candidates x 5 metrics, Fast and Turbo each.
 *
 * Plain protocols only (one bin per tone, one copy): Spread's summed bins and Burst's summed copies
 * do not follow these models. Scratch buffers are owned per instance; nothing is allocated per call.
 */

import type { ToneComplex } from '../protocol';

/** bits (b0 b1 b2, MSB first) -> tone. Neighbouring tones differ in one bit. */
export const GRAY_TO_TONE = [0, 1, 3, 2, 5, 6, 4, 7] as const;

/** tone -> its 3 bits. */
const TONE_TO_BITS = (() => {
  const out = new Uint8Array(8);
  GRAY_TO_TONE.forEach((tone, bits) => (out[tone] = bits));
  return out;
})();

/** Floor on the per-symbol SNR the exact metric assumes, so a weak estimate does not flatten every bit. */
const EXACT_MIN_SNR = 0.3;

const TONES = 8;
/** Largest coherent group: 3 symbols of 8 tones. */
const MAX_COMBOS = TONES ** 3;

/** Rescale to a fixed spread (BP is tuned for it). False if the values are flat: nothing to decode. */
export function normalise(llr: Float32Array, std: number): boolean {
  const n = llr.length;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < n; i++) {
    sum += llr[i]!;
    sum2 += llr[i]! * llr[i]!;
  }
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  if (!(variance > 1e-12)) return false;
  const scale = std / Math.sqrt(variance);
  for (let i = 0; i < n; i++) llr[i] = llr[i]! * scale;
  return true;
}

/** ln I0(x) for x >= 0 (Abramowitz and Stegun 9.8.1 and 9.8.2, relative error under 2e-7). */
export function logI0(x: number): number {
  if (x < 3.75) {
    const y = (x / 3.75) ** 2;
    return Math.log(1 + y * (3.5156229 + y * (3.0899424 + y * (1.2067492 + y * (0.2659732 + y * (0.0360768 + y * 0.0045813))))));
  }
  const y = 3.75 / x;
  const p = 0.39894228 + y * (0.01328592 + y * (0.00225319 + y * (-0.00157565 + y * (0.00916281 +
    y * (-0.02057706 + y * (0.02635537 + y * (-0.01647633 + y * 0.00392377)))))));
  return x - 0.5 * Math.log(x) + Math.log(p);
}

export class SoftMetrics {
  /** Per symbol: its Costas tone, or -1 for a data symbol. */
  private readonly syncTone: Int8Array;
  /** Per symbol: its index among the data symbols, or -1. */
  private readonly dataIndex: Int16Array;
  /** Coherent groups, nsym 2 and 3: consecutive symbols from a data symbol on (a sync symbol inside one has its known tone). */
  private readonly groups: Record<2 | 3, readonly Uint8Array[]>;
  private readonly scratch: Float64Array;
  private readonly sym = new Float64Array(TONES);
  private readonly lik = new Float64Array(TONES);
  private readonly advCos: Float64Array;
  private readonly advSin: Float64Array;
  private curRe = new Float64Array(MAX_COMBOS);
  private curIm = new Float64Array(MAX_COMBOS);
  private nextRe = new Float64Array(MAX_COMBOS);
  private nextIm = new Float64Array(MAX_COMBOS);
  private readonly best0 = new Float64Array(3 * 3);
  private readonly best1 = new Float64Array(3 * 3);

  constructor(
    /** Symbol index of each data symbol, ascending; 3 code bits each. */
    private readonly dataPositions: Uint8Array,
    syncStarts: readonly number[],
    syncPattern: readonly number[],
    private readonly symbolCount: number,
  ) {
    this.syncTone = new Int8Array(symbolCount).fill(-1);
    for (const start of syncStarts) syncPattern.forEach((tone, i) => (this.syncTone[start + i] = tone));
    this.dataIndex = new Int16Array(symbolCount).fill(-1);
    dataPositions.forEach((k, d) => (this.dataIndex[k] = d));
    this.groups = { 2: this.makeGroups(2), 3: this.makeGroups(3) };
    this.scratch = new Float64Array(symbolCount * TONES);
    this.advCos = new Float64Array(symbolCount * TONES);
    this.advSin = new Float64Array(symbolCount * TONES);
  }

  private makeGroups(nsym: number): Uint8Array[] {
    const groups: Uint8Array[] = [];
    let d = 0;
    while (d < this.dataPositions.length) {
      const first = this.dataPositions[d]!;
      const group: number[] = [];
      for (let k = first; k < first + nsym && k < this.symbolCount; k++) group.push(k);
      groups.push(Uint8Array.from(group));
      d += group.filter((k) => this.syncTone[k]! < 0).length;
    }
    return groups;
  }

  /**
   * For each data symbol's 3 bits: the largest `metric` among the tones that would carry a 1 there,
   * minus the largest among those that would carry a 0. `metric`: symbolCount x 8, by symbol.
   */
  maxLog(metric: ArrayLike<number>, out: Float32Array): void {
    const s = this.sym;
    for (let d = 0; d < this.dataPositions.length; d++) {
      const row = this.dataPositions[d]! * TONES;
      for (let bits = 0; bits < 8; bits++) s[bits] = metric[row + GRAY_TO_TONE[bits]!]!;
      const o = d * 3;
      out[o] = Math.max(s[4]!, s[5]!, s[6]!, s[7]!) - Math.max(s[0]!, s[1]!, s[2]!, s[3]!);
      out[o + 1] = Math.max(s[2]!, s[3]!, s[6]!, s[7]!) - Math.max(s[0]!, s[1]!, s[4]!, s[5]!);
      out[o + 2] = Math.max(s[1]!, s[3]!, s[5]!, s[7]!) - Math.max(s[0]!, s[2]!, s[4]!, s[6]!);
    }
  }

  /** Max-log over tone amplitudes. Not normalised. */
  magnitude(energies: Float32Array, out: Float32Array): void {
    const amp = this.scratch;
    for (let i = 0; i < amp.length; i++) amp[i] = Math.sqrt(energies[i]!);
    this.maxLog(amp, out);
  }

  /**
   * Rician log-likelihood ratios. A tone holding signal of energy S over noise N0 per bin has energy e
   * with likelihood ratio (against noise alone) exp(-S/N0) I0(2 sqrt(S e) / N0); N0 is the mean of the
   * Costas symbols' other tones, S their sync tone's excess over it. Already in natural units, so not
   * normalised. False when there is no noise to measure (silence).
   */
  exact(energies: Float32Array, out: Float32Array): boolean {
    let signal = 0;
    let signals = 0;
    let noise = 0;
    let noises = 0;
    for (let k = 0; k < this.symbolCount; k++) {
      const sync = this.syncTone[k]!;
      if (sync < 0) continue;
      for (let t = 0; t < TONES; t++) {
        const e = energies[k * TONES + t]!;
        if (t === sync) {
          signal += e;
          signals++;
        } else {
          noise += e;
          noises++;
        }
      }
    }
    const n0 = noise / noises;
    if (!(n0 > 0)) return false;
    const snr = Math.max(EXACT_MIN_SNR, signal / signals / n0 - 1);
    const lik = this.lik;
    for (let d = 0; d < this.dataPositions.length; d++) {
      const row = this.dataPositions[d]! * TONES;
      // exp(-S/N0) is the same for every tone, so it drops out of each ratio.
      for (let t = 0; t < TONES; t++) lik[t] = logI0(2 * Math.sqrt((snr * energies[row + t]!) / n0));
      for (let b = 0; b < 3; b++) out[d * 3 + b] = this.logSumExpBit(lik, 2 - b);
    }
    return true;
  }

  /** ln sum exp(lik) over the tones whose bit `shift` is 1, minus the same over those where it is 0. */
  private logSumExpBit(lik: Float64Array, shift: number): number {
    let max1 = -Infinity;
    let max0 = -Infinity;
    for (let t = 0; t < TONES; t++) {
      if ((TONE_TO_BITS[t]! >> shift) & 1) max1 = Math.max(max1, lik[t]!);
      else max0 = Math.max(max0, lik[t]!);
    }
    let sum1 = 0;
    let sum0 = 0;
    for (let t = 0; t < TONES; t++) {
      if ((TONE_TO_BITS[t]! >> shift) & 1) sum1 += Math.exp(lik[t]! - max1);
      else sum0 += Math.exp(lik[t]! - max0);
    }
    return max1 + Math.log(sum1) - (max0 + Math.log(sum0));
  }

  /**
   * Multi-symbol coherent metric over groups of `nsym` symbols: for every tone sequence of a group, the
   * magnitude of the symbols' complex values added with each one turned back by the phase the earlier
   * tones advanced; then max-log per bit over the sequences. Not normalised.
   */
  coherent(cx: ToneComplex, nsym: 2 | 3, out: Float32Array): void {
    const { re, im, advance } = cx;
    for (let i = 0; i < this.advCos.length; i++) {
      this.advCos[i] = Math.cos(advance[i]!);
      this.advSin[i] = Math.sin(advance[i]!);
    }
    const strides = [0, 0, 0];
    for (const group of this.groups[nsym]) {
      const n = group.length;
      // Partial sums from the last symbol back: S_j = X_j + e^{-j advance_j} S_{j+1}, every tone choice.
      let size = 0;
      for (let j = n - 1; j >= 0; j--) {
        const k = group[j]!;
        const fixed = this.syncTone[k]!;
        const choices = fixed >= 0 ? 1 : TONES;
        strides[j] = j === n - 1 ? 1 : size;
        const row = k * TONES;
        if (j === n - 1) {
          for (let c = 0; c < choices; c++) {
            const t = fixed >= 0 ? fixed : c;
            this.curRe[c] = re[row + t]!;
            this.curIm[c] = im[row + t]!;
          }
          size = choices;
          continue;
        }
        const { curRe, curIm, nextRe, nextIm } = this;
        for (let c = 0; c < choices; c++) {
          const t = fixed >= 0 ? fixed : c;
          const xr = re[row + t]!;
          const xi = im[row + t]!;
          const cos = this.advCos[row + t]!;
          const sin = this.advSin[row + t]!;
          for (let r = 0; r < size; r++) {
            const a = curRe[r]!;
            const b = curIm[r]!;
            // X + (a + jb)(cos - j sin)
            nextRe[c * size + r] = xr + a * cos + b * sin;
            nextIm[c * size + r] = xi + b * cos - a * sin;
          }
        }
        size *= choices;
        this.curRe = nextRe;
        this.curIm = nextIm;
        this.nextRe = curRe;
        this.nextIm = curIm;
      }
      // Best sequence magnitude with each data symbol's bit at 1 and at 0.
      this.best0.fill(-Infinity);
      this.best1.fill(-Infinity);
      for (let idx = 0; idx < size; idx++) {
        const mag = Math.hypot(this.curRe[idx]!, this.curIm[idx]!);
        for (let j = 0; j < n; j++) {
          if (this.syncTone[group[j]!]! >= 0) continue;
          const bits = TONE_TO_BITS[Math.floor(idx / strides[j]!) % TONES]!;
          for (let b = 0; b < 3; b++) {
            const slot = j * 3 + b;
            if ((bits >> (2 - b)) & 1) {
              if (mag > this.best1[slot]!) this.best1[slot] = mag;
            } else if (mag > this.best0[slot]!) this.best0[slot] = mag;
          }
        }
      }
      for (let j = 0; j < n; j++) {
        const d = this.dataIndex[group[j]!]!;
        if (d < 0) continue;
        for (let b = 0; b < 3; b++) out[d * 3 + b] = this.best1[j * 3 + b]! - this.best0[j * 3 + b]!;
      }
    }
  }
}
