/**
 * The conversation list on the Messages screen: Public on top, then everyone this station has heard or that announced itself,
 * a vertical contact list like a chat app: avatar with a presence dot, nickname,
 * the last message (or when it was heard) and a time; a click opens a message to them.
 *
 * Everything from the air (nicknames) goes in through textContent only.
 */

import { buildLinkModel, formatAge, type RepeaterInfo, type StationInfo, type StationStatus } from '../ale/link-model';
import type { LqaTable } from '../ale/lqa';
import { BROADCAST } from '../chat/frames';
import type { ChatPanel } from './chat-panel';

const db = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)} dB`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class UsersView {
  private readonly root: HTMLElement;
  private renderedAt = 0;
  private sinceAt = 0;

  constructor(
    private readonly lqa: LqaTable,
    private readonly chat: ChatPanel,
    private readonly getSelf: () => { id: number; nickname: string },
    private readonly getChannels: () => readonly number[],
    private readonly slotSec: number,
    private readonly isVisible: () => boolean,
    private readonly getRelay: () => RepeaterInfo,
    private readonly onMessage: (id: number) => void,
  ) {
    this.root = document.getElementById('users-view') as HTMLElement;
  }

  /** Call every animation frame; redraws at most every 4 s, only while the screen is showing. */
  tick(nowMs = Date.now()): void {
    if (!this.isVisible()) return;
    if (nowMs - this.renderedAt >= 4000) this.render(nowMs);
    else if (nowMs - this.sinceAt >= 1000) this.updateSince(nowMs);
  }

  /** Count the "since" column up once a second between redraws. */
  private updateSince(nowMs: number): void {
    this.sinceAt = nowMs;
    for (const e of this.root.querySelectorAll<HTMLElement>('.contact-since[data-heard-ms]')) {
      e.textContent = elapsed((nowMs - Number(e.dataset.heardMs)) / 1000);
    }
  }

  render(nowMs = Date.now()): void {
    this.renderedAt = nowMs;
    this.sinceAt = nowMs;
    const slot = Math.floor(nowMs / (this.slotSec * 1000));
    const model = buildLinkModel(this.lqa, this.getChannels(), slot, this.slotSec, this.getSelf().id, this.getRelay());
    const heard = new Map<number, StationInfo>(model.stations.map((s) => [s.id, s]));
    const self = this.getSelf();
    const ids = new Set<number>([...heard.keys(), ...this.chat.knownStations.keys()]);
    ids.delete(self.id);

    // Heard lately first (newest on top), then those only known from earlier visits, by name.
    const nameOf = (id: number): string => this.chat.knownStations.get(id) ?? '';
    const sorted = [...ids].sort((a, b) => {
      const ha = heard.get(a), hb = heard.get(b);
      if (ha && hb) return ha.ageSec - hb.ageSec || a - b;
      if (ha || hb) return ha ? -1 : 1;
      return nameOf(a).localeCompare(nameOf(b)) || a - b;
    });

    const last = this.chat.lastMessages();
    // Newest activity first, like a chat app: the later of "heard" and "last message".
    const activityMs = (id: number): number => {
      const h = heard.get(id);
      return Math.max(last.get(id)?.atMs ?? 0, h ? nowMs - h.ageSec * 1000 : 0);
    };
    sorted.sort((x, y) => activityMs(y) - activityMs(x) || x - y);

    const list = el('ul', 'contact-list');
    list.append(this.publicRow());
    for (const id of sorted) list.append(this.row(id, nameOf(id), heard.get(id), last.get(id), false, nowMs));
    this.root.replaceChildren(list);
    if (sorted.length === 0) {
      this.root.append(el('p', 'hint', 'Nobody else yet. Stations appear here when we hear a frame from them or they announce a name.'));
    }
  }

  /** The top row: messages addressed to nobody. */
  private publicRow(): HTMLElement {
    const last = this.chat.lastPublic();
    const li = el('li', 'contact');
    const btn = el('button', 'contact-row');
    btn.type = 'button';
    if (this.chat.currentRecipient === BROADCAST) btn.classList.add('contact-active');
    btn.addEventListener('click', () => this.onMessage(BROADCAST));
    const avatar = el('span', 'contact-avatar', '🌐');
    avatar.setAttribute('aria-hidden', 'true');
    const body = el('span', 'contact-body');
    const preview = last ? `${last.mine ? 'You: ' : last.who ? `${last.who}: ` : ''}${last.text}` : 'Messages addressed to nobody';
    body.append(el('span', 'contact-top', 'Public'), el('span', 'contact-preview', preview));
    body.firstElementChild!.classList.add('contact-name');
    btn.append(avatar, body);
    btn.title = 'Public: messages addressed to nobody, everyone can read them';
    li.append(btn);
    return li;
  }

  private row(
    id: number,
    nickname: string,
    info: StationInfo | undefined,
    last: { text: string; atMs: number; mine: boolean } | undefined,
    isSelf: boolean,
    nowMs: number,
  ): HTMLElement {
    const status: StationStatus | 'unheard' = info?.status ?? 'unheard';
    const li = el('li', 'contact');
    const btn = el('button', `contact-row${isSelf ? ' contact-self' : ''}${!isSelf && this.chat.currentRecipient === id ? ' contact-active' : ''}`);
    btn.type = 'button';
    if (isSelf) btn.disabled = true;
    else btn.addEventListener('click', () => this.onMessage(id));

    const avatar = el('span', 'contact-avatar', this.chat.iconOf(id));
    avatar.style.setProperty('--hue', String((id * 47) % 360));
    avatar.setAttribute('aria-hidden', 'true');
    if (!isSelf) avatar.append(el('span', `contact-presence presence-${status}`));

    const name = `${nickname || 'No name'}${isSelf ? ' (you)' : ''}`;
    const top = el('span', 'contact-top');
    const when = last?.atMs ?? (info ? nowMs - info.ageSec * 1000 : 0);
    // Slot resolution: the table only knows in which slot a station was last heard.
    const since = el('span', 'contact-since');
    if (!isSelf && info) {
      const heardMs = info.lastSlot * this.slotSec * 1000;
      since.dataset.heardMs = String(heardMs);
      since.textContent = elapsed((nowMs - heardMs) / 1000);
    } else since.textContent = isSelf ? '' : '–';
    since.title = 'Time since this station was last heard';
    top.append(el('span', 'contact-name', name), el('span', 'contact-time', isSelf || !when ? '' : clockShort(when, nowMs)), since);

    let preview: string;
    if (isSelf) preview = `Station #${id}`;
    else if (last) preview = `${last.mine ? 'You: ' : ''}${last.text}`;
    else if (info) preview = `#${id} · heard ${formatAge(info.ageSec)}${info.lastSnrDb !== undefined ? ` · ${db(info.lastSnrDb)} on ch ${info.lastChannel}` : ''}`;
    else preview = `#${id} · not heard lately`;
    btn.append(avatar, el('span', 'contact-body'));
    const body = btn.lastElementChild as HTMLElement;
    body.append(top, el('span', 'contact-preview', preview));
    btn.title = isSelf ? 'This station' : `Message ${nickname || `#${id}`}${info?.best ? ` · send on ch ${info.best.channel}` : ''}`;
    li.append(btn);
    return li;
  }
}

/** "12 s", "3 min 05 s", "1 h 20 min": time since, counting up. */
function elapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad2(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${pad2(Math.floor((s % 3600) / 60))} min`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** "14:32" for today, "12 Mar" otherwise. */
function clockShort(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const n = new Date(nowMs);
  if (d.toDateString() === n.toDateString()) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
