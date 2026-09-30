import { describe, expect, it } from 'vitest';
import { CRC_INPUT_BITS, crc14 } from '../src/protocol/gfsk8/crc14';
import { randomBits, rng } from './helpers';

/**
 * Independent byte-oriented CRC, a direct translation of the reference
 * implementation's structure (whole bytes folded into the top of the remainder),
 * to check the bitwise version against a differently-shaped algorithm.
 */
function referenceCrc(bits: Uint8Array): number {
  const padded = new Uint8Array(CRC_INPUT_BITS + 6); // whole number of bytes: 88
  padded.set(bits);
  const bytes: number[] = [];
  for (let i = 0; i < 88; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | padded[i + j]!;
    bytes.push(b);
  }
  let remainder = 0;
  for (let idx = 0; idx < CRC_INPUT_BITS; idx++) {
    if (idx % 8 === 0) remainder ^= bytes[idx >> 3]! << (14 - 8);
    remainder = remainder & 0x2000 ? (remainder << 1) ^ 0x2757 : remainder << 1;
    remainder &= 0x3fff;
  }
  return remainder;
}

describe('crc14', () => {
  it('matches an independent byte-oriented implementation', () => {
    const random = rng(7);
    for (let i = 0; i < 200; i++) {
      const msg = randomBits(random, 77);
      expect(crc14(msg)).toBe(referenceCrc(msg));
    }
  });

  it('is zero for an all-zero message and fits in 14 bits', () => {
    expect(crc14(new Uint8Array(77))).toBe(0);
    const random = rng(3);
    for (let i = 0; i < 100; i++) expect(crc14(randomBits(random, 77))).toBeLessThan(1 << 14);
  });

  it('detects every single-bit error', () => {
    const msg = randomBits(rng(5), 77);
    const good = crc14(msg);
    for (let i = 0; i < 77; i++) {
      const bad = msg.slice();
      bad[i] ^= 1;
      expect(crc14(bad)).not.toBe(good);
    }
  });

  it('rejects input longer than it is defined for', () => {
    expect(() => crc14(new Uint8Array(83))).toThrow(RangeError);
  });
});
