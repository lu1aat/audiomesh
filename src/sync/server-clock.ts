/**
 * How far this device's clock is from the clock of the server that served the page,
 * from the HTTP `Date` header of a same-origin HEAD request. Only on request (a
 * button, or the opt-in periodic check): the one runtime network request the app
 * makes, and it goes only to the page's own origin (CSP `connect-src 'self'`), so the
 * app still works from any static host and nothing reaches a third party.
 *
 * The header has whole seconds only. Each reply bounds the offset: the server's
 * clock read `serverSec` at some moment between sending and receiving, so
 *   local - server  lies in  (sendMs - serverMs - 1000, recvMs - serverMs].
 * Intersecting the bounds of several replies narrows it; a request timed to reach the
 * server just as its second ticks over halves the interval, down to about half the
 * round trip.
 */

export interface DateSample {
  /** Local wall clock (Date.now()) when the request left and when the reply came. */
  readonly sendMs: number;
  readonly recvMs: number;
  /** The Date header, ms since the epoch (a whole second). */
  readonly serverMs: number;
}

export interface ClockOffset {
  /** local - server, ms: positive = this device's clock is ahead. */
  readonly offsetMs: number;
  /** Half the width of the interval the offset is known to lie in. */
  readonly uncertaintyMs: number;
  readonly atMs: number;
  readonly samples: number;
}

/** The interval `local - server` lies in, from all samples; null when they contradict each other. */
export function offsetBounds(samples: readonly DateSample[]): { lo: number; hi: number } | null {
  let lo = -Infinity, hi = Infinity;
  for (const s of samples) {
    lo = Math.max(lo, s.sendMs - s.serverMs - 1000);
    hi = Math.min(hi, s.recvMs - s.serverMs);
  }
  return lo <= hi ? { lo, hi } : null;
}

export function estimateOffset(samples: readonly DateSample[]): ClockOffset | null {
  const b = offsetBounds(samples);
  if (!b || !Number.isFinite(b.lo) || !Number.isFinite(b.hi)) return null;
  return {
    offsetMs: (b.lo + b.hi) / 2,
    uncertaintyMs: (b.hi - b.lo) / 2,
    atMs: samples[samples.length - 1]!.recvMs,
    samples: samples.length,
  };
}

/**
 * Local time to send the next request so that it reaches the server (half a round
 * trip later) just as the server's second ticks, for the middle of the current bounds.
 */
export function nextProbeMs(nowMs: number, bounds: { lo: number; hi: number }, rttMs: number): number {
  const mid = (bounds.lo + bounds.hi) / 2;
  // Server time at arrival = send + rtt/2 - mid; aim it at the next whole second, at least 50 ms ahead.
  const arrivalServer = nowMs + 50 + rttMs / 2 - mid;
  const tick = Math.ceil(arrivalServer / 1000) * 1000;
  return tick + mid - rttMs / 2;
}

/** Drift of a series of offsets, ms per minute (least squares); null with fewer than 2 points or no time between them. */
export function driftMsPerMin(points: readonly { atMs: number; offsetMs: number }[]): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.atMs, 0) / n;
  const my = points.reduce((a, p) => a + p.offsetMs, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of points) {
    sxx += (p.atMs - mx) ** 2;
    sxy += (p.atMs - mx) * (p.offsetMs - my);
  }
  if (sxx < 1) return null;
  return (sxy / sxx) * 60_000;
}

export type Fetcher = () => Promise<{ serverMs: number | null }>;

/** HEAD the page's own URL, uncached, and read its Date header. */
export const sameOriginDate: Fetcher = async () => {
  const res = await fetch(`${location.pathname}?clock=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
  const date = res.headers.get('Date');
  const ms = date ? Date.parse(date) : NaN;
  return { serverMs: Number.isFinite(ms) ? ms : null };
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Measurements of this device's clock against the server, newest last. */
export class ServerClock {
  readonly history: ClockOffset[] = [];
  busy = false;
  error: string | null = null;

  constructor(
    private readonly fetchDate: Fetcher = sameOriginDate,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = wait,
  ) {}

  get latest(): ClockOffset | null {
    return this.history[this.history.length - 1] ?? null;
  }

  /** Drift of this clock against the server over the measurements kept, ms per minute. */
  get driftMsPerMin(): number | null {
    return driftMsPerMin(this.history);
  }

  /** About 3 s of requests: 6 spread over a second, then up to 8 aimed at the server's second tick. */
  async measure(): Promise<ClockOffset | null> {
    if (this.busy) return null;
    this.busy = true;
    this.error = null;
    try {
      const samples: DateSample[] = [];
      let rtt = 0;
      const probe = async (): Promise<void> => {
        const sendMs = this.now();
        const { serverMs } = await this.fetchDate();
        const recvMs = this.now();
        if (serverMs === null) throw new Error('the server sent no Date header');
        samples.push({ sendMs, recvMs, serverMs });
        rtt = samples.reduce((a, s) => a + (s.recvMs - s.sendMs), 0) / samples.length;
      };
      for (let i = 0; i < 6; i++) {
        await probe();
        await this.sleep(170);
      }
      for (let i = 0; i < 8; i++) {
        const b = offsetBounds(samples);
        if (!b) break;
        if (b.hi - b.lo <= rtt + 10) break; // as good as the round trip allows
        await this.sleep(nextProbeMs(this.now(), b, rtt) - this.now());
        await probe();
      }
      const result = estimateOffset(samples);
      if (!result) throw new Error('the server replies do not agree (its clock jumped?)');
      this.history.push(result);
      if (this.history.length > 30) this.history.shift();
      return result;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      this.busy = false;
    }
  }
}
