/**
 * Every frame sent or received, as data: the model behind the Network screen's frame
 * table. Pure (no DOM); filtering and persistence shape live here so tests reach them.
 */

import { frameFields, type FrameFields, type FrameType } from './describe';
import { driftMsPerMin } from '../sync/server-clock';

export interface FrameRecord {
  readonly id: number;
  /** When the frame was on the air (wall clock). */
  readonly atMs: number;
  readonly dir: 'tx' | 'rx';
  readonly channel: number;
  /** null for frames we sent. */
  readonly snrDb: number | null;
  /** Start time of the frame against the UTC slot start (received only), whatever grid offset we had when it arrived. */
  readonly dtSec?: number;
  readonly freqHz?: number;
  /** The 77 payload bits packed into 10 bytes, hex. */
  readonly hex: string;
}

export const MAX_FRAMES_KEPT = 1000;

export function payloadHex(bits: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ? 1 : 0);
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

export function hexPayload(hex: string, bitCount = 77): Uint8Array {
  const bits = new Uint8Array(bitCount);
  for (let i = 0; i < bitCount; i++) {
    const byte = parseInt(hex.slice((i >> 3) * 2, (i >> 3) * 2 + 2), 16);
    bits[i] = Number.isNaN(byte) ? 0 : (byte >> (7 - (i & 7))) & 1;
  }
  return bits;
}

export interface FrameFilter {
  readonly dir: 'all' | 'tx' | 'rx';
  readonly type: 'all' | FrameType;
  /** Station id text ("12", "#12") or a nickname fragment: matches from or to. */
  readonly station: string;
  /** '' = any channel. */
  readonly channel: string;
  /** Received frames weaker than this are hidden; null = no limit. Sent frames have no SNR and pass. */
  readonly minSnrDb: number | null;
  /** Substring of the decoded text or the hex. */
  readonly text: string;
  /** Hide received frames whose sender is this station: our own transmissions heard back through the speaker. */
  readonly hideSelf: boolean;
}

export const NO_FILTER: FrameFilter = { dir: 'all', type: 'all', station: '', channel: '', minSnrDb: null, text: '', hideSelf: false };

/** What the table starts with, and what Reset returns to: our own transmissions heard back are hidden. */
export const DEFAULT_FILTER: FrameFilter = { ...NO_FILTER, hideSelf: true };

export function decodeRecord(r: FrameRecord, label?: (id: number) => string): FrameFields {
  return frameFields(hexPayload(r.hex), label);
}

export function matchFrame(r: FrameRecord, f: FrameFilter, label: (id: number) => string = (id) => `#${id}`, myId: number | null = null): boolean {
  if (f.dir !== 'all' && r.dir !== f.dir) return false;
  if (f.channel !== '' && String(r.channel) !== f.channel.trim()) return false;
  if (f.minSnrDb !== null && r.snrDb !== null && r.snrDb < f.minSnrDb) return false;
  const d = decodeRecord(r, label);
  if (f.type !== 'all' && d.type !== f.type) return false;
  if (f.hideSelf && r.dir === 'rx' && myId !== null && d.src === myId) return false;
  const st = f.station.trim().replace(/^#/, '').toLowerCase();
  if (st) {
    const names = [d.src, d.dst].filter((x): x is number => x !== undefined && x !== 0).flatMap((id) => [String(id), label(id).toLowerCase()]);
    if (!names.some((n) => n === st || n.includes(st))) return false;
  }
  const tx = f.text.trim().toLowerCase();
  if (tx && !`${d.detail} ${r.hex}`.toLowerCase().includes(tx)) return false;
  return true;
}

/** Records in time order, newest last; the store trims to `MAX_FRAMES_KEPT`. */
export class FrameLog {
  private rows: FrameRecord[] = [];
  private nextId = 1;
  onChange: () => void = () => {};

  get all(): readonly FrameRecord[] {
    return this.rows;
  }

  get count(): number {
    return this.rows.length;
  }

  add(r: Omit<FrameRecord, 'id'>): void {
    this.rows.push({ ...r, id: this.nextId++ });
    if (this.rows.length > MAX_FRAMES_KEPT) this.rows.splice(0, this.rows.length - MAX_FRAMES_KEPT);
    this.onChange();
  }

  /** Remove the records with these ids; returns how many went. */
  remove(ids: ReadonlySet<number>): number {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !ids.has(r.id));
    if (this.rows.length !== before) this.onChange();
    return before - this.rows.length;
  }

  clear(): void {
    this.rows = [];
    this.onChange();
  }

  serialize(): FrameRecord[] {
    return this.rows;
  }

  /** Accepts only well-formed records; the old text-only debug rows are ignored. */
  restore(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const ok = raw.filter(
      (r): r is FrameRecord =>
        !!r && (r.dir === 'tx' || r.dir === 'rx') && typeof r.hex === 'string' && typeof r.atMs === 'number' && typeof r.channel === 'number' &&
        (r.snrDb === null || typeof r.snrDb === 'number'),
    );
    this.rows = ok.slice(-MAX_FRAMES_KEPT).map((r) => ({ ...r, id: this.nextId++ }));
  }
}

export interface StationDelay {
  /** Median start time of the station's frames against the UTC slot start. */
  readonly delaySec: number;
  readonly n: number;
}

/** How many of a station's newest frames the median uses. */
export const DELAY_SAMPLES = 20;

/** Per sending station: its typical frame start against the UTC slot start. Sent frames and frames without a sender are skipped. */
export function stationDelays(records: readonly FrameRecord[], sinceMs = -Infinity): Map<number, StationDelay> {
  const by = new Map<number, number[]>();
  for (const r of records) {
    if (r.dir !== 'rx' || r.dtSec === undefined || r.atMs < sinceMs) continue;
    const f = decodeRecord(r);
    // A repeated frame has the repeater's timing, not the sender's.
    if (f.src === undefined || f.via) continue;
    const src = f.src;
    let list = by.get(src);
    if (!list) by.set(src, (list = []));
    list.push(r.dtSec);
  }
  const out = new Map<number, StationDelay>();
  for (const [id, all] of by) {
    const v = all.slice(-DELAY_SAMPLES).sort((a, b) => a - b);
    const mid = v.length >> 1;
    out.set(id, { delaySec: v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2, n: v.length });
  }
  return out;
}

export interface StationClock {
  readonly id: number;
  /** Median frame start against UTC slots as we hear it: + = late, its clock behind ours. */
  readonly offsetSec: number;
  /** How that offset moves, ms per minute; null with too few frames or too short a span. */
  readonly driftMsPerMin: number | null;
  readonly n: number;
  readonly lastAtMs: number;
}

/** A drift needs frames spread over at least this long, else jitter dominates. */
const DRIFT_MIN_SPAN_MS = 2 * 60_000;

/** Per sending station since `sinceMs`: clock offset against ours and its drift. Repeated frames are skipped (the repeater's timing). */
export function stationClocks(records: readonly FrameRecord[], sinceMs = -Infinity): StationClock[] {
  const by = new Map<number, { atMs: number; offsetMs: number }[]>();
  for (const r of records) {
    if (r.dir !== 'rx' || r.dtSec === undefined || r.atMs < sinceMs) continue;
    const f = decodeRecord(r);
    if (f.src === undefined || f.via) continue;
    let list = by.get(f.src);
    if (!list) by.set(f.src, (list = []));
    list.push({ atMs: r.atMs, offsetMs: r.dtSec * 1000 });
  }
  const out: StationClock[] = [];
  for (const [id, pts] of by) {
    const sorted = pts.map((p) => p.offsetMs).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    const span = pts[pts.length - 1]!.atMs - pts[0]!.atMs;
    out.push({
      id,
      offsetSec: median / 1000,
      driftMsPerMin: pts.length >= 3 && span >= DRIFT_MIN_SPAN_MS ? driftMsPerMin(pts) : null,
      n: pts.length,
      lastAtMs: pts[pts.length - 1]!.atMs,
    });
  }
  return out.sort((a, b) => b.lastAtMs - a.lastAtMs);
}
