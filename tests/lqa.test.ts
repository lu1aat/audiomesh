import { describe, expect, it } from 'vitest';
import { LqaTable, RECIPROCITY_PENALTY_DB, TIE_DB, soundChannel } from '../src/ale/lqa';
import { ChatSession } from '../src/chat/session';
import { rng } from './helpers';

describe('LqaTable', () => {
  it('smooths repeated measurements and forgets stale ones', () => {
    const t = new LqaTable({ smoothing: 0.5, maxAgeSlots: 10 });
    t.heard(7, 3, -10, 0);
    t.heard(7, 3, -20, 1);
    expect(t.heardSnr(7, 3, 1)).toBe(-15);
    expect(t.heardSnr(7, 3, 11)).toBe(-15);
    expect(t.heardSnr(7, 3, 12)).toBeUndefined();
    t.heard(7, 3, -4, 30); // stale entry is replaced, not averaged with
    expect(t.heardSnr(7, 3, 30)).toBe(-4);
  });

  it('prefers the far end report over the heard value, which is docked', () => {
    const t = new LqaTable();
    t.heard(7, 3, -5, 0);
    expect(t.txScore(7, 3, 0)).toBe(-5 - RECIPROCITY_PENALTY_DB);
    t.reported(7, 3, -14, 0);
    expect(t.txScore(7, 3, 0)).toBe(-14);
    // Once it has reported anything, a channel it did not report is unknown, whatever we heard.
    t.heard(7, 4, -1, 0);
    expect(t.txScore(7, 4, 0)).toBeUndefined();
  });

  it('chooses the channel the far end hears best, and only among those within the tie band', () => {
    const t = new LqaTable();
    t.reported(7, 1, -18, 0);
    t.reported(7, 2, -6, 0);
    t.reported(7, 3, -5, 0);
    t.reported(7, 4, -6 - TIE_DB - 1, 0);
    const picks = new Set<number>();
    const random = rng(1);
    for (let i = 0; i < 200; i++) picks.add(t.chooseChannel([7], [1, 2, 3, 4, 5], 0, random)!);
    expect([...picks].sort()).toEqual([2, 3]);
  });

  it('moves off a busy channel to a quieter one that still works, but not to a weak one', () => {
    const t = new LqaTable();
    t.reported(7, 1, -3, 0); // best link, but two other stations talk there
    t.reported(7, 2, -8, 0); // a bit weaker, quiet
    t.reported(7, 3, -17, 0); // quiet but too weak to be worth it
    const load = new Map([[1, 2]]);
    for (let i = 0; i < 20; i++) expect(t.chooseChannel([7], [1, 2, 3], 0, Math.random, { load })).toBe(2);
    // When 2 is busy as well, the best link wins again; 3 is never chosen for being quiet.
    const both = new Map([[1, 2], [2, 2]]);
    for (let i = 0; i < 20; i++) expect(t.chooseChannel([7], [1, 2, 3], 0, Math.random, { load: both })).toBe(1);
  });

  it('keeps the channel used last while it is among the best, so stations do not hop', () => {
    const t = new LqaTable();
    t.reported(7, 1, -5, 0);
    t.reported(7, 2, -6, 0);
    t.reported(7, 3, -5, 0);
    for (let i = 0; i < 20; i++) expect(t.chooseChannel([7], [1, 2, 3], 0, Math.random, { prefer: 2 })).toBe(2);
    // Once someone else crowds it, it gives way.
    const moved = t.chooseChannel([7], [1, 2, 3], 0, Math.random, { prefer: 2, load: new Map([[2, 1]]) });
    expect([1, 3]).toContain(moved);
  });

  it('with only weak links, ignores load and keeps to the tie band', () => {
    const t = new LqaTable();
    t.reported(7, 1, -17, 0);
    t.reported(7, 2, -22, 0);
    expect(t.chooseChannel([7], [1, 2], 0, Math.random, { load: new Map([[1, 3]]) })).toBe(1);
  });

  it('is undefined when nothing is known, and for several stations takes the worst case', () => {
    const t = new LqaTable();
    expect(t.chooseChannel([7], [1, 2], 0)).toBeUndefined();
    t.reported(7, 1, 0, 0);
    t.reported(7, 2, -6, 0);
    t.reported(8, 1, -25, 0); // 8 hears channel 1 badly
    t.reported(8, 2, -8, 0);
    expect(t.chooseChannel([7, 8], [1, 2], 0)).toBe(2);
  });

  it('reports the pairs it has not reported for longest, rotating through every station and channel', () => {
    const t = new LqaTable();
    for (const s of [1, 2]) for (const c of [5, 6]) t.heard(s, c, -10 - c, 0);
    const seen = new Set<string>();
    for (let slot = 1; slot <= 2; slot++) {
      const out = t.reportsToSend(2, slot);
      expect(out).toHaveLength(2);
      for (const r of out) seen.add(`${r.station}:${r.channel}`);
    }
    expect([...seen].sort()).toEqual(['1:5', '1:6', '2:5', '2:6']);
  });

  it('stops reporting a station silent for longer than reportSilenceSlots, on every channel', () => {
    const t = new LqaTable({ reportSilenceSlots: 40 });
    t.heard(1, 5, -8, 0); // station 1: heard long ago on ch 5 ...
    t.heard(1, 6, -9, 30); // ... and more recently on ch 6
    t.heard(2, 5, -7, 0); // station 2: only long ago
    const at = (slot: number) => new Set(t.reportsToSend(10, slot).map((r) => `${r.station}:${r.channel}`));
    // Station 2 silent 40 slots: still reported. Station 1 reports both channels while it is active.
    expect(at(40)).toEqual(new Set(['1:5', '1:6', '2:5']));
    // 41 slots of silence: station 2 is gone; station 1 (heard 11 slots ago) keeps both channels.
    expect(at(41)).toEqual(new Set(['1:5', '1:6']));
    // Station 1 silent 41 slots: nothing left to report.
    expect(at(71)).toEqual(new Set());
  });

  it('rotates sound channels, offset by station id', () => {
    const chs = [1, 2, 3, 4];
    expect([0, 1, 2, 3, 4].map((n) => soundChannel(10, n, chs))).toEqual([3, 4, 1, 2, 3]);
    expect(soundChannel(11, 0, chs)).not.toBe(soundChannel(10, 0, chs));
  });
});

describe('LqaTable views', () => {
  it('ranks channels by worst case and says whether the best rests on a report', () => {
    const t = new LqaTable();
    t.reported(7, 1, -4, 0);
    t.reported(7, 2, -9, 0);
    t.reported(8, 1, -20, 0);
    t.reported(8, 2, -8, 0);
    expect(t.rankChannels([7, 8], [1, 2, 3], 0)).toEqual([{ channel: 2, score: -9 }, { channel: 1, score: -20 }]);
    expect(t.bestFor(7, [1, 2, 3], 0)).toEqual({ channel: 1, score: -4, measured: true });
    t.heard(9, 5, -2, 0);
    expect(t.bestFor(9, [5], 0)).toMatchObject({ channel: 5, measured: false });
    expect(t.bestFor(99, [1], 0)).toBeUndefined();
  });

  it('counts measurements, resets the count when stale, and keeps a bounded history', () => {
    const t = new LqaTable({ maxAgeSlots: 10 });
    t.heard(7, 3, -10, 0);
    t.heard(7, 3, -12, 1);
    expect(t.snapshot(1)[0]).toMatchObject({ heardCount: 2, reportedCount: 0 });
    t.heard(7, 3, -5, 50);
    expect(t.snapshot(50)[0]).toMatchObject({ heardCount: 1 });
    expect(t.history(1).map((x) => x.slot)).toEqual([1, 50]);
    for (let i = 0; i < 1200; i++) t.heard(7, 3, -5, 60 + i);
    expect(t.history(0).length).toBe(1000);
  });
});

describe('sessions learning link quality', () => {
  /** Station A hears B well on channel 2 only; B hears A well on channel 5 only. */
  const snrAtB = (ch: number): number | null => (ch === 5 ? -8 : ch === 4 ? -19 : null); // A -> B
  const snrAtA = (ch: number): number | null => (ch === 2 ? -7 : null); // B -> A

  it('a sound from each side, then an ack, tell a sender which channel the far end hears it on', () => {
    const lqaA = new LqaTable();
    const lqaB = new LqaTable();
    const a = new ChatSession({ stationId: 11, lqa: lqaA });
    const b = new ChatSession({ stationId: 22, lqa: lqaB });
    const air = (from: ChatSession, to: ChatSession, ch: number, snr: number | null, slot: number): void => {
      const tx = from.nextTx(slot);
      if (tx && snr !== null) to.receive(tx, slot, snr, ch);
    };
    // A sounds on 5 and 4 (a quiet slot between: beacons never go back to back); B hears them.
    a.sound();
    air(a, b, 5, snrAtB(5), 0);
    a.sound();
    air(a, b, 4, snrAtB(4), 2);
    // B sounds on channel 2, naming what it heard of A; A hears B.
    b.sound();
    air(b, a, 2, snrAtA(2), 3);
    expect(lqaA.reportedSnr(22, 5, 3)).toBe(-8);
    expect(lqaA.reportedSnr(22, 4, 3)).toBe(-19);
    expect(lqaA.heardSnr(22, 2, 3)).toBe(-7);
    // Sending to B, A picks the channel B reported best.
    expect(lqaA.chooseChannel([22], [1, 2, 3, 4, 5], 4)).toBe(5);
  });

  it('an ack carries how the message sender was heard', () => {
    const lqaA = new LqaTable();
    const lqaB = new LqaTable();
    const a = new ChatSession({ stationId: 11, lqa: lqaA });
    const b = new ChatSession({ stationId: 22, lqa: lqaB });
    a.send(22, 'HI');
    const first = a.nextTxTo(0)!;
    expect(first.dst).toBe(22);
    b.receive(first.payload, 0, -13, 6);
    const ack = b.nextTxTo(1)!;
    expect(ack.dst).toBe(11);
    a.receive(ack.payload, 1, -9, 3);
    expect(lqaA.reportedSnr(22, 6, 1)).toBe(-13);
    expect(lqaA.heardSnr(22, 3, 1)).toBe(-9);
  });

  it('holds a sound back while a message is in flight, and sends it afterwards', () => {
    const a = new ChatSession({ stationId: 11, lqa: new LqaTable() });
    const b = new ChatSession({ stationId: 22, lqa: new LqaTable() });
    a.send(22, 'HI');
    a.sound();
    const first = a.nextTxTo(0)!;
    expect(first.dst).toBe(22); // the message, not the sound
    expect(a.nextTxTo(1)).toBeNull(); // waiting for the ack: silent, still deaf-free
    b.receive(first.payload, 0, -10, 3);
    a.receive(b.nextTxTo(1)!.payload, 1, -10, 3);
    // Delivered; b sends its ack a second time in slot 3, so a stays off the air until then.
    expect(a.nextTxTo(2)).toBeNull();
    expect(a.nextTxTo(3)).toBeNull();
    expect(a.nextTxTo(4)?.dst).toBe(0); // now the sound goes
  });

  it('nextTxTo says broadcast for hellos and sounds', () => {
    const s = new ChatSession({ stationId: 11, lqa: new LqaTable() });
    s.setNickname('BOB');
    s.announce();
    expect(s.nextTxTo(0)?.dst).toBe(0);
    s.sound();
    expect(s.nextTxTo(1)).toBeNull(); // right after the hello: waits for a quiet slot
    expect(s.nextTxTo(2)?.dst).toBe(0);
  });
});

describe('LqaTable persistence', () => {
  it('round-trips through JSON and keeps the evidence', () => {
    const a = new LqaTable();
    a.heard(7, 9, -12, 100);
    a.reported(7, 9, -15, 101);
    const b = new LqaTable();
    b.restore(JSON.parse(JSON.stringify(a.serialize())));
    expect(b.heardSnr(7, 9, 102)).toBeCloseTo(-12);
    expect(b.reportedSnr(7, 9, 102)).toBeCloseTo(-15);
    expect(b.history(0)).toHaveLength(1);
  });

  it('skips malformed stored data and can be cleared', () => {
    const t = new LqaTable();
    t.restore({ heard: [[1, [['x']]], 'junk', [2, [[3, -5, 10, 1]]]], samples: [null, { slot: 1 }] });
    expect(t.heardSnr(2, 3, 10)).toBe(-5);
    expect(t.history(0)).toHaveLength(0);
    t.clear();
    expect(t.snapshot(10)).toHaveLength(0);
  });
});
