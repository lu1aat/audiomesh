/**
 * LDPC(174,91): 91 information bits, 83 parity bits, systematic (the codeword is
 * the 91 information bits followed by the 83 parity bits).
 *
 * Decoding is sum-product belief propagation on the parity-check graph.
 * Soft input convention throughout: LLR = ln(P(bit=1) / P(bit=0)), so a positive
 * value means "probably 1". That is the reference decoder's convention despite the
 * opposite one in one of its comments.
 *
 * Buffers are preallocated per instance so decode() allocates nothing.
 */

import { BIT_CHECKS, CHECK_BITS, GENERATOR } from './ldpc-tables';

export const LDPC_N = 174;
export const LDPC_K = 91;
export const LDPC_M = LDPC_N - LDPC_K;

/** Keep atanh finite: tanh products can reach exactly +-1 once messages get confident. */
const ATANH_LIMIT = 0.999999;

/** Generator rows unpacked to lists of the message-bit indices each parity bit sums. */
const PARITY_TAPS: readonly Uint8Array[] = GENERATOR.map((row) => {
  const taps: number[] = [];
  for (let bit = 0; bit < LDPC_K; bit++) {
    if ((row[bit >> 3]! >> (7 - (bit & 7))) & 1) taps.push(bit);
  }
  return Uint8Array.from(taps);
});

/**
 * Edge index of each (check, position in that check): bit n's j-th check is slot n * 3 + j of
 * the check-to-bit messages, so EDGE_SLOTS[m][i] is that slot for bit CHECK_BITS[m][i].
 */
const EDGE_SLOTS: readonly Int32Array[] = CHECK_BITS.map((bits, m) =>
  Int32Array.from(bits, (n) => {
    const j = BIT_CHECKS[n]!.indexOf(m);
    if (j < 0) throw new Error(`LDPC tables disagree: bit ${n} not in check ${m}`);
    return n * 3 + j;
  }),
);
const MAX_CHECK_DEGREE = Math.max(...CHECK_BITS.map((bits) => bits.length));

/** message: 91 bits, one per byte. Writes the 174-bit codeword into `out`. */
export function ldpcEncode(message: Uint8Array, out: Uint8Array): void {
  if (message.length !== LDPC_K) throw new RangeError(`message must be ${LDPC_K} bits`);
  if (out.length !== LDPC_N) throw new RangeError(`codeword buffer must be ${LDPC_N} bits`);
  out.set(message);
  for (let p = 0; p < LDPC_M; p++) {
    let sum = 0;
    for (const tap of PARITY_TAPS[p]!) sum ^= message[tap]!;
    out[LDPC_K + p] = sum;
  }
}

/** Number of the 83 parity checks a 174-bit hard decision fails. 0 means a valid codeword. */
export function ldpcSyndromeWeight(bits: Uint8Array): number {
  let failed = 0;
  for (const check of CHECK_BITS) {
    let x = 0;
    for (const n of check) x ^= bits[n]!;
    failed += x;
  }
  return failed;
}

export interface LdpcResult {
  /** Best hard decision found. Only a codeword if `failedChecks` is 0. */
  readonly bits: Uint8Array;
  readonly failedChecks: number;
}

export class LdpcDecoder {
  // Message from bit n to each of its 3 checks, and back.
  private readonly checkToBit = new Float64Array(LDPC_N * 3);
  private readonly bitToCheck: Float64Array[] = CHECK_BITS.map((c) => new Float64Array(c.length));
  private readonly hard = new Uint8Array(LDPC_N);
  private readonly best = new Uint8Array(LDPC_N);
  private readonly scratch = new Float64Array(MAX_CHECK_DEGREE);

  /**
   * `llr`: 174 log-likelihood ratios. Returns the best guess over the iterations.
   * The returned `bits` buffer is reused by the next call.
   */
  decode(llr: Float32Array, maxIterations = 30): LdpcResult {
    if (llr.length !== LDPC_N) throw new RangeError(`need ${LDPC_N} LLRs`);
    const { checkToBit, bitToCheck, hard, best, scratch } = this;
    checkToBit.fill(0);
    let bestFailed = LDPC_M + 1;

    for (let iter = 0; iter <= maxIterations; iter++) {
      // Hard decision from the channel plus everything the checks have said.
      for (let n = 0; n < LDPC_N; n++) {
        const total = llr[n]! + checkToBit[n * 3]! + checkToBit[n * 3 + 1]! + checkToBit[n * 3 + 2]!;
        hard[n] = total > 0 ? 1 : 0;
      }
      const failed = ldpcSyndromeWeight(hard);
      if (failed < bestFailed) {
        bestFailed = failed;
        best.set(hard);
        if (failed === 0) break;
      }
      if (iter === maxIterations) break;

      // Bit -> check: channel LLR plus messages from the bit's other checks.
      for (let m = 0; m < LDPC_M; m++) {
        const bits = CHECK_BITS[m]!;
        const slots = EDGE_SLOTS[m]!;
        const out = bitToCheck[m]!;
        for (let i = 0; i < bits.length; i++) {
          const n = bits[i]!;
          const own = slots[i]!;
          let t = llr[n]!;
          for (let e = n * 3; e < n * 3 + 3; e++) if (e !== own) t += checkToBit[e]!;
          out[i] = Math.tanh(-t / 2);
        }
      }

      // Check -> bit: product of the other bits' tanh terms, each check's leave-one-out
      // products from a running prefix and suffix product (O(degree), not O(degree^2)).
      for (let m = 0; m < LDPC_M; m++) {
        const slots = EDGE_SLOTS[m]!;
        const terms = bitToCheck[m]!;
        const degree = terms.length;
        let prefix = 1;
        for (let i = 0; i < degree; i++) {
          scratch[i] = prefix;
          prefix *= terms[i]!;
        }
        let suffix = 1;
        for (let i = degree - 1; i >= 0; i--) {
          const product = Math.max(-ATANH_LIMIT, Math.min(ATANH_LIMIT, scratch[i]! * suffix));
          checkToBit[slots[i]!] = -2 * Math.atanh(product);
          suffix *= terms[i]!;
        }
      }
    }
    return { bits: best, failedChecks: bestFailed };
  }
}
