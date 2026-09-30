import { describe, expect, it } from 'vitest';
import { GFSK8_NORMAL as spec } from '../src/protocol/gfsk8/spec';
import { nextSlotStartMs, slotIndexAt, slotStartMs } from '../src/protocol/slot-clock';

describe('slot clock (15 s slots)', () => {
  it('aligns slots to multiples of 15 s since the epoch', () => {
    expect(slotStartMs(0, spec)).toBe(0);
    expect(slotStartMs(3, spec)).toBe(45_000);
    expect(slotIndexAt(44_999, spec)).toBe(2);
    expect(slotIndexAt(45_000, spec)).toBe(3);
  });

  it('gives the next boundary, and stays on a boundary already reached', () => {
    expect(nextSlotStartMs(45_001, spec)).toBe(60_000);
    expect(nextSlotStartMs(59_999, spec)).toBe(60_000);
    expect(nextSlotStartMs(60_000, spec)).toBe(60_000);
  });

  it('skips a boundary that is too close to be reached in time', () => {
    expect(nextSlotStartMs(59_900, spec, 200)).toBe(75_000);
    expect(nextSlotStartMs(59_000, spec, 200)).toBe(60_000);
  });

  it('agrees for any two stations with the same clock', () => {
    const now = 1_790_000_123_456;
    expect(slotStartMs(slotIndexAt(now, spec), spec) % 15_000).toBe(0);
    expect(nextSlotStartMs(now, spec) - now).toBeLessThanOrEqual(15_000);
  });
});
