/**
 * The Network screen's frame table: every frame sent or received with its raw and
 * decoded form, filters, and removal of the selected or the filtered rows.
 * Nicknames and message text come from strangers: textContent only.
 */

import { decodeRecord, DEFAULT_FILTER, matchFrame, type FrameFilter, type FrameLog, type FrameRecord } from '../chat/frame-log';
import type { FrameType } from '../chat/describe';
import { exportFileName, framesToCsv, framesToText } from '../chat/frame-export';

/** More rows than this make the page slow to redraw; the filters narrow what is left. */
const MAX_SHOWN = 300;

const TYPES: readonly ('all' | FrameType)[] = ['all', 'first', 'next', 'spriteHead', 'spriteBody', 'ack', 'hello', 'sound', 'invalid'];

type SortKey = 'time' | 'channel' | 'snr';

const pad2 = (n: number): string => String(n).padStart(2, '0');
const stamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
/** Compact time since a frame: 42 s, 7 min, 3 h 05 min, 2 d. */
function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${pad2(m % 60)} min`;
  return `${Math.floor(h / 24)} d`;
}
const signed = (v: number, digits = 0): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class FrameTable {
  readonly root = el('div', 'frame-table');
  private filter: FrameFilter = DEFAULT_FILTER;
  private readonly selected = new Set<number>();
  private sortKey: SortKey = 'time';
  private sortDown = true;
  private readonly summary = el('p', 'hint');
  private readonly scroll = el('div', 'table-scroll frame-scroll');
  private readonly removeSelected = el('button', undefined, 'Remove selected');
  private readonly removeShown = el('button', undefined, 'Remove all shown');
  private readonly exportAll = el('button', undefined, 'Export all');
  private readonly copySelected = el('button', undefined, 'Copy selected');
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private shown: FrameRecord[] = [];

  constructor(
    private readonly log: FrameLog,
    private readonly label: (id: number) => string,
    private readonly getMyId: () => number,
  ) {
    this.root.append(this.filterBar(), this.toolbar(), this.scroll);
    this.refresh();
  }

  get scrollTop(): number {
    return this.scroll.scrollTop;
  }

  set scrollTop(v: number) {
    this.scroll.scrollTop = v;
  }

  /** True while the user is typing in a filter, so the screen does not redraw under them. */
  get busy(): boolean {
    return this.root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement;
  }

  private setFilter(patch: Partial<FrameFilter>): void {
    this.filter = { ...this.filter, ...patch };
    this.refresh();
  }

  private filterBar(): HTMLElement {
    const bar = el('div', 'frame-filters');
    const field = (label: string, input: HTMLElement): void => {
      const l = el('label', undefined, label);
      l.append(input);
      bar.append(l);
    };
    const dir = el('select');
    dir.id = 'frame-filter-dir';
    for (const [v, t] of [['all', 'All'], ['rx', 'Received'], ['tx', 'Sent']] as const) dir.append(new Option(t, v));
    dir.addEventListener('change', () => this.setFilter({ dir: dir.value as FrameFilter['dir'] }));
    field('Direction', dir);

    const type = el('select');
    type.id = 'frame-filter-type';
    for (const t of TYPES) type.append(new Option(t === 'all' ? 'All' : t, t));
    type.addEventListener('change', () => this.setFilter({ type: type.value as FrameFilter['type'] }));
    field('Type', type);

    const station = el('input');
    station.id = 'frame-filter-station';
    station.type = 'search';
    station.placeholder = 'id or name (from or to)';
    station.addEventListener('input', () => this.setFilter({ station: station.value }));
    field('Station', station);

    const channel = el('input');
    channel.id = 'frame-filter-channel';
    channel.type = 'number';
    channel.min = '1';
    channel.placeholder = 'any';
    channel.addEventListener('input', () => this.setFilter({ channel: channel.value }));
    field('Channel', channel);

    const snr = el('input');
    snr.id = 'frame-filter-snr';
    snr.type = 'number';
    snr.step = '1';
    snr.placeholder = 'any';
    snr.addEventListener('input', () => this.setFilter({ minSnrDb: snr.value === '' || Number.isNaN(Number(snr.value)) ? null : Number(snr.value) }));
    field('Min SNR (dB)', snr);

    const text = el('input');
    text.id = 'frame-filter-text';
    text.type = 'search';
    text.placeholder = 'in decoded text or hex';
    text.addEventListener('input', () => this.setFilter({ text: text.value }));
    field('Text', text);

    const self = el('input');
    self.id = 'frame-filter-self';
    self.type = 'checkbox';
    self.checked = DEFAULT_FILTER.hideSelf;
    self.addEventListener('change', () => this.setFilter({ hideSelf: self.checked }));
    const selfLabel = el('label', 'frame-check', 'Hide self decodes');
    selfLabel.title = 'Received frames sent by this station: our own transmissions heard back through the speaker';
    selfLabel.prepend(self);
    bar.append(selfLabel);

    const reset = el('button', undefined, 'Reset filters');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      dir.value = 'all';
      type.value = 'all';
      station.value = channel.value = snr.value = text.value = '';
      self.checked = DEFAULT_FILTER.hideSelf;
      this.setFilter(DEFAULT_FILTER);
    });
    bar.append(reset);
    return bar;
  }

  private toolbar(): HTMLElement {
    const bar = el('div', 'frame-toolbar');
    this.removeSelected.type = 'button';
    this.removeShown.type = 'button';
    this.removeSelected.addEventListener('click', () => {
      this.log.remove(new Set(this.selected));
      this.selected.clear();
      this.refresh();
    });
    this.removeShown.addEventListener('click', () => {
      const ids = new Set(this.matching().map((r) => r.id));
      if (ids.size === 0) return;
      if (!confirm(`Remove ${ids.size} frame${ids.size === 1 ? '' : 's'} matching the filters?`)) return;
      this.log.remove(ids);
      this.refresh();
    });
    this.exportAll.type = 'button';
    this.exportAll.title = 'Download every frame of the log (filters are ignored) as a CSV file: times in UTC and local, full raw hex, decoded text';
    this.exportAll.addEventListener('click', () => this.download());
    this.copySelected.type = 'button';
    this.copySelected.title = 'Copy the selected frames to the clipboard as tab-separated text with the full raw hex, oldest first';
    this.copySelected.addEventListener('click', () => void this.copy());
    bar.append(this.removeSelected, this.removeShown, this.copySelected, this.exportAll, this.summary);
    return bar;
  }

  /** Every frame of the log, not just the rows matching the filters, as a CSV download. */
  private download(): void {
    const frames = this.log.all;
    if (frames.length === 0) return;
    const url = URL.createObjectURL(new Blob([framesToCsv(frames, this.label)], { type: 'text/csv;charset=utf-8' }));
    const a = el('a');
    a.href = url;
    a.download = exportFileName(Date.now());
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /** The selected frames (selection survives filters) to the clipboard. */
  private async copy(): Promise<void> {
    const chosen = this.log.all.filter((r) => this.selected.has(r.id));
    if (chosen.length === 0) return;
    const text = framesToText(chosen, this.label);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // No clipboard API (a plain-http page) or permission refused: the old way, through a selection.
      const area = el('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
    }
    this.copySelected.textContent = ok ? `Copied ${chosen.length}` : 'Copy failed';
    clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => { this.copySelected.textContent = 'Copy selected'; }, 2000);
  }

  private matching(): FrameRecord[] {
    return this.log.all.filter((r) => matchFrame(r, this.filter, this.label, this.getMyId()));
  }

  private sorted(rows: FrameRecord[]): FrameRecord[] {
    const key: Record<SortKey, (r: FrameRecord) => number> = {
      time: (r) => r.atMs,
      channel: (r) => r.channel,
      snr: (r) => r.snrDb ?? -Infinity,
    };
    const k = key[this.sortKey];
    return rows.sort((a, b) => (k(a) - k(b) || a.atMs - b.atMs || a.id - b.id) * (this.sortDown ? -1 : 1));
  }

  /** Redraw the rows and counters; the filter inputs are left alone. */
  refresh(): void {
    const all = this.matching();
    const live = new Set(this.log.all.map((r) => r.id));
    for (const id of this.selected) if (!live.has(id)) this.selected.delete(id);
    this.shown = this.sorted(all).slice(0, MAX_SHOWN);
    const total = this.log.count;
    this.summary.textContent =
      `${all.length} of ${total} frame${total === 1 ? '' : 's'} match` +
      (all.length > MAX_SHOWN ? ` (first ${MAX_SHOWN} shown)` : '') +
      ` · ${this.selected.size} selected`;
    this.removeSelected.disabled = this.selected.size === 0;
    this.copySelected.disabled = this.selected.size === 0;
    this.exportAll.disabled = total === 0;
    this.removeShown.disabled = all.length === 0;
    this.removeShown.textContent = all.length === total ? 'Remove all' : 'Remove all shown';

    const table = el('table', 'link-table frame-grid');
    const head = el('tr');
    const all_ = el('input');
    all_.id = 'frame-select-all';
    all_.type = 'checkbox';
    all_.title = 'Select every row shown';
    all_.checked = this.shown.length > 0 && this.shown.every((r) => this.selected.has(r.id));
    all_.addEventListener('change', () => {
      for (const r of this.shown) all_.checked ? this.selected.add(r.id) : this.selected.delete(r.id);
      this.refresh();
    });
    const th0 = el('th');
    th0.append(all_);
    head.append(th0);
    const cols: [string, SortKey | null][] = [
      ['Time', 'time'], ['Since', 'time'], ['', null], ['Ch', 'channel'], ['From', null], ['To', null], ['Type', null], ['Msg', null], ['dt UTC (s)', null], ['SNR (dB)', 'snr'], ['Raw (hex)', null], ['Decoded', null],
    ];
    for (const [text, k] of cols) {
      const th = el('th', undefined, text + (k && this.sortKey === k ? (this.sortDown ? ' ▼' : ' ▲') : ''));
      if (k) {
        th.tabIndex = 0;
        const sort = (): void => {
          if (this.sortKey === k) this.sortDown = !this.sortDown;
          else { this.sortKey = k; this.sortDown = true; }
          this.refresh();
        };
        th.addEventListener('click', sort);
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter') sort(); });
      } else th.style.cursor = 'default';
      head.append(th);
    }
    const thead = el('thead');
    thead.append(head);
    table.append(thead);

    const body = el('tbody');
    for (const r of this.shown) body.append(this.row(r));
    table.append(body);
    this.scroll.replaceChildren(table);
    if (this.shown.length === 0) this.scroll.append(el('p', 'hint', total === 0 ? 'No frames yet.' : 'No frame matches the filters.'));
  }

  private row(r: FrameRecord): HTMLElement {
    const d = decodeRecord(r, this.label);
    const tr = el('tr', `frame-${r.dir}`);
    const box = el('input');
    box.id = `frame-select-${r.id}`;
    box.type = 'checkbox';
    box.title = 'Select this frame';
    box.checked = this.selected.has(r.id);
    box.addEventListener('change', () => {
      if (box.checked) this.selected.add(r.id);
      else this.selected.delete(r.id);
      this.refresh();
    });
    const c0 = el('td');
    c0.append(box);
    const to = d.dst === undefined ? '' : d.dst === 0 ? 'everyone' : this.label(d.dst);
    tr.append(
      c0,
      el('td', undefined, stamp(r.atMs)),
      el('td', 'frame-since', since(Date.now() - r.atMs)),
      el('td', undefined, r.dir === 'tx' ? 'TX' : 'RX'),
      el('td', undefined, r.channel ? String(r.channel) : '?'),
      el('td', undefined, d.src === undefined ? '' : this.label(d.src)),
      el('td', undefined, to),
      el('td', undefined, d.type),
      el('td', undefined, d.msgId === undefined ? '' : String(d.msgId)),
      el('td', undefined, r.dtSec === undefined ? '' : signed(r.dtSec, 2)),
      el('td', undefined, r.snrDb === null ? '' : signed(r.snrDb)),
      this.hexCell(r.hex),
      el('td', 'frame-detail', d.detail),
    );
    return tr;
  }

  /** Just enough of the raw hex to recognise a row at a glance; the full string is a hover away. */
  private hexCell(hex: string): HTMLElement {
    const td = el('td', 'frame-hex', hex.length > 3 ? `${hex.slice(0, 3)}…` : hex);
    td.title = hex;
    return td;
  }
}
