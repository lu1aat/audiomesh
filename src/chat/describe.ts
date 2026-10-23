/** One-line, human readable form of a chat frame, for the debug log. Pure. */

import { decodeFrame, type ChatFrame } from './frames';
import { spriteFrameCount } from './sprite';
import { t } from '../i18n/i18n';

/** " · repeater" for a station that says it repeats, " · repeated (tag n)" for a copy sent by a repeater. */
function relayNote(f: ChatFrame): string {
  const flag = (f.kind === 'hello' || f.kind === 'sound') && f.repeater ? ` · ${t('repeater')}` : '';
  return flag + (f.via ? ` · ${t('repeated (tag {tag})', { tag: f.via })}` : '');
}

const heardYou = (ch: number, db: number): string => t('heard you on ch {ch} at {db} dB', { ch, db });
const hears = (who: string, ch: number, db: number): string => t('hears {who} on ch {ch} at {db} dB', { who, ch, db });

/** `label` turns a station id into a name; the text of frames is untrusted, so callers show it via textContent. */
export function describeFrame(payload: Uint8Array, label: (id: number) => string = (id) => `#${id}`): string {
  const f = decodeFrame(payload);
  if (!f) return t('not a chat frame');
  return describeBody(f, label) + relayNote(f);
}

function describeBody(f: ChatFrame, label: (id: number) => string): string {
  const who = label(f.src);
  switch (f.kind) {
    case 'first':
      return `${who} → ${f.dst === 0 ? t('everyone') : label(f.dst)} · ${t('msg {id} frame {n}', { id: f.msgId, n: `1/${f.last + 1}` })} · "${f.text.trimEnd()}"`;
    case 'next':
      return `${who} · ${t('msg {id} frame {n}', { id: f.msgId, n: f.seq + 1 })} · "${f.text.trimEnd()}"`;
    case 'ack': {
      const got = [...Array(16).keys()].filter((i) => f.received & (1 << i)).map((i) => i + 1);
      const heard = f.heardChannel > 0 ? ` · ${heardYou(f.heardChannel, f.heardSnrDb)}` : '';
      return `${who} → ${label(f.dst)} · ${t('ack msg {id}, frames {list}', { id: f.msgId, list: got.join(',') || t('none') })}${heard}`;
    }
    case 'hello':
      return `${who} · ${t('hello, name "{name}"', { name: f.name })}`;
    case 'spriteHead':
      return `${who} → ${f.dst === 0 ? t('everyone') : label(f.dst)} · ${t('msg {id} sprite {side}×{side}, {colours} colours', { id: f.msgId, side: f.side, colours: 1 << f.bpp })} · ${t('frame {n}', { n: `1/${spriteFrameCount(f.side, f.bpp)}` })}`;
    case 'spriteBody':
      return `${who} · ${t('msg {id} sprite {side}×{side}', { id: f.msgId, side: f.side })} · ${t('frame {n}', { n: `${f.seq + 1}/${spriteFrameCount(f.side, f.bpp)}` })}`;
    case 'sound':
      return `${who} · ${t('sound')}${f.reports.map((r) => ` · ${hears(label(r.station), r.channel, r.snrDb)}`).join('')}`;
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
  if (!f) return { type: 'invalid', detail: t('not a chat frame') };
  const body = fieldsBody(f, label);
  return { ...body, detail: body.detail + relayNote(f), ...(f.via ? { via: f.via } : {}) };
}

function fieldsBody(f: ChatFrame, label: (id: number) => string): FrameFields {
  switch (f.kind) {
    case 'first':
      return { type: 'first', src: f.src, dst: f.dst, msgId: f.msgId, detail: `${t('frame {n}', { n: `1/${f.last + 1}` })} "${f.text.trimEnd()}"` };
    case 'next':
      return { type: 'next', src: f.src, msgId: f.msgId, detail: `${t('frame {n}', { n: f.seq + 1 })} "${f.text.trimEnd()}"` };
    case 'ack': {
      const got = [...Array(16).keys()].filter((i) => f.received & (1 << i)).map((i) => i + 1);
      const heard = f.heardChannel > 0 ? ` · ${heardYou(f.heardChannel, f.heardSnrDb)}` : '';
      return { type: 'ack', src: f.src, dst: f.dst, msgId: f.msgId, detail: t('frames {list}', { list: got.join(',') || t('none') }) + heard };
    }
    case 'hello':
      return { type: 'hello', src: f.src, detail: t('name "{name}"', { name: f.name }) };
    case 'spriteHead':
      return { type: 'spriteHead', src: f.src, dst: f.dst, msgId: f.msgId, detail: `${t('sprite {side}×{side}, {colours} colours', { side: f.side, colours: 1 << f.bpp })}, ${t('frame {n}', { n: `1/${spriteFrameCount(f.side, f.bpp)}` })}` };
    case 'spriteBody':
      return { type: 'spriteBody', src: f.src, msgId: f.msgId, detail: `${t('sprite {side}×{side}', { side: f.side })}, ${t('frame {n}', { n: `${f.seq + 1}/${spriteFrameCount(f.side, f.bpp)}` })}` };
    case 'sound':
      return { type: 'sound', src: f.src, detail: f.reports.map((r) => hears(label(r.station), r.channel, r.snrDb)).join(' · ') || t('no reports') };
  }
}
