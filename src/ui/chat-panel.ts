/**
 * Message bubbles and the compose bar. Feeds decoded frames to the ChatSession and
 * sends whatever it wants transmitted, one frame per slot (messages, acks, hellos);
 * shows received messages on the left and sent ones on the right, oldest first.
 * The audio, slots and decoding all live in the engine, the protocol in the session.
 *
 * Everything shown from the air goes in through textContent: what arrives over
 * radio is untrusted input.
 */

import { VIABLE_DB, soundChannel, type LqaTable } from '../ale/lqa';
import { pickRetryChannel } from '../ale/retry-channel';
import type { Channel } from '../band/band-plan';
import type { AudioEngine, DecodeResult } from '../audio/engine';
import { FrameLog, hexPayload, payloadHex } from '../chat/frame-log';
import type { UndecodedSync } from '../chat/clock-hint';
import type { Notifier } from './notifier';
import { normalizeText } from '../chat/charset6';
import { defaultIconIndex, emojiFor, ICON_COUNT } from '../chat/emoji-table';
import { iconOf as frameIcon } from '../chat/sequence';
import { BROADCAST, MAX_TEXT_CHARS, decodeFrame, repeaterTag, viaOf, type ChatFrame } from '../chat/frames';
import { pinnedReason } from '../ale/tx-policy';
import { LOAD_WINDOW_SLOTS, channelLoad, quietestChannel, type HeardOn } from '../ale/channel-load';
import type { ChatSession, InMessage, OutMessage, TxOut, Via } from '../chat/session';
import { paletteToString, pixelsToString, spriteColours, spriteFrameCount, viewFromStrings, viewOf, type Sprite } from '../chat/sprite';
import { SpriteEditor } from './sprite-editor';
import { DEFAULT_PIXEL_PX, drawSprite, type HoleStyle } from './sprite-view';
import type { FrameCodec, Protocol } from '../protocol/protocol';
import { distinctFrames } from '../protocol/multi-decode';
import { CHAT_KEY, DEBUG_KEY, STATIONS_KEY, DeferredSaver, loadJson, removeKey, saveJson } from '../storage/store';
import { nextSlotStartMs } from '../protocol/slot-clock';
import { frameDurationSec } from '../protocol/spec';

const MAX_ROWS = 500;

/** A sprite in a chat line, as stored: the pixels as text (`.` = never arrived), see sprite.ts `viewFromStrings`. */
interface SpriteLine {
  side: number;
  bpp: number;
  palette?: string;
  pixels: string;
  /** Frames heard (sent: all of them) out of `frames`. */
  got: number;
  frames: number;
  /** No more frames are expected (complete, timed out, or sent by us). */
  done: boolean;
}

/**
 * One line of the chat as kept in localStorage: only what is shown, already worded
 * (names and details as they were when it happened), so restoring needs no session.
 */
interface LogEntry {
  kind: 'in' | 'out' | 'notice';
  atMs: number;
  text: string;
  who?: string | null;
  /** The other station of a directed or received message: who a click on the bubble replies to. */
  station?: number;
  /** Details shown under ⓘ, one [label, value] line per item. */
  info?: [string, string][];
  /** A received directed message: what "Resend ACK" needs. */
  ack?: { src: number; msgId: number; frames: number };
  /** A sprite instead of text (`text` is then just a label such as "sprite 8×8"). */
  sprite?: SpriteLine;
  /** Details saved before `info` existed: plain lines. */
  details?: string[];
  /** Delivery state of a sent message: the CSS class, the short label and the explanation (a tooltip). */
  stateClass?: string;
  stateText?: string;
  statusText?: string;
}

/** Which conversation a chat line belongs to: 'public' (addressed to nobody) or the other station's id. Notices belong to none. */
function threadOf(e: LogEntry): string | null {
  if (e.kind === 'notice') return null;
  if (e.info?.some(([k, v]) => k === 'To' && v === 'everyone')) return 'public';
  if (e.station === undefined) return 'public';
  return String(e.station);
}

/** This many pinned samples (in runs of two or more) in a slot window count as an overloaded input. */
const OVERLOAD_MIN_CLIPPED = 3;
const OVERLOAD_NOTICE_MS = 120_000;
/** Grey notice lines (announcements, errors) vanish this long after they appeared. */
const NOTICE_TTL_MS = 5 * 60_000;
const NOTICE_SWEEP_MS = 15_000;

const INFLIGHT = /^bubble-state state-(queued|sending|waiting)$/;

/** Read back from storage, so nothing about it can be trusted. */
function parseLog(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  const out: LogEntry[] = [];
  for (const e of raw.slice(-MAX_ROWS)) {
    if (!e || (e.kind !== 'in' && e.kind !== 'out' && e.kind !== 'notice') || typeof e.text !== 'string' || typeof e.atMs !== 'number') continue;
    const entry: LogEntry = { kind: e.kind, atMs: e.atMs, text: e.text, who: typeof e.who === 'string' ? e.who : null, details: strings(e.details) };
    if (Array.isArray(e.info)) {
      entry.info = e.info.filter((x: unknown): x is [string, string] => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string');
    }
    const a = e.ack;
    if (a && [a.src, a.msgId, a.frames].every((v) => Number.isInteger(v) && v >= 0)) entry.ack = { src: a.src, msgId: a.msgId, frames: a.frames };
    const sl = e.sprite;
    if (sl && typeof sl === 'object' && Number.isInteger(sl.got) && Number.isInteger(sl.frames) && viewFromStrings(sl.side, sl.bpp, sl.palette, sl.pixels)) {
      // The session that was receiving it is gone with the page: whatever is here is final.
      entry.sprite = { side: sl.side, bpp: sl.bpp, ...(typeof sl.palette === 'string' ? { palette: sl.palette } : {}), pixels: sl.pixels, got: sl.got, frames: sl.frames, done: true };
    }
    if (typeof e.station === 'number') entry.station = e.station;
    else if (entry.who) {
      // Saved before stations were stored: the label ends in "(#id)" or "#id".
      const m = /#(\d+)\)?$/.exec(entry.who);
      if (m) entry.station = Number(m[1]);
    }
    if (!entry.info && entry.details && e.kind !== 'notice') upgradeLegacy(entry, typeof e.statusText === 'string' ? e.statusText : '');
    if (e.kind === 'out') {
      const inFlight = typeof e.stateClass === 'string' && INFLIGHT.test(e.stateClass);
      // The session that was sending it is gone with the page, so it will never finish.
      entry.stateClass = inFlight ? 'bubble-state state-failed' : typeof e.stateClass === 'string' ? e.stateClass : '';
      entry.stateText = inFlight ? '✗ interrupted' : typeof e.stateText === 'string' ? e.stateText : '';
      entry.statusText = inFlight ? 'the page was closed or reloaded before this was confirmed.' : entry.statusText ?? (typeof e.statusText === 'string' ? e.statusText : '');
      if (inFlight && entry.info) entry.info = entry.info.map(([k, v]): [string, string] => [k, k === 'Status' ? '✗ interrupted by a reload' : v]);
    }
    out.push(entry);
  }
  return out;
}

/**
 * A chat line saved before the ⓘ panel had one line per item: turn its plain sentences
 * into the same labelled lines. Lines it does not recognise are kept as they were.
 */
function upgradeLegacy(entry: LogEntry, statusText: string): void {
  const info: [string, string][] = [];
  const rest: string[] = [];
  let m: RegExpExecArray | null;
  if (entry.kind === 'in') {
    let path = 'direct';
    let toYou = false;
    const tail: [string, string][] = [];
    for (const line of entry.details ?? []) {
      if ((m = /^from (.+), to (everyone|you)$/.exec(line))) {
        toYou = m[2] === 'you';
        info.push(['From', m[1]!], ['To', m[2]!]);
      } else if ((m = /^(\d+) frames?, completed in the slot starting (.+)$/.exec(line))) tail.push(['Frames', `${m[1]}, complete at ${m[2]}`]);
      else if ((m = /^channel (.+)$/.exec(line))) tail.unshift(['Channel', m[1]!]);
      else if ((m = /^weakest frame (.+) dB \(SNR in 2500 Hz\)$/.exec(line))) tail.unshift(['Signal', `${m[1]} dB weakest frame`]);
      else if ((m = /^last frame came through repeater (.+?); /.exec(line))) path = `repeated by ${m[1]!.startsWith('with tag') ? `a repeater ${m[1]}` : m[1]}`;
      else rest.push(line);
    }
    if (info.length === 0) return;
    info.push(['Path', path], ['ACK', toYou ? 'sent automatically when it completed' : 'none (broadcasts are not confirmed)'], ...tail);
  } else {
    for (const line of entry.details ?? []) {
      if ((m = /^to (.+)$/.exec(line))) info.push(['To', m[1]!]);
      else if ((m = /^(\d+ frames?, one per .+)$/.exec(line))) info.push(['Frames', m[1]!]);
      else if ((m = /^transmit level (.+)$/.exec(line))) info.push(['Level', m[1]!]);
      else rest.push(line);
    }
    if (info.length === 0) return;
    if ((m = /^status (.+?): (.*)$/.exec(statusText))) {
      info.splice(1, 0, ['Status', m[1]!]);
      entry.statusText = m[2]!;
    }
  }
  entry.info = [...info, ...rest.map((r): [string, string] => ['', r])];
  delete entry.details;
}

/** Same margin the engine uses to move a transmission to the next boundary. */
const TX_LEAD_MS = 300;

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });
const clockShort = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
const signed = (v: number, digits: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

/** A frame kind in words. */
function kindText(f: ChatFrame): string {
  switch (f.kind) {
    case 'first': return 'message (first frame)';
    case 'next': return `message frame ${f.seq + 1}`;
    case 'spriteHead': return 'sprite (first frame)';
    case 'spriteBody': return `sprite frame ${f.seq + 1}`;
    case 'ack': return 'ack';
    case 'hello': return `announcement "${f.name}"`;
    case 'sound': return 'network probe';
  }
}

/** The ⓘ panel: one "label value" line per item; entries saved before that show their old plain lines. */
function fillInfo(box: HTMLElement, entry: LogEntry, action?: HTMLElement): void {
  box.replaceChildren();
  if (entry.info?.length) {
    for (const [k, v] of entry.info) {
      const row = document.createElement('div');
      row.className = 'bubble-row';
      const key = document.createElement('span');
      key.className = 'bubble-key';
      key.textContent = k;
      const val = document.createElement('span');
      val.textContent = v;
      if (k === 'Status' && entry.statusText) val.title = entry.statusText;
      row.append(key, val);
      if (k === 'ACK' && action) row.append(action);
      box.append(row);
    }
    return;
  }
  for (const line of [...(entry.kind === 'out' && entry.statusText ? [entry.statusText] : []), ...(entry.details ?? [])]) {
    const l = document.createElement('div');
    l.textContent = line;
    box.append(l);
  }
}

/** The parts of a chat line the panel keeps to update it later. */
interface Bubble {
  /** A sent message's delivery state; null for received lines. */
  state: HTMLElement | null;
  /** The ⓘ details box. */
  status: HTMLElement;
  /** A sprite line: redraw it after its pixels changed. */
  sprite?: { redraw: () => void };
}

export class ChatPanel {
  private readonly input = document.getElementById('msg-input') as HTMLInputElement;
  private readonly button = document.getElementById('send-button') as HTMLButtonElement;
  private readonly status = document.getElementById('rx-status') as HTMLElement;
  private readonly list = document.getElementById('rx-list') as HTMLElement;
  private readonly dstSelect = document.getElementById('dst-select') as HTMLSelectElement;
  private readonly codec: FrameCodec;
  /** Every frame sent and received; shown on the Network screen. */
  readonly frames = new FrameLog();
  /** Recent slots where nothing decoded: the best sync of all channels, for the clock hints. */
  readonly undecodedSyncs: UndecodedSync[] = [];
  private readonly framesSaver = new DeferredSaver(() => saveJson(DEBUG_KEY, this.frames.serialize()));
  private selected: Channel | null = null;
  /** The band being used: candidates for automatic channel choice and for sounding. */
  private bandChannels: readonly Channel[] = [];
  private autoChannel = true;
  /** Auto beacon off + a selected channel: every frame, beacons included, goes on that channel. */
  /** Called when a hello of ours is sent (Announce, auto announce or a beacon that became one), so the auto announce wait restarts. */
  onOwnHello: (() => void) | null = null;
  private autoSound = true;
  private soundCount = 0;
  private shownSecond = -1;
  private sendingAtMs = 0;
  /** What is on the air (or waiting for its slot), for the activity lines. */
  private currentTx: { what: string; channel: number; icon: string } | null = null;
  /** Destination -> channel we used for it last, kept while it stays among the best. */
  private readonly lastChannelFor = new Map<number, number>();
  /** `dst:msgId` -> the round last sent, its channel and every channel the message has used, so a retransmit round can go elsewhere. */
  private readonly retryRounds = new Map<string, { round: number; channel: number; used: number[] }>();
  private blocked: ReadonlySet<number> = new Set();

  /** Chat messages kept (sent and received; notices do not count). */
  get messageCount(): number {
    return this.log.filter((e) => e.kind !== 'notice').length;
  }

  /** The channel of the frame on the air or waiting for its slot; null when nothing is going out. */
  get sendingChannel(): number | null {
    // A cancelled frame (transmit turned off) sends no "done": trust the engine's flag.
    return this.engine.sending ? this.currentTx?.channel ?? null : null;
  }
  /** The newest thing that happened: a frame received or sent. */
  lastAction: { atMs: number; text: string; icon: string; dir: 'rx' | 'tx' } | null = null;
  private readonly outBubbles = new Map<number, { state: HTMLElement | null; status: HTMLElement; entry: LogEntry; levelPct: number }>();
  /** Sprites being received: the session's message uid -> its chat line, until it is final. */
  private readonly spriteBubbles = new Map<number, { entry: LogEntry; parts: Bubble }>();
  /** Redraws of every sprite canvas in the chat, for when the pixel size or hole style changes. */
  private readonly spriteRedraws = new Set<{ canvas: HTMLCanvasElement; redraw: () => void }>();
  private spritePx = DEFAULT_PIXEL_PX;
  private spriteHoles: HoleStyle = 'fill';
  private readonly editor: SpriteEditor;
  private readonly known = new Map<number, string>();
  /** Icon index announced by each station (hello); absent = use the hash default. */
  private readonly icons = new Map<number, number>();
  private log: LogEntry[] = [];
  private readonly chatSaver = new DeferredSaver(() => saveJson(CHAT_KEY, this.log.filter((e) => e.kind !== 'notice')));
  private readonly stationsSaver = new DeferredSaver(() => saveJson(STATIONS_KEY, [...this.known].map(([id, name]) => (this.icons.has(id) ? [id, name, this.icons.get(id)] : [id, name]))));
  /** Called when a complete message from another station arrives. */
  onIncoming: (() => void) | null = null;
  /** Called when one of our directed messages turns delivered. */
  onDelivered: (() => void) | null = null;
  /** Set to raise system notifications for messages and announcements while the page is in the background. */
  notifier: Notifier | null = null;
  /** Per analysed slot: channel numbers a frame from another station was decoded on, and the channels flagged as overloaded. */
  onActivity: ((heard: readonly number[], overloaded: readonly number[]) => void) | null = null;
  private lastOverloadNoticeMs = 0;

  constructor(
    private readonly engine: AudioEngine,
    private readonly protocol: Protocol,
    private readonly channels: readonly Channel[],
    private readonly getLevel: () => number,
    private readonly session: ChatSession,
    private readonly lqa: LqaTable,
  ) {
    this.codec = protocol.createCodec();
    this.frames.restore(loadJson(DEBUG_KEY));
    // Repeaters and stations heard only through one are not stored: relearn them from the frame log.
    const slotMs = protocol.spec.slotSec * 1000;
    for (const r of this.frames.all) if (r.dir === 'rx') session.replayHeard(hexPayload(r.hex), Math.floor(r.atMs / slotMs));
    this.frames.onChange = () => this.framesSaver.touch();
    this.input.maxLength = MAX_TEXT_CHARS;
    this.restoreStations();
    this.fillRecipients();
    for (const entry of parseLog(loadJson(CHAT_KEY))) {
      // Notices belong to the session that raised them (older builds saved them): never restored.
      if (entry.kind === 'notice') continue;
      this.log.push(entry);
      this.render(entry);
    }
    this.applyThread();
    setInterval(() => this.expireNotices(), NOTICE_SWEEP_MS);
    session.events.incoming = (m) => this.showIncoming(m);
    session.events.outgoing = (m) => this.showOutgoing(m);
    session.events.station = (id, name, icon) => {
      this.known.set(id, name);
      if (icon !== undefined) this.icons.set(id, icon);
      this.stationsSaver.touch();
      this.fillRecipients();
      this.addNotice(`${this.label(id)} announced itself`);
      this.notifier?.notify('Station announced', `${this.label(id)} announced itself`, `hello-${id}`);
    };
    this.editor = new SpriteEditor({
      slotSec: protocol.spec.slotSec,
      pixelPx: () => this.spritePx,
      recipient: () => ({ label: this.who(Number(this.dstSelect.value)), canSend: this.canTransmit }),
      send: (sprite) => this.sendSprite(sprite),
    });
    document.getElementById('sprite-button')?.addEventListener('click', () => this.editor.open());
    session.events.spriteProgress = (m) => this.showSprite(m, false);
    this.button.addEventListener('click', () => this.onSendClicked());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.button.disabled) this.onSendClicked();
    });
    engine.onFrameDone = () => {
      if (this.currentTx) this.lastAction = { atMs: Date.now(), text: `sent ${this.currentTx.what} on ch ${this.currentTx.channel}`, icon: this.currentTx.icon, dir: 'tx' };
      this.currentTx = null;
      this.refresh();
      this.pump();
    };
    engine.onDecoded = (result) => this.showResult(result);
  }

  /** Forget the chat lines (messages and notices). Stations and link statistics stay. */
  clearChat(): void {
    this.log = [];
    this.outBubbles.clear();
    this.spriteBubbles.clear();
    this.spriteRedraws.clear();
    this.list.replaceChildren();
    this.chatSaver.cancel();
    removeKey(CHAT_KEY);
  }

  /** Forget the log of sent and received frames. */
  clearDebug(): void {
    this.frames.clear();
    this.framesSaver.cancel();
    removeKey(DEBUG_KEY);
  }

  /** Every station seen or announced, with its nickname ('' when none). */
  get knownStations(): ReadonlyMap<number, string> {
    return this.known;
  }

  /** The newest message with each station (received, or sent to it directly), for the contact list. */
  lastMessages(): Map<number, { text: string; atMs: number; mine: boolean }> {
    const out = new Map<number, { text: string; atMs: number; mine: boolean }>();
    for (const e of this.log) {
      if (e.kind === 'notice' || e.station === undefined || threadOf(e) === 'public') continue;
      const prev = out.get(e.station);
      if (!prev || e.atMs >= prev.atMs) out.set(e.station, { text: e.text, atMs: e.atMs, mine: e.kind === 'out' });
    }
    return out;
  }

  /** The newest public message (addressed to nobody), for the top row of the contact list. */
  lastPublic(): { text: string; atMs: number; mine: boolean; who: string | null } | null {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i]!;
      if (threadOf(e) === 'public') return { text: e.text, atMs: e.atMs, mine: e.kind === 'out', who: e.who ?? null };
    }
    return null;
  }

  /** The conversation open now: a station id, or BROADCAST for Public. */
  get currentRecipient(): number {
    return Number(this.dstSelect.value);
  }

  /** Called when the open conversation changes. */
  onThreadChange: (() => void) | null = null;

  /** Open the conversation with one station (or BROADCAST = Public): show only its lines, point the composer at it, focus the message box. */
  selectRecipient(id: number): void {
    if (![...this.dstSelect.options].some((o) => o.value === String(id))) this.fillRecipients();
    this.dstSelect.value = String(id);
    this.applyThread();
    this.input.focus();
    this.blinkRecipient();
    this.onThreadChange?.();
  }

  /** Show only the lines of the open conversation (notices stay), and title it. */
  private applyThread(): void {
    const id = this.currentRecipient;
    const want = id === BROADCAST ? 'public' : String(id);
    for (const li of this.list.children) {
      const t = (li as HTMLElement).dataset.thread;
      (li as HTMLElement).hidden = t !== undefined && t !== want;
    }
    const title = document.getElementById('thread-title');
    if (title) title.textContent = id === BROADCAST ? 'Public' : this.label(id);
    this.list.scrollTop = this.list.scrollHeight;
  }

  /** Refill the composer with a failed message's text and recipient, so sending it again is one tap. A sprite goes back into the editor. */
  private retryFailed(m: OutMessage): void {
    this.selectRecipient(m.dst);
    if (m.content.kind === 'sprite') {
      this.editor.loadSprite(m.content.sprite);
      this.editor.open();
      return;
    }
    this.input.value = m.text;
  }

  /** Pixel size and the look of missing pixels for every sprite shown (settings): redraws what is on screen. */
  setSpriteStyle(pixelPx: number, holes: HoleStyle): void {
    this.spritePx = pixelPx;
    this.spriteHoles = holes;
    for (const r of this.spriteRedraws) {
      if (r.canvas.isConnected) r.redraw();
      else this.spriteRedraws.delete(r);
    }
    if (this.editor.isOpen) this.editor.refresh();
  }

  /** The editor's Send: queue the sprite for the recipient chosen in the composer; an error text when it cannot. */
  private sendSprite(sprite: Sprite): string | null {
    try {
      this.session.sendSprite(Number(this.dstSelect.value), sprite);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    this.pump();
    this.refresh();
    return null;
  }

  /** Flash the recipient selector so it is clear who the next message goes to. */
  private blinkRecipient(): void {
    const sel = this.dstSelect;
    sel.classList.remove('blink');
    void sel.offsetWidth; // restart the animation when clicked again
    sel.classList.add('blink');
    sel.addEventListener('animationend', () => sel.classList.remove('blink'), { once: true });
  }

  /** Forget the known stations (nicknames and the recipient list). Chat lines keep the names they were written with. */
  clearStations(): void {
    this.known.clear();
    this.icons.clear();
    this.session.forgetStations();
    this.stationsSaver.cancel();
    removeKey(STATIONS_KEY);
    this.fillRecipients();
  }

  get counts(): { chat: number; stations: number; debug: number } {
    return { chat: this.log.length, stations: this.known.size, debug: this.frames.count };
  }

  private restoreStations(): void {
    const raw = loadJson(STATIONS_KEY);
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!Array.isArray(item) || typeof item[0] !== 'number' || typeof item[1] !== 'string') continue;
      this.known.set(item[0], item[1]);
      if (Number.isInteger(item[2]) && item[2] >= 0 && item[2] < ICON_COUNT) this.icons.set(item[0], item[2]);
      this.session.restoreStation(item[0], item[1]);
    }
  }

  /** When the frame now queued or playing is on air, wall-clock ms; null when not sending. */
  get transmitWindow(): { startMs: number; endMs: number } | null {
    if (!this.engine.sending || this.sendingAtMs === 0) return null;
    return { startMs: this.sendingAtMs, endMs: this.sendingAtMs + frameDurationSec(this.protocol.spec) * 1000 };
  }

  setSelectedChannel(channel: Channel | null): void {
    this.selected = channel;
    this.refresh();
  }

  /** Channels the user switched off: nothing is sent on them (receiving goes on). All blocked = none blocked. */
  setBlockedChannels(numbers: ReadonlySet<number>): void {
    this.blocked = numbers;
  }

  setBandChannels(channels: readonly Channel[]): void {
    this.bandChannels = channels;
    this.refresh();
  }

  /** On: each frame goes on the channel the link quality table favours. Off: always the selected channel. */
  setAutoChannel(on: boolean): void {
    this.autoChannel = on;
    this.refresh();
  }

  /** Auto beacon on or off. Off with a channel selected pins every transmission to that channel. */
  setAutoSound(on: boolean): void {
    this.autoSound = on;
    this.session.setEventSounds(on);
    this.refresh();
  }

  /** Repeater mode on or off; says so in the chat. */
  setRepeater(on: boolean): void {
    if (on === this.session.isRepeater) return;
    this.session.setRepeater(on);
    this.addNotice(on
      ? 'repeater on: frames heard from other stations are repeated; a test beacon tells them'
      : `repeater off (${this.session.repeatedCount} frames repeated)`);
    this.pump();
  }

  /** Ask for a sound (beacon with link reports) to go out in the next free slot; `probe` makes every station answer. */
  sound(probe = false): void {
    this.session.sound(probe);
    this.pump();
  }

  private get canTransmit(): boolean {
    return this.engine.running && this.engine.transmitAllowed && (this.selected !== null || (this.autoChannel && this.bandChannels.length > 0));
  }

  /** Call when audio starts or stops, or a transmission ends. */
  refresh(): void {
    this.button.disabled = !this.canTransmit;
    const sound = document.getElementById('sound-button') as HTMLButtonElement | null;
    if (sound) sound.disabled = !this.canTransmit;
    this.button.textContent = 'Send';
    for (const announce of document.querySelectorAll<HTMLButtonElement>('.announce-button')) announce.disabled = this.button.disabled;
  }

  /** Ask for a hello with our nickname to go out in the next free slot. */
  announce(automatic = false): void {
    if (!this.session.hasNickname) {
      this.status.textContent = 'Set a name in Settings before announcing.';
      return;
    }
    this.session.announce();
    if (!automatic) this.addNotice('you announced yourself (sent at the next slot)');
    this.pump();
  }

  private currentSlot(nowMs = Date.now()): number {
    return Math.floor(nowMs / (this.protocol.spec.slotSec * 1000));
  }

  /**
   * Hand the transmitter its next frame when it is free. The frame is aimed at the
   * next slot boundary, so the session is told that slot: its ack timing counts in
   * slots. Without audio or a channel nothing is asked for, only timeouts advance.
   */
  private pump(): void {
    const nowMs = Date.now();
    this.session.tick(this.currentSlot(nowMs));
    if (this.engine.sending || !this.canTransmit) return;
    const slotMs = this.protocol.spec.slotSec * 1000;
    const offsetMs = this.engine.slotGridOffsetMs;
    const txMs = nextSlotStartMs(nowMs - offsetMs, this.protocol.spec, TX_LEAD_MS) + offsetMs;
    const txSlot = Math.round(txMs / slotMs);
    const tx = this.session.nextTxTo(txSlot);
    if (!tx) return;
    const channel = this.txChannel(tx, txSlot);
    if (decodeFrame(tx.payload)?.kind === 'hello') this.onOwnHello?.();
    const symbols = this.codec.encode(tx.payload);
    this.sendingAtMs = this.engine.sendFrame(symbols, channel.baseHz, this.getLevel());
    this.currentTx = { what: this.describeTx(tx.payload, tx.dst), channel: channel.number, icon: this.iconOfPayload(tx.payload) };
    this.frames.add({ atMs: this.sendingAtMs, dir: 'tx', channel: channel.number, snrDb: null, hex: payloadHex(tx.payload) });
    this.status.textContent = viaOf(tx.payload)
      ? `repeating a frame on channel ${channel.number} (${channel.why})`
      : `sending on channel ${channel.number} (${channel.why})`;
    this.refresh();
  }

  /**
   * Where a frame goes. Sounds rotate through the band. Anything else, with auto
   * channel on, goes where the far end reported hearing us best (for a broadcast:
   * the worst case over every station we hear), steering off channels other stations
   * are busy on and keeping the channel used last for that destination; with no link
   * data, on the quietest channel (the selected one on a tie). Auto off: the selected
   * channel, or the middle of the band if none is selected. Auto channel off, or Auto beacon off,
   * with a channel selected: everything (sounds too) goes on the selected channel.
   */
  private txChannel({ payload, dst, survey, msgId, round }: TxOut, slot: number): { number: number; baseHz: number; why: string } {
    const all = this.bandChannels;
    const open = all.filter((c) => !this.blocked.has(c.number));
    const band = open.length > 0 ? open : all;
    const byNumber = (n: number): Channel | undefined => all.find((c) => c.number === n) ?? this.channels.find((c) => c.number === n);
    const numbers = band.map((c) => c.number);
    const pinned = pinnedReason(this.selected !== null, this.autoChannel, this.autoSound);
    if (pinned && this.selected) return { ...this.selected, why: pinned };
    const isSound = survey === true || decodeFrame(payload)?.kind === 'sound';
    // An answer to a probe (dst = the prober) picks its channel like any directed frame.
    if (isSound && dst === BROADCAST && numbers.length > 0) {
      const n = soundChannel(this.session.stationId, this.soundCount++, numbers);
      return { ...byNumber(n)!, why: 'sound rotation' };
    }
    const home = this.selected ?? band[Math.floor(band.length / 2)]!;
    if (this.autoChannel && numbers.length > 0) {
      const load = this.channelLoadAt(slot);
      const busy = (n: number): string => {
        const k = load.get(n) ?? 0;
        return k > 0 ? `, ${k} other station${k === 1 ? '' : 's'} on it lately` : '';
      };
      const to = dst === BROADCAST ? this.lqa.stations(slot) : [dst];
      // A retransmit round of a directed message: all its frames on one channel, and not the one that just got no ack.
      const key = msgId !== undefined && round !== undefined ? `${dst}:${msgId}` : null;
      const last = key ? this.retryRounds.get(key) : undefined;
      if (last && round !== undefined && round > 1 && last.round === round) {
        return { ...byNumber(last.channel)!, why: `retry round ${round}` };
      }
      if (key && last && round !== undefined && round > last.round) {
        const ranked = this.lqa.rankChannels([dst], numbers, slot).filter((s) => s.score >= VIABLE_DB).map((s) => s.channel);
        const r = pickRetryChannel(last.used, numbers, ranked);
        if (r !== undefined) {
          this.noteRetryChannel(key, round, r, last.used);
          this.lastChannelFor.set(dst, r);
          return { ...byNumber(r)!, why: `retry round ${round}, not channel ${last.channel}` };
        }
      }
      let n = this.lqa.chooseChannel(to, numbers, slot, Math.random, { load, prefer: this.lastChannelFor.get(dst) });
      if (n !== undefined) {
        this.lastChannelFor.set(dst, n);
        if (key && round !== undefined) this.noteRetryChannel(key, round, n, last?.used ?? []);
        return { ...byNumber(n)!, why: `best link${busy(n)}` };
      }
      // Nothing known about the link: everyone hears the whole band, so take the quietest channel.
      n = quietestChannel(numbers, load, home.number);
      if (n !== home.number) return { ...byNumber(n)!, why: `no link data yet, channel ${home.number} busy` };
    }
    return { ...home, why: this.selected ? 'selected channel' : 'no link data yet' };
  }

  private noteRetryChannel(key: string, round: number, channel: number, used: readonly number[]): void {
    this.retryRounds.set(key, { round, channel, used: used.includes(channel) ? [...used] : [...used, channel] });
    if (this.retryRounds.size > 32) this.retryRounds.delete(this.retryRounds.keys().next().value!);
  }

  /**
   * Channel -> other transmitters heard on it in the last few slots, from the frame
   * log. A repeat counts as its repeater; our own frames heard back do not count.
   */
  private channelLoadAt(slot: number): Map<number, number> {
    const slotMs = this.protocol.spec.slotSec * 1000;
    const me = this.session.stationId;
    const myTag = this.session.isRepeater ? repeaterTag(me) : 0;
    const heard: HeardOn[] = [];
    const rows = this.frames.all;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      // A frame's time is its start; late or early by up to a few seconds, so round into its slot.
      const at = Math.floor((r.atMs + slotMs / 4) / slotMs);
      if (slot - at > LOAD_WINDOW_SLOTS) break;
      if (r.dir !== 'rx') continue;
      const f = decodeFrame(hexPayload(r.hex));
      if (!f) continue;
      const via = f.via ?? 0;
      if ((via === 0 && f.src === me) || (via !== 0 && via === myTag)) continue;
      heard.push({ slot: at, channel: r.channel, transmitter: via ? `r${via}` : `s${f.src}` });
    }
    return channelLoad(heard, slot);
  }

  /** Call every animation frame; drives the transmitter and timeouts once a second. */
  tick(): void {
    const second = Math.floor(Date.now() / 1000);
    if (second === this.shownSecond) return;
    this.shownSecond = second;
    this.pump();
  }

  private onSendClicked(): void {
    const text = normalizeText(this.input.value).trim();
    if (!text) return;
    try {
      this.session.send(Number(this.dstSelect.value), text);
    } catch (err) {
      this.status.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    this.input.value = '';
    this.pump();
    this.refresh();
  }

  private showResult(result: DecodeResult): void {
    const when = clock(result.slotStartUtcMs);
    if (result.error) {
      console.error(`slot ${when}: decoder error: ${result.error}`);
      return;
    }
    if (result.skipped === 'sending') {
      console.log(`slot ${when}: not decoded, this station was transmitting`);
      return;
    }
    if (result.channels.length === 0) {
      console.log(`slot ${when}: no channel listened to, nothing decoded`);
      return;
    }
    const slot = Math.round(result.slotStartUtcMs / (this.protocol.spec.slotSec * 1000));
    const heard = distinctFrames(result.channels);
    const ours = result.channels.find((c) => c.baseFreqHz === this.selected?.baseHz);
    if (heard.length === 0 && !result.ownTx) {
      let best: { score: number; timeOffsetSec: number } | null = null;
      for (const c of result.channels) if (c.sync && (!best || c.sync.score > best.score)) best = c.sync;
      if (best) {
        this.undecodedSyncs.push({ atMs: result.slotStartUtcMs, score: best.score, dtSec: best.timeOffsetSec });
        if (this.undecodedSyncs.length > 30) this.undecodedSyncs.shift();
      }
    }
    console.log(
      `slot ${when}: ${result.channels.length} channels, ${heard.length === 0 ? 'nothing decoded' : `${heard.length} frame${heard.length === 1 ? '' : 's'}`} ` +
      `(${result.decodeMs.toFixed(0)} ms)` +
      heard.map((h) => ` · ch ${this.channelNumber(h.baseFreqHz)} ${signed(h.frame.snrDb, 0)} dB${h.frame.copies ? ` (${h.frame.copies} copies combined)` : ''}`).join('') +
      // Why nothing decoded, on the channel we transmit on: that is the one being tested.
      (heard.length === 0 && ours?.sync ? this.syncHint(ours.sync) : ''),
    );
    for (const h of heard) {
      const at = result.slotStartUtcMs + h.frame.timeOffsetSec * 1000;
      this.frames.add({ atMs: at, dir: 'rx', channel: this.channelNumber(h.baseFreqHz), snrDb: h.frame.snrDb, dtSec: h.frame.timeOffsetSec + this.engine.slotGridOffsetMs / 1000, freqHz: h.baseFreqHz, hex: payloadHex(h.frame.payload) });
    }
    const heardChannels = heard.map((h) => this.channelNumber(h.baseFreqHz));
    // Clipping is a property of the whole mic signal: flag the channels that carried a frame in that slot.
    // Not while we transmit: our own speaker is then in the microphone by design, and says nothing about other stations.
    const over = !result.ownTx && (result.clipped ?? 0) >= OVERLOAD_MIN_CLIPPED;
    if (over) this.noteOverload(result.peak ?? 1, result.clipped ?? 0);
    // Only other stations' frames count as activity: our own, heard back through the speaker, do not.
    const fromOthers = heard
      .filter((h) => decodeFrame(h.frame.payload)?.src !== this.session.stationId)
      .map((h) => this.channelNumber(h.baseFreqHz));
    this.onActivity?.(fromOthers, over ? heardChannels : []);
    const fromOthersHeard = heard.filter((h) => decodeFrame(h.frame.payload)?.src !== this.session.stationId);
    if (fromOthersHeard.length) {
      const h = fromOthersHeard[0]!;
      const more = fromOthersHeard.length > 1 ? ` (and ${fromOthersHeard.length - 1} more)` : '';
      this.lastAction = {
        atMs: Date.now(),
        text: `received ${this.describeRx(h.frame.payload)} on ch ${this.channelNumber(h.baseFreqHz)}, ${signed(h.frame.snrDb, 0)} dB${more}`,
        icon: this.iconOfPayload(h.frame.payload),
        dir: 'rx',
      };
    }
    for (const h of heard) this.session.receive(h.frame.payload, slot, h.frame.snrDb, this.channelNumber(h.baseFreqHz));
    this.pump();
  }

  private who(id: number): string {
    return id === BROADCAST ? 'everyone' : this.label(id);
  }

  /** A frame we send, in words: "message frame 2/3 to ANA", "network probe", ... */
  private describeTx(payload: Uint8Array, dst: number): string {
    const f = decodeFrame(payload);
    if (!f) return 'a frame';
    if (f.via || f.src !== this.session.stationId) return `a repeat of ${this.label(f.src)}'s ${kindText(f)}`;
    switch (f.kind) {
      case 'first': return `message frame 1/${f.last + 1} to ${this.who(f.dst)}`;
      case 'next': {
        const total = this.session.outlook().sending?.total;
        return `message frame ${f.seq + 1}${total ? `/${total}` : ''} to ${this.who(dst)}`;
      }
      case 'spriteHead': return `sprite frame 1/${spriteFrameCount(f.side, f.bpp)} to ${this.who(f.dst)}`;
      case 'spriteBody': return `sprite frame ${f.seq + 1}/${spriteFrameCount(f.side, f.bpp)} to ${this.who(dst)}`;
      case 'ack': return `ack to ${this.who(f.dst)}`;
      case 'hello': return 'announcement';
      case 'sound': return 'network probe';
    }
  }

  /** A frame from another station, in words: "announcement from ANA", "network probe from #12 through a repeater". */
  private describeRx(payload: Uint8Array): string {
    const f = decodeFrame(payload);
    if (!f) return 'a frame';
    const to = f.kind === 'first' || f.kind === 'spriteHead' || f.kind === 'ack' ? ` to ${f.dst === this.session.stationId ? 'us' : this.who(f.dst)}` : '';
    return `${kindText(f)} from ${this.label(f.src)}${to}${f.via ? ' through a repeater' : ''}`;
  }

  private iconOfPayload(payload: Uint8Array): string {
    const f = decodeFrame(payload);
    return f ? frameIcon(f) : '📡';
  }

  /**
   * What this station will do next, for the activity panel: the words, a picture and a state
   * (`air` = on the air or about to be, `wait` = something is queued or pending, `listen`, `off`).
   */
  nextAction(nowMs = Date.now()): { text: string; icon: string; state: 'off' | 'listen' | 'wait' | 'air' } {
    const as = (state: 'off' | 'listen' | 'wait' | 'air', icon: string, text: string) => ({ text, icon, state });
    if (!this.engine.running) return as('off', '⏸️', 'audio is off');
    if (!this.engine.transmitAllowed) return as('off', '🔇', 'listening only: transmit is off');
    const secs = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));
    const tx = this.transmitWindow;
    if (tx && this.currentTx) {
      const what = `${this.currentTx.what} on ch ${this.currentTx.channel}`;
      if (nowMs < tx.startMs) return as('air', this.currentTx.icon, `waiting ${secs(tx.startMs - nowMs)} s for the slot to transmit ${what}`);
      return as('air', this.currentTx.icon, `transmitting ${what}, ${secs(tx.endMs - nowMs)} s left`);
    }
    if (!this.canTransmit) return as('off', '👂', 'listening: choose a channel (or turn on Auto channel) to transmit');
    const o = this.session.outlook();
    const slotMs = this.protocol.spec.slotSec * 1000;
    const nextSlot = `next slot in ${secs(slotMs - (nowMs % slotMs))} s`;
    if (o.ackDue) return as('wait', '✅', `sending an ack to ${this.label(o.ackDue.to)} (${nextSlot})`);
    if (o.repeats) return as('wait', '🔁', `repeating ${o.repeats} frame${o.repeats === 1 ? '' : 's'} from others (${nextSlot})`);
    // A beacon waits for a quiet slot after our last frame.
    const nowSlot = Math.floor(nowMs / slotMs);
    const beaconWait = o.beaconFromSlot !== null && o.beaconFromSlot > nowSlot + 1
      ? `after a quiet slot, in ${secs(o.beaconFromSlot * slotMs - nowMs)} s`
      : nextSlot;
    if (o.hello) return as('wait', '📣', `sending an announcement (${beaconWait})`);
    if (o.waitingAck) {
      const queued = o.queued ? `; ${o.queued} more message${o.queued === 1 ? '' : 's'} queued` : '';
      return as('wait', '⏳', `waiting for an ack from ${this.who(o.waitingAck.dst)} (up to ${secs((o.waitingAck.untilSlot + 1) * slotMs - nowMs)} s)${queued}`);
    }
    if (o.sending) return as('wait', o.sending.sprite ? '🖼️' : '💬', `sending a ${o.sending.sprite ? 'sprite' : 'message'} to ${this.who(o.sending.dst)}: ${o.sending.left} of ${o.sending.total} frames to go (${nextSlot})`);
    if (o.queued) return as('wait', '💬', `sending ${o.queued} queued message${o.queued === 1 ? '' : 's'} (${nextSlot})`);
    if (o.sound) return as('wait', '📡', `sending a network probe (${beaconWait})`);
    return as('listen', '👂', `listening (${nextSlot})`);
  }

  /** Tell the user, at most every two minutes, that the microphone signal is clipping. */
  private noteOverload(peak: number, clipped: number): void {
    const now = Date.now();
    if (now - this.lastOverloadNoticeMs < OVERLOAD_NOTICE_MS) return;
    this.lastOverloadNoticeMs = now;
    const peakDb = 20 * Math.log10(Math.max(peak, 1e-6));
    this.addNotice(`⚠ microphone overloaded (${clipped} clipped samples, peak ${peakDb.toFixed(1)} dBFS): lower the mic input volume, move the devices apart or lower the other station's level`);
  }

  private channelNumber(baseFreqHz: number): number {
    return this.channels.find((c) => c.baseHz === baseFreqHz)?.number ?? 0;
  }

  /**
   * Why nothing decoded, from the best sync candidate. The best of the whole search
   * scores 0.22-0.24 on pure noise (measured); a real frame that fails to decode
   * still scores 0.3-0.5, and a decodable one 0.5 or more.
   */
  private syncHint(sync: { score: number; timeOffsetSec: number }): string {
    const edge = this.protocol.spec.maxTimeOffsetSec;
    const timing = `dt ${signed(sync.timeOffsetSec, 2)} s of ±${edge} s`;
    if (sync.score < 0.28) return ` · no signal seen (sync ${sync.score.toFixed(2)}, noise ≈ 0.23)`;
    return ` · signal seen but not decoded (sync ${sync.score.toFixed(2)}, ${timing})`;
  }

  private fillRecipients(): void {
    const keep = this.dstSelect.value || String(BROADCAST);
    this.dstSelect.replaceChildren();
    const add = (value: number, label: string): void => {
      const o = document.createElement('option');
      o.value = String(value);
      o.textContent = label;
      this.dstSelect.append(o);
    };
    add(BROADCAST, 'Public');
    for (const [id, name] of this.known) add(id, `${this.iconOf(id)} ${name || `#${id}`}`);
    this.dstSelect.value = [...this.dstSelect.options].some((o) => o.value === keep) ? keep : String(BROADCAST);
  }

  /** A centred line in the chat that is not a message, e.g. a station announcing itself. */
  private addNotice(text: string): void {
    this.add({ kind: 'notice', atMs: Date.now(), text });
  }

  /** Drop notices older than NOTICE_TTL_MS from the log and the screen. */
  private expireNotices(): void {
    const cutoffMs = Date.now() - NOTICE_TTL_MS;
    const before = this.log.length;
    this.log = this.log.filter((e) => e.kind !== 'notice' || e.atMs > cutoffMs);
    for (const li of this.list.querySelectorAll<HTMLElement>('li.notice')) {
      if (Number(li.dataset.atMs) <= cutoffMs) li.remove();
    }
    if (this.log.length !== before) this.chatSaver.touch();
  }

  /** Append to the kept log and show it. */
  private add(entry: LogEntry): Bubble | null {
    this.log.push(entry);
    while (this.log.length > MAX_ROWS) this.log.shift();
    this.chatSaver.touch();
    return this.render(entry, true);
  }

  private render(entry: LogEntry, live = false): Bubble | null {
    if (entry.kind === 'notice') {
      this.appendItem(this.noticeItem(entry), false);
      return null;
    }
    return this.addBubble(entry, live);
  }

  private noticeItem(entry: LogEntry): HTMLElement {
    const item = document.createElement('li');
    item.className = 'notice';
    item.dataset.atMs = String(entry.atMs);
    item.textContent = `${clockShort(entry.atMs)} · ${entry.text}`;
    return item;
  }

  private appendItem(item: HTMLElement, forceScroll: boolean): void {
    const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.list.append(item);
    while (this.list.children.length > MAX_ROWS) this.list.firstElementChild?.remove();
    if (forceScroll || nearBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  /** A station's icon (announced, else the default hash of its id). */
  iconOf(id: number): string {
    return emojiFor(this.icons.get(id) ?? defaultIconIndex(id));
  }

  private label(id: number): string {
    const name = this.known.get(id);
    return `${this.iconOf(id)} ${name ? `${name} (#${id})` : `#${id}`}`;
  }

  private showIncoming(m: InMessage): void {
    if (m.sprite) {
      this.showSprite(m, true);
      return;
    }
    this.onIncoming?.();
    this.notifier?.notify(
      this.label(m.src) + (m.dst === BROADCAST ? '' : ' (to you)'),
      m.text || '(blank)',
      `msg-${m.src}`,
    );
    if (!this.known.has(m.src)) {
      this.known.set(m.src, '');
      this.stationsSaver.touch();
      this.fillRecipients();
    }
    const at = m.slot * this.protocol.spec.slotSec * 1000;
    const ch = this.channels.find((c) => c.number === m.channel);
    this.add({
      kind: 'in',
      atMs: at,
      text: m.text || '(blank)',
      who: this.label(m.src),
      station: m.src,
      ...(m.dst === BROADCAST ? {} : { ack: { src: m.src, msgId: m.msgId, frames: m.frames } }),
      info: [
        ['From', this.label(m.src)],
        ['To', m.dst === BROADCAST ? 'everyone' : 'you'],
        ['Path', m.via ? `repeated by ${this.repeaterName(m.via)}` : 'direct'],
        ['ACK', m.dst === BROADCAST ? 'none (broadcasts are not confirmed)' : `queued back to ${this.label(m.src)}`],
        ['Signal', `${signed(m.snrDb, 0)} dB weakest frame${m.via ? ', the repeater\'s' : ''}`],
        ['Channel', `${ch?.number ?? '?'} · ${ch?.baseHz ?? '?'} Hz`],
        ['Frames', `${m.frames}, complete at ${clock(at)}`],
      ],
    });
  }

  /**
   * A sprite from another station: one chat line that fills in as its frames arrive
   * (`final` false), and is settled by the session's `incoming` (complete, or timed out
   * with frames missing). The line is keyed on the message, so a reused id starts a new one.
   */
  private showSprite(m: InMessage, final: boolean): void {
    const view = m.sprite!;
    const known = this.known.has(m.src);
    if (!known) {
      this.known.set(m.src, '');
      this.stationsSaver.touch();
      this.fillRecipients();
    }
    const at = m.slot * this.protocol.spec.slotSec * 1000;
    const line: SpriteLine = {
      side: view.side, bpp: view.bpp, ...(view.paletteKnown && view.palette ? { palette: paletteToString(view.palette) } : {}),
      pixels: pixelsToString(view), got: m.framesGot ?? 0, frames: m.frames, done: final,
    };
    const fields = {
      text: `sprite ${view.side}×${view.side}`,
      info: this.spriteInInfo(m, at),
      sprite: line,
      ...(m.dst === this.session.stationId ? { ack: { src: m.src, msgId: m.msgId, frames: m.frames } } : {}),
    };
    let shown = this.spriteBubbles.get(m.uid);
    if (!shown) {
      const entry: LogEntry = { kind: 'in', atMs: at, who: this.label(m.src), station: m.src, ...fields };
      shown = { entry, parts: this.add(entry)! };
      this.spriteBubbles.set(m.uid, shown);
      this.onIncoming?.();
    } else {
      Object.assign(shown.entry, fields);
      this.chatSaver.touch();
    }
    shown.parts.sprite?.redraw();
    fillInfo(shown.parts.status, shown.entry, this.ackButton(shown.entry));
    if (!final) return;
    this.spriteBubbles.delete(m.uid);
    this.notifier?.notify(
      this.label(m.src) + (m.dst === this.session.stationId ? ' (to you)' : ''),
      `${fields.text}${m.partial ? ` (partial, ${line.got} of ${line.frames} frames)` : ''}`,
      `msg-${m.src}`,
    );
  }

  /** The ⓘ lines of a received sprite. */
  private spriteInInfo(m: InMessage, at: number): [string, string][] {
    const ch = this.channels.find((c) => c.number === m.channel);
    const got = m.framesGot ?? 0;
    const missing = Array.from({ length: m.frames }, (_, i) => i).filter((i) => !((m.framesMask ?? 0) & (1 << i))).map((i) => i + 1);
    const complete = missing.length === 0;
    let to: string;
    let ack: string;
    if (m.dst === null) {
      to = 'unknown (the first frame, which names it, was not heard)';
      ack = 'none until the first frame is heard';
    } else if (m.dst === BROADCAST) {
      to = 'everyone';
      ack = 'none (broadcasts are not confirmed)';
    } else {
      to = 'you';
      ack = complete ? `queued back to ${this.label(m.src)}` : `sent when ${this.label(m.src)} pauses, listing what is missing`;
    }
    return [
      ['From', this.label(m.src)],
      ['To', to],
      ['Path', m.via ? `repeated by ${this.repeaterName(m.via)}` : 'direct'],
      ['ACK', ack],
      ['Signal', `${signed(m.snrDb, 0)} dB weakest frame${m.via ? ', the repeater\'s' : ''}`],
      ['Channel', `${ch?.number ?? '?'} · ${ch?.baseHz ?? '?'} Hz`],
      ['Sprite', `${m.sprite!.side}×${m.sprite!.side}, ${1 << m.sprite!.bpp} colours`],
      ['Frames', complete ? `${m.frames}, complete at ${clock(at)}` : `${got} of ${m.frames}, missing ${missing.join(', ')}`],
    ];
  }

  private showOutgoing(m: OutMessage): void {
    let entry = this.outBubbles.get(m.localId);
    if (!entry) {
      const record: LogEntry = {
        kind: 'out',
        atMs: Date.now(),
        text: m.text,
        who: m.dst === BROADCAST ? null : `to ${this.label(m.dst)}`,
        station: m.dst === BROADCAST ? undefined : m.dst,
        ...(m.content.kind === 'sprite' ? { sprite: sentSpriteLine(m.content.sprite, m.frames) } : {}),
        info: [],
        stateClass: '',
        stateText: '',
        statusText: '',
      };
      entry = { ...this.add(record)!, entry: record, levelPct: Math.round(this.getLevel() * 100) };
      this.outBubbles.set(m.localId, entry);
    }
    const el = entry.state!;
    const { icon, label, meaning } = this.describeState(m);
    const rec = entry.entry;
    if (m.state === 'delivered' && rec.stateClass !== 'bubble-state state-delivered') this.onDelivered?.();
    rec.stateClass = `bubble-state state-${m.state}`;
    rec.stateText = `${icon} ${label}`;
    rec.statusText = meaning;
    rec.info = this.outInfo(m, `${icon} ${label}`, entry.levelPct);
    this.chatSaver.touch();
    el.className = rec.stateClass;
    el.textContent = rec.stateText;
    el.title = meaning;
    el.onclick = m.state === 'failed'
      ? (e) => {
          e.stopPropagation(); // the bubble itself also reacts to clicks (reply-to-this-station); don't let it re-focus over our text
          this.retryFailed(m);
        }
      : null;
    fillInfo(entry.status, rec);
  }

  /** The ⓘ lines of a sent message, rebuilt on every state change. */
  private outInfo(m: OutMessage, status: string, levelPct: number): [string, string][] {
    const broadcast = m.dst === BROADCAST;
    const all = `${m.frames} frame${m.frames === 1 ? '' : 's'}`;
    const max = this.session.maxRounds;
    let ack: string;
    if (broadcast) ack = 'none (broadcasts are not confirmed)';
    else if (m.state === 'delivered') ack = `all ${all} confirmed`;
    else if (m.ackedFrames > 0) ack = `${m.ackedFrames} of ${all} confirmed`;
    else if (m.state === 'queued' || m.state === 'sending') ack = 'expected after the last frame';
    else ack = m.state === 'failed' ? 'none received' : 'waiting';
    let retry: string;
    if (broadcast) retry = 'none (sent once)';
    else if (m.state === 'failed') retry = `gave up after ${m.round} of ${max} rounds; tap the status to send again`;
    else retry = m.round > 1 ? `round ${m.round} of ${max}` : `none yet (up to ${max - 1} more rounds)`;
    const path = m.echoedFrames > 0
      ? `repeated by ${m.echoedBy !== null ? this.label(m.echoedBy) : 'a repeater'}, ${m.echoedFrames} of ${all} heard back`
      : 'direct (no repeat heard)';
    const sprite = m.content.kind === 'sprite' ? m.content.sprite : null;
    return [
      ['To', broadcast ? 'everyone' : this.label(m.dst)],
      ...(sprite ? [['Sprite', `${sprite.side}×${sprite.side}, ${1 << sprite.bpp} colours`] as [string, string]] : []),
      ['Status', status],
      ['ACK', ack],
      ['Retry', retry],
      ['Path', path],
      ['Frames', `${all}, ${m.framesSent} sent, one per ${this.protocol.spec.slotSec} s slot`],
      ['Level', `${levelPct} %`],
    ];
  }

  /** "Resend ACK" for a received message to us, when we know which message it was. */
  private ackButton(entry: LogEntry): HTMLElement | undefined {
    const ack = entry.kind === 'in' ? entry.ack ?? this.findAck(entry) : undefined;
    if (!ack) return undefined;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bubble-action';
    b.textContent = 'Resend ACK';
    b.title = `Confirm all ${ack.frames} frame${ack.frames === 1 ? '' : 's'} to ${this.label(ack.src)} again, in the next free slot. Use it when the sender keeps resending.`;
    b.addEventListener('click', () => {
      this.session.resendAck(ack.src, ack.msgId, ack.frames);
      this.addNotice(`ACK queued for ${this.label(ack.src)}${this.canTransmit ? ' (sent at the next free slot)' : ' (waits until transmitting is possible)'}`);
      this.pump();
      b.disabled = true;
      b.textContent = 'ACK queued';
      setTimeout(() => { b.disabled = false; b.textContent = 'Resend ACK'; }, this.protocol.spec.slotSec * 2000);
    });
    return b;
  }

  /**
   * For a received line saved before it kept its message id: the newest first frame from
   * that station to us, up to the time the message completed, in the frame log.
   */
  private findAck(entry: LogEntry): LogEntry['ack'] {
    if (entry.station === undefined || !entry.info?.some(([k, v]) => k === 'To' && v === 'you')) return undefined;
    const untilMs = entry.atMs + this.protocol.spec.slotSec * 1000;
    const rows = this.frames.all;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.dir !== 'rx' || r.atMs > untilMs) continue;
      const f = decodeFrame(hexPayload(r.hex));
      if (f?.kind === 'first' && f.src === entry.station && f.dst === this.session.stationId) {
        entry.ack = { src: f.src, msgId: f.msgId, frames: f.last + 1 };
        this.chatSaver.touch();
        return entry.ack;
      }
    }
    return undefined;
  }

  /** "Station1 (#202)", or the tag when no single known repeater has it. */
  private repeaterName(via: Via): string {
    return via.repeater !== null ? this.label(via.repeater) : `a repeater with tag ${via.tag} (not identified)`;
  }

  /** Icon, short label (under the bubble) and a plain explanation (in the details). */
  private describeState(m: OutMessage): { icon: string; label: string; meaning: string } {
    const n = `${m.ackedFrames} of ${m.frames}`;
    switch (m.state) {
      case 'queued':
        return { icon: '⏳', label: 'waiting for a slot', meaning: 'not sent yet: it goes out at the next free 15 s slot, after any message or reply ahead of it.' };
      case 'sending':
        return m.round > 1
          ? { icon: '↻', label: `resending, round ${m.round}`, meaning: `the receiver did not confirm everything, so the missing frames are being sent again (round ${m.round} of the retry limit).` }
          : { icon: '⇡', label: `sending ${Math.min(m.framesSent, m.frames)}/${m.frames}`, meaning: `${m.frames} frame${m.frames === 1 ? '' : 's'} are sent one per slot; this many have gone out.` };
      case 'waiting':
        return m.ackedFrames > 0
          ? { icon: '✓', label: `${n} confirmed`, meaning: `all frames were sent; the receiver confirmed ${n} so far and the rest will be resent.` }
          : { icon: '✓', label: 'sent, waiting for confirmation', meaning: 'all frames were sent; waiting for the receiver to confirm. This takes at least 30 s, and the frames are resent if nothing comes back.' };
      case 'sent':
        return { icon: '✓', label: 'sent', meaning: 'broadcast: all frames were sent. Nobody confirms a message to everyone, so there is no way to know who received it.' };
      case 'delivered':
        return { icon: '✓✓', label: 'delivered', meaning: 'the receiver confirmed every frame.' };
      case 'failed':
        return {
          icon: '✗',
          label: m.ackedFrames > 0 ? `${n} confirmed, tap to retry` : 'not delivered, tap to retry',
          meaning: `no complete confirmation after ${m.round} rounds${m.ackedFrames > 0 ? ` (${n} frames confirmed)` : ''}. The receiver may be out of range, on another channel, or not listening. Tap the status to put its text back in the message box so you can send it again.`,
        };
    }
  }

  /** Builds a bubble from a log entry. Returns the elements that show a sent message's delivery state (null for received ones). */
  private addBubble(entry: LogEntry, forceScroll = false): Bubble {
    const kind = entry.kind === 'out' ? 'out' : 'in';
    const item = document.createElement('li');
    item.className = `bubble bubble-${kind}`;
    const thread = threadOf(entry);
    if (thread !== null) item.dataset.thread = thread;
    if (thread !== null && thread !== (this.currentRecipient === BROADCAST ? 'public' : String(this.currentRecipient))) item.hidden = true;
    if (entry.who) {
      const whoEl = document.createElement('div');
      whoEl.className = 'bubble-who';
      whoEl.textContent = entry.who;
      item.append(whoEl);
    }
    const replyTo = entry.station;
    if (replyTo !== undefined) {
      item.classList.add('bubble-reply');
      item.title = 'Click to reply to this station';
      item.addEventListener('click', (e) => {
        if ((e.target as Element).closest('button')) return;
        if (window.getSelection()?.toString()) return; // selecting text to copy, not replying
        this.selectRecipient(replyTo);
      });
    }
    const sprite = entry.sprite ? this.spriteBlock(entry) : null;
    const textEl = sprite?.el ?? document.createElement('div');
    if (!sprite) {
      textEl.className = 'bubble-text';
      textEl.textContent = entry.text;
    }
    const foot = document.createElement('div');
    foot.className = 'bubble-foot';
    const time = document.createElement('span');
    time.textContent = clockShort(entry.atMs);
    const toggle = document.createElement('button');
    toggle.className = 'info-toggle';
    toggle.type = 'button';
    toggle.textContent = 'ⓘ';
    toggle.title = 'Details';
    toggle.setAttribute('aria-expanded', 'false');
    const info = document.createElement('div');
    info.className = 'bubble-details';
    info.hidden = true;
    fillInfo(info, entry, this.ackButton(entry));
    toggle.addEventListener('click', () => {
      info.hidden = !info.hidden;
      toggle.setAttribute('aria-expanded', String(!info.hidden));
    });
    const state = kind === 'out' ? document.createElement('span') : null;
    if (state) {
      state.className = entry.stateClass ?? '';
      state.textContent = entry.stateText ?? '';
      if (entry.statusText) state.title = entry.statusText;
      foot.append(state);
    }
    foot.append(time, toggle);
    item.append(textEl, foot, info);
    this.appendItem(item, forceScroll && kind === 'out');
    return { state, status: info, ...(sprite ? { sprite } : {}) };
  }

  /** A sprite's canvas and its "n of m frames" note; `redraw` reads the line again (the pixels, the pixel size setting). */
  private spriteBlock(entry: LogEntry): { el: HTMLElement; redraw: () => void } {
    const el = document.createElement('div');
    el.className = 'bubble-text bubble-sprite';
    const canvas = document.createElement('canvas');
    canvas.className = 'sprite-canvas';
    canvas.setAttribute('role', 'img');
    const note = document.createElement('div');
    note.className = 'bubble-sprite-note';
    el.append(canvas, note);
    const redraw = (): void => {
      const line = entry.sprite;
      const view = line && viewFromStrings(line.side, line.bpp, line.palette, line.pixels);
      if (!line || !view) return;
      drawSprite(canvas, view.side, this.spritePx, spriteColours(view, this.spriteHoles), true);
      note.textContent = spriteNote(entry.kind, line);
      canvas.setAttribute('aria-label', `sprite ${line.side}×${line.side}, ${note.textContent}`);
    };
    redraw();
    if (this.spriteRedraws.size > MAX_ROWS) for (const r of this.spriteRedraws) if (!r.canvas.isConnected) this.spriteRedraws.delete(r);
    this.spriteRedraws.add({ canvas, redraw });
    return { el, redraw };
  }
}

/** A sprite we sent, as a chat line: every pixel known. */
function sentSpriteLine(sprite: Sprite, frames: number): SpriteLine {
  const view = viewOf(sprite);
  return { side: sprite.side, bpp: sprite.bpp, ...(sprite.palette ? { palette: paletteToString(sprite.palette) } : {}), pixels: pixelsToString(view), got: frames, frames, done: true };
}

/** Under a sprite: how much of it there is. */
function spriteNote(kind: LogEntry['kind'], line: SpriteLine): string {
  const all = `${line.frames} frame${line.frames === 1 ? '' : 's'}`;
  if (kind === 'out' || line.got >= line.frames) return all;
  return `${line.done ? 'partial' : 'receiving'}, ${line.got} of ${all}`;
}
