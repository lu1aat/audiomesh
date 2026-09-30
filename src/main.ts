/** Wiring only. Logic belongs in protocol/, band/, audio/ or render/. */

import { AudioEngine } from './audio/engine';
import { DEFAULT_BAND, bandsFor, listChannels, referenceTonesHz, type Band } from './band/band-plan';
import { DEFAULT_PROTOCOL_ID, getProtocol, isProtocolId, listProtocols } from './protocol/registry';
import { bandwidthHz, deepExtraSec, frameDurationSec } from './protocol/spec';
import { DEFAULT_CEIL_DB, DEFAULT_FLOOR_DB, MIN_LEVEL_SPAN_DB, SpectrumDisplay } from './render/spectrum-display';
import { LqaTable } from './ale/lqa';
import { formatAge, type RepeaterInfo } from './ale/link-model';
import { ChatSession } from './chat/session';
import { randomStationId } from './chat/frames';
import { ChatPanel } from './ui/chat-panel';
import { Notifier } from './ui/notifier';
import { LinkView, type StationsView } from './ui/link-view';
import { ServerClock } from './sync/server-clock';
import { UsersView } from './ui/users-view';
import { TestToneControl } from './ui/test-tone';
import { DeferredSaver, LINK_KEY, loadJson, removeKey, saveJson } from './storage/store';

const SETTINGS_KEY = 'audiochat:settings';

interface Settings {
  band: string;
  channel: number | null;
  decodeWhileSending: boolean;
  listenAll: boolean;
  autoChannel: boolean;
  autoSound: boolean;
  floorDb: number;
  ceilDb: number;
  channelsOpen: boolean;
  netOptionsOpen: boolean;
  mapOpen: boolean;
  syncOpen: boolean;
  stationId: number;
  nickname: string;
  autoAnnounce: boolean;
  announceIntervalMin: number;
  /** Minutes between Auto test beacons; one of AUTO_SOUND_CHOICES_MIN. */
  autoSoundIntervalMin: number;
  /** Slot grid moved against UTC to match another station ("Sync" on the Network screen). */
  slotOffsetMs: number;
  notifications: boolean;
  protocol: string;
  /** Repeat every frame heard from others (Network screen). */
  repeater: boolean;
  /** Search a few seconds beyond the usual timing window (Network screen). */
  deepDecode: boolean;
  /** Check this clock against the page's server every 10 minutes (Sync, Network screen). */
  serverClockAuto: boolean;
  /** Master transmit switch (Network options): off = this station never sends anything. */
  allowTx: boolean;
  /** Stations layout on the Network screen: table (columns), cards (one per station) or grid (compact tiles). */
  stationsView: StationsView;
  /** Sidebar narrowed to the status colour and the screen dots. */
  sidebarCollapsed: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  band: DEFAULT_BAND.name,
  channel: null,
  decodeWhileSending: false,
  listenAll: true,
  autoChannel: true,
  autoSound: true,
  floorDb: DEFAULT_FLOOR_DB,
  ceilDb: DEFAULT_CEIL_DB,
  channelsOpen: true,
  netOptionsOpen: false,
  mapOpen: true,
  syncOpen: false,
  stationId: 0,
  nickname: '',
  autoAnnounce: false,
  announceIntervalMin: 5,
  autoSoundIntervalMin: 5,
  slotOffsetMs: 0,
  notifications: false,
  protocol: DEFAULT_PROTOCOL_ID,
  repeater: false,
  deepDecode: false,
  serverClockAuto: false,
  allowTx: true,
  stationsView: 'table',
  sidebarCollapsed: false,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // Private windows and blocked storage throw; settings are a convenience only.
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // See loadSettings.
  }
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const settings = loadSettings();
const protocol = getProtocol(isProtocolId(settings.protocol) ? settings.protocol : DEFAULT_PROTOCOL_ID);
const allChannels = listChannels(protocol.spec);
const bands = bandsFor(protocol.spec);
const engine = new AudioEngine(protocol.spec);
let band: Band = bands.find((b) => b.name === settings.band) ?? bands[bands.length - 1] ?? DEFAULT_BAND;
let channels = listChannels(protocol.spec, band);

const tone = new TestToneControl(engine, allChannels);
if (!settings.stationId) {
  settings.stationId = randomStationId();
  saveSettings(settings);
}
// Stations silent for 10 minutes (when the graph fades them) drop out of our sound reports.
const lqa = new LqaTable({ reportSilenceSlots: Math.ceil(600 / protocol.spec.slotSec) });
lqa.restore(loadJson(LINK_KEY));
const linkSaver = new DeferredSaver(() => saveJson(LINK_KEY, lqa.serialize()), 5000);
lqa.onChange = () => linkSaver.touch();
const session = new ChatSession({ stationId: settings.stationId, lqa });
session.setNickname(settings.nickname);
session.setRepeater(settings.repeater);
const chat = new ChatPanel(engine, protocol, allChannels, () => tone.gain, session, lqa);

/**
 * Keep the shift inside 0.4 slot so slot numbers stay unambiguous: 6 s in the normal
 * mode. Receive windows and transmissions both move, so a far-off clock can be matched
 * even beyond what the decoder searches.
 */
const clampSlotOffset = (ms: number): number => {
  const limit = protocol.spec.slotSec * 400;
  return Math.round(Math.max(-limit, Math.min(limit, ms)));
};
settings.slotOffsetMs = clampSlotOffset(Number(settings.slotOffsetMs) || 0);
engine.setSlotOffsetMs(settings.slotOffsetMs);
engine.setDeepDecode(settings.deepDecode);
engine.setTransmitAllowed(settings.allowTx !== false);

const serverClock = new ServerClock();

const relayInfo = (): RepeaterInfo => ({
  repeaters: session.repeaters,
  framesVia: session.framesVia,
  paths: session.relayPaths,
  relayed: session.relayedStations,
  self: session.isRepeater,
});

const link = new LinkView(
  lqa,
  session.stations,
  () => channels.map((c) => c.number),
  protocol.spec.slotSec,
  () => !el('screen-network').hidden,
  () => settings.stationId,
  chat.frames,
  {
    offsetMs: () => settings.slotOffsetMs,
    set: (ms) => {
      settings.slotOffsetMs = clampSlotOffset(ms);
      engine.setSlotOffsetMs(settings.slotOffsetMs);
      saveSettings(settings);
    },
  },
  relayInfo,
  {
    undecoded: () => chat.undecodedSyncs,
    deepOn: () => settings.deepDecode,
    maxTimeOffsetSec: protocol.spec.maxTimeOffsetSec,
    deepExtraSec: deepExtraSec(protocol.spec),
    limitMs: protocol.spec.slotSec * 400,
    server: serverClock,
    latency: () => {
      if (!engine.running) return null;
      const inSec = engine.inputLatencyReportedSec;
      return { outMs: engine.outputLatencySec * 1000, inMs: inSec === null ? null : inSec * 1000 };
    },
  },
  {
    get: () => settings.stationsView,
    set: (v) => {
      settings.stationsView = v;
      saveSettings(settings);
    },
  },
  () => settings.nickname.trim(),
);

const deepBox = el<HTMLInputElement>('deep-decode');
deepBox.checked = settings.deepDecode;
deepBox.disabled = deepExtraSec(protocol.spec) === 0;
deepBox.addEventListener('change', () => {
  settings.deepDecode = deepBox.checked;
  saveSettings(settings);
  engine.setDeepDecode(settings.deepDecode);
  link.render();
});
const clockManual = el<HTMLInputElement>('clock-manual');
el('clock-set').addEventListener('click', () => {
  const sec = Number(clockManual.value.replace(',', '.'));
  if (!Number.isFinite(sec) || clockManual.value.trim() === '') return;
  link.setOffsetMs(Math.round(sec * 1000));
});
clockManual.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('clock-set').click();
});
el('clock-utc').addEventListener('click', () => link.setOffsetMs(0));

const serverCheck = el<HTMLButtonElement>('sync-server-check');
async function checkServerClock(): Promise<void> {
  serverCheck.disabled = true;
  link.render();
  await serverClock.measure();
  serverCheck.disabled = false;
  link.render();
}
serverCheck.addEventListener('click', () => void checkServerClock());
const serverAuto = el<HTMLInputElement>('sync-server-auto');
serverAuto.checked = settings.serverClockAuto;
serverAuto.addEventListener('change', () => {
  settings.serverClockAuto = serverAuto.checked;
  saveSettings(settings);
  if (serverAuto.checked && !serverClock.latest) void checkServerClock();
});
setInterval(() => {
  if (settings.serverClockAuto && !document.hidden) void checkServerClock();
}, 10 * 60_000);
if (settings.serverClockAuto) void checkServerClock();
el('sync-server-use').addEventListener('click', () => {
  const r = serverClock.latest;
  if (r) link.setOffsetMs(Math.round(r.offsetMs));
});

const users = new UsersView(
  lqa,
  chat,
  () => ({ id: settings.stationId, nickname: settings.nickname }),
  () => channels.map((c) => c.number),
  protocol.spec.slotSec,
  () => !el('screen-users').hidden,
  relayInfo,
  (id) => {
    showScreen('chat');
    chat.selectRecipient(id);
  },
);

const nicknameInput = el<HTMLInputElement>('nickname');
const nickCallout = el('nick-callout');
const nameBanner = el('name-banner');
function updateNickCallout(): void {
  const named = settings.nickname.trim() !== '';
  nickCallout.classList.toggle('nick-ok', named);
  nameBanner.hidden = named;
}
el('name-banner-set').addEventListener('click', () => {
  showScreen('settings');
  nicknameInput.focus();
});
nicknameInput.value = settings.nickname;
updateNickCallout();
nicknameInput.addEventListener('change', () => {
  settings.nickname = nicknameInput.value;
  session.setNickname(settings.nickname);
  saveSettings(settings);
  updateNickCallout();
});
/** Stored data: chat lines, stations and link statistics are kept and cleared separately. */
function showStoredCounts(): void {
  const { chat: chatCount, stations, debug } = chat.counts;
  el('stored-debug-count').textContent = `${debug} frame${debug === 1 ? '' : 's'}`;
  el('stored-chat-count').textContent = `${chatCount} line${chatCount === 1 ? '' : 's'}`;
  el('stored-stations-count').textContent = `${stations} station${stations === 1 ? '' : 's'}`;
  const links = lqa.serialize();
  el('stored-link-count').textContent = `${links.heard.length} station${links.heard.length === 1 ? '' : 's'} heard, ${links.samples.length} decodes`;
}
function confirmClear(what: string, action: () => void): void {
  if (!confirm(`Clear ${what}? This cannot be undone.`)) return;
  action();
  showStoredCounts();
  link.render();
}
el('clear-chat').addEventListener('click', () => confirmClear('all chat messages', () => chat.clearChat()));
el('clear-stations').addEventListener('click', () => confirmClear('the list of known stations', () => chat.clearStations()));
el('clear-debug').addEventListener('click', () => confirmClear('the frame log', () => chat.clearDebug()));
el('clear-link').addEventListener('click', () =>
  confirmClear('the link statistics', () => {
    linkSaver.cancel();
    lqa.clear();
    removeKey(LINK_KEY);
  }),
);
showStoredCounts();

for (const b of document.querySelectorAll('.announce-button')) b.addEventListener('click', () => chat.announce());

/** Sidebar collapse: the choice is kept in settings. */
const sidebarToggle = el<HTMLButtonElement>('sidebar-toggle');
function applySidebar(): void {
  const collapsed = settings.sidebarCollapsed;
  el('app').classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.textContent = collapsed ? '»' : '«';
  sidebarToggle.title = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
}
applySidebar();
sidebarToggle.addEventListener('click', () => {
  settings.sidebarCollapsed = !settings.sidebarCollapsed;
  saveSettings(settings);
  applySidebar();
});
el('station-id').textContent = `#${settings.stationId}`;
const display = new SpectrumDisplay(el<HTMLCanvasElement>('spectrum'));
display.setSlotMs(protocol.spec.slotSec * 1000);

const bandSelect = el<HTMLSelectElement>('band-select');
for (const b of bands) {
  const o = document.createElement('option');
  o.value = b.name;
  o.textContent = `${b.name} · ${b.lowHz / 1000}–${b.highHz / 1000} kHz`;
  bandSelect.append(o);
}

const decodeOwn = el<HTMLInputElement>('decode-while-sending');
decodeOwn.checked = settings.decodeWhileSending;
engine.setDecodeWhileSending(settings.decodeWhileSending);
decodeOwn.addEventListener('change', () => {
  engine.setDecodeWhileSending(decodeOwn.checked);
  settings.decodeWhileSending = decodeOwn.checked;
  saveSettings(settings);
});

const notifier = new Notifier();
void notifier.init();
chat.notifier = notifier;
// Also notify while the page is visible but another screen (Network, Users, Settings) is showing, like the unread dot.
notifier.attentive = () => !document.hidden && document.hasFocus() && !el('screen-chat').hidden;
const notifyBox = el<HTMLInputElement>('notifications');
const notifyHint = el('notifications-hint');
function syncNotifications(): void {
  notifier.enabled = settings.notifications && notifier.state === 'granted';
  notifyBox.checked = notifier.enabled;
  notifyHint.textContent =
    notifier.state === 'unsupported'
      ? 'This browser has no notifications (on iPhone, add the page to the home screen first).'
      : notifier.state === 'denied'
        ? 'Blocked in the browser: allow notifications for this site in its settings.'
        : '';
}
syncNotifications();
notifyBox.addEventListener('change', async () => {
  settings.notifications = notifyBox.checked && (await notifier.enable());
  saveSettings(settings);
  syncNotifications();
});

el('notify-test').addEventListener('click', async () => {
  notifyHint.textContent = 'Sending…';
  const result = await notifier.test();
  syncNotifications();
  notifyHint.textContent = notifyHint.textContent || result;
});

/** Listen on every channel of the band (costs CPU, ~0.3 s per channel per slot) or only the selected one. */
const listenAll = el<HTMLInputElement>('listen-all');
listenAll.checked = settings.listenAll;
function applyListen(): void {
  const selected = channels.find((c) => c.number === settings.channel);
  const listen = settings.listenAll ? channels : selected ? [selected] : [];
  engine.setListenChannels(listen.map((c) => c.baseHz));
}
listenAll.addEventListener('change', () => {
  settings.listenAll = listenAll.checked;
  saveSettings(settings);
  applyListen();
});

const autoChannel = el<HTMLInputElement>('auto-channel');
autoChannel.checked = settings.autoChannel;
chat.setAutoChannel(settings.autoChannel);
autoChannel.addEventListener('change', () => {
  settings.autoChannel = autoChannel.checked;
  saveSettings(settings);
  chat.setAutoChannel(autoChannel.checked);
});
el('sound-button').addEventListener('click', () => {
  lastSoundMs = Date.now();
  chat.sound();
});

/** Repeater mode: repeat every frame heard from others. Turning it on sends a sound that tells others. */
const repeaterBox = el<HTMLInputElement>('repeater');
repeaterBox.checked = settings.repeater;
repeaterBox.addEventListener('change', () => {
  settings.repeater = repeaterBox.checked;
  saveSettings(settings);
  chat.setRepeater(repeaterBox.checked);
  link.render();
});

/**
 * A collapsible block built from a plain button + body, not <details>/<summary>:
 * Chromium hides every non-summary child of a <details> through internal slot
 * rendering, not CSS, so a sibling control that must stay visible while collapsed
 * (the channel strip; Test) can't live inside one at all.
 */
function disclosure(toggleId: string, bodyId: string, open: boolean, onChange: (open: boolean) => void): void {
  const toggle = el<HTMLButtonElement>(toggleId);
  const body = el(bodyId);
  const apply = (isOpen: boolean): void => {
    toggle.setAttribute('aria-expanded', String(isOpen));
    body.hidden = !isOpen;
    // On the Network screen, Map and Channels are stretched to match height (see
    // .network-top in styles.css); a collapsed one should shrink to its own content
    // instead of staying stretched empty next to a sibling that is still open.
    toggle.closest('.channel-block')?.classList.toggle('is-collapsed', !isOpen);
  };
  apply(open);
  toggle.addEventListener('click', () => {
    const isOpen = toggle.getAttribute('aria-expanded') !== 'true';
    apply(isOpen);
    onChange(isOpen);
  });
}
disclosure('channel-block-toggle', 'channel-block-body', settings.channelsOpen, (open) => {
  settings.channelsOpen = open;
  saveSettings(settings);
});
disclosure('net-options-toggle', 'net-options-body', settings.netOptionsOpen, (open) => {
  settings.netOptionsOpen = open;
  saveSettings(settings);
});
disclosure('map-block-toggle', 'map-block-body', settings.mapOpen, (open) => {
  settings.mapOpen = open;
  saveSettings(settings);
});
disclosure('sync-block-toggle', 'sync-block-body', settings.syncOpen, (open) => {
  settings.syncOpen = open;
  saveSettings(settings);
});

/** Waterfall colour scale: floor and ceiling sliders plus a one-shot fit to the current input. */
const floorInput = el<HTMLInputElement>('level-floor');
const ceilInput = el<HTMLInputElement>('level-ceil');
function applyLevels(floorDb: number, ceilDb: number): void {
  floorDb = Math.min(floorDb, Number(ceilInput.max) - MIN_LEVEL_SPAN_DB);
  ceilDb = Math.max(ceilDb, floorDb + MIN_LEVEL_SPAN_DB);
  floorDb = Math.min(Math.max(floorDb, Number(floorInput.min)), Number(floorInput.max));
  ceilDb = Math.min(Math.max(ceilDb, Number(ceilInput.min)), Number(ceilInput.max));
  floorInput.value = String(floorDb);
  ceilInput.value = String(ceilDb);
  el('level-floor-value').textContent = `${floorDb} dB`;
  el('level-ceil-value').textContent = `${ceilDb} dB`;
  display.setLevelRange(floorDb, ceilDb);
  settings.floorDb = floorDb;
  settings.ceilDb = ceilDb;
  saveSettings(settings);
}
floorInput.addEventListener('input', () => {
  const floorDb = Number(floorInput.value);
  applyLevels(floorDb, Math.max(Number(ceilInput.value), floorDb + MIN_LEVEL_SPAN_DB));
});
ceilInput.addEventListener('input', () => {
  const ceilDb = Number(ceilInput.value);
  applyLevels(Math.min(Number(floorInput.value), ceilDb - MIN_LEVEL_SPAN_DB), ceilDb);
});
el('level-fit').addEventListener('click', () => {
  const fit = display.fitLevelRange();
  if (fit) applyLevels(fit.floorDb, fit.ceilDb);
});
applyLevels(settings.floorDb, settings.ceilDb);

/**
 * Modes as the user knows them: A/B/C are Normal/Medium/Fast, speed-ordered from
 * when there were only three. Long and Deep (slower and more sensitive than
 * Normal) came after, so they're lettered by their own initial instead.
 */
const MODE_LETTER: Record<string, string> = {
  'gfsk8-normal': 'A',
  'gfsk8-medium': 'B',
  'gfsk8-fast': 'C',
  'gfsk8-long': 'L',
  'gfsk8-deep': 'D',
};

/** Protocol choice. Both stations must use the same one; it applies after a reload, which rebuilds the audio path. */
const protocolSelect = el<HTMLSelectElement>('protocol-select');
for (const p of listProtocols()) {
  const o = document.createElement('option');
  o.value = p.spec.id;
  o.textContent = `Mode ${MODE_LETTER[p.spec.id] ?? '?'} · ${p.spec.name} · ${p.spec.slotSec} s slots`;
  protocolSelect.append(o);
}
protocolSelect.value = protocol.spec.id;
protocolSelect.addEventListener('change', () => {
  settings.protocol = protocolSelect.value;
  saveSettings(settings);
  location.reload();
});

/** A message arrived or one of ours was delivered while the Chat screen was hidden: its dot blinks green until Chat is shown. */
let chatNews = false;
function chatAttention(): void {
  const chatDot = dots.get('chat');
  if (chatDot) blink(chatDot, 'dot-blink');
  if (!el('screen-chat').hidden) return;
  chatNews = true;
  setDot('chat', 'green', true);
}
chat.onIncoming = chatAttention;
chat.onDelivered = chatAttention;

const dots = new Map<string, HTMLElement>();
for (const d of document.querySelectorAll<HTMLElement>('[data-dot]')) dots.set(d.dataset.dot!, d);
type DotColour = 'green' | 'yellow' | 'red' | null;
/** Restart a one-shot CSS blink (white flash) on an element. */
function blink(e: HTMLElement, className: string): void {
  e.classList.remove(className);
  void e.offsetWidth;
  e.classList.add(className);
  e.addEventListener('animationend', () => e.classList.remove(className), { once: true });
}
function setDot(name: string, colour: DotColour, pulsing = false): void {
  const d = dots.get(name);
  if (!d) return;
  const next = (colour ? `dot dot-${colour}` : 'dot') + (pulsing ? ' dot-pulse' : '');
  const was = d.dataset.state;
  if (was === next) return; // untouched, so a running blink is not cut short
  d.dataset.state = next;
  d.className = next;
  if (was !== undefined) blink(d, 'dot-blink'); // state change; the first draw does not blink
}
const LINK_GOOD_DB = -10;
const LINK_OK_DB = -16;
const LINK_RECENT_SLOTS = 8;
const USERS_RECENT_SLOTS = 4;
let dotsAtSec = -1;
/** Once a second: chat = unread message or delivery (blinking green), link = best recent SNR, users = who was heard lately. */
function updateDots(): void {
  const nowMs = Date.now();
  const sec = Math.floor(nowMs / 1000);
  if (sec === dotsAtSec) return;
  dotsAtSec = sec;
  setDot('chat', chatNews ? 'green' : null, chatNews);
  const slot = Math.floor(nowMs / (protocol.spec.slotSec * 1000));
  let best: number | undefined;
  let heardRecently = false;
  for (const r of lqa.snapshot(slot)) {
    if (slot - r.lastSlot > LINK_RECENT_SLOTS) continue;
    for (const v of [r.heardDb, r.reportedDb]) if (v !== undefined && (best === undefined || v > best)) best = v;
    if (r.heardDb !== undefined && slot - r.lastSlot <= USERS_RECENT_SLOTS) heardRecently = true;
  }
  setDot('network', best === undefined ? null : best >= LINK_GOOD_DB ? 'green' : best >= LINK_OK_DB ? 'yellow' : 'red');
  applyOverload(nowMs);
  const relayed = [...session.relayedStations.values()];
  if (relayed.some((r) => slot - r.slot <= USERS_RECENT_SLOTS)) heardRecently = true;
  setDot('users', heardRecently ? 'green' : lqa.stations(slot).length > 0 || relayed.length > 0 ? 'yellow' : null);
  setDot('settings', settings.nickname.trim() === '' ? 'yellow' : null);
}

/** Sidebar navigation: one screen visible at a time. */
const navItems = document.querySelectorAll<HTMLButtonElement>('.nav-item:not(:disabled)');
function showScreen(name: string): void {
  for (const item of navItems) {
    const active = item.dataset.screen === name;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
    el(`screen-${item.dataset.screen}`).hidden = !active;
  }
  if (name === 'network') link.render();
  if (name === 'users') users.render();
  if (name === 'settings') showStoredCounts();
  if (name === 'chat') {
    chatNews = false;
    setDot('chat', null);
  }
}
for (const item of navItems) item.addEventListener('click', () => showScreen(item.dataset.screen!));
// The Network screen is where audio is turned on and the network shows up: start there.
showScreen('network');
/** Channels flagged as overloaded, with the wall-clock time the flag runs out. */
const overUntilMs = new Map<number, number>();
const OVERLOAD_HOLD_MS = 60_000;
function applyOverload(nowMs = Date.now()): void {
  for (const [n, until] of overUntilMs) if (until <= nowMs) overUntilMs.delete(n);
  display.setOverloaded(new Set(overUntilMs.keys()));
  for (const cell of strip.children) {
    const over = overUntilMs.has(Number((cell as HTMLElement).dataset.channel));
    cell.classList.toggle('channel-over', over);
    if (over) cell.setAttribute('title', 'Input overloaded: lower the microphone level');
    else cell.removeAttribute('title');
  }
}
chat.onActivity = (heard, overloaded) => {
  const now = Date.now();
  for (const n of overloaded) overUntilMs.set(n, now + OVERLOAD_HOLD_MS);
  for (const cell of strip.children) {
    if (heard.includes(Number((cell as HTMLElement).dataset.channel))) blink(cell as HTMLElement, 'channel-blink');
  }
  for (const n of heard) display.flash(n);
  if (heard.length > 0) {
    lastRxMs = now;
    const lamp = keyAudio.querySelector<HTMLElement>('.lamp');
    if (lamp) blink(lamp, 'lamp-flash');
  }
  applyOverload(now);
};
/** One cell per channel of the band, in the header so it shows even when the block is collapsed. */
const strip = el('channel-strip');
function renderStrip(): void {
  strip.replaceChildren();
  for (const c of channels) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'channel-cell';
    cell.dataset.channel = String(c.number);
    cell.textContent = String(c.number);
    cell.title = `Channel ${c.number}: click to select, click again to clear. With Auto test off, a selected channel carries every transmission.`;
    cell.addEventListener('click', () => toggleChannel(c.number));
    strip.append(cell);
  }
}
function selectChannel(number: number | null): void {
  display.setSelected(number);
  const ch = channels.find((c) => c.number === number);
  for (const cell of strip.children) {
    const on = Number((cell as HTMLElement).dataset.channel) === number;
    cell.classList.toggle('channel-current', on);
    cell.setAttribute('aria-pressed', String(on));
  }
  tone.setSelectedChannel(ch ?? null);
  chat.setSelectedChannel(ch ?? null);
  settings.channel = ch ? ch.number : null;
  saveSettings(settings);
  applyListen();
}
/** Clicking the selected channel again clears the selection: frames go back to the best / quietest channel. */
function toggleChannel(number: number): void {
  selectChannel(settings.channel === number ? null : number);
}
display.onSelect = toggleChannel;

/** Show one band: waterfall span, channel plan and test tone references. Drops a channel from another band. */
function selectBand(next: Band): void {
  band = next;
  channels = listChannels(protocol.spec, band);
  chat.setBandChannels(channels);
  renderStrip();
  bandSelect.value = band.name;
  // Margin of 3% of the width either side so the edge channels and reference tones are not clipped.
  const margin = Math.max(20, (band.highHz - band.lowHz) * 0.03);
  display.setViewRange(Math.max(0, band.lowHz - margin), band.highHz + margin);
  display.setPlan(channels, bandwidthHz(protocol.spec), referenceTonesHz(band));
  settings.band = band.name;
  const current = channels.find((c) => c.number === settings.channel);
  selectChannel(current ? current.number : null);
  if (engine.running) {
    showError(null);
    warnIfRateTooLow();
    warnIfNoMic();
  }
}
bandSelect.addEventListener('change', () => {
  selectBand(bands.find((b) => b.name === bandSelect.value) ?? DEFAULT_BAND);
});

/**
 * The status block: state (stopped / listening / sending), the time left until the
 * next action. Only touches the DOM when a string changes.
 */
const shown = { status: '', main: '', count: '', last: '', next: '' };
const keyAudio = el<HTMLButtonElement>('key-audio');
const keyTx = el<HTMLButtonElement>('key-tx');
/** When a frame from another station was last decoded: the Audio lamp flashes and the panel says so for a moment. */
let lastRxMs = 0;
const RX_NOTE_MS = 4000;
const cadenceFill = el('status-cadence-fill');
// Where a frame ends within its slot: the rest of the slot is decode time.
el('status-cadence-mark').style.left = `${(100 * frameDurationSec(protocol.spec)) / protocol.spec.slotSec}%`;
function updateStatus(): void {
  const now = Date.now();
  const tx = chat.transmitWindow;
  // A frame handed to the transmitter but waiting for its slot boundary: preparing, not yet on air.
  const preparing = engine.sending && tx !== null && now < tx.startMs;
  const status = !engine.running ? 'stopped' : preparing ? 'preparing' : engine.sending ? 'sending' : !engine.hasMic ? 'txonly' : 'listening';
  const panel = el('audio-state');
  if (status !== shown.status) {
    shown.status = status;
    panel.className = `radio status-${status}`;
  }
  // Key lamps: Audio on/off; TX off / allowed / waiting for its slot / on air.
  const txLamp = !engine.transmitAllowed ? 'off' : preparing ? 'preparing' : engine.sending ? 'onair' : 'armed';
  const audioLamp = engine.running ? 'on' : 'off';
  if (panel.dataset.tx !== txLamp || panel.dataset.audio !== audioLamp) {
    panel.dataset.tx = txLamp;
    panel.dataset.audio = audioLamp;
    keyAudio.setAttribute('aria-pressed', String(engine.running));
    keyAudio.title = engine.running ? 'Turn audio off: stop listening and sending' : 'Turn audio on: listen to the microphone and allow sending';
    keyTx.setAttribute('aria-pressed', String(engine.transmitAllowed));
    keyTx.title = engine.transmitAllowed ? 'Transmit allowed: click to stop this station sending anything' : 'Transmit off: click to allow sending';
  }
  const slotMs = protocol.spec.slotSec * 1000;
  const offsetMs = settings.slotOffsetMs;
  const slotStart = Math.floor((now - offsetMs) / slotMs) * slotMs + offsetMs;
  // Cadence bar: how far into the slot we are, on our (possibly shifted) grid.
  cadenceFill.style.transform = `scaleX(${((now - slotStart) / slotMs).toFixed(4)})`;
  const secs = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));

  let count = status === 'stopped' ? 'Press Audio to start' : '';
  if (status === 'txonly') count = 'No microphone';
  else if (status !== 'stopped') {
    if (tx && now < tx.startMs) count = `On air in ${secs(tx.startMs - now)} s`;
    else if (tx && now < tx.endMs) count = `${secs(tx.endMs - now)} s left${chat.sendingChannel === null ? "" : `, ch ${chat.sendingChannel}`}`;
    else if (now - lastRxMs < RX_NOTE_MS) count = 'Frame received';
    else count = `${engine.transmitAllowed ? '' : 'TX off, '}next slot in ${secs(slotStart + slotMs - now)} s`;
    count = count.charAt(0).toUpperCase() + count.slice(1);
  }
  const main = { stopped: 'Audio off', listening: 'Listening', preparing: 'Sending soon', sending: 'On air', txonly: 'Sending only' }[status];
  if (main !== shown.main) el('status-main').textContent = shown.main = main;
  if (count !== shown.count) el('status-count').textContent = shown.count = count;

  // Network screen: the last thing that happened and what comes next.
  const act = chat.lastAction;
  const last = act ? `${act.text} · ${formatAge((now - act.atMs) / 1000)}` : 'nothing yet';
  const next = chat.nextAction(now);
  if (last !== shown.last) el('activity-last').textContent = shown.last = last;
  if (next !== shown.next) el('activity-next').textContent = shown.next = next;
}

const audioOn = el<HTMLInputElement>('audio-on');
const allowTx = el<HTMLInputElement>('allow-tx');
// The panel keys work the same switches as Network options, so both always agree.
keyAudio.addEventListener('click', () => audioOn.click());
keyTx.addEventListener('click', () => allowTx.click());
allowTx.checked = engine.transmitAllowed;
allowTx.addEventListener('change', () => {
  settings.allowTx = allowTx.checked;
  saveSettings(settings);
  engine.setTransmitAllowed(allowTx.checked);
  setAudioState(engine.running);
});

function setAudioState(running: boolean): void {
  updateStatus();
  audioOn.checked = running;
  tone.refresh();
  chat.refresh();
}

/** Without a microphone the station still sends; say so and what to do about it. */
function warnIfNoMic(): void {
  if (!engine.running || engine.hasMic) return;
  showError(
    `No microphone (${engine.micErrorText ?? 'not available'}): this station can only send. ` +
      'Connect a microphone or allow access to it, then reload the page to receive.',
  );
}

function showError(message: string | null): void {
  el('error').hidden = message === null;
  el('error-text').textContent = message ?? '';
}

/**
 * A context running at a low rate (a Bluetooth headset can force 16 kHz) simply
 * has no room above half its rate, so the highest channels would silently never
 * work. Say so instead. Keeps a margin below Nyquist for the receive filter.
 */
function warnIfRateTooLow(): void {
  const usableHz = engine.sampleRate * 0.45;
  const lost = channels.filter((c) => c.baseHz + bandwidthHz(protocol.spec) > usableHz);
  if (lost.length === 0) return;
  showError(
    `The audio device runs at ${engine.sampleRate} Hz, which cannot carry channels ` +
      `${lost[0]!.number}–${lost[lost.length - 1]!.number} (above ~${Math.round(usableHz)} Hz).`,
  );
}

audioOn.addEventListener('change', async () => {
  showError(null);
  try {
    if (engine.running) await engine.stop();
    else {
      await engine.start();
      warnIfRateTooLow();
      warnIfNoMic();
    }
  } catch (err) {
    showError(`Could not start audio: ${err instanceof Error ? err.message : String(err)}`);
  }
  setAudioState(engine.running);
});

function frame(): void {
  updateStatus();
  display.setTiming(settings.slotOffsetMs, engine.running ? engine.spectrumLagMs : 0);
  display.setSending(chat.sendingChannel);
  display.render(engine.getSpectrum(), engine.sampleRate);
  chat.tick();
  link.tick();
  users.tick();
  updateDots();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

selectBand(band);

/** Try to start on load. Browsers may refuse: a suspended context is resumed by the first click. */
async function autoStart(): Promise<void> {
  try {
    await engine.start();
    warnIfRateTooLow();
    warnIfNoMic();
  } catch {
    // The audio context could not be created: the Audio toggle still works.
  }
  setAudioState(engine.running);
  if (!engine.running) {
    document.addEventListener(
      'click',
      () => {
        // Runs after the button's own handler; only resumes a context that is still suspended.
        if (!engine.running) void engine.start().then(() => setAudioState(engine.running), () => {});
      },
      { once: true },
    );
  }
}
void autoStart();

/** Auto announce: a hello every `announceIntervalMin` minutes (default 5). */
const autoAnnounce = el<HTMLInputElement>('auto-announce');
autoAnnounce.checked = settings.autoAnnounce;
autoAnnounce.addEventListener('change', () => {
  settings.autoAnnounce = autoAnnounce.checked;
  saveSettings(settings);
});
const announceInterval = el<HTMLInputElement>('announce-interval');
announceInterval.value = String(settings.announceIntervalMin);
announceInterval.addEventListener('change', () => {
  const n = Math.round(Number(announceInterval.value));
  settings.announceIntervalMin = Number.isFinite(n) ? Math.min(120, Math.max(1, n)) : DEFAULT_SETTINGS.announceIntervalMin;
  announceInterval.value = String(settings.announceIntervalMin);
  saveSettings(settings);
});
let lastAnnounceMs = Date.now();
/** Auto test intervals offered, in minutes. Was a fixed 1 min, which crowded the band with several stations. */
const AUTO_SOUND_CHOICES_MIN = [1, 2, 3, 5, 10, 15];
if (!AUTO_SOUND_CHOICES_MIN.includes(settings.autoSoundIntervalMin)) settings.autoSoundIntervalMin = DEFAULT_SETTINGS.autoSoundIntervalMin;
const autoSound = el<HTMLInputElement>('auto-sound');
autoSound.checked = settings.autoSound;
chat.setAutoSound(settings.autoSound);
autoSound.addEventListener('change', () => {
  settings.autoSound = autoSound.checked;
  chat.setAutoSound(autoSound.checked);
  saveSettings(settings);
});
const autoSoundInterval = el<HTMLSelectElement>('auto-sound-interval');
autoSoundInterval.replaceChildren(...AUTO_SOUND_CHOICES_MIN.map((m) => new Option(`${m} min`, String(m))));
autoSoundInterval.value = String(settings.autoSoundIntervalMin);
autoSoundInterval.addEventListener('change', () => {
  settings.autoSoundIntervalMin = Number(autoSoundInterval.value);
  saveSettings(settings);
});
/**
 * Network options back to their defaults, through each control's own change
 * handler so every side effect (engine, chat, redraws) happens as if clicked.
 * Asks for a second click first. Protocol goes last: changing it reloads.
 */
const resetButton = el<HTMLButtonElement>('net-options-reset');
let resetArmedTimer: ReturnType<typeof setTimeout> | undefined;
resetButton.addEventListener('click', () => {
  if (resetArmedTimer === undefined) {
    resetButton.textContent = 'Click again to reset';
    resetArmedTimer = setTimeout(() => {
      resetArmedTimer = undefined;
      resetButton.textContent = 'Reset to defaults';
    }, 4000);
    return;
  }
  clearTimeout(resetArmedTimer);
  resetArmedTimer = undefined;
  resetButton.textContent = 'Reset to defaults';
  const d = DEFAULT_SETTINGS;
  const boxes: [HTMLInputElement, boolean][] = [
    [allowTx, d.allowTx],
    [autoChannel, d.autoChannel],
    [autoSound, d.autoSound],
    [repeaterBox, d.repeater],
    [deepBox, d.deepDecode && !deepBox.disabled],
  ];
  const selects: [HTMLSelectElement, string][] = [
    [autoSoundInterval, String(d.autoSoundIntervalMin)],
    [bandSelect, d.band],
    [protocolSelect, d.protocol],
  ];
  for (const [box, on] of boxes) {
    if (box.checked === on) continue;
    box.checked = on;
    box.dispatchEvent(new Event('change'));
  }
  for (const [select, value] of selects) {
    if (select.value === value) continue;
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }
});

/** Any beacon, automatic or "Test", restarts the Auto test wait. */
let lastSoundMs = Date.now();
// Checked every 10 s so a changed interval takes effect without a reload.
setInterval(() => {
  if (!settings.autoSound || !engine.running || !settings.autoChannel) return;
  if (Date.now() - lastSoundMs < settings.autoSoundIntervalMin * 60_000) return;
  lastSoundMs = Date.now();
  chat.sound();
}, 10_000);
// Checked every 10 s so a changed interval takes effect without a reload.
setInterval(() => {
  if (!settings.autoAnnounce || Date.now() - lastAnnounceMs < settings.announceIntervalMin * 60_000) return;
  lastAnnounceMs = Date.now();
  if (engine.running && session.hasNickname) chat.announce(true);
}, 10_000);
