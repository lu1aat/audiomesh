import { describe, expect, it } from 'vitest';
import { SlotRecorder, type SlotWindow } from '../src/dsp/slot-recorder';
import { GFSK8_NORMAL as spec } from '../src/protocol/gfsk8/spec';
import { windowDurationSec, windowLeadSec } from '../src/protocol/spec';

const RATE = 8000; // small: this tests bookkeeping, not DSP
const SLOT = spec.slotSec * RATE;
const LEAD = windowLeadSec(spec) * RATE;
const WINDOW = Math.round(windowDurationSec(spec) * RATE);

/** Feed samples whose value is their own absolute index, so a window's contents prove where it came from. */
function run(
  recorder: SlotRecorder,
  from: number,
  to: number,
  block: number,
  skip: (start: number) => boolean = () => false,
): SlotWindow[] {
  const out: SlotWindow[] = [];
  for (let at = from; at < to; at += block) {
    if (skip(at)) continue;
    const n = Math.min(block, to - at);
    const input = Float32Array.from({ length: n }, (_, i) => at + i);
    const w = recorder.process(input, at);
    if (w) out.push(w);
  }
  return out;
}

describe('SlotRecorder', () => {
  it('cuts one window per slot, starting one lead before the slot boundary', () => {
    const rec = new SlotRecorder(RATE, spec);
    rec.setSlotOrigin(0);
    // Start recording early enough that slot 1's whole window is available.
    const windows = run(rec, 0, 4 * SLOT, 128);
    expect(windows.map((w) => w.slotIndex)).toEqual([1, 2, 3]);
    for (const w of windows) {
      expect(w.samples).toHaveLength(WINDOW);
      const expectedStart = w.slotIndex * SLOT - LEAD;
      // Sample value == absolute index, so this pins the alignment exactly.
      expect(w.samples[0]).toBe(expectedStart);
      expect(w.samples[WINDOW - 1]).toBe(expectedStart + WINDOW - 1);
    }
  });

  it('places the slot boundary exactly `lead` into each window', () => {
    const rec = new SlotRecorder(RATE, spec);
    rec.setSlotOrigin(5000); // origin need not be zero
    const [w] = run(rec, 0, 3 * SLOT, 100);
    expect(w!.samples[LEAD]).toBe(5000 + w!.slotIndex * SLOT);
  });

  it('is independent of block size, including blocks that straddle the trigger', () => {
    const results = [64, 128, 999, 4001].map((block) => {
      const rec = new SlotRecorder(RATE, spec);
      rec.setSlotOrigin(0);
      return run(rec, 0, 3 * SLOT, block).map((w) => [w.slotIndex, w.samples[0], w.samples[WINDOW - 1]]);
    });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('skips a slot whose window began before recording did', () => {
    const rec = new SlotRecorder(RATE, spec);
    rec.setSlotOrigin(0);
    // Slot 1's window starts at SLOT - LEAD; start recording after that.
    const windows = run(rec, SLOT - LEAD + 1000, 4 * SLOT, 128);
    expect(windows.map((w) => w.slotIndex)).toEqual([2, 3]);
  });

  it('skips a slot with a hole in the input, and recovers for the next', () => {
    const rec = new SlotRecorder(RATE, spec);
    rec.setSlotOrigin(0);
    // Drop one block in the middle of slot 2's window.
    const hole = 2 * SLOT + 1024;
    const windows = run(rec, 0, 5 * SLOT, 128, (start) => start === hole);
    const slots = windows.map((w) => w.slotIndex);
    expect(slots).not.toContain(2);
    expect(slots).toContain(1);
    expect(slots).toContain(4);
  });

  it('emits nothing until told where the slots are', () => {
    const rec = new SlotRecorder(RATE, spec);
    expect(run(rec, 0, 3 * SLOT, 128)).toEqual([]);
    rec.setSlotOrigin(0);
    expect(run(rec, 3 * SLOT, 5 * SLOT, 128).length).toBeGreaterThan(0);
  });

  it('follows a nudged origin without repeating or skipping a slot', () => {
    const rec = new SlotRecorder(RATE, spec);
    rec.setSlotOrigin(0);
    const first = run(rec, 0, 3 * SLOT, 128);
    expect(first.map((w) => w.slotIndex)).toEqual([1, 2]);
    // The audio clock has drifted 40 samples against the wall clock: re-anchor.
    rec.setSlotOrigin(40);
    const next = run(rec, 3 * SLOT, 6 * SLOT, 128);
    expect(next.map((w) => w.slotIndex)).toEqual([3, 4, 5]);
    // Later windows are cut 40 samples later than the un-nudged grid would have.
    expect(next[0]!.samples[0]).toBe(3 * SLOT - LEAD + 40);
  });

  it('never returns a window that shares memory with the ring', () => {
    const rec = new SlotRecorder(RATE, spec);
    rec.setSlotOrigin(0);
    const windows = run(rec, 0, 4 * SLOT, 128);
    const copy = Float32Array.from(windows[0]!.samples);
    run(rec, 4 * SLOT, 6 * SLOT, 128);
    expect([...windows[0]!.samples.subarray(0, 50)]).toEqual([...copy.subarray(0, 50)]);
  });

  it('cuts wider windows with a longer lead when deep decoding', () => {
    const rate = 1000;
    const deep = new SlotRecorder(rate, spec, 3);
    expect(deep.leadSec).toBeCloseTo(windowLeadSec(spec) + 3);
    deep.setSlotOrigin(0);
    let got: { slotIndex: number; samples: Float32Array } | null = null;
    const block = new Float32Array(100);
    for (let t = 0; !got && t < 60 * rate; t += block.length) got = deep.process(block, t);
    expect(got).not.toBeNull();
    expect(got!.samples.length).toBe(Math.round((windowDurationSec(spec) + 6) * rate));
  });
});
