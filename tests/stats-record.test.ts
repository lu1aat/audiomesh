import { describe, expect, it } from 'vitest';
import { encodeFrame } from '../src/chat/frames';
import { payloadHex } from '../src/chat/frame-log';
import { parseStatsRecord, statsRecord, statsTopic } from '../src/stats/stats-record';

const ctx = { node: 12, band: 'ultrasonic', mode: 'gfsk8-fast' };

describe('stats record', () => {
  it('never carries message text', () => {
    const hex = payloadHex(encodeFrame({ kind: 'first', src: 5, dst: 0, msgId: 1, last: 0, text: 'SECRET ', via: 0 }));
    const rec = statsRecord({ id: 1, atMs: 1000, dir: 'rx', channel: 9, snrDb: -12.34, dtSec: 0.123, hex }, ctx);
    expect(rec).toMatchObject({ type: 'first', src: 5, dst: 0, snr: -12.3, ch: 9, node: 12 });
    expect(JSON.stringify(rec)).not.toContain('SECRET');
    expect(rec.detail).toBeUndefined();
  });

  it('round-trips through JSON and rejects junk', () => {
    const hex = payloadHex(encodeFrame({ kind: 'first', src: 5, dst: 0, msgId: 1, last: 0, text: 'HI     ', via: 0 }));
    const rec = statsRecord({ id: 1, atMs: 1000, dir: 'tx', channel: 9, snrDb: null, hex }, ctx);
    expect(parseStatsRecord(JSON.stringify(rec))).toEqual(rec);
    expect(parseStatsRecord('nope')).toBeNull();
    expect(parseStatsRecord('{"v":2}')).toBeNull();
    expect(parseStatsRecord(JSON.stringify({ ...rec, type: 'evil' }))).toBeNull();
  });

  it('builds a topic from safe parts', () => {
    expect(statsTopic({ node: 7, band: 'a/b#', mode: 'm+' })).toBe('audiomesh/v1/a_b_/m_/7');
  });
});
