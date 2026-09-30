/**
 * Chat frames: what goes into the 77 payload bits of one codec frame.
 *
 * Every frame starts with a 2-bit kind and the 10-bit id of the sending station
 * (1..1023; 0 is reserved for "everyone"). Bits are MSB first.
 *
 *   first  kind 0 | src 10 | msgId 4 | last 4 | dst 10 | 7 chars x 6 bit   (5 bits spare)
 *   next   kind 1 | src 10 | msgId 4 | seq 4  |           9 chars x 6 bit   (3 bits spare)
 *   ack    kind 2 | src 10 | dst 10   | msgId 4 | received 16 (bit i = frame i heard)
 *                 | heardChannel 5 | heardSnr 6     (how the acked station was last heard)
 *   ctrl   kind 3 | src 10 | subtype 3 | subtype body
 *            subtype 0 = hello: 8 chars x 6 bit nickname
 *            subtype 1 = sound: 2 x (station 10 | channel 5 | snr 6), station 0 = unused
 *
 * Tail, the same in every kind (the last bits, spare everywhere; zeros in old frames):
 *   bit 73      hello and sound only: the sender is a repeater
 *   bits 74..76 via: 0 = sent by `src` itself; 1..7 = repeated by a repeater with that
 *               tag (repeaterTag). `next` ends at bit 73, so 3 bits is all there is.
 *
 * SNR fields are whole dB offset by 30 (code 0..63 = -30..+33 dB), clamped. Channel 0
 * means "unknown". The link-quality reports let a sender learn which channel the
 * far end hears it best on (see src/ale/lqa.ts).
 *
 * `last` is the index of the last frame, so a message is 1..16 frames and at most
 * MAX_TEXT_CHARS characters. Only the first frame names the destination: that keeps
 * 9 characters in every later frame instead of 7, at the price that a message whose
 * first frame was lost cannot be delivered or acknowledged until it is heard again.
 *
 * The kind bits are never all zero together with a non-zero src, so a chat frame is
 * never the all-zero payload the codec refuses.
 */

import { PAYLOAD_BITS } from '../protocol/gfsk8/codec';
import type { LinkReport } from '../ale/lqa';
import { CHAR_BITS, charToCode, codeToChar } from './charset6';

export const STATION_BITS = 10;
export const BROADCAST = 0;
export const MAX_STATION_ID = (1 << STATION_BITS) - 1;
export const MSG_ID_COUNT = 16;
export const MAX_FRAMES = 16;
export const NAME_CHARS = 8;

export const FIRST_CHARS = 7;
export const NEXT_CHARS = 9;
export const MAX_TEXT_CHARS = FIRST_CHARS + (MAX_FRAMES - 1) * NEXT_CHARS;

/** `via` is the repeater tag (0 or absent = heard from `src` itself); `repeater` = the sender runs a repeater. */
export type ChatFrame =
  | { kind: 'first'; src: number; msgId: number; last: number; dst: number; text: string; via?: number }
  | { kind: 'next'; src: number; msgId: number; seq: number; text: string; via?: number }
  | { kind: 'ack'; src: number; dst: number; msgId: number; received: number; heardChannel: number; heardSnrDb: number; via?: number }
  | { kind: 'hello'; src: number; name: string; repeater?: boolean; via?: number }
  | { kind: 'sound'; src: number; reports: readonly LinkReport[]; repeater?: boolean; via?: number };

const VIA_BITS = 3;
const VIA_POS = PAYLOAD_BITS - VIA_BITS;
const REPEATER_FLAG_POS = VIA_POS - 1;
/** Tags 1..MAX_VIA_TAG; 0 means "not repeated". */
export const MAX_VIA_TAG = (1 << VIA_BITS) - 1;

/** The tag a repeater marks its repeats with. Not unique: resolved against the repeaters known. */
export const repeaterTag = (stationId: number): number => (stationId % MAX_VIA_TAG) + 1;

/** The via tag of a payload (0 = direct). */
export function viaOf(bits: Uint8Array): number {
  let v = 0;
  for (let i = VIA_POS; i < PAYLOAD_BITS; i++) v = (v << 1) | (bits[i] ? 1 : 0);
  return v;
}

/** A copy of the payload with the via tag set: what a repeater sends. */
export function withVia(bits: Uint8Array, tag: number): Uint8Array {
  checkId(tag, MAX_VIA_TAG, 'via');
  const out = bits.slice();
  for (let i = 0; i < VIA_BITS; i++) out[VIA_POS + i] = (tag >> (VIA_BITS - 1 - i)) & 1;
  return out;
}

/** The payload without its via tag, as text: the same frame, however it reached us. */
export function frameKey(bits: Uint8Array): string {
  let s = '';
  for (let i = 0; i < VIA_POS; i++) s += bits[i] ? '1' : '0';
  return s;
}

const KIND = { first: 0, next: 1, ack: 2, ctrl: 3 } as const;
const CTRL_HELLO = 0;
const CTRL_SOUND = 1;

export const SOUND_REPORTS = 2;
const CHANNEL_BITS = 5;
const SNR_BITS = 6;
const SNR_OFFSET_DB = 30;
const SNR_MAX_CODE = (1 << SNR_BITS) - 1;

export const snrToCode = (snrDb: number): number =>
  Math.min(SNR_MAX_CODE, Math.max(0, Math.round(snrDb) + SNR_OFFSET_DB));
export const codeToSnr = (code: number): number => code - SNR_OFFSET_DB;

class BitWriter {
  readonly bits = new Uint8Array(PAYLOAD_BITS);
  private pos = 0;

  put(value: number, width: number): void {
    if (this.pos + width > PAYLOAD_BITS) throw new Error('chat frame does not fit the payload');
    for (let b = width - 1; b >= 0; b--) this.bits[this.pos++] = (value >> b) & 1;
  }

  putText(text: string, chars: number): void {
    for (let i = 0; i < chars; i++) this.put(charToCode(i < text.length ? text[i]! : ' '), CHAR_BITS);
  }
}

class BitReader {
  private pos = 0;
  constructor(private readonly bits: Uint8Array) {}

  get(width: number): number {
    let v = 0;
    for (let b = 0; b < width; b++) v = (v << 1) | this.bits[this.pos++]!;
    return v;
  }

  getText(chars: number): string {
    let s = '';
    for (let i = 0; i < chars; i++) s += codeToChar(this.get(CHAR_BITS));
    return s;
  }
}

function checkId(value: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${what} out of range: ${value}`);
}

/** Frame -> 77 bits. Text is padded with spaces (the pad) to the frame's capacity. */
export function encodeFrame(frame: ChatFrame): Uint8Array {
  const w = new BitWriter();
  checkId(frame.src, MAX_STATION_ID, 'src');
  if (frame.src === 0) throw new Error('src 0 is reserved');
  switch (frame.kind) {
    case 'first':
      checkId(frame.msgId, MSG_ID_COUNT - 1, 'msgId');
      checkId(frame.last, MAX_FRAMES - 1, 'last');
      checkId(frame.dst, MAX_STATION_ID, 'dst');
      w.put(KIND.first, 2);
      w.put(frame.src, STATION_BITS);
      w.put(frame.msgId, 4);
      w.put(frame.last, 4);
      w.put(frame.dst, STATION_BITS);
      w.putText(frame.text, FIRST_CHARS);
      break;
    case 'next':
      checkId(frame.msgId, MSG_ID_COUNT - 1, 'msgId');
      checkId(frame.seq, MAX_FRAMES - 1, 'seq');
      w.put(KIND.next, 2);
      w.put(frame.src, STATION_BITS);
      w.put(frame.msgId, 4);
      w.put(frame.seq, 4);
      w.putText(frame.text, NEXT_CHARS);
      break;
    case 'ack':
      checkId(frame.msgId, MSG_ID_COUNT - 1, 'msgId');
      checkId(frame.dst, MAX_STATION_ID, 'dst');
      checkId(frame.received, 0xffff, 'received');
      if (frame.dst === 0) throw new Error('an ack needs a destination');
      w.put(KIND.ack, 2);
      w.put(frame.src, STATION_BITS);
      w.put(frame.dst, STATION_BITS);
      w.put(frame.msgId, 4);
      w.put(frame.received, 16);
      checkId(frame.heardChannel, (1 << CHANNEL_BITS) - 1, 'heardChannel');
      w.put(frame.heardChannel, CHANNEL_BITS);
      w.put(snrToCode(frame.heardSnrDb), SNR_BITS);
      break;
    case 'hello':
      w.put(KIND.ctrl, 2);
      w.put(frame.src, STATION_BITS);
      w.put(CTRL_HELLO, 3);
      w.putText(frame.name, NAME_CHARS);
      if (frame.repeater) w.bits[REPEATER_FLAG_POS] = 1;
      break;
    case 'sound':
      if (frame.reports.length > SOUND_REPORTS) throw new Error(`a sound carries at most ${SOUND_REPORTS} reports`);
      w.put(KIND.ctrl, 2);
      w.put(frame.src, STATION_BITS);
      w.put(CTRL_SOUND, 3);
      for (let i = 0; i < SOUND_REPORTS; i++) {
        const r = frame.reports[i];
        if (r) {
          checkId(r.station, MAX_STATION_ID, 'report station');
          checkId(r.channel, (1 << CHANNEL_BITS) - 1, 'report channel');
        }
        w.put(r?.station ?? 0, STATION_BITS);
        w.put(r?.channel ?? 0, CHANNEL_BITS);
        w.put(r ? snrToCode(r.snrDb) : 0, SNR_BITS);
      }
      if (frame.repeater) w.bits[REPEATER_FLAG_POS] = 1;
      break;
  }
  return frame.via ? withVia(w.bits, frame.via) : w.bits;
}

/** 77 bits -> frame; null for anything this layer does not understand (never throws). */
export function decodeFrame(bits: Uint8Array): ChatFrame | null {
  if (bits.length !== PAYLOAD_BITS) return null;
  const r = new BitReader(bits);
  const kind = r.get(2);
  const src = r.get(STATION_BITS);
  if (src === 0) return null;
  const frame = decodeBody(r, kind, src);
  if (!frame) return null;
  const via = viaOf(bits);
  if (via) frame.via = via;
  if ((frame.kind === 'hello' || frame.kind === 'sound') && bits[REPEATER_FLAG_POS]) frame.repeater = true;
  return frame;
}

function decodeBody(r: BitReader, kind: number, src: number): ChatFrame | null {
  switch (kind) {
    case KIND.first: {
      const msgId = r.get(4);
      const last = r.get(4);
      const dst = r.get(STATION_BITS);
      return { kind: 'first', src, msgId, last, dst, text: r.getText(FIRST_CHARS) };
    }
    case KIND.next: {
      const msgId = r.get(4);
      const seq = r.get(4);
      return { kind: 'next', src, msgId, seq, text: r.getText(NEXT_CHARS) };
    }
    case KIND.ack: {
      const dst = r.get(STATION_BITS);
      if (dst === 0) return null;
      const msgId = r.get(4);
      const received = r.get(16);
      const heardChannel = r.get(CHANNEL_BITS);
      return { kind: 'ack', src, dst, msgId, received, heardChannel, heardSnrDb: codeToSnr(r.get(SNR_BITS)) };
    }
    default: {
      const subtype = r.get(3);
      if (subtype === CTRL_HELLO) return { kind: 'hello', src, name: r.getText(NAME_CHARS).trimEnd() };
      if (subtype === CTRL_SOUND) {
        const reports: LinkReport[] = [];
        for (let i = 0; i < SOUND_REPORTS; i++) {
          const station = r.get(STATION_BITS);
          const channel = r.get(CHANNEL_BITS);
          const snrDb = codeToSnr(r.get(SNR_BITS));
          if (station !== 0) reports.push({ station, channel, snrDb });
        }
        return { kind: 'sound', src, reports };
      }
      return null;
    }
  }
}

/**
 * Text -> one chunk per frame, each padded to its frame's capacity so the last
 * frame's padding is the only padding. Throws on empty or over-long text.
 */
export function splitText(text: string): string[] {
  if (text.length === 0) throw new Error('message is empty');
  if (text.length > MAX_TEXT_CHARS) throw new Error(`message is over ${MAX_TEXT_CHARS} characters`);
  const chunks = [text.slice(0, FIRST_CHARS).padEnd(FIRST_CHARS, ' ')];
  for (let i = FIRST_CHARS; i < text.length; i += NEXT_CHARS) {
    chunks.push(text.slice(i, i + NEXT_CHARS).padEnd(NEXT_CHARS, ' '));
  }
  return chunks;
}

/** Number of frames a text of this length takes. */
export function frameCount(chars: number): number {
  return chars <= FIRST_CHARS ? 1 : 1 + Math.ceil((chars - FIRST_CHARS) / NEXT_CHARS);
}

/** A random station id in 1..MAX_STATION_ID. Collisions are possible and merely confusing. */
export function randomStationId(random: () => number = Math.random): number {
  return 1 + Math.floor(random() * MAX_STATION_ID);
}
