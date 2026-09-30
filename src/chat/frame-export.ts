/**
 * The frame log as text, for analysis outside the app: a CSV of every frame, and a tab-separated copy of the selected
 * ones (pastes into a spreadsheet or a chat). Pure and DOM-free. Both carry the FULL raw payload in hex (the table shows
 * only its first three digits) and the time in UTC as well as local, so a frame can be matched to an audio capture
 * (their file names are UTC slot starts) or to another station's log.
 */

import { decodeRecord, type FrameRecord } from './frame-log';

export const FRAME_COLUMNS = [
  'time_utc', 'time_local', 'dir', 'channel', 'from', 'to', 'type', 'msg', 'dt_s', 'snr_db', 'freq_hz', 'hex', 'decoded',
] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const local = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** One record as the columns above. Empty string for what a record does not have. */
export function frameFields(r: FrameRecord, label: (id: number) => string = (id) => `#${id}`): string[] {
  const d = decodeRecord(r, label);
  return [
    new Date(r.atMs).toISOString(),
    local(r.atMs),
    r.dir,
    r.channel ? String(r.channel) : '',
    d.src === undefined ? '' : label(d.src),
    d.dst === undefined ? '' : d.dst === 0 ? 'everyone' : label(d.dst),
    d.type,
    d.msgId === undefined ? '' : String(d.msgId),
    r.dtSec === undefined ? '' : r.dtSec.toFixed(3),
    r.snrDb === null ? '' : String(r.snrDb),
    r.freqHz === undefined ? '' : r.freqHz.toFixed(1),
    r.hex,
    d.detail,
  ];
}

/** Oldest first, whatever order the caller has them in. */
const inTimeOrder = (records: readonly FrameRecord[]): FrameRecord[] => [...records].sort((a, b) => a.atMs - b.atMs || a.id - b.id);

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** RFC 4180 CSV with a header row; nicknames and message text come from strangers, hence the quoting. */
export function framesToCsv(records: readonly FrameRecord[], label?: (id: number) => string): string {
  const rows = [FRAME_COLUMNS.join(','), ...inTimeOrder(records).map((r) => frameFields(r, label).map(csvCell).join(','))];
  return rows.join('\r\n') + '\r\n';
}

/** Tab-separated with a header row. Tabs and line breaks inside a field (text from other stations) become spaces. */
export function framesToText(records: readonly FrameRecord[], label?: (id: number) => string): string {
  const flat = (v: string): string => v.replace(/[\t\r\n]+/g, ' ');
  return [FRAME_COLUMNS.join('\t'), ...inTimeOrder(records).map((r) => frameFields(r, label).map(flat).join('\t'))].join('\n') + '\n';
}

/** "audiomesh-frames-2026-09-30T21-40-12Z.csv" */
export function exportFileName(nowMs: number): string {
  return `audiomesh-frames-${new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}.csv`;
}
