/** One-line, human readable form of a chat frame, for the debug log. Pure. */

import { decodeFrame, type ChatFrame } from './frames';
import { spriteFrameCount } from './sprite';

/** " · repeater" for a station that says it repeats, " · repeated (tag n)" for a copy sent by a repeater. */
function relayNote(f: ChatFrame): string {
  const flag = (f.kind === 'hello' || f.kind === 'sound') && f.repeater ? ' · repeater' : '';
  return flag + (f.via ? ` · repeated (tag ${f.via})` : '');
}

/** `label` turns a station id into a name; the text of frames is untrusted, so callers show it via textContent. */
export function describeFrame(payload: Uint8Array, label: (id: number) => string = (id) => `#${id}`): string {
  const f = decodeFrame(payload);
  if (!f) return 'not a chat frame';
  return describeBody(f, label) + relayNote(f);
}

function describeBody(f: ChatFrame, label: (id: number) => string): string {
  const who = label(f.src);
  switch (f.kind) {
    case 'first':
      return `${who} → ${f.dst === 0 ? 'everyone' : label(f.dst)} · msg ${f.msgId} frame 1/${f.last + 1} · "${f.text.trimEnd()}"`;
    case 'next':
      return `${who} · msg ${f.msgId} frame ${f.seq + 1} · "${f.text.trimEnd()}"`;
    case 'ack': {
      const got = [...Array(16).keys()].filter((i) => f.received & (1 << i)).map((i) => i + 1);
      const heard = f.heardChannel > 0 ? ` · heard you on ch ${f.heardChannel} at ${f.heardSnrDb} dB` : '';
      return `${who} → ${label(f.dst)} · ack msg ${f.msgId}, frames ${got.join(',') || 'none'}${heard}`;
    }
    case 'hello':
      return `${who} · hello, name "${f.name}"`;
    case 'spriteHead':
      return `${who} → ${f.dst === 0 ? 'everyone' : label(f.dst)} · msg ${f.msgId} sprite ${f.side}×${f.side}, ${1 << f.bpp} colours · frame 1/${spriteFrameCount(f.side, f.bpp)}`;
    case 'spriteBody':
      return `${who} · msg ${f.msgId} sprite ${f.side}×${f.side} · frame ${f.seq + 1}/${spriteFrameCount(f.side, f.bpp)}`;
    case 'sound':
      return `${who} · sound${f.reports.map((r) => ` · hears ${label(r.station)} on ch ${r.channel} at ${r.snrDb} dB`).join('')}`;
  }
}

export type FrameType = 'first' | 'next' | 'spriteHead' | 'spriteBody' | 'ack' | 'hello' | 'sound' | 'invalid';

/** A frame split into table columns. `dst` is 0 for everyone, undefined when the frame names nobody. */
export interface FrameFields {
  readonly type: FrameType;
  readonly src?: number;
  readonly dst?: number;
  readonly msgId?: number;
  /** Text, nickname, ack bitmap or link reports, without the sender and destination. */
  readonly detail: string;
  /** Repeater tag when a repeater sent this copy. */
  readonly via?: number;
}

export function frameFields(payload: Uint8Array, label: (id: number) => string = (id) => `#${id}`): FrameFields {
  const f = decodeFrame(payload);
  if (!f) return { type: 'invalid', detail: 'not a chat frame' };
  const body = fieldsBody(f, label);
  return { ...body, detail: body.detail + relayNote(f), ...(f.via ? { via: f.via } : {}) };
}

function fieldsBody(f: ChatFrame, label: (id: number) => string): FrameFields {
  switch (f.kind) {
    case 'first':
      return { type: 'first', src: f.src, dst: f.dst, msgId: f.msgId, detail: `frame 1/${f.last + 1} "${f.text.trimEnd()}"` };
    case 'next':
      return { type: 'next', src: f.src, msgId: f.msgId, detail: `frame ${f.seq + 1} "${f.text.trimEnd()}"` };
    case 'ack': {
      const got = [...Array(16).keys()].filter((i) => f.received & (1 << i)).map((i) => i + 1);
      const heard = f.heardChannel > 0 ? ` · heard you on ch ${f.heardChannel} at ${f.heardSnrDb} dB` : '';
      return { type: 'ack', src: f.src, dst: f.dst, msgId: f.msgId, detail: `frames ${got.join(',') || 'none'}${heard}` };
    }
    case 'hello':
      return { type: 'hello', src: f.src, detail: `name "${f.name}"` };
    case 'spriteHead':
      return { type: 'spriteHead', src: f.src, dst: f.dst, msgId: f.msgId, detail: `sprite ${f.side}×${f.side}, ${1 << f.bpp} colours, frame 1/${spriteFrameCount(f.side, f.bpp)}` };
    case 'spriteBody':
      return { type: 'spriteBody', src: f.src, msgId: f.msgId, detail: `sprite ${f.side}×${f.side}, frame ${f.seq + 1}/${spriteFrameCount(f.side, f.bpp)}` };
    case 'sound':
      return { type: 'sound', src: f.src, detail: f.reports.map((r) => `hears ${label(r.station)} on ch ${r.channel} at ${r.snrDb} dB`).join(' · ') || 'no reports' };
  }
}
