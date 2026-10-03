/**
 * The Stats screen: what every station publishing to the shared broker has heard and sent.
 * A circle map (an arrow per heard link, coloured by SNR) and a table of the newest records.
 */

import { signalLevel } from '../ale/link-model';
import type { StatsClient, StatsStatus } from './stats-client';
import type { StatsRecord } from './stats-record';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LEVEL_COLOR = { good: '#3fb26b', fair: '#c98500', weak: '#d9534f' } as const;
const TABLE_ROWS = 100;
/** A link or station older than this is left out of the map. */
const MAP_WINDOW_MS = 10 * 60_000;

const STATUS_TEXT: Record<StatsStatus, string> = {
  off: 'Off',
  connecting: 'Connecting to the broker…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  error: 'Error',
};
const STATUS_DOT: Record<StatsStatus, string> = { off: 'grey', connecting: 'yellow', connected: 'green', reconnecting: 'yellow', offline: 'red', error: 'red' };

const svg = (tag: string, attrs: Record<string, string | number> = {}): SVGElement => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const cell = (text: string, cls?: string): HTMLTableCellElement => {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
};
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

export interface Link {
  readonly from: number;
  readonly to: number;
  readonly snr: number;
}

/** Stations seen and the heard links (sender -> hearer, newest SNR), from the records of the last `windowMs`. Pure. */
export function statsGraph(records: readonly StatsRecord[], nowMs: number, windowMs = MAP_WINDOW_MS): { stations: number[]; links: Link[] } {
  const stations = new Set<number>();
  const links = new Map<string, Link & { at: number }>();
  for (const r of records) {
    if (nowMs - r.at > windowMs) continue;
    stations.add(r.node);
    if (r.src !== undefined) stations.add(r.src);
    if (r.dir !== 'rx' || r.snr === null || r.src === undefined || r.src === r.node) continue;
    const key = `${r.src}>${r.node}`;
    const had = links.get(key);
    if (!had || r.at >= had.at) links.set(key, { from: r.src, to: r.node, snr: r.snr, at: r.at });
  }
  return { stations: [...stations].sort((a, b) => a - b), links: [...links.values()].map(({ from, to, snr }) => ({ from, to, snr })) };
}

export class StatsView {
  private readonly statusEl = document.getElementById('stats-status') as HTMLElement;
  private readonly mapEl = document.getElementById('stats-map') as HTMLElement;
  private readonly bodyEl = document.getElementById('stats-rows') as HTMLTableSectionElement;
  private readonly hintEl = document.getElementById('stats-hint') as HTMLElement;
  private dirty = true;
  /** Names heard in published hello frames, newest wins. */
  private names = new Map<number, string>();

  constructor(
    private readonly client: StatsClient,
    private readonly isVisible: () => boolean,
    private readonly localName: (id: number) => string,
  ) {
    client.onChange = () => {
      this.dirty = true;
    };
  }

  /** Call every animation frame; redraws at most once a second, only while the screen shows. */
  private lastMs = 0;
  tick(nowMs = Date.now()): void {
    if (!this.isVisible() || !this.dirty || nowMs - this.lastMs < 1000) return;
    this.render(nowMs);
  }

  render(nowMs = Date.now()): void {
    this.dirty = false;
    this.lastMs = nowMs;
    const c = this.client;
    this.names = new Map();
    for (const r of c.records) {
      const m = r.type === 'hello' && r.src !== undefined ? /name "(.*)"/.exec(r.detail ?? '') : null;
      if (m?.[1]) this.names.set(r.src!, m[1]);
    }
    this.statusEl.textContent = `${STATUS_TEXT[c.status]}${c.error ? `: ${c.error}` : ''}`;
    this.statusEl.dataset.state = STATUS_DOT[c.status];
    this.hintEl.textContent = c.records.length === 0 ? 'No records yet. Stations that publish their stats show up here as they hear or send frames.' : '';
    this.renderMap(nowMs);
    this.renderTable();
  }

  private nameOf(id: number): string {
    return this.names.get(id) ?? this.localName(id);
  }

  private renderMap(nowMs: number): void {
    const { stations, links } = statsGraph(this.client.records, nowMs);
    const W = 360, C = W / 2, R = 120;
    const chart = svg('svg', { viewBox: `0 0 ${W} ${W}`, class: 'stats-chart', role: 'img', 'aria-label': 'Stations and the links between them' });
    const pos = new Map<number, { x: number; y: number }>();
    stations.forEach((id, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, stations.length) - Math.PI / 2;
      pos.set(id, { x: C + R * Math.cos(a), y: C + R * Math.sin(a) });
    });
    const defs = svg('defs');
    for (const [level, color] of Object.entries(LEVEL_COLOR)) {
      const m = svg('marker', { id: `stats-arrow-${level}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto', markerUnits: 'userSpaceOnUse' });
      m.append(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
      defs.append(m);
    }
    chart.append(defs);
    for (const l of links) {
      const a = pos.get(l.from), b = pos.get(l.to);
      if (!a || !b) continue;
      const level = signalLevel(l.snr);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      // Sideways nudge so the two directions of a link do not overlap; stop short of the node circles.
      const nx = -uy * 3, ny = ux * 3, gap = 14;
      const line = svg('line', {
        x1: a.x + ux * gap + nx, y1: a.y + uy * gap + ny, x2: b.x - ux * gap + nx, y2: b.y - uy * gap + ny,
        stroke: LEVEL_COLOR[level], 'stroke-width': 1.5, 'marker-end': `url(#stats-arrow-${level})`,
      });
      const title = svg('title');
      title.textContent = `${this.nameOf(l.from)} → ${this.nameOf(l.to)}: ${l.snr.toFixed(0)} dB`;
      line.append(title);
      chart.append(line);
    }
    for (const id of stations) {
      const p = pos.get(id)!;
      chart.append(svg('circle', { cx: p.x, cy: p.y, r: 11, class: 'stats-node' }));
      const t = svg('text', { x: p.x, y: p.y + 24, 'text-anchor': 'middle', class: 'chart-label' });
      t.textContent = this.nameOf(id);
      chart.append(t);
    }
    this.mapEl.replaceChildren(chart);
  }

  private renderTable(): void {
    const rows = this.client.records.slice(-TABLE_ROWS).reverse();
    this.bodyEl.replaceChildren(
      ...rows.map((r) => {
        const tr = document.createElement('tr');
        const who = r.src === undefined ? '–' : `${this.nameOf(r.src)}${r.dst === undefined ? '' : r.dst === 0 ? ' → all' : ` → ${this.nameOf(r.dst)}`}`;
        tr.append(
          cell(clock(r.at)),
          cell(this.nameOf(r.node)),
          cell(r.dir === 'tx' ? 'sent' : 'heard'),
          cell(`${r.band} · ${r.mode.replace('gfsk8-', '')}`),
          cell(String(r.ch)),
          cell(r.snr === null ? '–' : `${r.snr.toFixed(1)} dB`),
          cell(r.type + (r.via ? ' (repeated)' : '')),
          cell(who),
          cell(r.detail ?? ''),
        );
        return tr;
      }),
    );
  }
}
