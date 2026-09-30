import { describe, expect, it } from 'vitest';
import { LDPC_K, LDPC_M, LDPC_N, LdpcDecoder, ldpcEncode, ldpcSyndromeWeight } from '../src/protocol/gfsk8/ldpc';
import { BIT_CHECKS, CHECK_BITS, GENERATOR } from '../src/protocol/gfsk8/ldpc-tables';
import { gaussian, randomBits, rng } from './helpers';

function encode(message: Uint8Array): Uint8Array {
  const cw = new Uint8Array(LDPC_N);
  ldpcEncode(message, cw);
  return cw;
}

describe('LDPC(174,91) tables', () => {
  it('have the documented shape', () => {
    expect(GENERATOR).toHaveLength(LDPC_M);
    for (const row of GENERATOR) expect(row).toHaveLength(12);
    expect(CHECK_BITS).toHaveLength(LDPC_M);
    expect(BIT_CHECKS).toHaveLength(LDPC_N);
  });

  it('describe the same graph from both sides, with column weight 3', () => {
    let edges = 0;
    for (const [m, bits] of CHECK_BITS.entries()) {
      expect(bits.length === 6 || bits.length === 7).toBe(true);
      expect(new Set(bits).size).toBe(bits.length);
      for (const n of bits) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(LDPC_N);
        expect(BIT_CHECKS[n]).toContain(m);
        edges++;
      }
    }
    for (const checks of BIT_CHECKS) {
      expect(checks).toHaveLength(3);
      expect(new Set(checks).size).toBe(3);
    }
    expect(edges).toBe(LDPC_N * 3);
  });
});

describe('ldpcEncode', () => {
  it('is systematic', () => {
    const msg = randomBits(rng(1), LDPC_K);
    expect([...encode(msg).subarray(0, LDPC_K)]).toEqual([...msg]);
  });

  it('produces words that satisfy all 83 checks, for many random messages', () => {
    // The generator and the check matrix come from different tables in the source,
    // so this ties them together: a wrong entry in either fails here.
    const random = rng(2);
    for (let i = 0; i < 300; i++) expect(ldpcSyndromeWeight(encode(randomBits(random, LDPC_K)))).toBe(0);
  });

  it('is linear', () => {
    const random = rng(4);
    const a = randomBits(random, LDPC_K);
    const b = randomBits(random, LDPC_K);
    const sum = a.map((v, i) => v ^ b[i]!);
    const ea = encode(a);
    const eb = encode(b);
    expect([...encode(sum)]).toEqual([...ea.map((v, i) => v ^ eb[i]!)]);
  });

  it('makes a single flipped bit fail exactly its 3 checks', () => {
    const cw = encode(randomBits(rng(6), LDPC_K));
    for (const n of [0, 50, 90, 91, 130, 173]) {
      const bad = cw.slice();
      bad[n] ^= 1;
      expect(ldpcSyndromeWeight(bad)).toBe(3);
    }
  });

  it('rejects wrong sizes', () => {
    expect(() => ldpcEncode(new Uint8Array(90), new Uint8Array(LDPC_N))).toThrow(RangeError);
    expect(() => ldpcEncode(new Uint8Array(LDPC_K), new Uint8Array(100))).toThrow(RangeError);
  });
});

/** BPSK over AWGN with true LLRs. Positive LLR = bit 1. */
function noisyLlr(cw: Uint8Array, sigma: number, random: () => number): Float32Array {
  const llr = new Float32Array(LDPC_N);
  for (let i = 0; i < LDPC_N; i++) {
    const y = (cw[i] ? 1 : -1) + sigma * gaussian(random);
    llr[i] = (2 * y) / (sigma * sigma);
  }
  return llr;
}

describe('LdpcDecoder', () => {
  const decoder = new LdpcDecoder();

  it('returns a clean codeword unchanged', () => {
    const cw = encode(randomBits(rng(8), LDPC_K));
    const llr = Float32Array.from(cw, (b) => (b ? 6 : -6));
    const r = decoder.decode(llr);
    expect(r.failedChecks).toBe(0);
    expect([...r.bits]).toEqual([...cw]);
  });

  it('corrects noise that a hard decision alone would not survive', () => {
    // Measured behaviour of this decoder on BPSK/AWGN, 200 words per point:
    //   sigma 0.60 (4.7% raw bit errors): 200/200 decoded
    //   sigma 0.70 (7.7%): 195/200,  0.75 (9.0%): 179/200,  0.80 (10.6%): 136/200
    // i.e. a sharp threshold near 8% raw errors, as expected of a real code. The
    // test sits inside the reliable region, so it stays deterministic.
    const random = rng(9);
    const sigma = 0.6;
    let ok = 0;
    let rawErrors = 0;
    const trials = 100;
    for (let t = 0; t < trials; t++) {
      const cw = encode(randomBits(random, LDPC_K));
      const llr = noisyLlr(cw, sigma, random);
      for (let i = 0; i < LDPC_N; i++) if ((llr[i]! > 0 ? 1 : 0) !== cw[i]) rawErrors++;
      const r = decoder.decode(llr);
      if (r.failedChecks === 0 && r.bits.every((b, i) => b === cw[i])) ok++;
    }
    expect(rawErrors / (trials * LDPC_N)).toBeGreaterThan(0.04); // real errors going in
    expect(ok).toBe(trials);
  });

  it('gives up cleanly on pure noise', () => {
    const random = rng(10);
    let falseCodewords = 0;
    for (let t = 0; t < 50; t++) {
      const llr = Float32Array.from({ length: LDPC_N }, () => 4 * gaussian(random));
      if (decoder.decode(llr).failedChecks === 0) falseCodewords++;
    }
    expect(falseCodewords).toBe(0);
  });

  it('rejects the wrong number of LLRs', () => {
    expect(() => decoder.decode(new Float32Array(100))).toThrow(RangeError);
  });
});
