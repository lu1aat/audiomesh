import { describe, expect, it } from 'vitest';
import { LqaTable } from '../src/ale/lqa';
import { BROADCAST, decodeFrame, encodeFrame, frameKey, repeaterTag, viaOf, withVia } from '../src/chat/frames';
import { Repeater } from '../src/chat/repeater';
import { ChatSession, type InMessage } from '../src/chat/session';

/**
 * Stations with real timing: a frame sent in slot s is decoded during s+1, and what a
 * station sends in slot t is decided during t-1, so an answer goes out in s+2 at the
 * earliest. A station that transmits hears nothing that slot. `hears(i, j)`: i hears j.
 */
function run(stations: ChatSession[], hears: (i: number, j: number) => boolean, from: number, to: number): { sent: (Uint8Array | null)[][] } {
  const sent: (Uint8Array | null)[][] = [];
  for (let t = from; t < to; t++) {
    const old = sent[t - from - 2];
    if (old) {
      stations.forEach((rx, i) => {
        if (old[i]) return;
        old.forEach((p, j) => { if (p && i !== j && hears(i, j)) rx.receive(p, t - 2, -10, 5); });
      });
    }
    sent.push(stations.map((s) => s.nextTx(t)));
  }
  return { sent };
}

const LONG = 'MEET AT THE OLD BRIDGE AT NOON, BRING THE RADIO';

/** A (0) and C (2) cannot hear each other; both hear R (1). */
function line(): { a: ChatSession; r: ChatSession; c: ChatSession; heard: InMessage[]; hears: (i: number, j: number) => boolean } {
  const a = new ChatSession({ stationId: 101 });
  const r = new ChatSession({ stationId: 202 });
  const c = new ChatSession({ stationId: 303, lqa: new LqaTable() });
  const heard: InMessage[] = [];
  c.events.incoming = (m) => heard.push(m);
  r.setRepeater(true);
  return { a, r, c, heard, hears: (i, j) => Math.abs(i - j) === 1 };
}

describe('repeater frame bits', () => {
  it('carries the via tag and the repeater flag in the spare tail bits', () => {
    const msg = encodeFrame({ kind: 'next', src: 5, msgId: 3, seq: 2, text: 'ABCDEFGHI' });
    expect(viaOf(msg)).toBe(0);
    const rep = withVia(msg, 6);
    expect(viaOf(rep)).toBe(6);
    expect(frameKey(rep)).toBe(frameKey(msg));
    expect(decodeFrame(rep)).toEqual({ kind: 'next', src: 5, msgId: 3, seq: 2, text: 'ABCDEFGHI', via: 6 });
    expect(decodeFrame(encodeFrame({ kind: 'hello', src: 9, name: 'RPT', repeater: true }))).toEqual({ kind: 'hello', src: 9, name: 'RPT', repeater: true });
    expect(decodeFrame(encodeFrame({ kind: 'sound', src: 9, reports: [], repeater: true }))).toMatchObject({ repeater: true });
    expect(decodeFrame(encodeFrame({ kind: 'hello', src: 9, name: 'X' }))).not.toHaveProperty('repeater');
    for (let id = 1; id < 1024; id++) expect(repeaterTag(id)).toBeGreaterThan(0);
  });
});

describe('repeater queue', () => {
  const first = encodeFrame({ kind: 'first', src: 1, msgId: 0, last: 1, dst: 2, text: 'HELLO' });

  it('repeats 2 or 4 slots after hearing, never 3, and drops it after that', () => {
    const r = new Repeater(50);
    r.offer(first, 10);
    expect(r.next(11)).toBeNull();
    const out = r.next(12)!;
    expect(viaOf(out.payload)).toBe(repeaterTag(50));
    expect(out.dst).toBe(2);
    r.offer(first, 20); // a retransmit much later is repeated again
    expect(r.next(23)).toBeNull();
    expect(r.next(24)).not.toBeNull();
    r.offer(encodeFrame({ kind: 'first', src: 1, msgId: 1, last: 0, dst: 0, text: 'X' }), 30);
    expect(r.next(35)).toBeNull();
    expect(r.pending).toBe(0);
  });

  it('skips sounds, its own frames, repeats, duplicates and frames addressed to itself', () => {
    const r = new Repeater(50);
    r.offer(encodeFrame({ kind: 'sound', src: 1, reports: [] }), 0);
    r.offer(encodeFrame({ kind: 'hello', src: 50, name: 'ME' }), 0);
    r.offer(withVia(first, 3), 0);
    r.offer(encodeFrame({ kind: 'first', src: 1, msgId: 4, last: 1, dst: 50, text: 'TO YOU' }), 0);
    r.offer(encodeFrame({ kind: 'next', src: 1, msgId: 4, seq: 1, text: 'MORE' }), 0);
    r.offer(encodeFrame({ kind: 'ack', src: 1, dst: 50, msgId: 4, received: 1, heardChannel: 0, heardSnrDb: 0 }), 0);
    expect(r.pending).toBe(0);
    r.offer(first, 0);
    r.offer(first, 1);
    expect(r.pending).toBe(1);
  });
});

describe('repeater in a network', () => {
  it('carries a directed message and its ack between two stations that cannot hear each other', () => {
    const { a, r, c, heard, hears } = line();
    run([a, r, c], hears, 0, 4); // R's sound (queued by repeater mode) tells both it repeats
    expect(a.repeaterPresent(4)).toBe(true);
    const m = a.send(303, LONG);
    run([a, r, c], hears, 4, 80);
    expect(heard.map((h) => h.text)).toEqual([LONG]);
    expect(heard[0]!.via).toEqual({ tag: repeaterTag(202), repeater: 202 });
    expect(m.state).toBe('delivered');
    expect(m.round).toBe(1);
    expect(m.echoedFrames).toBe(m.frames);
    expect(m.echoedBy).toBe(202);
  });

  it('paces frames three slots apart while a repeater is known', () => {
    const { a, r, c, hears } = line();
    run([a, r, c], hears, 0, 4);
    a.send(BROADCAST, LONG);
    const { sent } = run([a, r, c], hears, 4, 40);
    const slots = sent.map((s, i) => (s[0] ? i : -1)).filter((i) => i >= 0);
    for (let k = 1; k < slots.length; k++) expect(slots[k]! - slots[k - 1]!).toBeGreaterThanOrEqual(3);
  });

  it('keeps link statistics honest: a repeated frame counts as the repeater, not the sender', () => {
    const { a, r, c, hears } = line();
    const lqa = (c as unknown as { lqa: LqaTable }).lqa;
    run([a, r, c], hears, 0, 4);
    a.send(BROADCAST, 'HI');
    run([a, r, c], hears, 4, 20);
    const ids = lqa.snapshot(20).map((row) => row.station);
    expect(ids).toContain(202);
    expect(ids).not.toContain(101);
    expect(c.framesVia.get(202)).toBeGreaterThan(0);
  });

  it('relearns repeaters and stations heard through them from saved frames after a reload', () => {
    const c = new ChatSession({ stationId: 303 });
    c.replayHeard(encodeFrame({ kind: 'sound', src: 202, reports: [], repeater: true }), 10);
    const ack = encodeFrame({ kind: 'ack', src: 101, dst: 303, msgId: 2, received: 1, heardChannel: 0, heardSnrDb: 0 });
    c.replayHeard(withVia(ack, repeaterTag(202)), 12);
    expect(c.repeaters.get(202)).toBe(12);
    expect(c.relayedStations.get(101)).toEqual({ slot: 12, via: 202, tag: repeaterTag(202) });
    expect(c.relayPaths).toEqual([{ from: 101, via: 202, slot: 12 }]);
    expect(c.framesVia.get(202)).toBe(1);
  });

  it('remembers a station heard only through the repeater, and which repeater', () => {
    const { a, r, c, hears } = line();
    run([a, r, c], hears, 0, 4);
    a.send(BROADCAST, 'HI');
    run([a, r, c], hears, 4, 20);
    const got = c.relayedStations.get(101);
    expect(got).toMatchObject({ via: 202, tag: repeaterTag(202) });
    expect(got!.slot).toBeGreaterThan(4);
    expect(c.relayedStations.has(202)).toBe(false); // heard direct only
    expect(a.relayedStations.has(101)).toBe(false); // our own frames heard back are not a station
  });

  it('handles a frame heard both direct and repeated once: one message, one ack', () => {
    const a = new ChatSession({ stationId: 101 });
    const r = new ChatSession({ stationId: 202 });
    const b = new ChatSession({ stationId: 404 });
    r.setRepeater(true);
    const heard: InMessage[] = [];
    b.events.incoming = (m) => heard.push(m);
    const everyone = (): boolean => true;
    run([a, r, b], everyone, 0, 4);
    const m = a.send(404, LONG);
    const { sent } = run([a, r, b], everyone, 4, 80);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.via).toBeNull();
    expect(m.state).toBe('delivered');
    const acks = sent.filter((s) => s[2] && decodeFrame(s[2])?.kind === 'ack');
    expect(acks).toHaveLength(2); // the ack and its planned second copy, not one per copy of the frame
  });
});
