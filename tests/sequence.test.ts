import { describe, expect, it } from 'vitest';
import { encodeFrame, type ChatFrame } from '../src/chat/frames';
import { payloadHex, type FrameRecord } from '../src/chat/frame-log';
import { encodeSprite } from '../src/chat/sprite';
import { bubbleText, buildSequence, BUBBLE_GAP_MS, type SeqEvent } from '../src/chat/sequence';

const ME = 1;
let nextId = 1;
const rec = (f: ChatFrame, atMs: number, dir: 'tx' | 'rx' = 'rx'): FrameRecord => ({
  id: nextId++, atMs, dir, channel: 5, snrDb: dir === 'rx' ? -9 : null, hex: payloadHex(encodeFrame(f)),
});
const events = (items: readonly { kind: string }[]): SeqEvent[] => items.filter((i): i is SeqEvent => i.kind === 'event');
const NOW = new Date(2026, 8, 30, 15, 0, 0).getTime();

describe('buildSequence', () => {
  it('draws an announcement from the station to the air, in the control tone', () => {
    const seq = buildSequence([rec({ kind: 'hello', src: 2, name: 'ALPHA' }, NOW - 5000)], ME, NOW);
    const [e] = events(seq.items);
    expect(e!.tone).toBe('control');
    expect(e!.lines).toEqual([{ from: 2, to: 'public', label: 'announce "ALPHA"', dashed: false }]);
    expect(seq.actors).toEqual([2]);
  });

  it('carries a directed message on from the air to its destination, dashed, white tone', () => {
    const seq = buildSequence([rec({ kind: 'first', src: 3, msgId: 4, last: 0, dst: 2, text: 'HI' }, NOW - 5000)], ME, NOW);
    const [e] = events(seq.items);
    expect(e!.tone).toBe('message');
    expect(e!.lines.map((l) => [l.from, l.to, l.dashed])).toEqual([[3, 'public', false], ['public', 2, true]]);
    expect(seq.actors).toEqual([2, 3]);
  });

  it('a broadcast stops at the air, and a later frame of a message finds its destination from the first', () => {
    const seq = buildSequence([
      rec({ kind: 'first', src: 3, msgId: 4, last: 1, dst: 2, text: 'HI     ' }, NOW - 9000),
      rec({ kind: 'next', src: 3, msgId: 4, seq: 1, text: 'THERE' }, NOW - 8000),
      rec({ kind: 'first', src: 3, msgId: 5, last: 0, dst: 0, text: 'ALL' }, NOW - 7000),
    ], ME, NOW);
    const [a, b, c] = events(seq.items);
    expect(b!.lines.map((l) => l.to)).toEqual(['public', 2]);
    expect(c!.lines).toHaveLength(1);
    expect(c!.lines[0]!.label).toContain('→ all');
    expect(a!.lines).toHaveLength(2);
  });

  it('an ack is green and goes to whom it acks', () => {
    const seq = buildSequence([rec({ kind: 'ack', src: 2, dst: 3, msgId: 4, received: 0b11, heardChannel: 5, heardSnrDb: -9 }, NOW - 1000)], ME, NOW);
    const [e] = events(seq.items);
    expect(e!.tone).toBe('ack');
    expect(e!.lines.map((l) => [l.from, l.to])).toEqual([[2, 'public'], ['public', 3]]);
    expect(e!.lines[0]!.label).toBe('ack 1,2');
  });

  it('a beacon adds a dashed line to each station it reports', () => {
    const seq = buildSequence([rec({ kind: 'sound', src: 2, reports: [{ station: 3, channel: 5, snrDb: -8 }, { station: 4, channel: 6, snrDb: -12 }] }, NOW - 1000)], ME, NOW);
    const [e] = events(seq.items);
    expect(e!.lines.map((l) => [l.from, l.to, l.dashed])).toEqual([[2, 'public', false], [2, 3, true], [2, 4, true]]);
    expect(seq.actors).toEqual([2, 3, 4]);
  });

  it('leaves out our own frames heard back, keeps the ones we sent, and puts us first', () => {
    const seq = buildSequence([
      rec({ kind: 'hello', src: ME, name: 'ME' }, NOW - 3000, 'tx'),
      rec({ kind: 'hello', src: ME, name: 'ME' }, NOW - 2900, 'rx'),
      rec({ kind: 'hello', src: 5, name: 'FIVE' }, NOW - 2000),
      rec({ kind: 'hello', src: 9, name: 'NINE' }, NOW - 1000),
    ], ME, NOW);
    expect(events(seq.items)).toHaveLength(3);
    expect(seq.actors).toEqual([ME, 5, 9]);
  });

  it('puts a bubble before the first event and after a long quiet spell or a new day', () => {
    const f = (t: number) => rec({ kind: 'hello', src: 2, name: 'A' }, t);
    const seq = buildSequence([f(NOW - 3 * 3600_000), f(NOW - 3 * 3600_000 + 60_000), f(NOW - 3 * 3600_000 + BUBBLE_GAP_MS + 120_000)], ME, NOW);
    expect(seq.items.map((i) => i.kind)).toEqual(['bubble', 'event', 'event', 'bubble', 'event']);
  });

  it('keeps only the newest events', () => {
    const all = Array.from({ length: 10 }, (_, i) => rec({ kind: 'hello', src: 2, name: 'A' }, NOW - 1000 * (10 - i)));
    const seq = buildSequence(all, ME, NOW, 4);
    expect(events(seq.items).map((e) => e.id)).toEqual(all.slice(-4).map((r) => r.id));
  });
});

describe('sprites and icons', () => {
  it('a sprite frame carries the picture as far as it had arrived, filling in frame by frame', () => {
    const side = 4;
    const data = encodeSprite({ side, bpp: 2, palette: new Uint8Array([0, 8, 11, 14]), pixels: Uint8Array.from({ length: side * side }, (_, i) => i % 4) });
    const frames: ChatFrame[] = data.map((d, i) => (i === 0
      ? { kind: 'spriteHead', src: 3, msgId: 7, dst: 2, side, bpp: 2, data: d }
      : { kind: 'spriteBody', src: 3, msgId: 7, seq: i, side, bpp: 2, data: d }));
    const seq = buildSequence(frames.map((f, i) => rec(f, NOW - 10_000 + i * 1000)), ME, NOW);
    const evs = events(seq.items);
    expect(evs.map((e) => e.sprite?.got)).toEqual(frames.map((_, i) => i + 1));
    expect(evs[0]!.sprite).toMatchObject({ side, frames: frames.length });
    expect(evs[0]!.sprite!.colours).toHaveLength(side * side);
    expect(evs[0]!.icon).toBe('🖼️');
    expect(evs.at(-1)!.lines.map((l) => l.to)).toEqual(['public', 2]); // bodies find the destination
  });

  it('gives each kind of frame its emoji', () => {
    const seq = buildSequence([
      rec({ kind: 'hello', src: 2, name: 'A' }, NOW - 5000),
      rec({ kind: 'sound', src: 2, reports: [] }, NOW - 4000),
      rec({ kind: 'sound', src: 2, reports: [], probe: true }, NOW - 3000),
      rec({ kind: 'first', src: 2, msgId: 1, last: 0, dst: 0, text: 'HI' }, NOW - 2000),
      rec({ kind: 'ack', src: 2, dst: 3, msgId: 1, received: 1, heardChannel: 0, heardSnrDb: 0 }, NOW - 1000),
    ], ME, NOW);
    expect(events(seq.items).map((e) => e.icon)).toEqual(['📣', '📡', '🔎', '💬', '✅']);
  });
});

describe('bubbleText', () => {
  it('says Today, Yesterday or the date', () => {
    expect(bubbleText(new Date(2026, 8, 30, 9, 5).getTime(), NOW)).toBe('Today 09:05');
    expect(bubbleText(new Date(2026, 8, 29, 23, 59).getTime(), NOW)).toBe('Yesterday 23:59');
    expect(bubbleText(new Date(2026, 8, 20, 18, 0).getTime(), NOW)).toBe('2026-09-20 18:00');
  });
});
