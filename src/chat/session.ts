/**
 * One station's chat state: splits outgoing messages into frames, reassembles
 * incoming ones, and runs the best-effort ack / selective-retransmit exchange.
 * Pure state machine: no audio, no DOM, no clock. Time is the UTC slot index the
 * caller passes in, so tests can run hours of chat instantly.
 *
 * Half duplex, one frame per slot. What the caller does each slot:
 *   receive(payload, slot, snrDb, channel)  for every frame decoded from that slot's audio
 *   nextTx(slot)            when the transmitter is free: the payload to send in
 *                           `slot`, or null. Asking commits to sending it.
 *
 * Sender: FIRST frame then the rest, one per slot. A directed message then waits
 * (stop and wait: nothing else is sent, since a transmitting station is deaf) for an ack (bitmap of frames heard). A complete bitmap means delivered; a partial
 * one triggers a retransmit round of just the missing frames; silence for
 * ackTimeoutSlots triggers a round of everything not yet acknowledged. After
 * maxRounds rounds it is marked failed. Broadcasts are never acked and end at 'sent'.
 *
 * Receiver: a directed message is acked once it is complete, or, if it stalls
 * incomplete, with the partial bitmap after partialAckSlots quiet slots (a nack). The
 * frame with the highest index ends a round, so it is answered at once. A complete ack
 * goes out a second time ackRepeatGapSlots later (a lost ack otherwise costs a whole
 * resend round), unless the sender is heard again first; the sender listens that much
 * longer (ackTimeoutSlots) and, once delivered, keeps its next frames off the repeat's slot.
 * A duplicate of a message already delivered is acked again and not shown twice.
 * Incomplete messages are discarded after reassemblySlots.
 *
 * Repeaters (one hop, see repeater.ts): with repeater mode on, frames heard from others
 * are repeated, tagged with our via tag, ahead of our own new frames. While any repeater
 * is known (heard within repeaterMemorySlots, or we are one), our own frames are paced
 * paceGapSlots apart so a repeater, deaf while it repeats, hears every frame; acks wait
 * paceGapSlots longer, and both ack timers grow by twice that. A repeated frame feeds link
 * quality as the repeater's signal, never the sender's, and a frame heard again within
 * DEDUP_SLOTS (direct and repeated) is handled once.
 */

import type { LqaTable } from '../ale/lqa';
import { normalizeText } from './charset6';
import { Repeater } from './repeater';
import {
  BROADCAST,
  MAX_FRAMES,
  MAX_TEXT_CHARS,
  MSG_ID_COUNT,
  SOUND_REPORTS,
  decodeFrame,
  encodeFrame,
  frameKey,
  repeaterTag,
  splitText,
  type ChatFrame,
} from './frames';

export type OutState =
  /** Not started: waiting for the transmitter or an earlier message. */
  | 'queued'
  /** Frames are going out (this may be a retransmit round). */
  | 'sending'
  /** Every frame has been sent; waiting for the ack. */
  | 'waiting'
  /** Broadcast: all frames sent, and there is nobody to ack. */
  | 'sent'
  /** Directed: the ack lists every frame. */
  | 'delivered'
  /** Directed: out of rounds without a complete ack. */
  | 'failed';

export interface OutMessage {
  /** Local, ever-increasing; for the UI. Not on the air. */
  readonly localId: number;
  readonly dst: number;
  /** As it will arrive: upper case, characters outside the code replaced. */
  readonly text: string;
  readonly frames: number;
  state: OutState;
  /** Frames the receiver has confirmed. */
  ackedFrames: number;
  /** Frame transmissions so far, retransmits included. */
  framesSent: number;
  /** 1 for the first pass, then one more per retransmit round. */
  round: number;
  /** Slot of the latest transmission, or null. */
  lastTxSlot: number | null;
  /** Frames heard back from a repeater: it has them. */
  echoedFrames: number;
  /** The repeater that echoed them, when known. */
  echoedBy: number | null;
}

/** How a frame reached us through a repeater: its tag, and the station when exactly one known repeater has that tag. */
export interface Via {
  readonly tag: number;
  readonly repeater: number | null;
}

export interface InMessage {
  readonly src: number;
  /** The sender's 4-bit message id: what an ack names. */
  readonly msgId: number;
  /** BROADCAST or this station. */
  readonly dst: number;
  readonly text: string;
  readonly frames: number;
  /** Slot the last missing frame arrived in. */
  readonly slot: number;
  /** Weakest frame, for the UI. */
  readonly snrDb: number;
  /** Channel number the last frame arrived on (0 when the caller does not say). */
  readonly channel: number;
  /** The last frame came through a repeater; null when heard from the sender itself. */
  readonly via: Via | null;
}

export interface SessionOptions {
  stationId: number;
  /** Slots from a message's last frame until the sender resends. Default 5 + ackRepeatGapSlots. */
  ackTimeoutSlots?: number;
  /** A complete ack is sent again this many slots after the first (plus the pacing gap); 0 = once. Default 2. */
  ackRepeatGapSlots?: number;
  partialAckSlots?: number;
  maxRounds?: number;
  reassemblySlots?: number;
  /** A repeater heard (hello or sound flag, or its repeats) within this many slots counts as present. Default 120. */
  repeaterMemorySlots?: number;
  /** Idle slots between our own frames while a repeater is present. Default 2. */
  paceGapSlots?: number;
  /**
   * Announcements and sounds (beacons) wait until at least this many slots have passed
   * since our last transmission of any kind: 2 = one quiet slot in between, so a beacon
   * never follows another frame of ours back to back and clogs the channel. Default 2.
   */
  beaconGapSlots?: number;
  /** Link quality table to feed and to take report values from; without it no reports are sent or kept. */
  lqa?: LqaTable;
}

export interface SessionEvents {
  incoming?: (message: InMessage) => void;
  /** Called whenever an outgoing message changes state or progress. */
  outgoing?: (message: OutMessage) => void;
  /** A hello arrived: a station told us its nickname. */
  station?: (id: number, name: string) => void;
}

interface OutInternal extends OutMessage {
  msgId: number;
  chunks: string[];
  ackedMask: number;
  echoMask: number;
  /** Frame indices still to send in the current round, in order. */
  pending: number[];
  waitUntilSlot: number;
}

interface InInternal {
  src: number;
  msgId: number;
  /** null until the first frame is heard. */
  dst: number | null;
  frames: number | null;
  parts: (string | undefined)[];
  mask: number;
  lastHeardSlot: number;
  /** Slot from which an ack may go out; null when none is due. */
  ackDueSlot: number | null;
  /** Slot from which the complete ack goes out a second time; null when none is due. */
  ackRepeatSlot: number | null;
  delivered: boolean;
  minSnrDb: number;
  /** Channel number the latest frame was heard on. */
  channel: number;
  via: Via | null;
}

/** The same frame heard again within this many slots (direct and repeated) is handled once. */
const DEDUP_SLOTS = 5;

const bit = (i: number): number => 1 << i;

/** What the session has lined up, for the "next action" line. Read-only: asking changes nothing. */
/** The newest frame from a station that reached us through a repeater. */
export interface RelayedFrom {
  readonly slot: number;
  /** The repeater, or null when its tag matches no single known repeater. */
  readonly via: number | null;
  readonly tag: number;
}

export interface SessionOutlook {
  /** An ack we owe, and from which slot it may go. */
  readonly ackDue: { readonly to: number; readonly fromSlot: number } | null;
  /** Frames from others waiting to be repeated. */
  readonly repeats: number;
  readonly hello: boolean;
  readonly sound: boolean;
  /** The message being sent: its destination and how many of its frames are still to go. */
  readonly sending: { readonly dst: number; readonly left: number; readonly total: number } | null;
  /** A sent message waiting for its ack (stop and wait: nothing new goes out meanwhile). */
  readonly waitingAck: { readonly dst: number; readonly untilSlot: number } | null;
  /** Further messages queued behind. */
  readonly queued: number;
  /** Earliest slot a pending announcement or sound may go (one quiet slot after our last frame); null = no limit. */
  readonly beaconFromSlot: number | null;
}

export class ChatSession {
  readonly stationId: number;
  events: SessionEvents = {};
  private readonly ackTimeoutSlots: number;
  private readonly ackRepeatGapSlots: number;
  /** Our own frames and beacons wait through this slot: a receiver's second ack goes there. */
  private holdOwnUntilSlot: number | null = null;
  private readonly partialAckSlots: number;
  /** Transmission rounds before a directed message fails (the first pass counts as one). */
  readonly maxRounds: number;
  private readonly reassemblySlots: number;
  private readonly out: OutInternal[] = [];
  private readonly incoming = new Map<string, InInternal>();
  /** Acks asked for by hand (a received message's "Resend ACK"): every frame confirmed. */
  private readonly manualAcks: { src: number; msgId: number; frames: number }[] = [];
  private readonly stationNames = new Map<number, string>();
  private nextLocalId = 1;
  private nextMsgId = 0;
  private nickname: string | null = null;
  private helloPending = false;
  private soundPending = false;
  private readonly lqa: LqaTable | null;
  private readonly repeaterMemorySlots: number;
  private readonly paceGapSlots: number;
  private repeater: Repeater | null = null;
  /** Repeaters we know of: station id -> last slot it showed it is one. */
  private readonly repeaterSeen = new Map<number, number>();
  /** Frames received through each repeater. */
  private readonly viaCount = new Map<number, number>();
  /** `src>repeater` -> last slot a frame from src reached us through that repeater. */
  private readonly relayPath = new Map<string, number>();
  /** Stations heard through a repeater: src -> last slot, the repeater (null when its tag is not resolved) and the tag. */
  private readonly relayedFrom = new Map<number, RelayedFrom>();
  /** frameKey -> slot it was first heard, for DEDUP_SLOTS. */
  private readonly recentFrames = new Map<string, number>();
  /** Slot of our latest own frame (not acks, not repeats), for pacing. */
  private lastOwnTxSlot: number | null = null;
  /** Slot of our latest transmission of any kind (acks and repeats included), for beaconGapSlots. */
  private lastAnyTxSlot: number | null = null;
  private readonly beaconGapSlots: number;

  constructor(options: SessionOptions) {
    this.stationId = options.stationId;
    // The earliest an ack can come back: the receiver hears the last frame in slot
    // s, decodes early in slot s+1, and transmits in s+2. Its slot is decoded in s+3.
    this.lqa = options.lqa ?? null;
    this.ackRepeatGapSlots = options.ackRepeatGapSlots ?? 2;
    this.ackTimeoutSlots = options.ackTimeoutSlots ?? 5 + this.ackRepeatGapSlots;
    this.partialAckSlots = options.partialAckSlots ?? 3;
    this.maxRounds = options.maxRounds ?? 4;
    this.reassemblySlots = options.reassemblySlots ?? 60;
    this.repeaterMemorySlots = options.repeaterMemorySlots ?? 120;
    this.paceGapSlots = options.paceGapSlots ?? 2;
    this.beaconGapSlots = options.beaconGapSlots ?? 2;
  }

  // --- repeaters ---------------------------------------------------------------

  /** Repeater mode on or off. Turning it on queues a sound, which tells others we repeat. */
  setRepeater(on: boolean): void {
    if (on === (this.repeater !== null)) return;
    this.repeater = on ? new Repeater(this.stationId) : null;
    if (on) this.soundPending = true;
  }

  get isRepeater(): boolean {
    return this.repeater !== null;
  }

  /** Frames we have repeated since repeater mode was turned on. */
  get repeatedCount(): number {
    return this.repeater?.repeated ?? 0;
  }

  /** Known repeaters: station id -> last slot it showed it is one. */
  get repeaters(): ReadonlyMap<number, number> {
    return this.repeaterSeen;
  }

  /** Frames received through each repeater. */
  get framesVia(): ReadonlyMap<number, number> {
    return this.viaCount;
  }

  /** Stations heard through a repeater: from, the repeater, and the last slot. */
  get relayPaths(): { from: number; via: number; slot: number }[] {
    return [...this.relayPath].map(([k, slot]) => {
      const [from, via] = k.split('>').map(Number) as [number, number];
      return { from, via, slot };
    });
  }

  /** Stations heard through a repeater, newest frame each (they have no link quality of their own). */
  get relayedStations(): ReadonlyMap<number, RelayedFrom> {
    return this.relayedFrom;
  }

  /** The station behind a via tag, when exactly one repeater known in the last repeaterMemorySlots has it. */
  repeaterFor(tag: number, slot: number): number | null {
    const ids = [...this.repeaterSeen].filter(([id, at]) => repeaterTag(id) === tag && slot - at <= this.repeaterMemorySlots).map(([id]) => id);
    return ids.length === 1 ? ids[0]! : null;
  }

  /** Any repeater heard lately, or we are one: then frames are paced. */
  repeaterPresent(slot: number): boolean {
    if (this.repeater) return true;
    for (const at of this.repeaterSeen.values()) if (slot - at <= this.repeaterMemorySlots) return true;
    return false;
  }

  private paceGap(slot: number): number {
    return this.repeaterPresent(slot) ? this.paceGapSlots : 0;
  }

  /** Messages in the order they were sent, oldest first. Do not mutate. */
  get messages(): readonly OutMessage[] {
    return this.out;
  }

  get hasNickname(): boolean {
    return this.nickname !== null;
  }

  /** Nicknames learned from hello frames. */
  get stations(): ReadonlyMap<number, string> {
    return this.stationNames;
  }

  /** Put back a nickname kept from an earlier run. */
  restoreStation(id: number, name: string): void {
    if (name) this.stationNames.set(id, name);
  }

  /** Forget every learned nickname. */
  forgetStations(): void {
    this.stationNames.clear();
  }

  setNickname(name: string | null): void {
    this.nickname = name ? normalizeText(name).slice(0, 8).trim() || null : null;
  }

  /** Queue a sound (a beacon carrying link reports) for the next free slot. */
  sound(): void {
    this.soundPending = true;
  }

  /** Queue a hello with our nickname for the next free slot. No-op without a nickname. */
  announce(): void {
    if (this.nickname) this.helloPending = true;
  }

  /**
   * Queue a message. `dst` is BROADCAST or a station id. Throws when the text is
   * empty or too long once normalised, or when all 16 message ids are in flight.
   */
  send(dst: number, text: string): OutMessage {
    const clean = normalizeText(text).trim();
    if (clean.length > MAX_TEXT_CHARS) throw new Error(`message is over ${MAX_TEXT_CHARS} characters`);
    const chunks = splitText(clean);
    const msgId = this.allocateMsgId();
    const msg: OutInternal = {
      localId: this.nextLocalId++,
      dst,
      text: clean,
      frames: chunks.length,
      state: 'queued',
      ackedFrames: 0,
      framesSent: 0,
      round: 1,
      lastTxSlot: null,
      echoedFrames: 0,
      echoedBy: null,
      msgId,
      chunks,
      ackedMask: 0,
      echoMask: 0,
      pending: chunks.map((_, i) => i),
      waitUntilSlot: 0,
    };
    this.out.push(msg);
    this.events.outgoing?.(msg);
    return msg;
  }

  /** Start a failed message over from the first frame. */
  retry(message: OutMessage): void {
    const msg = this.out.find((m) => m.localId === message.localId);
    if (!msg || msg.state !== 'failed') return;
    msg.state = 'queued';
    msg.round = 1;
    msg.ackedMask = 0;
    msg.ackedFrames = 0;
    msg.echoMask = 0;
    msg.echoedFrames = 0;
    msg.pending = msg.chunks.map((_, i) => i);
    this.events.outgoing?.(msg);
  }

  private allocateMsgId(): number {
    for (let n = 0; n < MSG_ID_COUNT; n++) {
      const id = (this.nextMsgId + n) % MSG_ID_COUNT;
      const busy = this.out.some((m) => m.msgId === id && (m.state === 'queued' || m.state === 'sending' || m.state === 'waiting'));
      if (!busy) {
        this.nextMsgId = (id + 1) % MSG_ID_COUNT;
        return id;
      }
    }
    throw new Error('too many messages in flight');
  }

  // --- receive ---------------------------------------------------------------

  /** A payload decoded from the audio of `slot`. Anything not chat is ignored. */
  receive(payload: Uint8Array, slot: number, snrDb = 0, channel = 0): void {
    const frame = decodeFrame(payload);
    if (!frame) return;
    const tag = frame.via ?? 0;
    // Our own repeat of someone else's frame, heard back through the speaker.
    if (tag !== 0 && this.repeater && tag === this.repeater.tag && this.recentFrames.has(frameKey(payload))) return;
    const through = this.noteRelay(frame, slot);
    if (frame.src === this.stationId) {
      if (tag !== 0) this.onEcho(frame, slot, through);
      return;
    }
    // A repeated frame carries the repeater's signal, not the sender's.
    if (channel > 0) {
      if (tag === 0) this.lqa?.heard(frame.src, channel, snrDb, slot);
      else if (through !== null) this.lqa?.heard(through, channel, snrDb, slot);
    }
    this.repeater?.offer(payload, slot);
    const key = frameKey(payload);
    const seen = this.recentFrames.get(key);
    if (seen !== undefined && slot - seen < DEDUP_SLOTS) return;
    this.recentFrames.set(key, slot);
    const via: Via | null = tag === 0 ? null : { tag, repeater: through };
    switch (frame.kind) {
      case 'hello':
        this.stationNames.set(frame.src, frame.name);
        this.events.station?.(frame.src, frame.name);
        break;
      case 'ack':
        if (frame.dst === this.stationId) {
          if (frame.heardChannel > 0) this.lqa?.reported(frame.src, frame.heardChannel, frame.heardSnrDb, slot);
          this.onAck(frame, slot);
        }
        break;
      case 'sound':
        for (const r of frame.reports) {
          if (r.channel <= 0) continue;
          if (r.station === this.stationId) this.lqa?.reported(frame.src, r.channel, r.snrDb, slot);
          else if (r.station !== frame.src) this.lqa?.overheard(frame.src, r.station, r.channel, r.snrDb, slot);
        }
        break;
      case 'first':
      case 'next':
        this.onData(frame, slot, snrDb, channel, via);
        break;
    }
  }

  /**
   * The repeater bookkeeping of a received frame: which repeaters exist, what came
   * through which, and who was heard only through one. Returns the repeater behind the
   * frame's via tag, or null (direct, or the tag is not resolved).
   */
  private noteRelay(frame: ChatFrame, slot: number): number | null {
    const tag = frame.via ?? 0;
    const through = tag === 0 ? null : this.repeaterFor(tag, slot);
    if (through !== null) {
      this.repeaterSeen.set(through, slot);
      this.viaCount.set(through, (this.viaCount.get(through) ?? 0) + 1);
    }
    if (frame.src === this.stationId) return through;
    if ((frame.kind === 'hello' || frame.kind === 'sound') && frame.repeater) this.repeaterSeen.set(frame.src, slot);
    if (through !== null && through !== frame.src) this.relayPath.set(`${frame.src}>${through}`, slot);
    if (tag !== 0) this.relayedFrom.set(frame.src, { slot, via: through, tag });
    return through;
  }

  /**
   * Relearn repeaters and stations heard through them from a saved frame, oldest first,
   * after a reload (none of it is stored on its own). Only that bookkeeping: no
   * messages, acks, link quality or repeats.
   */
  replayHeard(payload: Uint8Array, slot: number): void {
    const frame = decodeFrame(payload);
    if (!frame) return;
    // Our own repeats heard back carry our tag; they say nothing about others.
    if (this.repeater && frame.via === this.repeater.tag && frame.src !== this.stationId) return;
    this.noteRelay(frame, slot);
  }

  /** One of our own frames came back from a repeater: it has that frame. */
  private onEcho(frame: ChatFrame, slot: number, through: number | null): void {
    if (frame.kind !== 'first' && frame.kind !== 'next') return;
    const msg = this.out.find((m) => m.msgId === frame.msgId && m.lastTxSlot !== null && slot - m.lastTxSlot <= this.reassemblySlots && m.state !== 'queued');
    if (!msg) return;
    msg.echoMask |= bit(frame.kind === 'first' ? 0 : frame.seq);
    msg.echoedFrames = popcount(msg.echoMask);
    if (through !== null) msg.echoedBy = through;
    this.events.outgoing?.(msg);
  }

  private onData(frame: Extract<ChatFrame, { kind: 'first' | 'next' }>, slot: number, snrDb: number, channel: number, via: Via | null): void {
    const key = `${frame.src}:${frame.msgId}`;
    // The sender moved on to another message, so it has our ack: no second one.
    for (const other of this.incoming.values()) if (other.src === frame.src && other.msgId !== frame.msgId) other.ackRepeatSlot = null;
    let st = this.incoming.get(key);
    // A first frame that differs from the one we hold is a new message reusing the
    // id (or a stale partial), not a repeat.
    if (st && frame.kind === 'first' && st.parts[0] !== undefined && (st.parts[0] !== frame.text || st.frames !== frame.last + 1)) {
      this.incoming.delete(key);
      st = undefined;
    }
    if (!st) {
      st = {
        src: frame.src, msgId: frame.msgId, dst: null, frames: null, parts: new Array(MAX_FRAMES).fill(undefined),
        mask: 0, lastHeardSlot: slot, ackDueSlot: null, ackRepeatSlot: null, delivered: false, minSnrDb: snrDb, channel, via,
      };
      this.incoming.set(key, st);
    }
    if (frame.kind === 'first') {
      st.dst = frame.dst;
      st.frames = frame.last + 1;
      st.parts[0] = frame.text;
      st.mask |= bit(0);
    } else {
      st.parts[frame.seq] = frame.text;
      st.mask |= bit(frame.seq);
    }
    st.lastHeardSlot = slot;
    st.channel = channel;
    st.via = via;
    st.minSnrDb = Math.min(st.minSnrDb, snrDb);

    // Not for us: keep nothing.
    if (st.dst !== null && st.dst !== BROADCAST && st.dst !== this.stationId) {
      this.incoming.delete(key);
      return;
    }
    const complete = st.frames !== null && this.isComplete(st);
    if (complete && !st.delivered) {
      st.delivered = true;
      this.events.incoming?.({
        src: st.src, msgId: st.msgId, dst: st.dst!, frames: st.frames!, slot, snrDb: st.minSnrDb, channel: st.channel, via: st.via,
        text: st.parts.slice(0, st.frames!).join('').trimEnd(),
      });
    }
    if (st.dst === this.stationId) {
      // Frames go out in ascending order, so the last index ends a round and the
      // sender falls silent: answer at once. Anything else may be mid-round, and
      // answering then would be talking over a station that cannot hear us.
      // With a repeater about, wait until it has repeated the frame and listens again.
      const seq = frame.kind === 'first' ? 0 : frame.seq;
      const gap = this.paceGap(slot);
      st.ackRepeatSlot = null; // it is sending again: the ack below answers this round
      st.ackDueSlot = st.frames !== null && seq === st.frames - 1 ? slot + 1 + gap : slot + this.partialAckSlots + 2 * gap;
    }
  }

  private isComplete(st: InInternal): boolean {
    for (let i = 0; i < st.frames!; i++) if (!(st.mask & bit(i))) return false;
    return true;
  }

  private onAck(ack: Extract<ChatFrame, { kind: 'ack' }>, slot: number): void {
    const msg = this.out.find((m) => m.dst === ack.src && m.msgId === ack.msgId && m.state !== 'delivered' && m.state !== 'queued');
    if (!msg) return;
    const all = (1 << msg.frames) - 1;
    msg.ackedMask |= ack.received & all;
    msg.ackedFrames = popcount(msg.ackedMask);
    if (msg.ackedMask === all) {
      msg.state = 'delivered';
      msg.pending = [];
      // The receiver sends this ack again: stay off the air in that slot so both can hear.
      if (this.ackRepeatGapSlots > 0) {
        const until = slot + this.ackRepeatGapSlots + this.paceGap(slot);
        this.holdOwnUntilSlot = Math.max(this.holdOwnUntilSlot ?? until, until);
      }
    } else if (msg.state === 'waiting') {
      // The receiver told us what it lacks: go again now rather than after the timeout.
      this.startRound(msg);
    } else {
      msg.pending = msg.pending.filter((i) => !(msg.ackedMask & bit(i)));
    }
    this.events.outgoing?.(msg);
  }

  /**
   * Confirm a received message again, all frames, in the next free slot: for when the
   * sender keeps resending because our ack did not reach it. Asking twice queues it once.
   */
  resendAck(src: number, msgId: number, frames: number): void {
    if (this.manualAcks.some((a) => a.src === src && a.msgId === msgId)) return;
    this.manualAcks.push({ src, msgId, frames: Math.min(MAX_FRAMES, Math.max(1, frames)) });
  }

  // --- transmit --------------------------------------------------------------

  /** Advance timeouts. nextTx calls this; call it on its own each slot for the UI's sake. */
  tick(slot: number): void {
    for (const msg of this.out) {
      if (msg.state === 'waiting' && slot >= msg.waitUntilSlot) {
        this.startRound(msg);
        this.events.outgoing?.(msg);
      }
    }
    for (const [key, st] of this.incoming) {
      const age = slot - st.lastHeardSlot;
      if (age > this.reassemblySlots || (st.delivered && st.ackDueSlot === null && st.ackRepeatSlot === null && age > this.reassemblySlots / 2)) {
        this.incoming.delete(key);
      }
    }
    for (const [key, at] of this.recentFrames) if (slot - at >= DEDUP_SLOTS) this.recentFrames.delete(key);
  }

  /** Begin a retransmit round of what is still unacknowledged, or give up. */
  private startRound(msg: OutInternal): void {
    if (msg.round >= this.maxRounds) {
      msg.state = 'failed';
      msg.pending = [];
      return;
    }
    msg.round++;
    msg.state = 'sending';
    msg.pending = msg.chunks.map((_, i) => i).filter((i) => !(msg.ackedMask & bit(i)));
  }

  /**
   * The payload to transmit in `slot`, or null when there is nothing to say. The
   * caller must transmit what it gets: state advances as if it had been sent.
   */
  nextTx(slot: number): Uint8Array | null {
    return this.nextTxTo(slot)?.payload ?? null;
  }

  outlook(): SessionOutlook {
    let ackDue: SessionOutlook['ackDue'] = null;
    for (const st of this.incoming.values()) {
      for (const due of [st.ackDueSlot, st.ackRepeatSlot]) {
        if (due !== null && st.dst === this.stationId && (!ackDue || due < ackDue.fromSlot)) ackDue = { to: st.src, fromSlot: due };
      }
    }
    if (!ackDue && this.manualAcks.length > 0) ackDue = { to: this.manualAcks[0]!.src, fromSlot: 0 }; // due now
    const sendingMsg = this.out.find((m) => m.state === 'sending');
    const waiting = this.out.find((m) => m.state === 'waiting');
    return {
      ackDue,
      repeats: this.repeater?.pending ?? 0,
      hello: this.helloPending && this.nickname !== null,
      sound: this.soundPending,
      sending: sendingMsg ? { dst: sendingMsg.dst, left: sendingMsg.pending.length, total: sendingMsg.frames } : null,
      waitingAck: waiting ? { dst: waiting.dst, untilSlot: waiting.waitUntilSlot } : null,
      queued: this.out.filter((m) => m.state === 'queued').length,
      beaconFromSlot: this.lastAnyTxSlot === null ? null : this.lastAnyTxSlot + this.beaconGapSlots,
    };
  }

  /** Like nextTx, and says who the frame is for (BROADCAST for hellos, sounds and broadcasts), so the caller can pick a channel. */
  nextTxTo(slot: number): { payload: Uint8Array; dst: number } | null {
    const tx = this.pickTx(slot);
    if (tx) this.lastAnyTxSlot = slot;
    return tx;
  }

  /** A beacon (hello, sound) would follow our last frame too closely: it waits, it is not dropped. */
  private beaconTooSoon(slot: number): boolean {
    return this.lastAnyTxSlot !== null && slot > this.lastAnyTxSlot && slot - this.lastAnyTxSlot < this.beaconGapSlots;
  }

  private pickTx(slot: number): { payload: Uint8Array; dst: number } | null {
    this.tick(slot);

    const ackOf = (st: InInternal): { payload: Uint8Array; dst: number } => {
      const heard = this.lqa?.latestHeard(st.src, slot);
      return {
        dst: st.src,
        payload: encodeFrame({
          kind: 'ack', src: this.stationId, dst: st.src, msgId: st.msgId, received: st.mask,
          heardChannel: heard?.channel ?? 0, heardSnrDb: heard?.snrDb ?? 0,
        }),
      };
    };
    for (const st of this.incoming.values()) {
      if (st.ackDueSlot !== null && st.ackDueSlot <= slot && st.dst === this.stationId) {
        st.ackDueSlot = null;
        const complete = st.frames !== null && this.isComplete(st);
        st.ackRepeatSlot = complete && this.ackRepeatGapSlots > 0 ? slot + this.ackRepeatGapSlots + this.paceGap(slot) : null;
        return ackOf(st);
      }
    }
    for (const st of this.incoming.values()) {
      if (st.ackRepeatSlot !== null && st.ackRepeatSlot <= slot && st.dst === this.stationId) {
        st.ackRepeatSlot = null;
        return ackOf(st);
      }
    }

    const manual = this.manualAcks.shift();
    if (manual) {
      const heard = this.lqa?.latestHeard(manual.src, slot);
      return {
        dst: manual.src,
        payload: encodeFrame({
          kind: 'ack', src: this.stationId, dst: manual.src, msgId: manual.msgId, received: (1 << manual.frames) - 1,
          heardChannel: heard?.channel ?? 0, heardSnrDb: heard?.snrDb ?? 0,
        }),
      };
    }

    const repeat = this.repeater?.next(slot);
    if (repeat) {
      // Remember it so our own repeat, heard back through the speaker, is not taken for another's.
      this.recentFrames.set(frameKey(repeat.payload), slot);
      return repeat;
    }

    if (this.holdOwnUntilSlot !== null && slot <= this.holdOwnUntilSlot) return null;

    // Pacing: with a repeater about, leave it room to repeat our last frame.
    const gap = this.paceGap(slot);
    if (gap > 0 && this.lastOwnTxSlot !== null && slot > this.lastOwnTxSlot && slot - this.lastOwnTxSlot <= gap) return null;
    const own = (tx: { payload: Uint8Array; dst: number } | null): { payload: Uint8Array; dst: number } | null => {
      if (tx) this.lastOwnTxSlot = slot;
      return tx;
    };

    if (this.helloPending && this.nickname && !this.beaconTooSoon(slot)) {
      this.helloPending = false;
      return own({ dst: BROADCAST, payload: encodeFrame({ kind: 'hello', src: this.stationId, name: this.nickname, repeater: this.isRepeater }) });
    }

    // Stop and wait: a station that transmits cannot hear, so while an ack is
    // expected it stays quiet instead of starting the next message over it.
    if (this.out.some((m) => m.state === 'waiting')) return null;
    const msg = this.out.find((m) => m.state === 'sending' || m.state === 'queued');
    if (!msg) {
      // A sound is a low priority beacon: only when no message is in flight, so it never
      // makes us deaf to an ack we are waiting for or delays a message.
      if (!this.soundPending || this.beaconTooSoon(slot)) return null;
      this.soundPending = false;
      const reports = this.lqa?.reportsToSend(SOUND_REPORTS, slot) ?? [];
      return own({ dst: BROADCAST, payload: encodeFrame({ kind: 'sound', src: this.stationId, reports, repeater: this.isRepeater }) });
    }
    if (msg.state === 'queued') msg.state = 'sending';
    const seq = msg.pending.shift();
    if (seq === undefined) {
      // Everything was acked while queued behind others; nothing left to send.
      msg.state = msg.ackedMask === (1 << msg.frames) - 1 ? 'delivered' : 'waiting';
      msg.waitUntilSlot = slot + this.ackTimeoutSlots + 2 * gap;
      this.events.outgoing?.(msg);
      return this.pickTx(slot);
    }
    const chunk = msg.chunks[seq]!;
    const frame: ChatFrame = seq === 0
      ? { kind: 'first', src: this.stationId, msgId: msg.msgId, last: msg.frames - 1, dst: msg.dst, text: chunk }
      : { kind: 'next', src: this.stationId, msgId: msg.msgId, seq, text: chunk };
    msg.framesSent++;
    msg.lastTxSlot = slot;
    if (msg.pending.length === 0) {
      if (msg.dst === BROADCAST) msg.state = 'sent';
      else {
        msg.state = 'waiting';
        msg.waitUntilSlot = slot + this.ackTimeoutSlots + 2 * gap;
      }
    }
    this.events.outgoing?.(msg);
    return own({ dst: msg.dst, payload: encodeFrame(frame) });
  }
}

function popcount(n: number): number {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
}
