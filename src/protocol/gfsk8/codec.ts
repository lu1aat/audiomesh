/**
 * Frame codec: 77 payload bits <-> 79 channel symbols.
 *
 *   payload (77) -> + CRC-14 -> 91 bits -> LDPC(174,91) -> 174 bits
 *     -> 3 bits per symbol, Gray-mapped to tones -> 58 data symbols
 *     -> Costas sync blocks inserted at their fixed positions -> 79 symbols
 *
 * Gray mapping means neighbouring tones differ in exactly one bit, so the most
 * likely receive error (energy landing in the next tone over) costs one bit, not
 * up to three.
 *
 * Decoding takes per-tone energies, not decided symbols: the LDPC decoder needs
 * the soft information, and throwing it away costs several dB.
 *
 * A candidate the plain decode refuses can be tried harder (decodeHarder): the other
 * soft metrics of soft-metrics.ts, then each of them with a priori knowledge (ApHint):
 * payload bits the receiver knows before hearing the frame, fixed before BP. Measured
 * through Demodulator.decode on Fast acks (48 kHz, unknown timing, 48 frames per
 * point): at -14 dB the plain decode gets 10, the other metrics with the hints "an ack"
 * (23 bits) and "a sound" 30, also knowing the ack we wait for (who, to whom, which
 * message, full bitmap: 63 bits) 46; at -16 dB 0, 1 and 13. 0 frames from 300 noise
 * windows with every hint, Fast and Turbo.
 */

import { AP_UNKNOWN, type ApHint, type FrameCodec, type ToneComplex } from '../protocol';
import { CRC_BITS, crc14 } from './crc14';
import { LDPC_K, LDPC_N, LdpcDecoder, ldpcEncode } from './ldpc';
import { GRAY_TO_TONE, SoftMetrics, normalise } from './soft-metrics';
import { binsPerTone, repeatCount, type ProtocolSpec } from '../spec';

/** Information bits per frame before the CRC. 91 - 14. */
export const PAYLOAD_BITS = LDPC_K - CRC_BITS;

/** Spread of the soft values after normalisation; the decoder is tuned around this. */
const LLR_STD = Math.sqrt(24);

/** Soft metrics, in the order decodeHarder tries them; `power` is the plain decode's. */
type Metric = 'power' | 'mag' | 'exact' | 'coh2' | 'coh3';
const METRICS: readonly Metric[] = ['power', 'mag', 'exact', 'coh2', 'coh3'];

/** A known bit's soft value, against the strongest of the candidate's own: certain, but not overflowing BP. */
const AP_STRENGTH = 1.01;

/** Iterations of belief propagation before giving up on a candidate. */
const MAX_ITERATIONS = 30;

const EPS = 1e-30;

export class Gfsk8Codec implements FrameCodec {
  private readonly dataPositions: Uint8Array;
  private readonly ldpc = new LdpcDecoder();
  private readonly info = new Uint8Array(LDPC_K);
  private readonly codeword = new Uint8Array(LDPC_N);
  private readonly llr = new Float32Array(LDPC_N);
  private readonly energySum: Float32Array;
  private readonly logPower: Float32Array;
  private readonly metrics: SoftMetrics;
  /** One tone per bin and one copy: the protocols the other soft metrics are made for. */
  private readonly plain: boolean;
  /** decodeHarder's soft bits per metric (each computed once per call), and the copy a hint is applied to. */
  private readonly metricLlr = new Map<Metric, Float32Array>(METRICS.map((m) => [m, new Float32Array(LDPC_N)]));
  private readonly metricState = new Map<Metric, 'todo' | 'ok' | 'flat'>();
  private readonly hinted = new Float32Array(LDPC_N);

  constructor(private readonly spec: ProtocolSpec) {
    if (spec.toneCount !== 8) throw new RangeError('Gfsk8Codec is an 8-tone codec');
    const isSync = new Uint8Array(spec.symbolCount);
    for (const start of spec.syncStarts) isSync.fill(1, start, start + spec.syncPattern.length);
    this.dataPositions = Uint8Array.from(
      Array.from(isSync.keys()).filter((i) => isSync[i] === 0),
    );
    if (this.dataPositions.length * 3 !== LDPC_N) {
      throw new RangeError('spec must leave exactly 58 data symbols for a 174-bit codeword');
    }
    if (spec.payloadBits !== PAYLOAD_BITS) {
      throw new RangeError(`spec.payloadBits must be ${PAYLOAD_BITS}`);
    }
    this.logPower = new Float32Array(spec.symbolCount * spec.toneCount);
    this.energySum = new Float32Array(spec.symbolCount * spec.toneCount);
    this.metrics = new SoftMetrics(this.dataPositions, spec.syncStarts, spec.syncPattern, spec.symbolCount);
    this.plain = binsPerTone(spec) === 1 && repeatCount(spec) === 1;
  }

  /** payload: 77 bits, one per byte. Returns 79 tone indices, repeated `repeats` times for a repeating protocol. */
  encode(payload: Uint8Array): Uint8Array {
    if (payload.length !== PAYLOAD_BITS) throw new RangeError(`payload must be ${PAYLOAD_BITS} bits`);
    for (const b of payload) if (b > 1) throw new RangeError('payload bits must be 0 or 1');

    this.info.set(payload);
    const crc = crc14(payload);
    for (let i = 0; i < CRC_BITS; i++) this.info[PAYLOAD_BITS + i] = (crc >> (CRC_BITS - 1 - i)) & 1;
    ldpcEncode(this.info, this.codeword);

    const symbols = new Uint8Array(this.spec.symbolCount);
    for (const start of this.spec.syncStarts) symbols.set(this.spec.syncPattern, start);
    for (let d = 0; d < this.dataPositions.length; d++) {
      const b = d * 3;
      const bits = (this.codeword[b]! << 2) | (this.codeword[b + 1]! << 1) | this.codeword[b + 2]!;
      symbols[this.dataPositions[d]!] = GRAY_TO_TONE[bits]!;
    }
    const repeats = repeatCount(this.spec);
    if (repeats === 1) return symbols;
    const all = new Uint8Array(repeats * symbols.length);
    for (let k = 0; k < repeats; k++) all.set(symbols, k * symbols.length);
    return all;
  }

  /**
   * toneEnergies: linear power, symbolCount x toneCount, row-major by symbol. Sync
   * symbols are ignored (they belong to the demodulator's timing search).
   * Returns the 77 payload bits, or null if the CRC or the code rejects the frame.
   */
  decode(toneEnergies: Float32Array): Uint8Array | null {
    if (!this.softBits(toneEnergies, this.llr)) return null;
    return this.finish(this.llr);
  }

  /**
   * Receptions of one frame: the tone energies are added (each copy first scaled to the same
   * mean, so a louder reception does not drown the others) and the sum is decoded. Measured with
   * ideal timing, 48 kHz, Fast: adding energies beat adding each copy's soft bits by about half a
   * dB (3 copies at -16 dB: 23/24 against 16/24), and two copies reach about 2 dB lower than one.
   */
  decodeCombined(copies: readonly Float32Array[]): Uint8Array | null {
    if (copies.length === 1) return this.decode(copies[0]!);
    const sum = this.energySum;
    sum.fill(0);
    for (const energies of copies) {
      if (energies.length !== sum.length) throw new RangeError(`need ${sum.length} tone energies`);
      let total = 0;
      for (let i = 0; i < energies.length; i++) total += energies[i]!;
      if (!(total > 0)) return null;
      const scale = energies.length / total;
      for (let i = 0; i < energies.length; i++) sum[i]! += energies[i]! * scale;
    }
    return this.decode(sum);
  }

  /**
   * After decode() refused these energies: the other soft metrics (plain protocols only; the coherent
   * ones call `complex` the first time they are reached), then every metric once more with each hint's
   * known bits fixed, the hints in the order given. Returns the first payload the code accepts and, for
   * a hint, that agrees with every bit the hint knows; `pass` = "coh3", "mag+ack", ...
   */
  decodeHarder(
    toneEnergies: Float32Array,
    complex: (() => ToneComplex) | null,
    hints: readonly ApHint[],
  ): { payload: Uint8Array; pass: string } | null {
    const size = this.spec.symbolCount * this.spec.toneCount;
    if (toneEnergies.length !== size) throw new RangeError(`need ${size} tone energies`);
    for (const h of hints) if (h.bits.length !== PAYLOAD_BITS) throw new RangeError(`hint ${h.label} must be ${PAYLOAD_BITS} bits`);
    const metrics = this.plain ? METRICS : METRICS.slice(0, 1);
    for (const m of METRICS) this.metricState.set(m, 'todo');
    let cx: ToneComplex | null = null;
    const llrOf = (m: Metric): Float32Array | null => {
      if (this.metricState.get(m) === 'todo') {
        if ((m === 'coh2' || m === 'coh3') && !cx) cx = complex?.() ?? null;
        this.metricState.set(m, this.fillMetric(m, toneEnergies, cx) ? 'ok' : 'flat');
      }
      return this.metricState.get(m) === 'ok' ? this.metricLlr.get(m)! : null;
    };

    for (const m of metrics) {
      if (m === 'power') continue; // decode() tried it
      const llr = llrOf(m);
      const payload = llr && this.finish(llr);
      if (payload) return { payload, pass: m };
    }
    for (const hint of hints) {
      for (const m of metrics) {
        const llr = llrOf(m);
        if (!llr) continue;
        this.withHint(llr, hint.bits, this.hinted);
        const payload = this.finish(this.hinted);
        if (payload && agrees(payload, hint.bits)) return { payload, pass: `${m}+${hint.label}` };
      }
    }
    return null;
  }

  private fillMetric(m: Metric, energies: Float32Array, cx: ToneComplex | null): boolean {
    const out = this.metricLlr.get(m)!;
    switch (m) {
      case 'power':
        return this.softBits(energies, out);
      case 'mag':
        this.metrics.magnitude(energies, out);
        return normalise(out, LLR_STD);
      case 'exact':
        return this.metrics.exact(energies, out);
      case 'coh2':
      case 'coh3':
        if (!cx) return false;
        this.metrics.coherent(cx, m === 'coh2' ? 2 : 3, out);
        return normalise(out, LLR_STD);
    }
  }

  /** `llr` with the hint's known payload bits (the codeword's first bits: the code is systematic) made certain. */
  private withHint(llr: Float32Array, known: Uint8Array, out: Float32Array): void {
    let strongest = 0;
    for (let i = 0; i < LDPC_N; i++) strongest = Math.max(strongest, Math.abs(llr[i]!));
    out.set(llr);
    const certain = AP_STRENGTH * strongest;
    for (let i = 0; i < known.length; i++) {
      if (known[i] !== AP_UNKNOWN) out[i] = known[i] ? certain : -certain;
    }
  }

  /** Soft bits (positive = 1) of one reception, scaled to the spread the decoder is tuned for. False if flat. */
  private softBits(toneEnergies: Float32Array, out: Float32Array): boolean {
    const { spec, logPower } = this;
    const tones = spec.toneCount;
    if (toneEnergies.length !== spec.symbolCount * tones) {
      throw new RangeError(`need ${spec.symbolCount * tones} tone energies`);
    }
    // Work in log power: a bit's likelihood ratio is then a difference of the
    // strongest matching tones, and it no longer depends on the absolute level.
    for (let i = 0; i < logPower.length; i++) logPower[i] = Math.log(toneEnergies[i]! + EPS);

    // For each of a symbol's 3 bits: the strongest tone that would carry a 1 there,
    // minus the strongest that would carry a 0.
    this.metrics.maxLog(logPower, out);
    // Rescale to a fixed spread. BP is sensitive to the LLR scale, and the raw
    // values depend on the receiver's gain and noise floor. Flat (silence): nothing to decode.
    return normalise(out, LLR_STD);
  }

  private finish(llr: Float32Array): Uint8Array | null {
    const { bits, failedChecks } = this.ldpc.decode(llr, MAX_ITERATIONS);
    if (failedChecks !== 0) return null;

    // An all-zero codeword satisfies every check and has CRC 0, and is what BP
    // converges to on pure noise. It is never a real frame.
    let any = 0;
    for (let i = 0; i < LDPC_K; i++) any |= bits[i]!;
    if (any === 0) return null;

    const payload = bits.slice(0, PAYLOAD_BITS);
    const crc = crc14(payload);
    for (let i = 0; i < CRC_BITS; i++) {
      if (bits[PAYLOAD_BITS + i] !== ((crc >> (CRC_BITS - 1 - i)) & 1)) return null;
    }
    return payload;
  }
}

/** The payload has every bit the hint knows. */
function agrees(payload: Uint8Array, known: Uint8Array): boolean {
  for (let i = 0; i < known.length; i++) if (known[i] !== AP_UNKNOWN && known[i] !== payload[i]) return false;
  return true;
}
