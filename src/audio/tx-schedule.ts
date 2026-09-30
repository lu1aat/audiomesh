/**
 * Remembers when this station is transmitting, on the wall clock, so the receiver
 * can skip windows that contain our own signal: a station hears itself far louder
 * than anyone else, and decoding it is just noise in the message list.
 *
 * Pure bookkeeping, no audio; kept apart from AudioEngine so it can be tested.
 */

interface Interval {
  startMs: number;
  endMs: number;
}

export class TxSchedule {
  private intervals: Interval[] = [];

  /** Record a transmission that will occupy [startMs, endMs). */
  add(startMs: number, endMs: number): void {
    this.intervals.push({ startMs, endMs });
  }

  /**
   * The latest transmission stopped at `nowMs` (cancelled). One cancelled before it
   * had started never transmitted anything, so it is dropped rather than left as an
   * empty interval.
   */
  endLatestAt(nowMs: number): void {
    const last = this.intervals[this.intervals.length - 1];
    if (!last) return;
    if (nowMs <= last.startMs) this.intervals.pop();
    else last.endMs = Math.min(last.endMs, nowMs);
  }

  /** True if any recorded transmission overlaps [startMs, endMs). Does not change anything. */
  overlaps(startMs: number, endMs: number): boolean {
    return this.intervals.some((i) => i.startMs < endMs && i.endMs > startMs);
  }

  /** Forget transmissions that ended before `ms`. Call with a time no later window will reach back past. */
  forgetBefore(ms: number): void {
    this.intervals = this.intervals.filter((i) => i.endMs > ms);
  }

  clear(): void {
    this.intervals = [];
  }
}
