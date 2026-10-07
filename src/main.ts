/** Wiring only. Logic belongs in protocol/, band/, audio/ or render/. */

import { autoBeaconDue } from './ale/tx-policy';
import { AudioEngine } from './audio/engine';
import { DEFAULT_BAND, bandsFor, listChannels, referenceTonesHz, type Band } from './band/band-plan';
import { DEFAULT_PROTOCOL_ID, getProtocol, isProtocolId, listProtocols } from './protocol/registry';
import { bandwidthHz, deepExtraSec, frameDurationSec } from './protocol/spec';
import { DEFAULT_THEME_ID, THEMES, themeById } from './render/waterfall-themes';
import { DEFAULT_CEIL_DB, DEFAULT_FLOOR_DB, MIN_LEVEL_SPAN_DB, SpectrumDisplay } from './render/spectrum-display';
import { LqaTable } from './ale/lqa';
import { formatAge, type RepeaterInfo } from './ale/link-model';
import { ChatSession } from './chat/session';
import { randomStationId } from './chat/frames';
import { StatsClient } from './stats/stats-client';
import { statsRecord } from './stats/stats-record';
import { StatsView } from './stats/stats-view';
import { ChatPanel } from './ui/chat-panel';
import { Notifier } from './ui/notifier';
import { CaptureView } from './ui/capture-view';
import { WindowCapture } from './dsp/window-capture';
import { LinkView, type StationsView } from './ui/link-view';
import { ServerClock } from './sync/server-clock';
import { EMOJI, ICON_COUNT, defaultIconIndex, emojiFor } from './chat/emoji-table';
import { UsersView } from './ui/users-view';
import { DEFAULT_PIXEL_PX, clampPixelPx, drawSprite, type HoleStyle } from './ui/sprite-view';
import { SPRITE_GALLERY, parseRows } from './chat/sprite-gallery';
import { SPRITE_PALETTE } from './chat/sprite';
import { TestToneControl } from './ui/test-tone';
import { DeferredSaver, LINK_KEY, loadJson, removeKey, saveJson } from './storage/store';

const SETTINGS_KEY = 'audiochat:settings';

interface Settings {
  band: string;
  channel: number | null;
  /** Channels switched off for transmitting (tap cycle: normal, selected, blocked), by protocol id. */
  blockedChannels: Record<string, number[]>;
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
  /** Our icon: index into the emoji table, or -1 for the automatic one (a hash of the station id). */
  iconIndex: number;
  autoAnnounce: boolean;
  announceIntervalMin: number;
  /** Minutes between Auto beacon beacons; one of AUTO_SOUND_CHOICES_MIN. */
  autoSoundIntervalMin: number;
  /** Slot grid moved against UTC to match another station ("Sync" on the Network screen). */
  slotOffsetMs: number;
  notifications: boolean;
  /** Share frame metadata with the public MQTT broker (Settings > Network stats). Off by default. */
  publishStats: boolean;
  protocol: string;
  /** Repeat every frame heard from others (Network screen). */
  repeater: boolean;
  /** Search a few seconds beyond the usual timing window (Network screen). */
  deepDecode: boolean;
  /** The Capture section is shown on the Network screen (Settings > Network capture). Capturing itself always starts off. */
  networkCapture: boolean;
  /** Check this clock against the page's server every 10 minutes (Sync, Network screen). */
  /** The automatic server clock check (at startup and every 10 min) is switched off. */
  serverClockOff: boolean;
  /** Master transmit switch (Network options): off = this station never sends anything. */
  allowTx: boolean;
  /** Stations layout on the Network screen: table (columns), cards (one per station) or grid (compact tiles). */
  stationsView: StationsView;
  /** Sidebar narrowed to the status colour and the screen dots. */
  sidebarCollapsed: boolean;
  rotate180: boolean;
  /** Size of one sprite pixel in the chat and the editor, CSS pixels (2..40). */
  spritePixelSize: number;
  /** How a partly received sprite shows its missing pixels. */
  spriteHoles: HoleStyle;
  waterfallTheme: string;
}

const DEFAULT_SETTINGS: Settings = {
  band: DEFAULT_BAND.name,
  channel: null,
  blockedChannels: {},
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
  iconIndex: -1,
  autoAnnounce: false,
  announceIntervalMin: 5,
  autoSoundIntervalMin: 5,
  slotOffsetMs: 0,
  notifications: false,
  publishStats: false,
  protocol: DEFAULT_PROTOCOL_ID,
  repeater: false,
  deepDecode: false,
  networkCapture: false,
  serverClockOff: false,
  allowTx: true,
  stationsView: 'table',
  sidebarCollapsed: false,
  rotate180: false,
  spritePixelSize: DEFAULT_PIXEL_PX,
  spriteHoles: 'fill',
  waterfallTheme: DEFAULT_THEME_ID,
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
const lqa = new LqaTable({ reportSilenceSlots: Math.ceil(600 / protocol.spec.slotSec), slotSec: protocol.spec.slotSec });
lqa.restore(loadJson(LINK_KEY));
const linkSaver = new DeferredSaver(() => saveJson(LINK_KEY, lqa.serialize()), 5000);
lqa.onChange = () => linkSaver.touch();
const session = new ChatSession({ stationId: settings.stationId, lqa });
session.setNickname(settings.nickname);
const myIconIndex = (): number => (settings.iconIndex >= 0 && settings.iconIndex < ICON_COUNT ? settings.iconIndex : defaultIconIndex(settings.stationId));
session.setIcon(myIconIndex());
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
  updateClockBanner();
}
serverCheck.addEventListener('click', () => void checkServerClock());
const serverAuto = el<HTMLInputElement>('sync-server-auto');
serverAuto.checked = !settings.serverClockOff;
serverAuto.addEventListener('change', () => {
  settings.serverClockOff = !serverAuto.checked;
  saveSettings(settings);
  if (serverAuto.checked && !serverClock.latest) void checkServerClock();
});
setInterval(() => {
  if (!settings.serverClockOff && !document.hidden) void checkServerClock();
}, 10 * 60_000);
if (!settings.serverClockOff) void checkServerClock();
el('sync-server-use').addEventListener('click', () => {
  const r = serverClock.latest;
  if (!r) return;
  link.setOffsetMs(Math.round(r.offsetMs));
  // Say what happened: the offset is clamped, so a big error may not be fully corrected.
  const wantMs = Math.round(r.offsetMs);
  const gotMs = settings.slotOffsetMs;
  clockBannerFlash = Math.abs(wantMs - gotMs) < 20
    ? { text: `Server time applied: the slot grid moved by ${(gotMs / 1000).toFixed(2)} s.`, until: Date.now() + 5000 }
    : { text: `Only ${(gotMs / 1000).toFixed(2)} s of ${(wantMs / 1000).toFixed(2)} s could be applied (the limit is 0.4 of a slot). Fix this device's clock.`, until: Date.now() + 15000 };
  updateClockBanner();
  setTimeout(updateClockBanner, 5100);
});

/**
 * Warning bar when our clock, against the server's, is off by enough to eat a good part of the
 * decoder's timing window. Closing it keeps it closed until the page is reloaded; it goes away
 * by itself once the clock is fine again.
 */
const clockBanner = el('clock-banner');
let clockBannerClosed = false;
let clockBannerText = '';
let clockBannerFlash: { text: string; until: number } | null = null;
function updateClockBanner(): void {
  if (clockBannerFlash && Date.now() >= clockBannerFlash.until) clockBannerFlash = null;
  const r = serverClock.latest;
  // What is left after our slot offset: "Use server time" sets the offset to the measurement.
  const leftMs = r ? r.offsetMs - settings.slotOffsetMs : 0;
  const limitMs = Math.max(0.3 * protocol.spec.maxTimeOffsetSec * 1000, (r?.uncertaintyMs ?? 0) + 50);
  const off = r !== null && Math.abs(leftMs) > limitMs;
  let text = '';
  if (off) {
    const secs = (Math.abs(leftMs) / 1000).toFixed(1);
    text = `This device's clock is ${secs} s ${leftMs > 0 ? 'ahead of' : 'behind'} the server's. ` +
      `Stations with the right time may not decode (this mode tolerates ${protocol.spec.maxTimeOffsetSec} s in total). ` +
      'If nothing decodes but the waterfall shows activity in the channels, this is probably why.';
  }
  // Right after "Use server time" the bar shows the result, even if the clock is fine now.
  if (clockBannerFlash) text = clockBannerFlash.text;
  if (text !== clockBannerText) {
    clockBannerText = text;
    el('clock-banner-text').textContent = text;
  }
  clockBanner.hidden = clockBannerFlash ? false : !off || clockBannerClosed;
  el('clock-banner-use').hidden = clockBannerFlash !== null;
  // The Sync section's own dot, whether or not the bar was closed: red = out of sync against the
  // server, yellow = a slot offset is being applied, green = no offset and no deviation, grey = no check yet.
  const applied = settings.slotOffsetMs !== 0;
  const syncDot: DotColour = off ? 'red' : applied ? 'yellow' : r ? 'green' : null;
  setDot('sync', syncDot);
  const syncTitle = off ? "Out of sync: the clock differs from the server's"
    : applied ? `Applying a slot offset of ${(settings.slotOffsetMs / 1000).toFixed(2)} s`
    : r ? 'In sync with the server, no offset applied'
    : 'No clock check against the server yet';
  const syncDotEl = dots.get('sync');
  if (syncDotEl && syncDotEl.title !== syncTitle) syncDotEl.title = syncTitle;
}
el('clock-banner-use').addEventListener('click', () => el('sync-server-use').click());
el('clock-banner-close').addEventListener('click', () => {
  clockBannerClosed = true;
  updateClockBanner();
});

const users = new UsersView(
  lqa,
  chat,
  () => ({ id: settings.stationId, nickname: settings.nickname }),
  () => channels.map((c) => c.number),
  protocol.spec.slotSec,
  () => !el('screen-chat').hidden,
  relayInfo,
  (id) => chat.selectRecipient(id),
);
chat.onThreadChange = () => users.render();

// Publish Network Stats (opt-in, off by default): metadata of every frame we send or hear goes to the
// shared broker, and the Stats screen shows what all publishing stations report.
const statsClient = new StatsClient(() => ({ node: settings.stationId, band: band.name, mode: protocol.spec.id }));
const statsView = new StatsView(
  statsClient,
  () => !el('screen-stats').hidden,
  (id) => (id === settings.stationId ? settings.nickname || `#${id}` : session.stations.get(id) || `#${id}`),
);
chat.frames.onAdd = (r) => {
  if (statsClient.status === 'connected') statsClient.publish(statsRecord(r, { node: settings.stationId, band: band.name, mode: protocol.spec.id }));
};
const statsBox = el<HTMLInputElement>('publish-stats');
const applyPublishStats = (): void => {
  el('nav-stats').hidden = !settings.publishStats;
  if (settings.publishStats) void statsClient.start();
  else {
    statsClient.stop();
    if (!el('screen-stats').hidden) showScreen('settings');
  }
  statsView.render();
};
statsBox.checked = settings.publishStats;
statsBox.addEventListener('change', () => {
  settings.publishStats = statsBox.checked;
  saveSettings(settings);
  applyPublishStats();
});

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
nicknameInput.value = settings.nickname.toUpperCase();
updateNickCallout();
// The wire code is upper case only, so show what will be sent while typing (caret kept).
nicknameInput.addEventListener('input', () => {
  const { selectionStart, selectionEnd } = nicknameInput;
  nicknameInput.value = nicknameInput.value.toUpperCase();
  nicknameInput.setSelectionRange(selectionStart, selectionEnd);
});
nicknameInput.addEventListener('change', () => {
  nicknameInput.value = nicknameInput.value.toUpperCase();
  settings.nickname = nicknameInput.value;
  session.setNickname(settings.nickname);
  saveSettings(settings);
  updateNickCallout();
});
link.iconOf = (id) => (id === settings.stationId ? emojiFor(myIconIndex()) : chat.iconOf(id));
// Icon picker: a grid of the whole table inside a details element; the chosen one is sent with hellos.
const iconGrid = el('icon-grid');
const iconCurrent = el('icon-current');
function showIcon(): void {
  const i = myIconIndex();
  iconCurrent.textContent = emojiFor(i);
  for (const b of iconGrid.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.index) === i));
}
EMOJI.forEach((e, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = e;
  b.dataset.index = String(i);
  b.addEventListener('click', () => {
    settings.iconIndex = i;
    session.setIcon(i);
    saveSettings(settings);
    showIcon();
  });
  iconGrid.append(b);
});
el('icon-auto').addEventListener('click', () => {
  settings.iconIndex = -1;
  session.setIcon(myIconIndex());
  saveSettings(settings);
  showIcon();
});
showIcon();
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
el('clear-chat').addEventListener('click', () => confirmClear('all messages', () => chat.clearChat()));
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

// Without a name there is nothing to announce: take the user to the field instead of failing silently.
for (const b of document.querySelectorAll('.announce-button')) {
  b.addEventListener('click', () => {
    if (settings.nickname.trim() === '') el('name-banner-set').click();
    else chat.announce();
  });
}

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
/** Rotate 180 (phones: the speaker and mic sit at the bottom edge, so the phone is held upside down to point them at the other stations; the system rotation often does not do it) and full screen. */
const rotateButton = el<HTMLButtonElement>('rotate-button');
const rotateBox = el<HTMLInputElement>('rotate-180');
function applyRotate(): void {
  document.documentElement.classList.toggle('rotated', settings.rotate180);
  rotateButton.setAttribute('aria-pressed', String(settings.rotate180));
  rotateBox.checked = settings.rotate180;
}
function setRotate(on: boolean): void {
  settings.rotate180 = on;
  saveSettings(settings);
  applyRotate();
}
settings.rotate180 = settings.rotate180 === true;
applyRotate();
rotateButton.addEventListener('click', () => setRotate(!settings.rotate180));
rotateBox.addEventListener('change', () => setRotate(rotateBox.checked));
const fullscreenButton = el<HTMLButtonElement>('fullscreen-button');
// iPhone Safari only allows full screen for video: no button there.
if (document.fullscreenEnabled) {
  fullscreenButton.hidden = false;
  fullscreenButton.addEventListener('click', () => {
    void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement !== null;
    fullscreenButton.setAttribute('aria-pressed', String(on));
    fullscreenButton.title = on ? 'Leave full screen' : 'Full screen';
  });
}
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

/**
 * Listen on every channel of the band (costs CPU) or only the selected one. Blocking is for sending
 * only, so blocked channels are decoded either way (blocking the selected channel also unselects it).
 */
const listenAll = el<HTMLInputElement>('listen-all');
listenAll.checked = settings.listenAll;
function applyListen(): void {
  const listen = settings.listenAll ? channels : channels.filter((c) => c.number === settings.channel || blockedNow.has(c.number));
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
  chat.sound(true);
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
disclosure('capture-block-toggle', 'capture-block-body', false, () => {});
for (const name of ['notify', 'stats', 'listen', 'announce', 'capture', 'screen', 'waterfall', 'sprites', 'stored', 'tone']) {
  disclosure(`set-${name}-toggle`, `set-${name}-body`, true, () => {});
}
// Capture is for debugging decodes: never stored, off at every start (see CaptureView).
const windowCapture = new WindowCapture(protocol.spec.id);
const showResultNow = engine.onDecoded;
engine.onDecoded = (result) => {
  showResultNow(result);
  windowCapture.offer(result);
};
new CaptureView(windowCapture, (on) => engine.setCaptureWindows(on), settings.networkCapture, (on) => {
  settings.networkCapture = on;
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

/** Protocol choice. Both stations must use the same one; it applies after a reload, which rebuilds the audio path. */
const protocolSelect = el<HTMLSelectElement>('protocol-select');
for (const p of listProtocols()) {
  const o = document.createElement('option');
  o.value = p.spec.id;
  o.textContent = `${p.spec.label} · ${p.spec.name} · ${p.spec.slotSec} s slots`;
  protocolSelect.append(o);
}
protocolSelect.value = protocol.spec.id;
protocolSelect.addEventListener('change', () => {
  settings.protocol = protocolSelect.value;
  saveSettings(settings);
  location.reload();
});

/** A message arrived or one of ours was delivered while the Messages screen was hidden: its dot blinks green until Messages is shown. */
let chatNews = false;
function chatAttention(): void {
  const chatDot = dots.get('chat');
  if (chatDot) blink(chatDot, 'dot-blink');
  if (!el('screen-chat').hidden) return;
  chatNews = true;
  setDot('chat', 'green', true);
}
chat.onIncoming = chatAttention;
chat.isChatVisible = () => !el('screen-chat').hidden;
chat.onUnreadChange = () => users.render();
document.addEventListener('visibilitychange', () => chat.markRead());
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
/** A packet was heard: a few random dark cells of the logo mark light up and fade, each a little apart. */
const logoCells = [...document.querySelectorAll<SVGElement>('.logo-mark .lm-off')];
function blinkLogo(): void {
  for (let k = 0; k < 4; k++) {
    const cell = logoCells[Math.floor(Math.random() * logoCells.length)];
    if (!cell) return;
    cell.style.animationDelay = `${Math.floor(Math.random() * 200)}ms`;
    cell.classList.remove('lm-rx');
    void cell.getBoundingClientRect();
    cell.classList.add('lm-rx');
    cell.addEventListener('animationend', () => cell.classList.remove('lm-rx'), { once: true });
  }
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
/** Network dot by the age of the last station heard: green up to 3 min, yellow up to 5, red up to 6, then grey (no network). */
const NET_GREEN_SEC = 180;
const NET_YELLOW_SEC = 300;
const NET_RED_SEC = 360;
let dotsAtSec = -1;
/** Once a second: chat = unread message or delivery (blinking green), network = how long since a station was heard, users = who was heard lately. */
function updateDots(): void {
  const nowMs = Date.now();
  const sec = Math.floor(nowMs / 1000);
  if (sec === dotsAtSec) return;
  dotsAtSec = sec;
  const chatDotOn = chatNews || chat.totalUnread() > 0;
  setDot('chat', chatDotOn ? 'green' : null, chatDotOn);
  const slot = Math.floor(nowMs / (protocol.spec.slotSec * 1000));
  const relayed = [...session.relayedStations.values()];
  // A station heard only through a repeater counts too.
  const newest = Math.max(lqa.newestHeardSlot() ?? -Infinity, ...relayed.map((r) => r.slot));
  const ageSec = (slot - newest) * protocol.spec.slotSec;
  setDot('network', !Number.isFinite(newest) || ageSec > NET_RED_SEC ? null : ageSec <= NET_GREEN_SEC ? 'green' : ageSec <= NET_YELLOW_SEC ? 'yellow' : 'red');
  applyOverload(nowMs);
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
  if (name === 'stats') statsView.render();
  if (name === 'settings') showStoredCounts();
  if (name === 'chat') {
    chat.markRead();
    users.render();
    chatNews = false;
    setDot('chat', chat.totalUnread() > 0 ? 'green' : null);
  }
}
for (const item of navItems) item.addEventListener('click', () => showScreen(item.dataset.screen!));
// Help: the chips at the top scroll to their section (not links: a hash would fight the screen switcher).
for (const chip of document.querySelectorAll<HTMLButtonElement>('[data-help-jump]')) {
  chip.addEventListener('click', () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(chip.dataset.helpJump!)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  });
}
// The Network screen is where audio is turned on and the network shows up: start there.
showScreen('network');
applyPublishStats();
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
    blinkLogo();
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
    cell.title = `Channel ${c.number}: each click moves it on: select, then block (nothing is sent on it; we still listen), then normal. With Auto beacon off, a selected channel carries every transmission.`;
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
const blockedNow = new Set<number>((settings.blockedChannels?.[protocol.spec.id] ?? []));
const unblockButton = el<HTMLButtonElement>('channel-unblock');
const toast = el('toast');
let toastTimer = 0;
function showToast(text: string, undo?: () => void): void {
  toast.replaceChildren(text);
  if (undo) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Undo';
    b.addEventListener('click', () => {
      undo();
      toast.hidden = true;
    });
    toast.append(b);
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
}
function applyBlocked(): void {
  settings.blockedChannels = { ...settings.blockedChannels, [protocol.spec.id]: [...blockedNow] };
  saveSettings(settings);
  display.setBlocked(blockedNow);
  chat.setBlockedChannels(blockedNow);
  applyListen();
  for (const cell of strip.children) {
    const n = Number((cell as HTMLElement).dataset.channel);
    cell.classList.toggle('channel-blocked', blockedNow.has(n));
  }
  const count = channels.filter((c) => blockedNow.has(c.number)).length;
  unblockButton.hidden = count === 0;
  unblockButton.textContent = `${count} blocked · Unblock all`;
}
unblockButton.addEventListener('click', () => {
  blockedNow.clear();
  applyBlocked();
});
/** Each tap moves a channel on: normal, selected, blocked (nothing is sent on it; we still listen), normal. */
function toggleChannel(number: number): void {
  if (blockedNow.has(number)) {
    blockedNow.delete(number);
    applyBlocked();
  } else if (settings.channel === number) {
    selectChannel(null);
    blockedNow.add(number);
    applyBlocked();
    showToast(`Channel ${number} blocked for sending`, () => {
      blockedNow.delete(number);
      applyBlocked();
    });
  } else {
    selectChannel(number);
  }
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
  const current = channels.find((c) => c.number === settings.channel && !blockedNow.has(c.number));
  selectChannel(current ? current.number : null);
  applyBlocked();
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
const shown = { status: '', main: '', count: '', last: '', lastAge: '', next: '', nextState: '' };
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
  const last = act ? act.text : 'nothing yet';
  const lastAge = act ? formatAge((now - act.atMs) / 1000) : '';
  if (last !== shown.last) {
    el('activity-last').textContent = shown.last = last;
    el('activity-last-icon').textContent = act?.icon ?? '·';
    el('activity-last-row').dataset.dir = act?.dir ?? 'none';
  }
  if (lastAge !== shown.lastAge) el('activity-last-age').textContent = shown.lastAge = lastAge;
  const next = chat.nextAction(now);
  if (next.text !== shown.next) {
    el('activity-next').textContent = shown.next = next.text;
    el('activity-next-icon').textContent = next.icon;
  }
  if (next.state !== shown.nextState) {
    shown.nextState = next.state;
    el('activity-next-row').dataset.state = next.state;
    el('activity').dataset.state = next.state;
  }
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

el('error-close').addEventListener('click', () => showError(null));

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
  // A collapsed Channels block draws no waterfall at all.
  if (!el('channel-block-body').hidden) display.render(engine.getSpectrum(), engine.sampleRate);
  chat.tick();
  link.tick();
  users.tick();
  statsView.tick();
  updateDots();
  updateClockBanner();
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

/** Sprites: pixel size and how missing pixels look. A sample sprite shows the size. */
const spritePixelSize = el<HTMLInputElement>('sprite-pixel-size');
const spritePixelOut = el<HTMLOutputElement>('sprite-pixel-size-out');
const spriteHoles = el<HTMLSelectElement>('sprite-holes');
const spriteSample = el<HTMLCanvasElement>('sprite-sample');
const sampleRows = SPRITE_GALLERY.find((g) => g.side === 8)!.sprites[0]!.rows;
function applySpriteStyle(): void {
  chat.setSpriteStyle(settings.spritePixelSize, settings.spriteHoles);
  spritePixelOut.textContent = String(settings.spritePixelSize);
  drawSprite(spriteSample, 8, settings.spritePixelSize, Array.from(parseRows(sampleRows, 8), (v) => SPRITE_PALETTE[v]!), settings.spritePixelSize >= 6);
}
settings.spritePixelSize = clampPixelPx(settings.spritePixelSize);
if (settings.spriteHoles !== 'fill' && settings.spriteHoles !== 'checker') settings.spriteHoles = DEFAULT_SETTINGS.spriteHoles;
spritePixelSize.value = String(settings.spritePixelSize);
spriteHoles.value = settings.spriteHoles;
spritePixelSize.addEventListener('input', () => {
  settings.spritePixelSize = clampPixelPx(spritePixelSize.value);
  saveSettings(settings);
  applySpriteStyle();
});
spriteHoles.addEventListener('change', () => {
  settings.spriteHoles = spriteHoles.value === 'checker' ? 'checker' : 'fill';
  saveSettings(settings);
  applySpriteStyle();
});
applySpriteStyle();

/** Waterfall look (Settings > Waterfall). */
const waterfallTheme = el<HTMLSelectElement>('waterfall-theme');
for (const t of THEMES) waterfallTheme.append(new Option(t.label, t.id));
settings.waterfallTheme = themeById(String(settings.waterfallTheme)).id;
waterfallTheme.value = settings.waterfallTheme;
display.setTheme(settings.waterfallTheme);
waterfallTheme.addEventListener('change', () => {
  settings.waterfallTheme = themeById(waterfallTheme.value).id;
  saveSettings(settings);
  display.setTheme(settings.waterfallTheme);
});

let lastAnnounceMs = Date.now();
/** Any hello of ours (Announce, auto, or an Auto beacon with nothing to report) restarts the auto announce wait. */
chat.onOwnHello = () => { lastAnnounceMs = Date.now(); };
/** Auto beacon intervals offered, in minutes. Was a fixed 1 min, which crowded the band with several stations. */
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

/** Any beacon, automatic or "Test", restarts the Auto beacon wait. */
let lastSoundMs = Date.now();
// Checked every 10 s so a changed interval takes effect without a reload.
setInterval(() => {
  if (!autoBeaconDue(settings.autoSound, engine.running, lastSoundMs, Date.now(), settings.autoSoundIntervalMin)) return;
  lastSoundMs = Date.now();
  chat.sound();
}, 10_000);
// Checked every 10 s so a changed interval takes effect without a reload.
setInterval(() => {
  if (!settings.autoAnnounce || Date.now() - lastAnnounceMs < settings.announceIntervalMin * 60_000) return;
  lastAnnounceMs = Date.now();
  if (engine.running && session.hasNickname) chat.announce(true);
}, 10_000);
