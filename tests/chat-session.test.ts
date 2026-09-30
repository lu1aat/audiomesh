import { describe, expect, it } from 'vitest';
import { BROADCAST, decodeFrame, encodeFrame } from '../src/chat/frames';
import { ChatSession, type InMessage } from '../src/chat/session';
import { rng } from './helpers';

/**
 * Two stations on one channel. Each slot both may transmit; a station that
 * transmits hears nothing that slot. `lose` decides which transmissions vanish.
 */
function run(
  stations: ChatSession[],
  slots: number,
  lose: (slot: number, from: number, n: number) => boolean = () => false,
  startSlot = 0,
): void {
  const counters = new Map<number, number>();
  for (let slot = startSlot; slot < startSlot + slots; slot++) {
    const sent = stations.map((s) => s.nextTx(slot));
    stations.forEach((rx, i) => {
      if (sent[i]) return; // half duplex
      stations.forEach((_tx, j) => {
        const payload = sent[j];
        if (!payload || i === j) return;
        const n = (counters.get(j) ?? 0) + 1;
        counters.set(j, n);
        if (!lose(slot, j, n)) rx.receive(payload, slot, -10);
      });
    });
  }
}

function pair(): { a: ChatSession; b: ChatSession; heard: InMessage[] } {
  const a = new ChatSession({ stationId: 11 });
  const b = new ChatSession({ stationId: 22 });
  const heard: InMessage[] = [];
  b.events.incoming = (m) => heard.push(m);
  return { a, b, heard };
}

const LONG = 'MEET AT THE OLD BRIDGE AT NOON, BRING THE RADIO AND SOME COFFEE PLEASE';

describe('chat session', () => {
  it('resends an ack by hand: a sender that gave up on a lost ack ends delivered', () => {
    const { a, b, heard } = pair();
    const m = a.send(22, 'hello');
    run([a, b], 40, (_slot, from) => from === 1); // every frame of b's is lost
    expect(heard).toHaveLength(1);
    expect(m.state).toBe('failed');
    b.resendAck(11, heard[0]!.msgId, heard[0]!.frames);
    b.resendAck(11, heard[0]!.msgId, heard[0]!.frames); // asked twice, sent once
    expect(b.outlook().ackDue?.to).toBe(11);
    const first = b.nextTx(40);
    expect(first && decodeFrame(first)).toMatchObject({ kind: 'ack', src: 22, dst: 11, msgId: heard[0]!.msgId, received: 1 });
    a.receive(first!, 40, -10);
    expect(m.state).toBe('delivered');
    expect(b.nextTx(41)).toBeNull();
  });

  it('delivers a one-frame directed message and gets the ack', () => {
    const { a, b, heard } = pair();
    const m = a.send(22, 'hello');
    run([a, b], 10);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ src: 11, dst: 22, text: 'HELLO', frames: 1 });
    expect(m.state).toBe('delivered');
    expect(m.framesSent).toBe(1);
  });

  it('delivers a long message in order, one frame per slot, then acks it', () => {
    const { a, b, heard } = pair();
    const m = a.send(22, LONG);
    expect(m.frames).toBe(Math.ceil((LONG.length - 7) / 9) + 1);
    run([a, b], 30);
    expect(heard.map((h) => h.text)).toEqual([LONG]);
    expect(m.state).toBe('delivered');
    expect(m.ackedFrames).toBe(m.frames);
    expect(m.framesSent).toBe(m.frames);
  });

  it('broadcast reaches everyone, is never acked, and ends at sent', () => {
    const a = new ChatSession({ stationId: 1 });
    const b = new ChatSession({ stationId: 2 });
    const c = new ChatSession({ stationId: 3 });
    const got: string[] = [];
    b.events.incoming = (m) => got.push(`b:${m.text}`);
    c.events.incoming = (m) => got.push(`c:${m.text}`);
    const m = a.send(BROADCAST, 'CQ CQ ALL STATIONS');
    run([a, b, c], 20);
    expect(got.sort()).toEqual(['b:CQ CQ ALL STATIONS', 'c:CQ CQ ALL STATIONS']);
    expect(m.state).toBe('sent');
    expect(b.nextTx(100)).toBeNull();
  });

  it('ignores directed messages for someone else', () => {
    const a = new ChatSession({ stationId: 1 });
    const b = new ChatSession({ stationId: 2 });
    const c = new ChatSession({ stationId: 3 });
    const got: InMessage[] = [];
    c.events.incoming = (m) => got.push(m);
    a.send(2, 'PRIVATE MESSAGE HERE');
    run([a, b, c], 20);
    expect(got).toHaveLength(0);
    expect(c.nextTx(50)).toBeNull();
  });

  it('retransmits only the frames a partial ack says are missing', () => {
    const { a, b, heard } = pair();
    const m = a.send(22, LONG);
    // Lose the 2nd and 4th frame of a's first pass.
    run([a, b], 60, (_slot, from, n) => from === 0 && (n === 2 || n === 4));
    expect(heard.map((h) => h.text)).toEqual([LONG]);
    expect(m.state).toBe('delivered');
    expect(m.round).toBe(2);
    expect(m.framesSent).toBe(m.frames + 2);
  });

  it('resends everything after silence when the first pass was lost, then fails after maxRounds', () => {
    const a = new ChatSession({ stationId: 11, maxRounds: 3 });
    const m = a.send(22, LONG);
    run([a], 80);
    expect(m.state).toBe('failed');
    expect(m.round).toBe(3);
    expect(m.framesSent).toBe(3 * m.frames);
  });

  it('recovers when both acks are lost: the duplicate is re-acked, not shown twice', () => {
    const { a, b, heard } = pair();
    const m = a.send(22, 'HELLO THERE FRIEND');
    // b is station index 1; drop its first ack and the second copy of it.
    run([a, b], 60, (_slot, from, n) => from === 1 && n <= 2);
    expect(heard).toHaveLength(1);
    expect(m.state).toBe('delivered');
    expect(m.round).toBe(2);
  });

  it('sends a complete ack twice, two slots apart, so one lost ack costs no resend round', () => {
    const { a, b } = pair();
    const m = a.send(22, 'HELLO THERE FRIEND');
    const acks: number[] = [];
    const lost = (slot: number, from: number, n: number): boolean => {
      if (from === 1) acks.push(slot);
      return from === 1 && n === 1;
    };
    run([a, b], 30, lost);
    expect(m.state).toBe('delivered');
    expect(m.round).toBe(1);
    expect(acks).toHaveLength(2);
    expect(acks[1]! - acks[0]!).toBe(2);
  });

  it('keeps the next message off the slot of the second ack', () => {
    const { a, b, heard } = pair();
    const m1 = a.send(22, 'ONE');
    const m2 = a.send(22, 'TWO');
    run([a, b], 40);
    expect(heard.map((h) => h.text)).toEqual(['ONE', 'TWO']);
    expect([m1.state, m2.state]).toEqual(['delivered', 'delivered']);
    expect(m2.round).toBe(1);
  });

  it('delivers when the first frame arrives late (retransmit round fills the gap)', () => {
    const { a, b, heard } = pair();
    const m = a.send(22, LONG);
    run([a, b], 80, (_slot, from, n) => from === 0 && n === 1);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.text).toBe(LONG);
    expect(m.state).toBe('delivered');
  });

  it('discards an incomplete message after the reassembly timeout and never delivers it', () => {
    const b = new ChatSession({ stationId: 22, reassemblySlots: 10 });
    const a = new ChatSession({ stationId: 11 });
    const heard: InMessage[] = [];
    b.events.incoming = (m) => heard.push(m);
    a.send(22, LONG);
    run([a, b], 3, (_s, from, n) => from === 0 && n >= 3); // only the first 2 frames arrive
    b.tick(100);
    b.tick(200);
    expect(heard).toHaveLength(0);
    // A late straggler cannot complete a discarded message.
    expect((b as unknown as { incoming: Map<string, unknown> }).incoming.size).toBe(0);
  });

  it('sends messages one after another and keeps them apart', () => {
    const { a, b, heard } = pair();
    a.send(22, 'FIRST MESSAGE, QUITE LONG');
    a.send(22, 'SECOND ONE');
    run([a, b], 60);
    expect(heard.map((h) => h.text)).toEqual(['FIRST MESSAGE, QUITE LONG', 'SECOND ONE']);
    expect(a.messages.every((m) => m.state === 'delivered')).toBe(true);
  });

  it('reuses a message id after 16 messages without confusing the receiver', () => {
    const { a, b, heard } = pair();
    for (let i = 0; i < 20; i++) {
      a.send(22, `MSG NUMBER ${i}`);
      run([a, b], 12, () => false, i * 12);
    }
    expect(heard).toHaveLength(20);
    expect(heard.map((h) => h.text)).toEqual(Array.from({ length: 20 }, (_, i) => `MSG NUMBER ${i}`));
  });

  it('refuses a 17th message while 16 are in flight, empty text and over-long text', () => {
    const a = new ChatSession({ stationId: 1 });
    for (let i = 0; i < 16; i++) a.send(2, 'X');
    expect(() => a.send(2, 'X')).toThrow(/in flight/);
    expect(() => new ChatSession({ stationId: 1 }).send(2, '   ')).toThrow();
    expect(() => new ChatSession({ stationId: 1 }).send(2, 'A'.repeat(143))).toThrow();
  });

  it('retry restarts a failed message', () => {
    const a = new ChatSession({ stationId: 11, maxRounds: 1 });
    const b = new ChatSession({ stationId: 22 });
    const m = a.send(22, 'HELLO');
    run([a], 20);
    expect(m.state).toBe('failed');
    a.retry(m);
    expect(m.state).toBe('queued');
    run([a, b], 20, () => false, 20);
    expect(m.state).toBe('delivered');
  });

  it('learns nicknames from hello frames and ignores its own echo', () => {
    const a = new ChatSession({ stationId: 11 });
    const b = new ChatSession({ stationId: 22 });
    a.setNickname('alice');
    a.announce();
    run([a, b], 3);
    expect(b.stations.get(11)).toBe('ALICE');
    a.receive(a.nextTx(10) ?? new Uint8Array(77), 10); // nothing queued: harmless
    expect(a.stations.size).toBe(0);
  });

  it('survives random loss: every message either arrives intact or is marked failed', () => {
    const random = rng(7);
    const { a, b, heard } = pair();
    for (let i = 0; i < 6; i++) a.send(22, `${i}: ${LONG.slice(0, 20 + i * 8)}`);
    run([a, b], 400, () => random() < 0.25);
    for (const m of a.messages) expect(['delivered', 'failed']).toContain(m.state);
    const delivered = a.messages.filter((m) => m.state === 'delivered').length;
    expect(delivered).toBeGreaterThanOrEqual(4);
    // Nothing shown twice.
    expect(new Set(heard.map((h) => h.text)).size).toBe(heard.length);
  });

describe('outlook', () => {
  it('says what is lined up without changing it', () => {
    const a = new ChatSession({ stationId: 11 });
    expect(a.outlook()).toMatchObject({ ackDue: null, sending: null, waitingAck: null, queued: 0, sound: false });
    a.sound();
    a.send(22, 'A LONGER MESSAGE THAN ONE FRAME');
    const o = a.outlook();
    expect(o.sound).toBe(true);
    expect(o.queued).toBe(1);
    expect(a.outlook()).toEqual(o); // asking twice changes nothing
    a.nextTx(1); // first frame goes out
    expect(a.outlook().sending).toMatchObject({ dst: 22, total: 4 });
    for (let slot = 2; slot < 6; slot++) a.nextTx(slot);
    expect(a.outlook().waitingAck?.dst).toBe(22);
    expect(a.outlook().sending).toBeNull();
  });
});

describe('beacons do not clog the channel', () => {
  it('holds a sound or announcement for one quiet slot after any frame of ours, without dropping it', () => {
    const a = new ChatSession({ stationId: 11 });
    a.setNickname('ANA');
    a.send(0, 'HI'); // a one-frame broadcast
    expect(a.nextTx(10)).not.toBeNull(); // the message goes out in slot 10
    a.sound();
    a.announce();
    expect(a.nextTx(11)).toBeNull(); // right after it: both wait
    expect(a.outlook().beaconFromSlot).toBe(12);
    const hello = a.nextTx(12);
    expect(hello).not.toBeNull(); // after a quiet slot the announcement goes
    expect(a.nextTx(13)).toBeNull(); // and the sound waits again behind it
    expect(a.nextTx(14)).not.toBeNull();
    expect(a.outlook().sound).toBe(false);
  });

  it('does not hold back message frames', () => {
    const a = new ChatSession({ stationId: 11 });
    a.send(0, 'A LONGER MESSAGE THAN ONE FRAME');
    for (let slot = 1; slot <= 4; slot++) expect(a.nextTx(slot), `slot ${slot}`).not.toBeNull();
  });
});
});

describe('probe sound', () => {
  it('the probe bit roundtrips and a plain sound has none', () => {
    const on = decodeFrame(encodeFrame({ kind: 'sound', src: 5, reports: [], probe: true }));
    const off = decodeFrame(encodeFrame({ kind: 'sound', src: 5, reports: [] }));
    expect(on).toMatchObject({ kind: 'sound', probe: true });
    expect(off && 'probe' in off).toBe(false);
  });

  it('every station that hears a probe answers with a plain sound to the prober, at once and every time', () => {
    const prober = new ChatSession({ stationId: 11 });
    const other = new ChatSession({ stationId: 22 });
    for (let k = 0; k < 3; k++) {
      prober.sound(true);
      const probe = prober.nextTxTo(10 + k * 10)!;
      expect(decodeFrame(probe.payload)).toMatchObject({ kind: 'sound', probe: true });
      other.receive(probe.payload, 10 + k * 10, -8, 5);
      const answer = other.nextTxTo(11 + k * 10)!;
      expect(answer.dst).toBe(11);
      const f = decodeFrame(answer.payload);
      expect(f).toMatchObject({ kind: 'sound', src: 22 });
      expect(f && 'probe' in f).toBe(false);
      prober.receive(answer.payload, 11 + k * 10, -8, 5);
      expect(prober.nextTxTo(12 + k * 10)).toBeNull(); // no chain
    }
  });
});
