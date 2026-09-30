import { describe, expect, it } from 'vitest';
import { TxSchedule } from '../src/audio/tx-schedule';

describe('TxSchedule', () => {
  it('is empty until something is added', () => {
    expect(new TxSchedule().overlaps(0, 1000)).toBe(false);
  });

  it('overlaps any window that shares time with a transmission', () => {
    const s = new TxSchedule();
    s.add(15_000, 27_640); // one frame from the 15 s boundary
    expect(s.overlaps(13_000, 29_640)).toBe(true); // its own slot's window
    expect(s.overlaps(0, 15_001)).toBe(true); // touches the very start
    expect(s.overlaps(27_000, 40_000)).toBe(true); // touches the very end
  });

  it('does not overlap the neighbouring slots\' windows', () => {
    // Windows are [slot - 2 s, slot + 14.64 s]. A frame at 15 s..27.64 s must not
    // block slot 0's window (-2..14.64 s) or slot 30 s's window (28..44.64 s).
    const s = new TxSchedule();
    s.add(15_000, 27_640);
    expect(s.overlaps(-2000, 14_640)).toBe(false);
    expect(s.overlaps(28_000, 44_640)).toBe(false);
  });

  it('stops overlapping once a cancelled transmission has been cut short', () => {
    const s = new TxSchedule();
    s.add(15_000, 27_640);
    s.endLatestAt(17_000);
    expect(s.overlaps(20_000, 30_000)).toBe(false);
    expect(s.overlaps(16_000, 18_000)).toBe(true); // it did play until 17 s
  });

  it('cancelling before the start leaves nothing behind', () => {
    const s = new TxSchedule();
    s.add(15_000, 27_640);
    s.endLatestAt(10_000); // cancelled while still waiting for the boundary
    expect(s.overlaps(0, 60_000)).toBe(false);
  });

  it('asking does not make it forget, however the questions are ordered', () => {
    const s = new TxSchedule();
    s.add(15_000, 27_640);
    expect(s.overlaps(30_000, 40_000)).toBe(false);
    expect(s.overlaps(16_000, 18_000)).toBe(true);
  });

  it('forgets old transmissions only when told to', () => {
    const s = new TxSchedule();
    s.add(15_000, 27_640);
    s.forgetBefore(20_000); // still running at 20 s: kept
    expect(s.overlaps(16_000, 18_000)).toBe(true);
    s.forgetBefore(30_000); // ended before 30 s: gone
    expect(s.overlaps(16_000, 18_000)).toBe(false);
  });

  it('remembers several transmissions and can be cleared', () => {
    const s = new TxSchedule();
    s.add(15_000, 27_640);
    s.add(45_000, 57_640);
    expect(s.overlaps(40_000, 60_000)).toBe(true);
    s.clear();
    expect(s.overlaps(40_000, 60_000)).toBe(false);
  });
});
