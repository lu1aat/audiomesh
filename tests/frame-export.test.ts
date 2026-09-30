import { describe, expect, it } from 'vitest';
import { encodeFrame } from '../src/chat/frames';
import { payloadHex, type FrameRecord } from '../src/chat/frame-log';
import { FRAME_COLUMNS, exportFileName, frameFields, framesToCsv, framesToText } from '../src/chat/frame-export';

const hello = (name: string): string => payloadHex(encodeFrame({ kind: 'hello', src: 796, name }));
const rec = (id: number, atMs: number, over: Partial<FrameRecord> = {}): FrameRecord => ({
  id, atMs, dir: 'rx', channel: 12, snrDb: -11, dtSec: 0.254, freqHz: 18964.2, hex: hello('AT ML'), ...over,
});
const label = (id: number): string => (id === 796 ? 'AT ML' : `#${id}`);

describe('frame export', () => {
  it('writes every column, the FULL hex and UTC time, for one frame', () => {
    const f = frameFields(rec(1, Date.UTC(2026, 8, 30, 21, 36, 25)), label);
    expect(f).toHaveLength(FRAME_COLUMNS.length);
    expect(f[0]).toBe('2026-09-30T21:36:25.000Z');
    expect(f.slice(2, 12)).toEqual(['rx', '12', 'AT ML', '', 'hello', '', '0.254', '-11', '18964.2', hello('AT ML')]);
    expect(f[12]).toContain('AT ML');
  });

  it('names the destination like the table does: a name, "everyone" for a broadcast', () => {
    const broadcast = payloadHex(encodeFrame({ kind: 'first', src: 200, dst: 0, msgId: 3, last: 0, text: 'HOLA' }));
    expect(frameFields(rec(3, 0, { hex: broadcast }), label)[5]).toBe('everyone');
    const directed = payloadHex(encodeFrame({ kind: 'first', src: 200, dst: 796, msgId: 3, last: 0, text: 'HOLA' }));
    expect(frameFields(rec(4, 0, { hex: directed }), label)[5]).toBe('AT ML');
  });

  it('leaves empty what a frame does not have (a sent frame has no snr, dt or frequency)', () => {
    const f = frameFields(rec(2, 0, { dir: 'tx', snrDb: null, dtSec: undefined, freqHz: undefined, channel: 0 }), label);
    expect([f[2], f[3], f[8], f[9], f[10]]).toEqual(['tx', '', '', '', '']);
  });

  it('CSV: header row, oldest first, CRLF, quotes doubled where a field has a comma, quote or line break', () => {
    const csv = framesToCsv([rec(2, 2000), rec(1, 1000, { hex: hello('A,"B"') })], label);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(FRAME_COLUMNS.join(','));
    expect(lines).toHaveLength(4); // header, two frames, trailing empty
    expect(lines[1]).toContain(Date.UTC(1970, 0, 1, 0, 0, 1) === 1000 ? '1970-01-01T00:00:01.000Z' : '');
    expect(csv).toContain('"'); // the name with a comma and quotes is quoted
    expect(csv).not.toContain(',"A,"B"'); // and its quotes were doubled, not left bare
    expect(lines[2]).toContain('1970-01-01T00:00:02.000Z');
  });

  it('text for the clipboard: tab separated, header row, oldest first, no stray tabs or line breaks inside a field', () => {
    const text = framesToText([rec(2, 2000), rec(1, 1000)], label);
    const lines = text.trimEnd().split('\n');
    expect(lines[0]!.split('\t')).toEqual([...FRAME_COLUMNS]);
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith('1970-01-01T00:00:01.000Z')).toBe(true);
    for (const l of lines) expect(l.split('\t')).toHaveLength(FRAME_COLUMNS.length);
  });

  it('file name carries the UTC time and is safe on every file system', () => {
    expect(exportFileName(Date.UTC(2026, 8, 30, 21, 40, 12, 345))).toBe('audiomesh-frames-2026-09-30T21-40-12Z.csv');
  });
});
