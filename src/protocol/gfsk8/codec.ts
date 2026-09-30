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
 */

import type { FrameCodec } from '../protocol';
import { CRC_BITS, crc14 } from './crc14';
import { LDPC_K, LDPC_N, LdpcDecoder, ldpcEncode } from './ldpc';
import type { ProtocolSpec } from '../spec';

/** Information bits per frame before the CRC. 91 - 14. */
export const PAYLOAD_BITS = LDPC_K - CRC_BITS;

/** bits (b0 b1 b2, MSB first) -> tone. */
const GRAY_TO_TONE = [0, 1, 3, 2, 5, 6, 4, 7] as const;

/** Spread of the soft values after normalisation; the decoder is tuned around this. */
const LLR_STD = Math.sqrt(24);

/** Iterations of belief propagation before giving up on a candidate. */
const MAX_ITERATIONS = 30;

const EPS = 1e-30;

export class Gfsk8Codec implements FrameCodec {
  private readonly dataPositions: Uint8Array;
  private readonly ldpc = new LdpcDecoder();
  private readonly info = new Uint8Array(LDPC_K);
  private readonly codeword = new Uint8Array(LDPC_N);
  private readonly llr = new Float32Array(LDPC_N);
  private readonly logPower: Float32Array;

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
  }

  /** payload: 77 bits, one per byte. Returns 79 tone indices. */
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
    return symbols;
  }

  /**
   * toneEnergies: linear power, symbolCount x toneCount, row-major by symbol. Sync
   * symbols are ignored (they belong to the demodulator's timing search).
   * Returns the 77 payload bits, or null if the CRC or the code rejects the frame.
   */
  decode(toneEnergies: Float32Array): Uint8Array | null {
    const { spec, logPower, llr } = this;
    const tones = spec.toneCount;
    if (toneEnergies.length !== spec.symbolCount * tones) {
      throw new RangeError(`need ${spec.symbolCount * tones} tone energies`);
    }
    // Work in log power: a bit's likelihood ratio is then a difference of the
    // strongest matching tones, and it no longer depends on the absolute level.
    for (let i = 0; i < logPower.length; i++) logPower[i] = Math.log(toneEnergies[i]! + EPS);

    // Soft bits, positive = 1. For each of a symbol's 3 bits: the strongest tone
    // that would carry a 1 there, minus the strongest that would carry a 0.
    const s = new Float32Array(8);
    for (let d = 0; d < this.dataPositions.length; d++) {
      const row = this.dataPositions[d]! * tones;
      for (let bits = 0; bits < 8; bits++) s[bits] = logPower[row + GRAY_TO_TONE[bits]!]!;
      const o = d * 3;
      llr[o] = Math.max(s[4]!, s[5]!, s[6]!, s[7]!) - Math.max(s[0]!, s[1]!, s[2]!, s[3]!);
      llr[o + 1] = Math.max(s[2]!, s[3]!, s[6]!, s[7]!) - Math.max(s[0]!, s[1]!, s[4]!, s[5]!);
      llr[o + 2] = Math.max(s[1]!, s[3]!, s[5]!, s[7]!) - Math.max(s[0]!, s[2]!, s[4]!, s[6]!);
    }

    // Rescale to a fixed spread. BP is sensitive to the LLR scale, and the raw
    // values depend on the receiver's gain and noise floor.
    let sum = 0;
    let sum2 = 0;
    for (let i = 0; i < LDPC_N; i++) {
      sum += llr[i]!;
      sum2 += llr[i]! * llr[i]!;
    }
    const mean = sum / LDPC_N;
    const variance = sum2 / LDPC_N - mean * mean;
    if (!(variance > 1e-12)) return null; // silence, or a flat spectrum: nothing to decode
    const scale = LLR_STD / Math.sqrt(variance);
    for (let i = 0; i < LDPC_N; i++) llr[i] = llr[i]! * scale;

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


