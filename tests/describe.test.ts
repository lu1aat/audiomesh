import { describe, expect, it } from 'vitest';
import { LqaTable } from '../src/ale/lqa';
import { describeFrame } from '../src/chat/describe';
import { encodeFrame } from '../src/chat/frames';

describe('describeFrame', () => {
  it('describes every kind on one line', () => {
    const name = (id: number): string => `S${id}`;
    const text = (f: Parameters<typeof encodeFrame>[0]): string => describeFrame(encodeFrame(f), name);
    expect(text({ kind: 'first', src: 5, msgId: 3, last: 1, dst: 0, text: 'HI     ' })).toBe('S5 → everyone · msg 3 frame 1/2 · "HI"');
    expect(text({ kind: 'next', src: 5, msgId: 3, seq: 1, text: 'THERE    ' })).toBe('S5 · msg 3 frame 2 · "THERE"');
    expect(text({ kind: 'ack', src: 6, dst: 5, msgId: 3, received: 0b11, heardChannel: 4, heardSnrDb: -9 })).toBe(
      'S6 → S5 · ack msg 3, frames 1,2 · heard you on ch 4 at -9 dB',
    );
    expect(text({ kind: 'hello', src: 6, name: 'BOB' })).toBe('S6 · hello, name "BOB"');
    expect(text({ kind: 'sound', src: 6, reports: [{ station: 5, channel: 2, snrDb: -3 }] })).toBe('S6 · sound · hears S5 on ch 2 at -3 dB');
    expect(text({ kind: 'hello', src: 6, name: 'RPT', repeater: true })).toBe('S6 · hello, name "RPT" · repeater');
    expect(text({ kind: 'next', src: 5, msgId: 3, seq: 1, text: 'THERE', via: 4 })).toBe('S5 · msg 3 frame 2 · "THERE" · repeated (tag 4)');
  });

  it('says so for payloads that are not chat frames', () => {
    expect(describeFrame(new Uint8Array(77))).toBe('not a chat frame');
  });
});

describe('LqaTable.snapshot', () => {
  it('gives the slot of the newest evidence for each row', () => {
    const t = new LqaTable();
    t.heard(7, 3, -10, 5);
    t.reported(7, 3, -12, 9);
    t.heard(7, 4, -10, 6);
    expect(t.snapshot(10)).toEqual([
      { station: 7, channel: 3, heardDb: -10, reportedDb: -12, heardCount: 1, reportedCount: 1, lastSlot: 9 },
      { station: 7, channel: 4, heardDb: -10, heardCount: 1, reportedCount: 0, lastSlot: 6 },
    ]);
  });
});
