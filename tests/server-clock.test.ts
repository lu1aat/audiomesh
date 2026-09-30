import { describe, expect, it } from 'vitest';
import { ServerClock, driftMsPerMin, estimateOffset, offsetBounds } from '../src/sync/server-clock';
import { rng } from './helpers';

/** Virtual time: a local clock `offsetMs` ahead of the server, a round trip of rttMs +- jitter. */
function fakeServer(offsetMs: number, rttMs: number, jitterMs: number, seed = 1) {
  let t = 1_790_000_000_123;
  const random = rng(seed);
  const now = () => t;
  const sleep = async (ms: number) => { t += Math.max(0, ms); };
  const fetchDate = async () => {
    const up = rttMs / 2 + random() * jitterMs;
    const down = rttMs / 2 + random() * jitterMs;
    t += up;
    const serverMs = Math.floor((t - offsetMs) / 1000) * 1000;
    t += down;
    return { serverMs };
  };
  return { now, sleep, fetchDate };
}

describe('server clock', () => {
  it('bounds the offset from one reply by a second plus the round trip', () => {
    const b = offsetBounds([{ sendMs: 10_000, recvMs: 10_050, serverMs: 8_000 }])!;
    expect(b).toEqual({ lo: 1_000, hi: 2_050 });
  });

  it('refuses replies that contradict each other', () => {
    expect(offsetBounds([
      { sendMs: 10_000, recvMs: 10_010, serverMs: 8_000 },
      { sendMs: 10_020, recvMs: 10_030, serverMs: 5_000 },
    ])).toBeNull();
    expect(estimateOffset([])).toBeNull();
  });

  for (const [offsetMs, rttMs] of [[1234, 40], [-2750, 20], [0, 120], [480, 5]] as const) {
    it(`measures a clock ${offsetMs} ms off to about half the round trip (rtt ${rttMs} ms)`, async () => {
      const f = fakeServer(offsetMs, rttMs, rttMs / 4, offsetMs + rttMs);
      const clock = new ServerClock(f.fetchDate, f.now, f.sleep);
      const r = (await clock.measure())!;
      expect(r).not.toBeNull();
      expect(Math.abs(r.offsetMs - offsetMs)).toBeLessThanOrEqual(r.uncertaintyMs + 1);
      expect(r.uncertaintyMs).toBeLessThan(rttMs + 30);
      expect(r.samples).toBeLessThanOrEqual(14);
    });
  }

  it('reports a missing Date header as an error', async () => {
    const clock = new ServerClock(async () => ({ serverMs: null }), () => 0, async () => {});
    expect(await clock.measure()).toBeNull();
    expect(clock.error).toMatch(/no Date header/);
  });

  it('computes drift in ms per minute', () => {
    expect(driftMsPerMin([{ atMs: 0, offsetMs: 100 }])).toBeNull();
    expect(driftMsPerMin([{ atMs: 0, offsetMs: 100 }, { atMs: 120_000, offsetMs: 106 }])).toBeCloseTo(3);
  });
});
