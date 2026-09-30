/**
 * Repeater mode, one hop: repeat every frame heard from other stations, marked with
 * our via tag so nobody repeats it again and receivers do not mistake our signal for
 * the sender's. Pure: no audio, no clock; time is the UTC slot index.
 *
 * What is repeated: first, next, sprite head/body, ack and hello frames heard direct (via 0) from other
 * stations. Never sounds (a sound measures one link; a repeated copy would mislead),
 * never frames addressed to us (we are their destination), never our own.
 *
 * Timing: a frame heard in slot s is decoded during s+1, so the earliest repeat is s+2.
 * Senders pace their frames 3 slots apart while a repeater is known (s, s+3, ...), so a
 * repeat may go out 2 or 4 slots after it was heard, never 3 (the sender's next frame,
 * which we would miss while transmitting). Anything older is dropped.
 */

import { BROADCAST, decodeFrame, frameKey, repeaterTag, withVia } from './frames';

/** Slots after hearing a frame in which its repeat may go out. */
const REPEAT_AGES = [2, 4];
const MAX_AGE = Math.max(...REPEAT_AGES);
/** The same frame heard again within this many slots is not repeated again (sender retransmits come later). */
const DEDUP_SLOTS = 5;
const MAX_QUEUE = 16;
/** How long a message's destination is remembered, to recognise its `next` frames. */
const MSG_MEMORY_SLOTS = 120;

interface Pending {
  payload: Uint8Array;
  dst: number;
  heardSlot: number;
}

export class Repeater {
  readonly tag: number;
  /** Frames repeated since the page loaded. */
  repeated = 0;
  private readonly queue: Pending[] = [];
  private readonly recent = new Map<string, number>();
  /** `src:msgId` -> destination and when its first frame was heard, so `next` frames to us are not repeated. */
  private readonly messageDst = new Map<string, { dst: number; slot: number }>();

  constructor(readonly stationId: number) {
    this.tag = repeaterTag(stationId);
  }

  /** A payload decoded from the audio of `slot`. Queues a repeat when it qualifies. */
  offer(payload: Uint8Array, slot: number): void {
    const f = decodeFrame(payload);
    if (!f || f.via || f.src === this.stationId || f.kind === 'sound') return;
    let dst = BROADCAST;
    if (f.kind === 'first' || f.kind === 'spriteHead') {
      this.messageDst.set(`${f.src}:${f.msgId}`, { dst: f.dst, slot });
      dst = f.dst;
    } else if (f.kind === 'next' || f.kind === 'spriteBody') {
      dst = this.messageDst.get(`${f.src}:${f.msgId}`)?.dst ?? BROADCAST;
    } else if (f.kind === 'ack') dst = f.dst;
    if (dst === this.stationId) return;
    const key = frameKey(payload);
    const seen = this.recent.get(key);
    if (seen !== undefined && slot - seen < DEDUP_SLOTS) return;
    this.recent.set(key, slot);
    this.queue.push({ payload: withVia(payload, this.tag), dst, heardSlot: slot });
    while (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  /** Repeats waiting (some may still be too early, or be dropped as too late). */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * The repeat to transmit in `slot`, oldest first, or null. The caller must transmit
   * what it gets. `dst` is the frame's destination (BROADCAST when unknown), for choosing a channel.
   */
  next(slot: number): { payload: Uint8Array; dst: number } | null {
    this.forget(slot);
    const i = this.queue.findIndex((p) => REPEAT_AGES.includes(slot - p.heardSlot));
    if (i < 0) return null;
    const [p] = this.queue.splice(i, 1);
    this.repeated++;
    return { payload: p!.payload, dst: p!.dst };
  }

  private forget(slot: number): void {
    for (let i = this.queue.length - 1; i >= 0; i--) if (slot - this.queue[i]!.heardSlot > MAX_AGE) this.queue.splice(i, 1);
    for (const [k, at] of this.recent) if (slot - at >= DEDUP_SLOTS) this.recent.delete(k);
    for (const [k, m] of this.messageDst) if (slot - m.slot > MSG_MEMORY_SLOTS) this.messageDst.delete(k);
  }
}
