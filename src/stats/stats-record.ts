/**
 * What "Publish Network Stats" puts on the wire, as plain data (no DOM, no MQTT): one small
 * JSON record per frame this station sent or heard. Metadata only: never audio, never message
 * text or sprite pixels. The only free text is a hello's nickname, a sound's link reports and an
 * ack's bitmap, all of which every station on the air already sees.
 */

import { frameFields, type FrameType } from '../chat/describe';
import { hexPayload, type FrameRecord } from '../chat/frame-log';

/** Fixed: the CSP's `connect-src` names this one broker (vite.config.ts). */
export const STATS_BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';
export const STATS_TOPIC_ROOT = 'audiomesh/v1';
/** Subscription covering every station: root/<band>/<protocol>/<station id>. */
export const STATS_TOPIC_ALL = `${STATS_TOPIC_ROOT}/#`;

const FRAME_TYPES: readonly FrameType[] = ['first', 'next', 'spriteHead', 'spriteBody', 'ack', 'hello', 'sound', 'invalid'];
/** Frame kinds whose `detail` is safe to publish (nickname, link reports, ack bitmap). */
const DETAIL_TYPES: ReadonlySet<FrameType> = new Set(['hello', 'sound', 'ack']);
const MAX_DETAIL = 120;

export interface StatsRecord {
  readonly v: 1;
  /** Station that publishes this record. */
  readonly node: number;
  readonly band: string;
  /** Protocol id, e.g. gfsk8-fast. */
  readonly mode: string;
  /** When the frame was on the air, UTC ms. */
  readonly at: number;
  readonly dir: 'tx' | 'rx';
  readonly ch: number;
  /** null for frames the node sent. */
  readonly snr: number | null;
  readonly dt?: number;
  readonly type: FrameType;
  readonly src?: number;
  readonly dst?: number;
  readonly msgId?: number;
  /** Repeater tag when a repeater sent this copy. */
  readonly via?: number;
  readonly detail?: string;
}

export interface StatsContext {
  readonly node: number;
  readonly band: string;
  readonly mode: string;
}

export function statsRecord(r: FrameRecord, ctx: StatsContext): StatsRecord {
  const f = frameFields(hexPayload(r.hex));
  return {
    v: 1,
    node: ctx.node,
    band: ctx.band,
    mode: ctx.mode,
    at: r.atMs,
    dir: r.dir,
    ch: r.channel,
    snr: r.snrDb === null ? null : Math.round(r.snrDb * 10) / 10,
    ...(r.dtSec !== undefined ? { dt: Math.round(r.dtSec * 100) / 100 } : {}),
    type: f.type,
    ...(f.src !== undefined ? { src: f.src } : {}),
    ...(f.dst !== undefined ? { dst: f.dst } : {}),
    ...(f.msgId !== undefined ? { msgId: f.msgId } : {}),
    ...(f.via !== undefined ? { via: f.via } : {}),
    ...(DETAIL_TYPES.has(f.type) && f.detail ? { detail: f.detail.slice(0, MAX_DETAIL) } : {}),
  };
}

const topicPart = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function statsTopic(ctx: StatsContext): string {
  return `${STATS_TOPIC_ROOT}/${topicPart(ctx.band)}/${topicPart(ctx.mode)}/${ctx.node}`;
}

/** Read back from the broker, so nothing about it can be trusted: null when it is not a record. */
export function parseStatsRecord(raw: string): StatsRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const int = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
  if (r.v !== 1 || !int(r.node) || typeof r.band !== 'string' || typeof r.mode !== 'string') return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at) || (r.dir !== 'tx' && r.dir !== 'rx') || !int(r.ch)) return null;
  if (r.snr !== null && (typeof r.snr !== 'number' || !Number.isFinite(r.snr))) return null;
  if (typeof r.type !== 'string' || !FRAME_TYPES.includes(r.type as FrameType)) return null;
  const opt = (v: unknown): number | undefined => (int(v) ? v : undefined);
  const dt = typeof r.dt === 'number' && Number.isFinite(r.dt) ? r.dt : undefined;
  const detail = typeof r.detail === 'string' ? r.detail.slice(0, MAX_DETAIL) : undefined;
  const src = opt(r.src), dst = opt(r.dst), msgId = opt(r.msgId), via = opt(r.via);
  return {
    v: 1, node: r.node, band: r.band.slice(0, 32), mode: r.mode.slice(0, 32), at: r.at, dir: r.dir, ch: r.ch, snr: r.snr,
    ...(dt !== undefined ? { dt } : {}),
    type: r.type as FrameType,
    ...(src !== undefined ? { src } : {}),
    ...(dst !== undefined ? { dst } : {}),
    ...(msgId !== undefined ? { msgId } : {}),
    ...(via !== undefined ? { via } : {}),
    ...(detail ? { detail } : {}),
  };
}
