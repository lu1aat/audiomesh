/**
 * The Network screen: who we hear, how well they hear us, which channels work.
 * Stations first (status and best channel), then the band's channels ranked,
 * the signal-by-channel table (worst case, they hear us, we hear them), the signal history and the table of all frames.
 *
 * Everything from the air (nicknames) goes in through textContent only.
 */

import { FAIR_DB, GOOD_DB, ageColor, buildLinkModel, formatAge, signalLevel, type GraphEdge, type LinkModel, type RepeaterInfo, type SignalLevel, type StationInfo, type StationStatus } from '../ale/link-model';
import type { LqaTable } from '../ale/lqa';
import { decodeRecord, stationClocks, stationDelays, type FrameLog, type StationDelay } from '../chat/frame-log';
import type { ServerClock } from '../sync/server-clock';
import { clockHints, type UndecodedSync } from '../chat/clock-hint';
import { repeaterTag } from '../chat/frames';
import { FrameTable } from './frame-table';
import { HistoryView } from './history-view';
import { hexBackground, hexGrid, layoutGraph, snapToHexGrid, type LayoutLink } from './graph-layout';

const SVG = 'http://www.w3.org/2000/svg';

/** Line colours, fixed order: categorical slots 1-4 for the dark surface (validated). Later stations are grey. */
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const SERIES_OTHER = '#8a8f98';

const STATUS_TEXT: Record<StationStatus, { icon: string; label: string }> = {
  active: { icon: '●', label: 'active' },
  recent: { icon: '◐', label: 'recent' },
  quiet: { icon: '○', label: 'quiet' },
};

/** Three ways to lay out the Stations list; the user's pick is remembered by the caller. */
export type StationsView = 'cards' | 'table' | 'grid';

const LEVEL_COLOR: Record<SignalLevel, string> = { good: '#3fb26b', fair: '#c98500', weak: '#d9534f' };
/** Generic good/fair/weak text colouring for any table or tile cell (dB, timing, …), not just the card's own .station-signal. */
const LEVEL_CLASS: Record<SignalLevel, string> = { good: 'lvl-good', fair: 'lvl-warn', weak: 'lvl-bad' };
function levelClass(level: SignalLevel | undefined): string {
  return level ? LEVEL_CLASS[level] : 'lvl-none';
}
/** How far off a station's timing is against how far the receiver actually searches: near the edge risks missed frames. */
function timingLevel(deltaSec: number, reachSec: number): SignalLevel {
  if (reachSec <= 0) return 'good';
  const frac = Math.abs(deltaSec) / reachSec;
  return frac > 0.7 ? 'weak' : frac > 0.35 ? 'fair' : 'good';
}
/** Graph stations and links not heard for over ten minutes stay, faded. */
const STALE_OPACITY = 0.4;
/** Other stations' cells are this see-through, so their age colour sits a little darker on the map. */
const NODE_FILL_OPACITY = 0.7;
/** One cycle of the arrows' drifting dashes; matches `.graph-flow` in styles.css. */
const FLOW_PERIOD_MS = 1600;
/** Graph units the honeycomb background runs past the map's square on every side. */
const HEX_OVERFLOW = 260;
const LEVEL_TEXT: Record<SignalLevel, string> = { good: 'strong', fair: 'fair', weak: 'weak' };
/** "Reached us through a repeater" lines: level unknown, so neutral grey. */
const RELAY_COLOR = '#8a8f98';

/** How long a node glows after a frame from that station. */
const FLASH_MS = 1600;
/** How to read the graph: its tooltip (no visible text). */
const GRAPH_LEGEND = 'The stronger the signal between two stations, the closer their cells; we are the blue cell at the bottom. Arrows point the way a signal reaches: green strong, yellow fair, red weak. A link heard both ways is two arrows side by side, one per direction. Grey dotted: that station reached us only through the repeater it points to. A double border marks a repeater. Faded: nothing heard for over 10 minutes. Links between other stations are what they report hearing.';
const ME_COLOR = '#3987e5';
const FLASH_COLOR = '#e6e8eb';

/** Signal history range choices, in minutes. */
const HISTORY_RANGES: readonly { readonly label: string; readonly min: number }[] = [
  { label: '1h', min: 60 },
  { label: '6h', min: 360 },
  { label: '12h', min: 720 },
];

/** A station silent this long gets a broken line in the signal history. */
const HISTORY_GAP_MIN = 10;
/** Up to this many frames in the chart, each marker carries its channel number. */
const HISTORY_CHANNEL_LABELS_MAX = 60;

/** Points of a pointy-top hexagon of circumradius `r` around (cx, cy). */
function hexPoints(r: number, cx = 0, cy = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

interface GraphNode {
  readonly g: SVGGElement;
  readonly halo: SVGCircleElement;
  readonly ring: SVGPolygonElement;
  /** Where the layout wants the node; it glides there. */
  readonly target: { readonly x: number; readonly y: number };
}

/** A link line; its ends follow the nodes while they glide to a new cell. */
interface GraphLine {
  readonly el: SVGLineElement;
  /** A wide invisible twin that catches the pointer: the drawn line is too thin to hover. */
  readonly hit: SVGLineElement;
  /** Faint dashes over the line that drift toward the arrowhead, showing the direction. */
  readonly flow: SVGLineElement;
  readonly from: number;
  readonly to: number;
  /** Sideways offset, so the two directions of a link heard both ways sit side by side. */
  readonly side: number;
  readonly gapFrom: number;
  readonly gapTo: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const dateTime = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const signed = (v: number, digits: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
/** Compact age for a map cell: "12s", "4m", "2h". */
const shortAge = (sec: number): string => (sec < 60 ? `${Math.floor(sec / 10) * 10}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`);
const db = (v: number | undefined): string => (v === undefined ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}`);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** What the Clock section needs besides the frame log. */
export interface ClockOptions {
  readonly undecoded: () => readonly UndecodedSync[];
  readonly deepOn: () => boolean;
  readonly maxTimeOffsetSec: number;
  /** 0 when the protocol has no room for deep decoding. */
  readonly deepExtraSec: number;
  /** Largest slot offset allowed either way. */
  readonly limitMs: number;
  readonly server: ServerClock;
  /** Audio latencies the receive timing is corrected by; null when audio is off. inMs null = the browser does not say. */
  readonly latency: () => { outMs: number; inMs: number | null } | null;
}

export class LinkView {
  private readonly root: HTMLElement;
  /** The network graph sits apart, at the top of the screen beside the controls. */
  private readonly graphRoot: HTMLElement;
  private renderedAt = 0;
  private hovering = false;
  private readonly frameTable: FrameTable;
  private readonly sequence: HistoryView;
  /** Series colour per station, assigned on first sight so a station keeps its colour. */
  private readonly colorIndex = new Map<number, number>();
  /** The graph's live elements, moved every animation frame. */
  private graph: { nodes: Map<number, GraphNode>; lines: GraphLine[] } | null = null;
  /** When each station's newest frame was seen (performance.now()), for the glow. */
  private readonly flashAt = new Map<number, number>();
  private readonly lit = new Set<number>();
  /** Where each node is drawn now (before drift), carried across redraws so a moved node glides. */
  private readonly placed = new Map<number, { x: number; y: number }>();
  private lastAnimMs = 0;
  /** Newest frame record already turned into a flash; -1 = not started (old frames never flash). */
  private lastFrameId = -1;
  private readonly still = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  /** Sections collapsed by the user (by `section()`'s key); not persisted, but survives the periodic
   * re-render. Everything but Stations starts collapsed: Map, Channels and Stations are the screen's
   * main panels, the rest is detail the user opens when they want it. */
  private readonly collapsed = new Set<string>(['history', 'signal-matrix', 'frames']);
  /** Signal history chart range, in minutes; one of HISTORY_RANGES. */
  private historyRange = HISTORY_RANGES[0]!.min;

  constructor(
    private readonly lqa: LqaTable,
    private readonly names: ReadonlyMap<number, string>,
    private readonly getChannels: () => readonly number[],
    private readonly slotSec: number,
    private readonly isVisible: () => boolean,
    private readonly getMyId: () => number,
    private readonly frames: FrameLog,
    private readonly grid: { readonly offsetMs: () => number; readonly set: (ms: number) => void },
    private readonly getRelay: () => RepeaterInfo,
    private readonly clock: ClockOptions,
    private readonly stationsView: { readonly get: () => StationsView; readonly set: (v: StationsView) => void },
    /** Our own nickname ('' when unset), shown in our map cell. */
    private readonly getMyName: () => string,
  ) {
    this.root = document.getElementById('link-view') as HTMLElement;
    this.graphRoot = document.getElementById('network-graph') as HTMLElement;
    this.frameTable = new FrameTable(this.frames, (id) => this.name(id), this.getMyId);
    this.sequence = new HistoryView(
      this.frames,
      (id) => (id === this.getMyId() ? this.getMyName() : this.names.get(id) ?? '') || `#${id}`,
      this.getMyId,
      (id) => {
        if (!this.colorIndex.has(id)) this.colorIndex.set(id, this.colorIndex.size);
        return SERIES[this.colorIndex.get(id)!] ?? SERIES_OTHER;
      },
    );
    // Scrolling moves the graph under a still pointer and no pointerleave comes until the scroll
    // ends, so the redraw pause for hovering would freeze the screen while the page scrolls.
    window.addEventListener('scroll', () => { this.hovering = false; }, { capture: true, passive: true });
  }

  /** Call every animation frame; redraws at most every 4 s, only while the screen is showing. */
  tick(nowMs = Date.now()): void {
    this.noteFrames();
    if (this.isVisible()) {
      this.animateGraph();
      this.sequence.sync();
    }
    // Not while typing a manual offset: redrawing moves the Sync section, which would drop the focus.
    const typing = document.activeElement?.id === 'clock-manual';
    if (!this.isVisible() || this.hovering || this.frameTable.busy || typing || nowMs - this.renderedAt < 4000) return;
    this.render(nowMs);
  }

  /** Redraw now, e.g. when the screen is opened. */
  render(nowMs = Date.now()): void {
    this.renderedAt = nowMs;
    const slot = Math.floor(nowMs / (this.slotSec * 1000));
    const model = buildLinkModel(this.lqa, this.getChannels(), slot, this.slotSec, this.getMyId(), this.getRelay(), this.historyRange * 60);
    for (const s of model.stations) if (!this.colorIndex.has(s.id)) this.colorIndex.set(s.id, this.colorIndex.size);
    // A cropped map (see graphSection) should not be stretched to the height of the Channels card.
    document.getElementById('map-block')?.classList.toggle('map-compact', model.nodes.length - 1 < 3);
    this.renderClock(nowMs);
    const scrollTop = this.frameTable.scrollTop;
    this.frameTable.refresh();
    this.sequence.refresh(nowMs);
    if (model.stations.length === 0) {
      // The map still shows us, alone, so it is clear where others will appear.
      this.graphRoot.replaceChildren(this.graphSection(model));
      this.animateGraph();
      this.swapSections([el('p', 'hint', 'No stations heard yet. Turn Audio on (Network options) on both devices and press "Test" on each; every test beacon and every ack teaches the table.'), ...this.syncBlock()]);
      this.frameTable.scrollTop = scrollTop;
      return;
    }
    this.graphRoot.replaceChildren(this.graphSection(model));
    this.animateGraph();
    this.swapSections([
      this.stationsSection(model),
      this.historySection(model, nowMs),
      ...this.syncBlock(),
      this.signalSection(model),
    ]);
    this.frameTable.scrollTop = scrollTop;
  }

  /** The Sync section is static HTML (its input keeps its value); it is moved in below the signal history. */
  private syncBlock(): HTMLElement[] {
    const block = document.getElementById('sync-block');
    return block ? [block] : [];
  }

  /** Move our slot grid against UTC (clamped by the owner) and redraw. */
  setOffsetMs(ms: number): void {
    this.grid.set(ms);
    this.render();
  }

  // --- clock ------------------------------------------------------------------

  /** The Clock section is static HTML (its input must survive redraws); only its text and hints are filled here. */
  private renderClock(nowMs: number): void {
    const off = this.grid.offsetMs();
    const reach = this.clock.maxTimeOffsetSec + (this.clock.deepOn() ? this.clock.deepExtraSec : 0);
    const state = document.getElementById('clock-state');
    if (state) {
      state.textContent =
        `Slot timing: ${off === 0 ? 'UTC, by this device\'s clock' : `UTC ${signed(off / 1000, 2)} s`}. ` +
        `The receiver finds frames up to ±${reach.toFixed(1)} s off${this.clock.deepOn() ? ' (deep decode)' : ''}; ` +
        `the offset can be set up to ±${(this.clock.limitMs / 1000).toFixed(1)} s.` +
        this.latencyText();
    }
    const manual = document.getElementById('clock-manual') as HTMLInputElement | null;
    if (manual && document.activeElement !== manual) manual.value = (off / 1000).toFixed(2);
    const list = document.querySelector('#clock-hints tbody');
    if (!list) return;
    const hints = clockHints({
      delays: stationDelays(this.frames.all, nowMs - 30 * 60_000),
      offsetMs: off,
      maxTimeOffsetSec: this.clock.maxTimeOffsetSec,
      deepExtraSec: this.clock.deepExtraSec,
      deepOn: this.clock.deepOn(),
      undecoded: this.clock.undecoded(),
      nowMs,
      slotSec: this.slotSec,
      name: (id) => this.name(id),
      myId: this.getMyId(),
      server: this.clock.server.latest,
    });
    this.renderServer(nowMs, off);
    this.renderStationClocks(nowMs);
    list.replaceChildren(
      ...hints.map((h) => {
        const tr = el('tr');
        tr.append(el('td', undefined, h.text));
        const actionTd = el('td', 'hint-action');
        if (h.action) {
          const { offsetMs, label } = h.action;
          const b = el('button', 'btn-action', label);
          b.type = 'button';
          b.disabled = Math.abs(off - offsetMs) < 20;
          b.addEventListener('click', () => this.setOffsetMs(offsetMs));
          actionTd.append(b);
        } else actionTd.textContent = '–';
        tr.append(actionTd);
        return tr;
      }),
    );
  }

  private renderServer(nowMs: number, offMs: number): void {
    const server = this.clock.server;
    const state = document.getElementById('sync-server-state');
    const use = document.getElementById('sync-server-use') as HTMLButtonElement | null;
    const r = server.latest;
    if (use) use.disabled = !r || Math.abs(r.offsetMs - offMs) < 20;
    if (!state) return;
    if (server.busy) {
      state.textContent = 'Checking against the server…';
      return;
    }
    const parts: string[] = [];
    if (server.error) parts.push(`Server check failed: ${server.error}.`);
    if (r) {
      const ms = Math.round(r.offsetMs);
      parts.push(
        `This device's clock is ${Math.abs(ms)} ms ${ms > 0 ? 'ahead of' : ms < 0 ? 'behind' : 'level with'} the server's (±${Math.round(r.uncertaintyMs)} ms, ${formatAge((nowMs - r.atMs) / 1000)}, ${r.samples} requests).`,
      );
      const drift = server.driftMsPerMin;
      if (drift !== null) parts.push(`Drift ${signed(drift, 1)} ms/min over ${server.history.length} checks.`);
    } else if (!server.error) parts.push('Not checked yet.'); // the no-third-party explanation already lives in the button's own tooltip
    state.textContent = parts.join(' ');
  }

  /** Every station's clock as we hear it: offset against ours (and against the server, when checked) and how it drifts. */
  private renderStationClocks(nowMs: number): void {
    const table = document.getElementById('sync-stations');
    if (!table) return;
    const clocks = stationClocks(this.frames.all, nowMs - 30 * 60_000).filter((c) => c.id !== this.getMyId());
    if (clocks.length === 0) {
      table.replaceChildren();
      return;
    }
    const server = this.clock.server.latest;
    const head = el('tr');
    for (const h of ['Station', 'Clock vs ours', ...(server ? ['vs server'] : []), 'Drift', 'Frames', 'Last']) head.append(el('th', undefined, h));
    const rows = clocks.map((c) => {
      const tr = el('tr');
      // Late frames = its clock behind ours.
      const vsOurs = -c.offsetSec;
      tr.append(
        el('td', undefined, this.name(c.id)),
        el('td', 'num', `${signed(vsOurs, 2)} s`),
      );
      // Its clock minus the server's = (its - ours) + (ours - server).
      if (server) tr.append(el('td', 'num', `${signed(vsOurs + server.offsetMs / 1000, 2)} s`));
      tr.append(
        el('td', 'num', c.driftMsPerMin === null ? '–' : `${signed(-c.driftMsPerMin, 1)} ms/min`),
        el('td', 'num', String(c.n)),
        el('td', undefined, formatAge((nowMs - c.lastAtMs) / 1000)),
      );
      return tr;
    });
    const caption = el('caption', 'hint', 'Station clocks as heard over the last 30 min (+ = ahead). Includes audio latency; repeated frames are left out.');
    const thead = el('thead'), tbody = el('tbody');
    thead.append(head);
    tbody.append(...rows);
    table.replaceChildren(caption, thead, tbody);
  }

  private latencyText(): string {
    const l = this.clock.latency();
    if (!l) return '';
    const inText = l.inMs === null ? 'microphone unknown (this browser does not say)' : `microphone ${l.inMs.toFixed(0)} ms`;
    return ` Receive timing is corrected for audio latency: speaker ${l.outMs.toFixed(0)} ms, ${inText}.`;
  }

  /** A station's nickname or #id; our own id reads "me (#914)", so reports about us are not taken for a stranger. */
  private name(id: number): string {
    const icon = this.iconOf(id);
    const pre = icon ? `${icon} ` : '';
    if (id === this.getMyId()) return `${pre}me (#${id})`;
    return `${pre}${this.names.get(id) || `#${id}`}`;
  }

  /** Picture shown before a station's name ('' = none); set by main.ts. */
  iconOf: (id: number) => string = () => '';

  /**
   * A section with a collapsible header, same pattern as the channel/options blocks
   * (a real button, not <details>/<summary>): the open/closed state is kept here so
   * it survives the periodic re-render (every section is rebuilt from scratch each
   * `render()` call). `key` identifies the section for that memory; it is not shown.
   */
  private section(key: string, title: string, note?: string): { root: HTMLElement; body: HTMLElement } {
    const root = el('section', 'link-section');
    const open = !this.collapsed.has(key);
    const bodyId = `lv-body-${key}`;
    const toggle = el('button', 'block-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-controls', bodyId);
    toggle.append(el('span', 'channel-block-title', title));
    const heading = el('h3', 'link-section-heading');
    heading.append(toggle);
    const body = el('div', 'link-section-body');
    body.id = bodyId;
    body.hidden = !open;
    if (note) body.append(el('p', 'hint', note));
    toggle.addEventListener('click', () => {
      const willOpen = this.collapsed.has(key);
      if (willOpen) this.collapsed.delete(key);
      else this.collapsed.add(key);
      toggle.setAttribute('aria-expanded', String(willOpen));
      body.hidden = !willOpen;
    });
    root.append(heading, body);
    return { root, body };
  }

  // --- stations ---------------------------------------------------------------

  private stationsSection(model: LinkModel): HTMLElement {
    const { root: s, body } = this.section('stations', 'Stations');
    const n = model.stations.length;
    const last = model.lastPacket;
    const head = el('div', 'section-head');
    head.append(
      el(
        'p',
        'link-summary',
        `${n} station${n === 1 ? '' : 's'} heard · last packet ${last ? `${formatAge(last.ageSec)} from ${this.name(last.station)}` : '–'}`,
      ),
      this.viewSwitch(),
    );
    body.append(head);
    const delays = stationDelays(this.frames.all);
    const mode = this.stationsView.get();
    if (mode === 'table') body.append(this.stationsTable(model, delays));
    else if (mode === 'grid') body.append(this.stationsGrid(model, delays));
    else {
      const list = el('ul', 'station-list');
      for (const st of model.stations) list.append(this.stationRow(st, delays.get(st.id)));
      body.append(list);
    }
    return s;
  }

  /** Three station layouts, all reachable from the same screen; the pick is remembered. */
  private viewSwitch(): HTMLElement {
    const wrap = el('div', 'view-switch');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Stations layout');
    const options: { id: StationsView; label: string; title: string }[] = [
      { id: 'table', label: 'Table', title: 'One row per station, attributes in columns' },
      { id: 'cards', label: 'Cards', title: 'One detailed card per station' },
      { id: 'grid', label: 'Grid', title: 'Compact tiles, for scanning many stations at a glance' },
    ];
    const current = this.stationsView.get();
    for (const o of options) {
      const b = el('button', o.id === current ? 'active' : undefined, o.label);
      b.type = 'button';
      b.title = o.title;
      b.setAttribute('aria-pressed', String(o.id === current));
      b.addEventListener('click', () => {
        if (this.stationsView.get() === o.id) return;
        this.stationsView.set(o.id);
        this.render();
      });
      wrap.append(b);
    }
    return wrap;
  }

  /** How far off a station's timing can be before the receiver simply stops finding its frames. */
  private timingReachSec(): number {
    return this.clock.maxTimeOffsetSec + (this.clock.deepOn() ? this.clock.deepExtraSec : 0);
  }

  /** Notes column / line shared by the table and grid layouts: repeater relay and relayed-through info. */
  private stationNotes(st: StationInfo): string[] {
    const notes: string[] = [];
    if (st.relayed) notes.push(`via ${st.relayed.via !== null ? this.name(st.relayed.via) : `tag ${st.relayed.tag} (unidentified)`}`);
    if (st.framesVia) notes.push(`relays ${st.framesVia} frame${st.framesVia === 1 ? '' : 's'}`);
    return notes;
  }

  /** Table model: one row per station, attributes in columns; weak signal and off timing are coloured. */
  private stationsTable(model: LinkModel, delays: ReadonlyMap<number, StationDelay>): HTMLElement {
    const wrap = el('div', 'table-wrap');
    const table = el('table', 'station-table');
    const head = el('tr');
    for (const h of ['Station', 'Status', 'Last heard', 'Signal', 'Send on', 'Timing', 'Notes']) head.append(el('th', undefined, h));
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    const reach = this.timingReachSec();
    for (const st of model.stations) {
      const tr = el('tr', `status-${st.status}`);

      const nameTd = el('td', 'st-name-cell');
      const nick = this.names.get(st.id);
      nameTd.append(el('span', 'st-name', nick || `#${st.id}`));
      if (nick) nameTd.append(el('span', 'st-id', `#${st.id}`));
      if (st.repeater) {
        const badge = el('span', 'st-badge', '⟲');
        badge.title = 'Runs a repeater';
        nameTd.append(badge);
      }
      tr.append(nameTd);

      tr.append(el('td', 'st-status', `${STATUS_TEXT[st.status].icon} ${STATUS_TEXT[st.status].label}`));

      const lastTd = el('td', 'num', formatAge(st.ageSec));
      lastTd.title = dateTime(st.lastSlot * this.slotSec * 1000);
      tr.append(lastTd);

      const sigTd = el(
        'td',
        `num ${levelClass(st.level)}`,
        st.lastSnrDb === undefined ? '–' : `${db(st.lastSnrDb)} dB · ch ${st.lastChannel}`,
      );
      tr.append(sigTd);

      const sendTd = el(
        'td',
        `num ${levelClass(st.best ? signalLevel(st.best.score) : undefined)}`,
        st.best ? `ch ${st.best.channel} · ${db(st.best.score)} dB` : '–',
      );
      if (st.best) sendTd.title = st.best.measured ? 'reported by them' : 'estimated';
      tr.append(sendTd);

      const delay = delays.get(st.id);
      const timeTd = el('td');
      if (delay) {
        timeTd.className = `num ${levelClass(timingLevel(delay.delaySec, reach))}`;
        timeTd.title = `median of ${delay.n} frames vs UTC slots`;
        timeTd.append(document.createTextNode(`${signed(delay.delaySec, 2)} s `), this.syncButton(delay));
      } else {
        timeTd.className = 'num lvl-none';
        timeTd.textContent = '–';
      }
      tr.append(timeTd);

      const notes = this.stationNotes(st);
      tr.append(el('td', 'st-notes', notes.length ? notes.join(' · ') : '–'));

      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  /** Grid model: compact coloured tiles, for scanning many stations at once with less detail per one. */
  private stationsGrid(model: LinkModel, delays: ReadonlyMap<number, StationDelay>): HTMLElement {
    const grid = el('div', 'station-grid');
    const reach = this.timingReachSec();
    for (const st of model.stations) {
      const tile = el('div', `station-tile status-${st.status}`);
      const nick = this.names.get(st.id);
      const name = el('div', 'tile-name', nick || `#${st.id}`);
      if (nick) name.append(el('span', 'tile-id', ` #${st.id}`));
      if (st.repeater) name.append(el('span', 'tile-badge', ' ⟲'));
      tile.append(name);
      tile.append(el('div', `tile-signal ${levelClass(st.level)}`, st.lastSnrDb === undefined ? '–' : `${db(st.lastSnrDb)} dB`));
      const metaBits = [`${STATUS_TEXT[st.status].icon} ${STATUS_TEXT[st.status].label}`, formatAge(st.ageSec)];
      if (st.lastChannel !== undefined) metaBits.push(`ch ${st.lastChannel}`);
      tile.append(el('div', 'tile-meta', metaBits.join(' · ')));
      const delay = delays.get(st.id);
      if (delay) {
        const timing = el('div', `tile-timing ${levelClass(timingLevel(delay.delaySec, reach))}`);
        timing.append(document.createTextNode(`Δ ${signed(delay.delaySec, 2)} s `), this.syncButton(delay));
        tile.append(timing);
      }
      const notes = this.stationNotes(st);
      if (notes.length) tile.append(el('div', 'tile-note', notes.join(' · ')));
      grid.append(tile);
    }
    return grid;
  }

  /** "Sync to this station": shift our slot grid to match its median frame start. Shared by all three station layouts. */
  private syncButton(delay: StationDelay, label = 'Sync'): HTMLButtonElement {
    const ms = Math.round(delay.delaySec * 1000);
    const synced = Math.abs(this.grid.offsetMs() - ms) < 20;
    const sync = el('button', 'station-sync', synced ? 'Synced' : label);
    sync.type = 'button';
    sync.disabled = synced;
    sync.title = `Shift our slot timing by ${signed(delay.delaySec, 2)} s so this station's frames start at the slot boundary`;
    sync.addEventListener('click', () => { this.grid.set(ms); this.render(); });
    return sync;
  }

  /**
   * One station, read at a glance: on the left its name (big), status and when it was
   * last heard; on the right the details as label / value pairs.
   */
  private stationRow(st: StationInfo, delay?: StationDelay): HTMLElement {
    const row = el('li', `station-row status-${st.status}`);

    const main = el('div', 'station-main');
    const nick = this.names.get(st.id);
    const title = el('div', 'station-title');
    title.append(el('span', 'station-name', nick || `#${st.id}`));
    if (nick) title.append(el('span', 'station-id', `#${st.id}`));
    if (st.repeater) {
      const badge = el('span', 'station-repeater', '⟲ repeater');
      badge.title = 'This station repeats every frame it hears, so stations out of each other\'s range can reach one another';
      title.append(badge);
    }
    const state = el('div', 'station-state');
    state.append(
      el('span', 'station-status', `${STATUS_TEXT[st.status].icon} ${STATUS_TEXT[st.status].label}`),
      el('span', 'station-age', formatAge(st.ageSec)),
    );
    main.append(title, state, el('div', 'station-seen', `last seen ${dateTime(st.lastSlot * this.slotSec * 1000)}`));

    const details = el('dl', 'station-details');
    const item = (label: string, ...value: (Node | string)[]): void => {
      const dd = el('dd');
      dd.append(...value);
      details.append(el('dt', undefined, label), dd);
    };
    const level = st.level ?? 'weak';
    const signal = el('span', `station-signal level-${st.level ?? 'none'}`, st.level ? `● ${LEVEL_TEXT[level]}` : '○ –');
    item('Signal', signal, st.lastSnrDb === undefined ? (st.direct ? '' : ' only heard through a repeater') : ` ${db(st.lastSnrDb)} dB on ch ${st.lastChannel}`);
    if (st.relayed) {
      const by = st.relayed.via !== null ? `repeater ${this.name(st.relayed.via)}` : `a repeater with tag ${st.relayed.tag} (not identified)`;
      item('Through', `${by}, ${formatAge(st.relayed.ageSec)}`);
    }
    item(
      'Send on',
      st.best ? `ch ${st.best.channel} (${db(st.best.score)} dB, ${st.best.measured ? 'reported by them' : 'estimated'})` : 'unknown yet',
    );
    if (delay) item('Timing', `${signed(delay.delaySec, 2)} s vs UTC slots (median of ${delay.n}) `, this.syncButton(delay, 'Sync to this station'));
    else item('Timing', '–');
    if (st.framesVia) item('Relayed', `${st.framesVia} frame${st.framesVia === 1 ? '' : 's'} from others reached us through it`);

    row.append(main, details);
    return row;
  }


  // --- graph ------------------------------------------------------------------

  private graphSection(model: LinkModel): HTMLElement {
    const s = el('section', 'link-section');
    const nodes = model.nodes;
    this.graph = null;
    if (nodes.length === 0) return s;
    const W = 360, C = W / 2, NR = 30;
    const chart = svg('svg', { viewBox: `0 0 ${W} ${W}`, class: 'graph-chart', role: 'img', 'aria-label': `Stations and the links between them: ${model.edges.length} links` });
    // The legend as a description, not a title: a title would show as a tooltip over the whole graph.
    const legend = svg('desc', {});
    legend.textContent = GRAPH_LEGEND;
    chart.append(legend);
    const wrap = el('div', 'graph-wrap');
    const tip = el('div', 'chart-tip graph-tip');
    tip.hidden = true;
    const showTip = (e: PointerEvent, text: string): void => {
      const box = wrap.getBoundingClientRect();
      tip.textContent = text;
      tip.hidden = false;
      tip.style.left = `${e.clientX - box.left}px`;
      tip.style.top = `${e.clientY - box.top}px`;
    };
    /** Hover target: the tip follows the pointer, the target (and what it names) lights up. */
    const hoverable = (target: Element, text: () => string, hot: () => Element[]): void => {
      target.addEventListener('pointermove', (e) => showTip(e as PointerEvent, text()));
      target.addEventListener('pointerenter', () => { for (const h of hot()) h.classList.add('graph-hot'); });
      target.addEventListener('pointerleave', () => {
        tip.hidden = true;
        for (const h of hot()) h.classList.remove('graph-hot');
      });
    };
    chart.addEventListener('pointerenter', () => { this.hovering = true; });
    chart.addEventListener('pointerleave', () => { this.hovering = false; tip.hidden = true; });
    const stationInfo = new Map(model.stations.map((st) => [st.id, st]));
    // The graph is rebuilt on every redraw; start each flow at the phase the clock says, so
    // the drift carries on across redraws instead of jumping back.
    const flowPhase = `-${Math.round(performance.now() % FLOW_PERIOD_MS)}ms`;
    const flowLine = (): SVGLineElement => {
      const f = svg('line', { class: 'graph-flow' });
      f.style.animationDelay = flowPhase;
      return f;
    };
    const defs = svg('defs', {});
    const colors: Record<string, string> = { ...LEVEL_COLOR, relay: RELAY_COLOR };
    for (const [name, color] of Object.entries(colors)) {
      // Fixed size in graph units, not scaled by the line width.
      const m = svg('marker', {
        id: `arrow-${name}`, viewBox: '0 0 8 8', refX: 4.5, refY: 4, markerUnits: 'userSpaceOnUse', markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
      });
      // The line ends inside the head (refX 4.5, where the head is wider than the line), so its
      // butt end never shows at the tip; a round join softens the corners.
      m.append(svg('path', { d: 'M0.8,0.8 L7.2,4 L0.8,7.2 z', fill: color, stroke: color, 'stroke-width': 1, 'stroke-linejoin': 'round' }));
      defs.append(m);
    }
    const blur = svg('filter', { id: 'node-glow', x: '-100%', y: '-100%', width: '300%', height: '300%' });
    blur.append(svg('feGaussianBlur', { stdDeviation: 5 }));
    defs.append(blur);
    chart.append(defs);
    // Stronger signal between two stations = shorter link; we sit in the middle.
    const best = new Map<string, LayoutLink>();
    for (const e of model.edges) {
      const key = e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
      const had = best.get(key);
      if (!had || had.snrDb === undefined || e.snrDb > had.snrDb) best.set(key, { a: e.from, b: e.to, snrDb: e.snrDb });
    }
    for (const r of model.relays) {
      const key = r.from < r.via ? `${r.from}-${r.via}` : `${r.via}-${r.from}`;
      if (!best.has(key)) best.set(key, { a: r.from, b: r.via });
    }
    // The spring layout says where each station would ideally sit; each then takes the
    // nearest free cell of the honeycomb, strongest link to us first.
    // Our cell sits 16 units above the bottom edge so the name under it fits.
    const cells = hexGrid(W, NR, 16);
    const me = this.getMyId();
    const ideal = layoutGraph(nodes, [...best.values()], me, {
      size: W, margin: NR + 16, minDist: 120, maxDist: 290, minSep: 105, clearance: NR + 13,
      anchor: { x: C, y: cells[0]!.y },
    });
    const toMe = (id: number): number =>
      Math.max(-99, ...model.edges.filter((e) => (e.from === id && e.to === me) || (e.to === id && e.from === me)).map((e) => e.snrDb));
    const order = nodes.filter((id) => id !== me).sort((a, b) => toMe(b) - toMe(a) || a - b);
    const pos = snapToHexGrid(ideal, order, me, cells, NR, W);
    // With fewer than three other stations the top of the map is empty: cut it off. The viewBox
    // keeps the width, so cells and stations stay the same size; only the height shrinks.
    if (nodes.length - 1 < 3) {
      const cropTop = Math.max(0, Math.floor(Math.min(...[...pos.values()].map((c) => c.y)) - NR - 18));
      chart.setAttribute('viewBox', `0 ${cropTop} ${W} ${W - cropTop}`);
    }

    const grid = svg('g', { class: 'hex-grid', 'aria-hidden': 'true' });
    // The card is wider and taller than the square: carry the pattern on to its border (the svg overflows, the card clips).
    for (const c of hexBackground(W, NR, 16, HEX_OVERFLOW)) grid.append(svg('polygon', { points: hexPoints(NR - 2, c.x, c.y), class: 'hex-cell' }));
    chart.append(grid);
    const lines: GraphLine[] = [];
    const gap = NR + 3;

    const has = new Map(model.edges.map((e) => [`${e.from}>${e.to}`, e]));
    const drawn = new Set<string>();
    // One arrow per direction heard: a link heard both ways is two arrows side by side,
    // a one-way link a single arrow down the middle.
    for (const e of model.edges) {
      if (!pos.has(e.from) || !pos.has(e.to)) continue;
      const back = has.get(`${e.to}>${e.from}`);
      const l = svg('line', {
        stroke: LEVEL_COLOR[e.level], 'stroke-width': e.level === 'good' ? 2 : 1.5, 'stroke-dasharray': e.level === 'weak' ? '4 3' : '',
        'marker-end': `url(#arrow-${e.level})`,
      });
      if (e.stale) l.setAttribute('opacity', String(STALE_OPACITY));
      const flow = flowLine();
      if (e.stale) flow.setAttribute('opacity', String(STALE_OPACITY));
      const hit = svg('line', { class: 'graph-hit' });
      const way = (x: GraphEdge): string =>
        `${this.name(x.from)} → ${this.name(x.to)}: ${db(x.snrDb)} dB (${LEVEL_TEXT[x.level]})${x.stale ? ', over 10 min old' : ''}`;
      hoverable(hit, () => [way(e), ...(back ? [way(back)] : [])].join('\n'), () => [l]);
      lines.push({ el: l, hit, flow, from: e.from, to: e.to, side: back ? 4 : 0, gapFrom: gap, gapTo: gap });
      chart.append(l, flow, hit);
      drawn.add(`${e.from}>${e.to}`);
    }

    for (const r of model.relays) {
      if (!pos.has(r.from) || !pos.has(r.via) || drawn.has(`${r.from}>${r.via}`)) continue; // a measured link says more
      const l = svg('line', {
        stroke: RELAY_COLOR, 'stroke-width': 1.5, 'stroke-dasharray': '1 4', 'stroke-linecap': 'round', 'marker-end': 'url(#arrow-relay)',
      });
      if (r.stale) l.setAttribute('opacity', String(STALE_OPACITY));
      const flow = flowLine();
      if (r.stale) flow.setAttribute('opacity', String(STALE_OPACITY));
      const hit = svg('line', { class: 'graph-hit' });
      hoverable(hit, () => `${this.name(r.from)} reached us through repeater ${this.name(r.via)} (signal level unknown)`, () => [l]);
      lines.push({ el: l, hit, flow, from: r.from, to: r.via, side: 0, gapFrom: gap, gapTo: gap });
      chart.append(l, flow, hit);
    }

    const stale = new Set(model.staleNodes);
    const repeaters = new Set(model.repeaters);
    const graphNodes = new Map<number, GraphNode>();
    for (const id of nodes) {
      const p = pos.get(id);
      if (!p) continue; // the honeycomb is full
      const g = svg('g', stale.has(id) ? { opacity: STALE_OPACITY } : {});
      if (!this.placed.has(id)) this.placed.set(id, { x: p.x, y: p.y });
      const glow = id === me ? ME_COLOR : FLASH_COLOR;
      const halo = svg('circle', { cx: 0, cy: 0, r: NR + 6, fill: glow, filter: 'url(#node-glow)', opacity: 0, 'pointer-events': 'none' });
      const ring = svg('polygon', { points: hexPoints(NR - 2), fill: 'none', stroke: glow, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', opacity: 0, 'pointer-events': 'none' });
      g.append(halo, ring);
      // Us: white. Others: green when heard in the last minute, then orange, red and grey as time passes
      // (only mentioned by others, never heard: grey).
      const info = stationInfo.get(id);
      const age = info && Math.min(info.ageSec, info.relayed?.ageSec ?? Infinity);
      const tone = id === me ? null : ageColor(age ?? Infinity, NODE_FILL_OPACITY);
      const dark = id === me || tone!.darkText;
      const cls = `graph-node${id === me ? ' graph-me' : ''}`;
      const body = svg('polygon', { points: hexPoints(NR - 2), class: cls });
      if (tone) {
        body.style.fill = tone.fill;
        body.style.fillOpacity = String(NODE_FILL_OPACITY);
      }
      g.append(body);
      // A repeater: a hexagon like any station, with a second border inside it.
      if (repeaters.has(id)) g.append(svg('polygon', { points: hexPoints(NR - 6), class: `graph-repeater${dark ? ' graph-repeater-dark' : ''}`, 'pointer-events': 'none' }));
      // In the cell: the station's emoji and under it how long ago it was last heard (only the emoji for us). Outside it: the nickname
      // (ours from Settings), or the #id when there is none.
      // The station's emoji sits above the time (ours alone, centred: there is no time for us).
      const emoji = this.iconOf(id);
      if (emoji) {
        const pic = svg('text', { x: 0, y: id === me ? 7 : -5, class: 'graph-emoji', 'text-anchor': 'middle', 'pointer-events': 'none' });
        pic.textContent = emoji;
        g.append(pic);
      }
      if (id !== me) {
        const inner = svg('text', { x: 0, y: emoji ? 9 : 2, class: `graph-id${dark ? ' graph-id-dark' : ''}`, 'text-anchor': 'middle' });
        inner.textContent = age === undefined || !Number.isFinite(age) ? '–' : shortAge(age);
        g.append(inner);
        // How loud we hear it (SNR of its last frames at our end), when we have heard it at all.
        const heard = model.edges.find((e) => e.from === id && e.to === me);
        if (heard) {
          const snr = svg('text', { x: 0, y: emoji ? 21 : 14, class: `graph-snr${dark ? ' graph-id-dark' : ''}`, 'text-anchor': 'middle', 'pointer-events': 'none' });
          snr.textContent = `${db(heard.snrDb)} dB`;
          g.append(snr);
        }
      }
      const nick = id === me ? this.getMyName() : this.names.get(id) ?? '';
      // Other stations: the name above the cell. Us: below it (the arrows come from above).
      const label = svg('text', { x: 0, y: id === me ? NR + 12 : -NR - 2, class: 'chart-label', 'text-anchor': 'middle' });
      label.textContent = nick || `#${id}`;
      g.append(label);
      graphNodes.set(id, { g, halo, ring, target: { x: p.x, y: p.y } });
      hoverable(g, () => this.nodeTip(id, stationInfo.get(id), repeaters.has(id), stale.has(id)), () => [
        g,
        ...lines.filter((l) => l.from === id || l.to === id).map((l) => l.el),
      ]);
      chart.append(g);
    }
    this.graph = { nodes: graphNodes, lines };
    this.lit.clear();
    wrap.append(chart, tip);
    s.append(wrap);
    if (model.edges.length === 0 && model.relays.length === 0) s.append(el('p', 'hint', 'No links known yet.'));
    return s;
  }

  /** What hovering a station in the graph tells. */
  private nodeTip(id: number, st: StationInfo | undefined, repeater: boolean, stale: boolean): string {
    const me = id === this.getMyId();
    const nick = me ? '' : this.names.get(id);
    const lines = [me ? `This station (#${id})` : nick ? `${nick} (#${id})` : `#${id}`];
    if (st) {
      lines.push(`${STATUS_TEXT[st.status].label} · last heard ${formatAge(st.ageSec)}`);
      if (st.lastSnrDb !== undefined) lines.push(`last signal ${db(st.lastSnrDb)} dB on ch ${st.lastChannel}${st.level ? ` (${LEVEL_TEXT[st.level]})` : ''}`);
      lines.push(st.best ? `send on ch ${st.best.channel} (${db(st.best.score)} dB, ${st.best.measured ? 'reported by them' : 'estimated'})` : 'send on: unknown yet');
      if (st.framesVia) lines.push(`${st.framesVia} frame${st.framesVia === 1 ? '' : 's'} from others reached us through it`);
    } else if (!me) lines.push('only mentioned by other stations');
    if (repeater) lines.push(me ? 'we run a repeater' : 'runs a repeater');
    if (stale) lines.push('nothing heard for over 10 minutes');
    return lines.join('\n');
  }

  /** New frames in the log light up their sender (and the repeater that relayed them); ours light up "me". */
  private noteFrames(): void {
    const rows = this.frames.all;
    const newest = rows.length ? rows[rows.length - 1]!.id : 0;
    if (this.lastFrameId < 0 || newest < this.lastFrameId) {
      this.lastFrameId = newest;
      return;
    }
    const now = performance.now();
    for (let i = rows.length - 1; i >= 0 && rows[i]!.id > this.lastFrameId; i--) {
      const r = rows[i]!;
      if (r.dir === 'tx') {
        this.flashAt.set(this.getMyId(), now);
        continue;
      }
      const f = decodeRecord(r);
      if (f.src !== undefined) this.flashAt.set(f.src, now);
      if (f.via) {
        const by = [...this.getRelay().repeaters.keys()].filter((id) => repeaterTag(id) === f.via);
        if (by.length === 1) this.flashAt.set(by[0]!, now);
      }
    }
    this.lastFrameId = newest;
  }

  /** A node glides to a new cell; a node that just sent a frame glows and sends out a ring. */
  private animateGraph(): void {
    if (!this.graph) return;
    const now = performance.now();
    const still = this.still?.matches ?? false;
    // Glide to a new place over about a second and a half, whatever the frame rate.
    const ease = still ? 1 : 1 - Math.exp(-Math.min(250, now - this.lastAnimMs) / 500);
    this.lastAnimMs = now;
    const at = new Map<number, { x: number; y: number }>();
    for (const [id, n] of this.graph.nodes) {
      const cur = this.placed.get(id) ?? { ...n.target };
      cur.x += (n.target.x - cur.x) * ease;
      cur.y += (n.target.y - cur.y) * ease;
      this.placed.set(id, cur);
      const x = cur.x, y = cur.y;
      at.set(id, { x, y });
      n.g.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      const age = now - (this.flashAt.get(id) ?? -Infinity);
      if (age < FLASH_MS) {
        const k = 1 - age / FLASH_MS;
        n.halo.setAttribute('opacity', (0.9 * k * k).toFixed(3));
        n.ring.setAttribute('opacity', still ? '0' : (0.8 * k).toFixed(3));
        n.ring.setAttribute('transform', `scale(${(1 + 1.4 * (1 - k)).toFixed(3)})`);
        this.lit.add(id);
      } else if (this.lit.delete(id)) {
        n.halo.setAttribute('opacity', '0');
        n.ring.setAttribute('opacity', '0');
      }
    }
    for (const l of this.graph.lines) {
      const a = at.get(l.from), b = at.get(l.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const ox = -uy * l.side, oy = ux * l.side;
      const x1 = (a.x + ux * l.gapFrom + ox).toFixed(2), y1 = (a.y + uy * l.gapFrom + oy).toFixed(2);
      const x2 = (b.x - ux * l.gapTo + ox).toFixed(2), y2 = (b.y - uy * l.gapTo + oy).toFixed(2);
      for (const e of [l.el, l.flow, l.hit]) {
        e.setAttribute('x1', x1);
        e.setAttribute('y1', y1);
        e.setAttribute('x2', x2);
        e.setAttribute('y2', y2);
      }
    }
  }

  // --- signal by channel -----------------------------------------------------

  /** One table, one column per channel: the worst case over all stations (what channel choice
   * goes by, top three numbered), then what each station reports hearing from us, then what we hear from each. */
  private signalSection(model: LinkModel): HTMLElement {
    const n = model.stations.length;
    const { root: s, body } = this.section(
      'signal-matrix',
      'Signal by channel',
      `SNR in dB (2500 Hz bandwidth); · means no data. "For everyone" is the weakest report from the ${n} station${n === 1 ? '' : 's'} heard, and its three best channels are numbered. A bordered cell is the channel we send on to that station.`,
    );
    const table = el('table', 'signal-matrix');
    const head = el('tr');
    head.append(el('th', 'sm-corner', 'Channel'));
    for (const c of model.channels) head.append(el('th', 'sm-ch', String(c.channel)));
    table.append(el('thead'));
    table.tHead!.append(head);

    const summary = el('tbody', 'sm-summary');
    const all = el('tr');
    all.append(el('th', 'sm-station', 'For everyone'));
    for (const c of model.channels) {
      const td = this.signalCell(c.score, `channel ${c.channel}, weakest report: ${c.score === undefined ? 'no data' : `${db(c.score)} dB`}${c.rank ? `, rank ${c.rank}` : ''}`);
      if (c.rank) {
        td.classList.add('sm-pick');
        td.prepend(el('span', 'sm-rank', String(c.rank)));
      }
      all.append(td);
    }
    summary.append(all);
    table.append(summary);

    const group = (label: string, kind: 'heard' | 'reported'): HTMLTableSectionElement => {
      const tbody = el('tbody');
      const title = el('tr', 'sm-group');
      const th = el('th', undefined, label);
      th.colSpan = model.channels.length + 1;
      title.append(th);
      tbody.append(title);
      for (const st of model.stations) {
        const tr = el('tr');
        const name = el('th', 'sm-station');
        const nick = this.names.get(st.id);
        name.append(el('span', 'st-name', nick || `#${st.id}`));
        if (nick) name.append(el('span', 'st-id', `#${st.id}`));
        tr.append(name);
        for (const c of model.channels) {
          const r = model.rows.find((x) => x.station === st.id && x.channel === c.channel);
          const v = kind === 'heard' ? r?.heardDb : r?.reportedDb;
          const td = this.signalCell(v, `${this.name(st.id)}, channel ${c.channel}: ${v === undefined ? 'no data' : `${db(v)} dB`}`);
          if (kind === 'reported' && st.best?.channel === c.channel) {
            td.classList.add('sm-pick');
            td.title += ', we send to this station here';
          }
          tr.append(td);
        }
        tbody.append(tr);
      }
      return tbody;
    };
    table.append(group('They hear us (their reports)', 'reported'), group('We hear them', 'heard'));

    const wrap = el('div', 'table-scroll');
    wrap.append(table);
    body.append(wrap);
    return s;
  }

  /** A dB value coloured by the shared green / yellow / red signal levels. */
  private signalCell(v: number | undefined, title: string): HTMLTableCellElement {
    const td = el('td', v === undefined ? 'sm-cell sm-empty' : `sm-cell level-${signalLevel(v)}`, v === undefined ? '·' : db(v));
    td.title = title;
    return td;
  }

  // --- history chart ----------------------------------------------------------

  /** The chart's range button group: `history()`'s own memory (1000 raw decodes) may hold less
   * than the longer ranges ask for on a busy band, in which case the chart just shows what it has. */
  private historyRangeSwitch(): HTMLElement {
    const wrap = el('div', 'view-switch');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Signal history range');
    for (const r of HISTORY_RANGES) {
      const b = el('button', r.min === this.historyRange ? 'active' : undefined, r.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(r.min === this.historyRange));
      b.addEventListener('click', () => {
        if (this.historyRange === r.min) return;
        this.historyRange = r.min;
        this.render();
      });
      wrap.append(b);
    }
    return wrap;
  }

  private historySection(model: LinkModel, nowMs: number): HTMLElement {
    const rangeMin = this.historyRange;
    const rangeLabel = HISTORY_RANGES.find((r) => r.min === rangeMin)?.label ?? `${rangeMin} min`;
    const { root: s, body } = this.section('history', 'Signal history');
    const head = el('div', 'section-head');
    head.append(el('div'), this.historyRangeSwitch());
    body.insertBefore(head, body.firstChild);
    if (model.samples.length === 0) {
      body.append(el('p', 'hint', `No frames decoded in the last ${rangeLabel}.`));
      return s;
    }
    const W = 900, H = 200, L = 32, R = 70, T = 8, B = 20;
    const t1 = nowMs, t0 = nowMs - rangeMin * 60 * 1000;
    const yMin = -24, yMax = 6;
    const x = (ms: number): number => L + ((ms - t0) / (t1 - t0)) * (W - L - R);
    const y = (v: number): number => T + ((yMax - Math.max(yMin, Math.min(yMax, v))) / (yMax - yMin)) * (H - T - B);

    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'history-chart', role: 'img', 'aria-label': `SNR of decoded frames over the last ${rangeLabel}, one line per station; the table below has the same numbers` });
    // Quality bands behind everything, in the same green / yellow / red as the rest of the screen.
    for (const [hi, lo, cls, name] of [[yMax, GOOD_DB, 'good', 'good'], [GOOD_DB, FAIR_DB, 'fair', 'fair'], [FAIR_DB, yMin, 'weak', 'weak']] as const) {
      chart.append(svg('rect', { x: L, y: y(hi), width: W - L - R, height: y(lo) - y(hi), class: `chart-band chart-band-${cls}` }));
      const t = svg('text', { x: L + 6, y: y(hi) + 9, class: `chart-band-name chart-band-name-${cls}` });
      t.textContent = name;
      chart.append(t);
    }
    for (const v of [-24, -18, -12, -6, 0]) {
      chart.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === GOOD_DB || v === FAIR_DB ? 'chart-threshold' : 'chart-grid' }));
      const t = svg('text', { x: L - 6, y: y(v) + 4, class: 'chart-axis', 'text-anchor': 'end' });
      t.textContent = `${v}`;
      chart.append(t);
    }
    // A handful of grid lines back from now, spaced to suit the chosen range, each labelled.
    const stepMin = rangeMin <= 60 ? 10 : rangeMin <= 360 ? 60 : 120;
    for (let m = 0; m <= rangeMin; m += stepMin) {
      const ms = t1 - m * 60 * 1000;
      chart.append(svg('line', { x1: x(ms), x2: x(ms), y1: T, y2: H - B, class: 'chart-grid' }));
      const t = svg('text', { x: x(ms), y: H - 6, class: 'chart-axis', 'text-anchor': 'middle' });
      t.textContent = m === 0 ? 'now' : m % 60 === 0 ? `−${m / 60} h` : `−${m} min`;
      chart.append(t);
    }
    const unit = svg('text', { x: 4, y: T + 4, class: 'chart-axis' });
    unit.textContent = 'dB';
    chart.append(unit);

    const tip = el('div', 'chart-tip');
    tip.hidden = true;
    const wrap = el('div', 'chart-wrap');
    const legend = el('div', 'chart-legend');

    const points: { px: number; py: number; text: string }[] = [];
    for (const st of model.stations) {
      const idx = this.colorIndex.get(st.id) ?? 0;
      const color = SERIES[idx] ?? SERIES_OTHER;
      const mine = model.samples.filter((p) => p.station === st.id);
      if (mine.length === 0) continue;
      const xy = mine.map((p) => ({ px: x(p.slot * this.slotSec * 1000), py: y(p.snrDb), p }));
      // A silence longer than HISTORY_GAP_MIN breaks the line: a dotted hint across the gap, solid only where frames came.
      let run: typeof xy = [];
      const flush = (): void => {
        if (run.length > 1) chart.append(svg('polyline', { points: run.map((q) => `${q.px.toFixed(1)},${q.py.toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
        run = [];
      };
      for (const q of xy) {
        const prev = run[run.length - 1];
        if (prev && (q.p.slot - prev.p.slot) * this.slotSec > HISTORY_GAP_MIN * 60) {
          flush();
          chart.append(svg('line', { x1: prev.px, y1: prev.py, x2: q.px, y2: q.py, stroke: color, 'stroke-width': 1, 'stroke-dasharray': '2 4', 'stroke-opacity': 0.5 }));
        }
        run.push(q);
      }
      flush();
      // Small dots; with few enough frames the channel number rides above each.
      const labelled = model.samples.length <= HISTORY_CHANNEL_LABELS_MAX;
      for (const q of xy) {
        chart.append(svg('circle', { cx: q.px.toFixed(1), cy: q.py.toFixed(1), r: 2.2, fill: color }));
        if (labelled) {
          const c = svg('text', { x: q.px.toFixed(1), y: (q.py - 4.5).toFixed(1), class: 'chart-channel', 'text-anchor': 'middle' });
          c.textContent = String(q.p.channel);
          chart.append(c);
        }
        points.push({ px: q.px, py: q.py, text: `${this.name(st.id)} · ${db(q.p.snrDb)} dB · ch ${q.p.channel} · ${dateTime(q.p.slot * this.slotSec * 1000)}` });
      }
      const last = xy[xy.length - 1]!;
      const label = svg('text', { x: Math.min(last.px + 8, W - R + 6), y: last.py + 4, class: 'chart-label' });
      label.textContent = this.name(st.id);
      chart.append(label);
      const key = el('span', 'legend-item');
      const swatch = el('span', 'legend-swatch');
      swatch.style.background = color;
      key.append(swatch, this.name(st.id));
      legend.append(key);
    }

    // One overlay for hover: the nearest point within 14 px of the pointer gets the tooltip.
    const overlay = svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
    overlay.addEventListener('pointermove', (e) => {
      this.hovering = true;
      const box = chart.getBoundingClientRect();
      const mx = ((e.clientX - box.left) / box.width) * W;
      const my = ((e.clientY - box.top) / box.height) * H;
      let best: (typeof points)[number] | undefined;
      let bestD = 14 * 14;
      for (const p of points) {
        const d = (p.px - mx) ** 2 + (p.py - my) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      }
      tip.hidden = best === undefined;
      if (best) {
        tip.textContent = best.text;
        tip.style.left = `${(best.px / W) * 100}%`;
        tip.style.top = `${(best.py / H) * 100}%`;
      }
    });
    overlay.addEventListener('pointerleave', () => {
      this.hovering = false;
      tip.hidden = true;
    });
    chart.append(overlay);
    wrap.append(chart, tip);
    body.append(legend, wrap);
    return s;
  }

  // --- frames -----------------------------------------------------------------

  private framesEl: HTMLElement | null = null;

  /** Built once and never taken out of the page: it is what the user is often reading. */
  private framesSection(): HTMLElement {
    if (!this.framesEl) {
      const { root: s, body } = this.section('frames', 'History', 'The latest frames as a sequence diagram, then every frame in a table. The log keeps the last 1000.');
      body.append(el('h4', 'history-sub', 'Sequence'), this.sequence.root, el('h4', 'history-sub', 'All frames'), el('p', 'hint', 'Every frame sent or received, newest first. Filter, tick rows and remove them.'), this.frameTable.root);
      this.framesEl = s;
    }
    return this.framesEl;
  }

  /**
   * Replace every section above History and leave History itself in place. Rebuilding
   * the whole screen every few seconds made the page flicker and jump while the log was open;
   * with one element that stays put, the browser keeps what the user is looking at where it is.
   */
  private swapSections(sections: Node[]): void {
    const keep = this.framesSection();
    for (const child of [...this.root.children]) if (child !== keep) child.remove();
    if (keep.parentElement !== this.root) this.root.append(keep); // moving it would reset its scroll
    keep.before(...sections);
  }
}
