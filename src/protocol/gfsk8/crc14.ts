/**
 * CRC-14 over a bit sequence, MSB first, initial value 0, polynomial 0x2757
 * (x^14 + x^13 + x^10 + x^9 + x^8 + x^6 + x^4 + x^2 + x + 1).
 *
 * The payload is zero-extended to 82 bits before the CRC is taken, exactly as the
 * reference does, so the 14 CRC bits fit after 77 payload bits to make the 91
 * information bits of the LDPC(174,91) code.
 */

const WIDTH = 14;
const POLY = 0x2757;
const TOP = 1 << (WIDTH - 1);
const MASK = (1 << WIDTH) - 1;

export const CRC_BITS = WIDTH;
/** Payload is padded with zeros up to this many bits before the CRC is computed. */
export const CRC_INPUT_BITS = 82;

/** `bits`: one bit per byte (0 or 1). Returns the 14-bit CRC of the bits zero-extended to 82. */
export function crc14(bits: Uint8Array): number {
  if (bits.length > CRC_INPUT_BITS) throw new RangeError(`crc14 input is at most ${CRC_INPUT_BITS} bits`);
  let rem = 0;
  for (let i = 0; i < CRC_INPUT_BITS; i++) {
    const bit = i < bits.length ? bits[i]! : 0;
    const feedback = (rem & TOP) !== 0 !== (bit !== 0);
    rem = (rem << 1) & MASK;
    if (feedback) rem ^= POLY;
  }
  return rem;
}
