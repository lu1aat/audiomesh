/**
 * The frame log as a sequence diagram, as data (pure, no DOM): every station is a vertical
 * line, the shared air ("public", the audiomesh centre) sits in the middle, and every frame
 * is a horizontal line from its sender to the air and, when it names a destination, on
 * from the air to that station (dashed). Sounds add a dashed line to each station they report.
 */

import { decodeFrame, type ChatFrame } from './frames';
import { hexPayload, type FrameRecord } from './frame-log';
import { SpriteAssembly, spriteColours, spriteFrameCount } from './sprite';

export type Actor = number | 'public';
/** control = announcements and beacons, message = text and sprites, ack = acknowledgements. */
export type Tone = 'control' | 'message' | 'ack';

export interface SeqLine {
  readonly from: Actor;
  readonly to: Actor;
  readonly label: string;
  /** The line carries on from the air to the destination, or only mentions a station: drawn dashed. */
  readonly dashed: boolean;
}

/** A sprite frame: the picture as far as it had arrived when this frame did. */
export interface SeqSprite {
  readonly side: number;
  /** One CSS colour per pixel, holes filled from the nearest received pixel. */
  readonly colours: readonly (string | null)[];
  /** Frames of the sprite heard up to and including this one, out of `frames`. */
  readonly got: number;
  readonly frames: number;
}

export interface SeqEvent {
  readonly kind: 'event';
  /** The frame log record id. */
  readonly id: number;
  readonly atMs: number;
  readonly dir: 'tx' | 'rx';
  readonly tone: Tone;
  /** One emoji for the kind of frame. */
  readonly icon: string;
  readonly sprite?: SeqSprite;
  readonly lines: readonly SeqLine[];
  /** A copy sent by a repeater. */
  readonly repeated: boolean;
}

/** The chat-app pill between events: the time, with the day when it is not today. */
export interface SeqBubble {
  readonly kind: 'bubble';
  readonly atMs: number;
  readonly text: string;
}

export type SeqItem = SeqEvent | SeqBubble;

export interface Sequence {
  /** Stations in the diagram: ours first, then by id. */
  readonly actors: readonly number[];
  readonly items: readonly SeqItem[];
}

/** A quiet spell longer than this gets a bubble. */
export const BUBBLE_GAP_MS = 15 * 60_000;
export const DEFAULT_EVENT_LIMIT = 80;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today 14:32", "Yesterday 09:10", "2026-09-28 18:00". */
export function bubbleText(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(now.getDate() - 1);
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  if (sameDay(at, now)) return `Today ${time}`;
  if (sameDay(at, yesterday)) return `Yesterday ${time}`;
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${time}`;
}

const quoted = (text: string): string => `"${text.trimEnd()}"`;

function iconOf(f: ChatFrame): string {
  switch (f.kind) {
    case 'hello': return '📣';
    case 'sound': return f.probe ? '🔎' : '📡';
    case 'ack': return '✅';
    case 'spriteHead':
    case 'spriteBody': return '🖼️';
    default: return '💬';
  }
}

function toneOf(f: ChatFrame): Tone {
  switch (f.kind) {
    case 'hello':
    case 'sound':
      return 'control';
    case 'ack':
      return 'ack';
    default:
      return 'message';
  }
}

/** What the first line says. `dst` is 0 (everyone) or a station for the frames that name one. */
function labelOf(f: ChatFrame, dst: number | undefined): string {
  const to = dst === 0 ? ' → all' : '';
  switch (f.kind) {
    case 'hello':
      return `announce ${quoted(f.name)}${f.repeater ? ' · repeater' : ''}`;
    case 'sound':
      return `${f.probe ? 'probe' : 'beacon'}${f.repeater ? ' · repeater' : ''}`;
    case 'first':
      return `${quoted(f.text)} · 1/${f.last + 1}${to}`;
    case 'next':
      return `${quoted(f.text)} · ${f.seq + 1}${to}`;
    case 'spriteHead':
      return `sprite ${f.side}×${f.side} · 1/${spriteFrameCount(f.side, f.bpp)}${to}`;
    case 'spriteBody':
      return `sprite · ${f.seq + 1}/${spriteFrameCount(f.side, f.bpp)}${to}`;
    case 'ack': {
      const got = [...Array(16).keys()].filter((i) => f.received & (1 << i)).map((i) => i + 1);
      return `ack ${got.join(',') || 'none'}`;
    }
  }
}

/**
 * The newest `limit` frames as a sequence. Frames of ours heard back through the speaker
 * are left out (the sent one is there already).
 */
export function buildSequence(
  records: readonly FrameRecord[],
  myId: number,
  nowMs: number,
  limit = DEFAULT_EVENT_LIMIT,
): Sequence {
  // Later frames of a message do not name the destination: remember it from the first.
  const destOf = new Map<string, number>();
  const assemblies = new Map<string, SpriteAssembly>();
  const events: SeqEvent[] = [];
  for (const r of records) {
    const f = decodeFrame(hexPayload(r.hex));
    if (!f) continue;
    if (r.dir === 'rx' && f.src === myId) continue;
    let dst: number | undefined;
    if (f.kind === 'first' || f.kind === 'spriteHead' || f.kind === 'ack') {
      dst = f.dst;
      if (f.kind !== 'ack') destOf.set(`${f.src}:${f.msgId}`, f.dst);
    } else if (f.kind === 'next' || f.kind === 'spriteBody') {
      dst = destOf.get(`${f.src}:${f.msgId}`);
    }
    let sprite: SeqSprite | undefined;
    if (f.kind === 'spriteHead' || f.kind === 'spriteBody') {
      const key = `${f.src}:${f.msgId}`;
      const seq = f.kind === 'spriteHead' ? 0 : f.seq;
      try {
        let a = assemblies.get(key);
        if (!a || !a.matches(f.side, f.bpp) || a.conflicts(seq, f.data)) {
          a = new SpriteAssembly(f.side, f.bpp);
          assemblies.set(key, a);
        }
        a.accept(seq, f.data);
        sprite = { side: a.side, colours: spriteColours(a, 'fill'), got: a.framesGot, frames: a.frames };
      } catch {
        // a shape that cannot exist: no picture, the label still says what it was
      }
    }
    const lines: SeqLine[] = [{ from: f.src, to: 'public', label: labelOf(f, dst), dashed: false }];
    if (dst !== undefined && dst !== 0 && dst !== f.src) lines.push({ from: 'public', to: dst, label: '', dashed: true });
    if (f.kind === 'sound') {
      for (const rep of f.reports) {
        if (rep.station !== f.src) lines.push({ from: f.src, to: rep.station, label: `hears ${rep.snrDb} dB · ch ${rep.channel}`, dashed: true });
      }
    }
    events.push({ kind: 'event', id: r.id, atMs: r.atMs, dir: r.dir, tone: toneOf(f), icon: iconOf(f), ...(sprite ? { sprite } : {}), lines, repeated: !!f.via });
  }
  const shown = events.slice(-limit);

  const actorSet = new Set<number>();
  for (const e of shown) for (const l of e.lines) for (const a of [l.from, l.to]) if (a !== 'public') actorSet.add(a);
  const actors = [...actorSet].sort((a, b) => Number(b === myId) - Number(a === myId) || a - b);

  const items: SeqItem[] = [];
  let prev: SeqEvent | undefined;
  for (const e of shown) {
    if (!prev || e.atMs - prev.atMs > BUBBLE_GAP_MS || !sameDay(new Date(prev.atMs), new Date(e.atMs))) {
      items.push({ kind: 'bubble', atMs: e.atMs, text: bubbleText(e.atMs, nowMs) });
    }
    items.push(e);
    prev = e;
  }
  return { actors, items };
}
