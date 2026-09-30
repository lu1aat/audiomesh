import { describe, expect, it } from 'vitest';
import { clockHints, type ClockInput } from '../src/chat/clock-hint';

const base: ClockInput = {
  delays: new Map(),
  offsetMs: 0,
  maxTimeOffsetSec: 2,
  deepExtraSec: 3,
  deepOn: false,
  undecoded: [],
  nowMs: 1_000_000,
  slotSec: 15,
  name: (id) => `#${id}`,
  myId: 1,
};
const delays = (...ds: [number, number][]) => new Map(ds.map(([id, d]) => [id, { delaySec: d, n: 5 }]));

describe('clockHints', () => {
  it('says nothing when everyone is on time', () => {
    expect(clockHints({ ...base, delays: delays([2, 0.2], [3, -0.1]) })).toEqual([]);
  });

  it('blames our clock when every station is off by the same amount, and offers to sync', () => {
    const h = clockHints({ ...base, delays: delays([2, 1.4], [3, 1.6]) });
    expect(h[0]!.text).toMatch(/this clock is probably 1\.5 s ahead/);
    expect(h[0]!.action?.offsetMs).toBe(1500);
  });

  it('blames the one station that is off while the others are on time', () => {
    const h = clockHints({ ...base, delays: delays([2, 1.2], [3, 0.1], [4, -0.1]) });
    expect(h).toHaveLength(1);
    expect(h[0]!.text).toMatch(/^#2 is 1\.2 s late .* behind/);
    expect(h[0]!.action).toBeUndefined();
  });

  it('with one station, cannot tell whose clock it is and offers to sync', () => {
    const h = clockHints({ ...base, delays: delays([2, -1.2]) });
    expect(h[0]!.text).toMatch(/one of the two clocks/);
    expect(h[0]!.action?.offsetMs).toBe(-1200);
  });

  it('ignores stations timed only once, and ourselves', () => {
    const d = new Map([[2, { delaySec: 1.5, n: 1 }], [1, { delaySec: 1.5, n: 9 }]]);
    expect(clockHints({ ...base, delays: d })).toEqual([]);
  });

  it('warns when a station sits near the edge of the search', () => {
    const h = clockHints({ ...base, delays: delays([2, 1.7], [3, 0], [4, 0]) });
    expect(h.some((x) => /near the ±2\.0 s/.test(x.text) && /Deep decode/.test(x.text))).toBe(true);
  });

  it('suggests deep decoding when real signals keep failing at the edge of the window', () => {
    const undecoded = [
      { atMs: 990_000, score: 0.4, dtSec: 1.9 },
      { atMs: 975_000, score: 0.35, dtSec: 1.8 },
      { atMs: 960_000, score: 0.24, dtSec: 1.9 }, // noise
    ];
    const h = clockHints({ ...base, undecoded });
    expect(h).toHaveLength(1);
    expect(h[0]!.text).toMatch(/In 2 recent slots .* Turn on Deep decode/);
  });

  it('with deep decoding already on, proposes a manual offset beyond the edge', () => {
    const undecoded = [
      { atMs: 990_000, score: 0.4, dtSec: -4.8 },
      { atMs: 975_000, score: 0.4, dtSec: -4.6 },
    ];
    const h = clockHints({ ...base, undecoded, deepOn: true });
    expect(h[0]!.action?.offsetMs).toBe(-5700);
  });

  it('forgets old undecoded signals', () => {
    const undecoded = [
      { atMs: 100_000, score: 0.4, dtSec: 1.9 },
      { atMs: 115_000, score: 0.4, dtSec: 1.9 },
    ];
    expect(clockHints({ ...base, undecoded })).toEqual([]);
  });

  it('passes on a fresh server check that says this clock is off, with the fix', () => {
    const h = clockHints({ ...base, server: { offsetMs: -2300, uncertaintyMs: 20, atMs: 990_000 } });
    expect(h[0]!.text).toMatch(/server says this device's clock is 2\.3 s behind/);
    expect(h[0]!.action?.offsetMs).toBe(-2300);
    // Already applied, or too old: nothing to say.
    expect(clockHints({ ...base, offsetMs: -2300, server: { offsetMs: -2300, uncertaintyMs: 20, atMs: 990_000 } })).toEqual([]);
    expect(clockHints({ ...base, server: { offsetMs: -2300, uncertaintyMs: 20, atMs: -1e7 } })).toEqual([]);
  });
});
