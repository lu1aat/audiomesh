/**
 * The History section's diagram: the latest frames as a sequence diagram. Each station is a
 * vertical line, the shared air ("audiomesh", public) is the centre one, and time runs down;
 * the newest event is at the bottom and the view stays on it unless the user scrolled up.
 * Model in `chat/sequence.ts`. Nicknames and message text are strangers': textContent only.
 */

import type { FrameLog } from '../chat/frame-log';
import { buildSequence, type Actor, type SeqEvent, type SeqLine } from '../chat/sequence';
import { drawSprite } from './sprite-view';

const SVG = 'http://www.w3.org/2000/svg';
/** Narrowest a station's column gets before the diagram scrolls sideways. */
const COLUMN_MIN_PX = 104;

const pad2 = (n: number): string => String(n).padStart(2, '0');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A pointy-top hexagon filled with the station's colour, like its cell on the map. */
function hex(fill: string): SVGSVGElement {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 32 32');
  s.setAttribute('class', 'seq-hex');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'polygon');
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k - Math.PI / 2;
    pts.push(`${(16 + 14 * Math.cos(a)).toFixed(2)},${(16 + 14 * Math.sin(a)).toFixed(2)}`);
  }
  p.setAttribute('points', pts.join(' '));
  p.setAttribute('fill', fill);
  s.append(p);
  return s;
}

export class HistoryView {
  readonly root = el('div', 'seq');
  private readonly scroll = el('div', 'seq-scroll');
  private lastId = -1;
  private renderedCount = -1;
  /** Drawn while hidden (the section collapsed), so nothing could be measured: go to the newest event once shown. */
  private pendingStick = true;

  constructor(
    private readonly log: FrameLog,
    /** Nickname, or `#id` when there is none. */
    private readonly label: (id: number) => string,
    private readonly getMyId: () => number,
    /** The station's colour (the same one its line has in the signal history). */
    private readonly colorOf: (id: number) => string,
  ) {
    this.root.append(this.scroll, el('p', 'hint seq-legend', 'audiomesh is the shared air. Teal: announcements and beacons. White: messages and sprites. Green: acks. Dashed: where a frame goes on to, or whom a beacon reports. Newest at the bottom.'));
    this.refresh();
  }

  /** Redraw when the log has changed since the last draw; cheap to call every frame. */
  sync(): void {
    if (this.pendingStick && this.scroll.clientHeight > 0) {
      this.scroll.scrollTop = this.scroll.scrollHeight;
      this.pendingStick = false;
    }
    const all = this.log.all;
    const newest = all.length ? all[all.length - 1]!.id : 0;
    if (newest === this.lastId && all.length === this.renderedCount) return;
    this.refresh();
  }

  refresh(nowMs = Date.now()): void {
    const all = this.log.all;
    const me = this.getMyId();
    const { actors, items } = buildSequence(all, me, nowMs);
    const previousLast = this.lastId;
    this.lastId = all.length ? all[all.length - 1]!.id : 0;
    this.renderedCount = all.length;

    const hidden = this.scroll.clientHeight === 0;
    const stick = hidden || this.scroll.scrollTop + this.scroll.clientHeight >= this.scroll.scrollHeight - 24;
    if (hidden) this.pendingStick = true;
    const top = this.scroll.scrollTop;

    if (items.length === 0) {
      this.scroll.replaceChildren(el('p', 'hint', 'No frames yet. Every frame sent or heard shows up here as it happens.'));
      return;
    }

    // Columns: stations left of the air, the air, stations right of it.
    const leftCount = Math.ceil(actors.length / 2);
    const columns: Actor[] = [...actors.slice(0, leftCount), 'public', ...actors.slice(leftCount)];
    const n = columns.length;
    const col = new Map<Actor, number>(columns.map((a, i) => [a, i]));
    const pct = (i: number): number => ((i + 0.5) / n) * 100;

    const canvas = el('div', 'seq-canvas');
    canvas.style.minWidth = `${n * COLUMN_MIN_PX + 64}px`;

    const head = el('div', 'seq-head');
    const headHex = new Map<Actor, SVGSVGElement>();
    head.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    for (const a of columns) {
      const box = el('div', a === 'public' ? 'seq-actor seq-actor-public' : 'seq-actor');
      if (a === 'public') {
        const h = hex('var(--accent)');
        headHex.set(a, h);
        box.append(h, el('span', 'seq-actor-name', 'audiomesh'), el('span', 'seq-actor-id', 'public'));
      } else {
        const name = this.label(a);
        const numbered = `#${String(a).padStart(3, '0')}`;
        const nicked = name !== `#${a}`;
        const sub = `${nicked ? numbered : ''}${a === me ? `${nicked ? ' · ' : ''}me` : ''}`;
        const h = hex(this.actorColor(a));
        headHex.set(a, h);
        box.append(h, el('span', 'seq-actor-name', nicked ? name : numbered), el('span', 'seq-actor-id', sub));
      }
      head.append(box);
    }

    const lane = el('div', 'seq-lane');
    const pinged = new Set<Actor>();
    columns.forEach((a, i) => {
      const life = el('div', a === 'public' ? 'seq-life seq-life-public' : 'seq-life');
      life.style.left = `${pct(i)}%`;
      lane.append(life);
    });

    for (const item of items) {
      if (item.kind === 'bubble') {
        const b = el('div', 'seq-bubble');
        b.append(el('span', undefined, item.text));
        lane.append(b);
        continue;
      }
      const fresh = previousLast >= 0 && item.id > previousLast;
      lane.append(this.eventRow(item, col, pct, fresh));
      const sender = item.lines[0]?.from;
      if (fresh && sender !== undefined) pinged.add(sender);
    }

    // The sender's hexagon in the header flashes: who just spoke.
    for (const a of pinged) {
      const h = headHex.get(a);
      if (!h) continue;
      h.style.setProperty('--c', this.actorColor(a));
      h.classList.add('seq-ping');
      h.addEventListener('animationend', () => h.classList.remove('seq-ping'), { once: true });
    }
    canvas.append(head, lane);
    this.scroll.replaceChildren(canvas);
    this.scroll.scrollTop = stick ? this.scroll.scrollHeight : top;
  }

  /** Hexagon fill for a station: its colour, white for us, the accent for the air. */
  private actorColor(a: Actor): string {
    if (a === 'public') return 'var(--accent)';
    return a === this.getMyId() ? '#ffffff' : this.colorOf(a);
  }

  private eventRow(e: SeqEvent, col: Map<Actor, number>, pct: (i: number) => number, fresh: boolean): HTMLElement {
    const row = el('div', `seq-event seq-${e.tone}${e.dir === 'tx' ? ' seq-tx' : ''}${fresh ? ' seq-new' : ''}${e.repeated ? ' seq-repeated' : ''}`);
    const d = new Date(e.atMs);
    row.append(el('span', 'seq-time', `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`));
    e.lines.forEach((line, i) => row.append(this.lineEl(e, line, i, col, pct)));
    return row;
  }

  private lineEl(e: SeqEvent, line: SeqLine, index: number, col: Map<Actor, number>, pct: (i: number) => number): HTMLElement {
    const a = col.get(line.from);
    const b = col.get(line.to);
    const wrap = el('div', 'seq-line');
    if (a === undefined || b === undefined || a === b) return wrap;
    const seg = el('div', `seq-seg ${b > a ? 'seq-right' : 'seq-left'}${line.dashed ? ' seq-dashed' : ''}${line.to === 'public' ? ' seq-to-public' : ''}`);
    seg.style.left = `${pct(Math.min(a, b))}%`;
    seg.style.width = `${Math.abs(pct(b) - pct(a))}%`;
    seg.style.setProperty('--n', String(index));
    seg.style.setProperty('--from', this.actorColor(line.from));
    seg.style.setProperty('--to', this.actorColor(line.to));

    // A sprite frame draws the picture as it stood when this frame arrived, above the line.
    const pic = index === 0 ? e.sprite : undefined;
    if (pic) {
      const cell = Math.max(2, Math.min(5, Math.floor(40 / pic.side)));
      const figure = el('div', 'seq-sprite');
      const canvas = el('canvas');
      drawSprite(canvas, pic.side, cell, pic.colours, false);
      figure.append(canvas, el('span', undefined, `${e.icon} ${pic.got}/${pic.frames}`));
      figure.title = line.label;
      seg.append(figure);
      wrap.style.height = `${pic.side * cell + 30}px`;
    } else if (line.label) {
      const text = el('span', 'seq-text');
      if (index === 0) text.append(el('span', 'seq-icon', e.icon), ' ');
      text.append(line.label);
      text.title = line.label;
      seg.append(text);
    }
    seg.append(el('span', 'seq-rule'), el('span', 'seq-node seq-node-from'));
    // Landing on a station: a hollow hexagon in its colour. On the air: the arrowhead alone.
    if (line.to !== 'public') seg.append(el('span', 'seq-node seq-node-to'));
    wrap.append(seg);
    return wrap;
  }
}
