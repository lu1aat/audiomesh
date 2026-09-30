import { describe, expect, it } from 'vitest';
import { encodeFrame } from '../src/chat/frames';
import { stationDelays, FrameLog, hexPayload, matchFrame, NO_FILTER, payloadHex } from '../src/chat/frame-log';

const hello = payloadHex(encodeFrame({ kind: 'hello', src: 12, name: 'ANA' }));
const first = payloadHex(encodeFrame({ kind: 'first', src: 30, msgId: 1, last: 0, dst: 12, text: 'HI' }));

describe('frame log', () => {
  it('round-trips a payload through hex', () => {
    const bits = encodeFrame({ kind: 'hello', src: 12, name: 'ANA' });
    expect(hexPayload(payloadHex(bits))).toEqual(bits);
    expect(payloadHex(bits)).toHaveLength(20);
  });

  it('filters by direction, type, station, channel, SNR and text', () => {
    const rx = { id: 1, atMs: 0, dir: 'rx', channel: 9, snrDb: -15, hex: first } as const;
    const tx = { id: 2, atMs: 0, dir: 'tx', channel: 4, snrDb: null, hex: hello } as const;
    expect(matchFrame(rx, { ...NO_FILTER, dir: 'tx' })).toBe(false);
    expect(matchFrame(tx, { ...NO_FILTER, type: 'hello' })).toBe(true);
    expect(matchFrame(rx, { ...NO_FILTER, type: 'hello' })).toBe(false);
    expect(matchFrame(rx, { ...NO_FILTER, station: '#12' })).toBe(true); // destination
    expect(matchFrame(rx, { ...NO_FILTER, station: '99' })).toBe(false);
    expect(matchFrame(rx, { ...NO_FILTER, channel: '9' })).toBe(true);
    expect(matchFrame(rx, { ...NO_FILTER, minSnrDb: -10 })).toBe(false);
    expect(matchFrame(tx, { ...NO_FILTER, minSnrDb: -10 })).toBe(true); // sent frames have no SNR
    expect(matchFrame(rx, { ...NO_FILTER, text: 'hi' })).toBe(true);
    const own = { id: 3, atMs: 0, dir: 'rx', channel: 9, snrDb: -5, hex: hello } as const; // sent by 12
    expect(matchFrame(own, { ...NO_FILTER, hideSelf: true }, undefined, 12)).toBe(false);
    expect(matchFrame(own, { ...NO_FILTER, hideSelf: true }, undefined, 30)).toBe(true);
    expect(matchFrame(tx, { ...NO_FILTER, hideSelf: true }, undefined, 12)).toBe(true); // frames we sent stay
    expect(matchFrame(rx, { ...NO_FILTER, station: 'bob' }, (id) => (id === 30 ? 'Bob' : `#${id}`))).toBe(true);
  });

  it('removes by id, trims, and ignores old text-only rows on restore', () => {
    const log = new FrameLog();
    for (let i = 0; i < 3; i++) log.add({ atMs: i, dir: 'rx', channel: 1, snrDb: -10, hex: hello });
    expect(log.remove(new Set([log.all[1]!.id]))).toBe(1);
    expect(log.count).toBe(2);
    const copy = new FrameLog();
    copy.restore([...JSON.parse(JSON.stringify(log.serialize())), { direction: 'rx', text: 'old' }]);
    expect(copy.count).toBe(2);
  });

  it('takes the median frame start per sending station, from received frames only', () => {
    const rx = (dtSec: number, hex = hello) => ({ id: 0, atMs: 0, dir: 'rx' as const, channel: 1, snrDb: -10, dtSec, hex });
    const d = stationDelays([rx(0.1), rx(0.5), rx(0.3), rx(9, first), { ...rx(5), dir: 'tx' as const }]);
    expect(d.get(12)).toEqual({ delaySec: 0.3, n: 3 });
    expect(d.get(30)).toEqual({ delaySec: 9, n: 1 });
    expect(d.size).toBe(2);
  });
});

describe('stationClocks', () => {
  it('gives each station its median offset and drift, skipping repeats and our sends', async () => {
    const { stationClocks } = await import('../src/chat/frame-log');
    const { withVia } = await import('../src/chat/frames');
    const hello = (src: number) => encodeFrame({ kind: 'hello', src, name: 'A' });
    const recs = [0, 1, 2, 3, 4].map((i) => ({
      id: i, atMs: i * 60_000, dir: 'rx' as const, channel: 1, snrDb: -5, dtSec: 1 + i * 0.002, hex: payloadHex(hello(7)),
    }));
    recs.push({ id: 9, atMs: 5 * 60_000, dir: 'rx', channel: 1, snrDb: -5, dtSec: 4, hex: payloadHex(withVia(hello(7), 3)) });
    const [c] = stationClocks(recs);
    expect(c!.id).toBe(7);
    expect(c!.n).toBe(5);
    expect(c!.offsetSec).toBeCloseTo(1.004, 3);
    expect(c!.driftMsPerMin).toBeCloseTo(2, 5);
  });
});
