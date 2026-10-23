// The How it works page (how-it-works.html). Every number and every decode comes from audiomesh's own modules (am.ts).
import * as AM from './am';
import type { OutMessage } from '../chat/session';
import DecodeWorker from './decode.worker.ts?worker';
import './how-it-works.css';

type Spec = AM.ProtocolSpec;
const MODES: Spec[] = [AM.GFSK8_TURBO, AM.GFSK8_FAST, AM.GFSK8_MEDIUM, AM.GFSK8_NORMAL, AM.GFSK8_LONG, AM.GFSK8_DEEP];
/** Measured reliable floor in 2500 Hz (CLAUDE.md / network-protocol.md, white noise, 48 kHz, unknown timing). */
const FLOOR_DB: Record<string, number> = {
  'gfsk8-turbo': -9, 'gfsk8-fast': -11, 'gfsk8-medium': -14, 'gfsk8-normal': -18, 'gfsk8-long': -21, 'gfsk8-deep': -23,
};
let spec: Spec = AM.GFSK8_NORMAL;
const modeHooks: (() => void)[] = [];

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const minus = (x: number, d = 0): string => (x < 0 ? '−' : '') + Math.abs(x).toFixed(d);
const signed = (x: number, d = 0): string => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(d);
const secs = (s: number): string => `${+s.toFixed(2)} s`;
function duration(s: number): string {
  if (s < 60) return `${+s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r ? `${m} min ${r} s` : `${m} min`;
}
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** SVG charts use their on-screen width as viewBox width, so their text keeps its size on a phone. */
const chartW = (id: string): number => Math.max(340, Math.round(document.getElementById(id)!.getBoundingClientRect().width || 1000));
const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Canvas at device resolution, drawn in CSS pixels. */
function fit(canvas: HTMLCanvasElement, cssH: number): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(200, canvas.parentElement!.clientWidth);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: cssH };
}

const VIRIDIS = ['#0d0a1a', '#3b0f5c', '#46327e', '#365c8d', '#277f8e', '#1fa187', '#4ac16d', '#a0da39', '#fde725'];
const LUT: [number, number, number][] = (() => {
  const stops = VIRIDIS.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]);
  const out: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(x));
    const f = x - k;
    out.push([0, 1, 2].map((c) => Math.round(stops[k]![c]! + f * (stops[k + 1]![c]! - stops[k]![c]!))) as [number, number, number]);
  }
  return out;
})();

// ---------------------------------------------------------------- worker and audio

const worker = new DecodeWorker();
interface Picture {
  rate: number; baseHz: number; rowsBelow: number; rows: number; hopsPerSymbol: number;
  picture: Float32Array; cols: number; window: Float32Array; symbols: Uint8Array;
  ms?: number; sync?: { score: number; dt: number } | null;
  frames?: { text: string | null; right: boolean; snrDb: number; dtSec: number; dfHz: number; pass: string | null }[];
}
let jobSeq = 0;
const pending = new Map<number, (r: Picture) => void>();
worker.onmessage = (e: MessageEvent) => {
  const r = e.data as Picture & { id: number };
  pending.get(r.id)?.(r);
  pending.delete(r.id);
};
function job(type: 'picture' | 'decode', p: { mode: string; text: string; snrDb: number; dtSec: number; dfHz: number; seed: number }): Promise<Picture> {
  const id = ++jobSeq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type, ...p });
  });
}

let actx: AudioContext | null = null;
let playing: { stop: () => void; button: HTMLButtonElement } | null = null;
function ctx(): AudioContext {
  actx ??= new AudioContext();
  void actx.resume();
  return actx;
}
function stopAudio(): void {
  const p = playing;
  playing = null;
  p?.stop();
}
/** A play / stop toggle. `make` renders the samples on demand; `tick` gets 0..1 while it plays. */
function bindPlay(button: HTMLButtonElement, make: (rate: number) => { samples: Float32Array; rate: number } | null, tick?: (f: number) => void): void {
  const idle = button.innerHTML;
  button.addEventListener('click', () => {
    if (playing?.button === button) { stopAudio(); return; }
    stopAudio();
    const ac = ctx();
    const made = make(ac.sampleRate);
    if (!made) return;
    const buf = ac.createBuffer(1, made.samples.length, made.rate);
    buf.copyToChannel(made.samples as Float32Array<ArrayBuffer>, 0);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const gain = ac.createGain();
    gain.gain.value = 0.3;
    src.connect(gain).connect(ac.destination);
    const t0 = ac.currentTime + 0.05;
    src.start(t0);
    const dur = made.samples.length / made.rate;
    let raf = 0;
    const step = (): void => {
      const f = (ac.currentTime - t0) / dur;
      tick?.(Math.max(0, Math.min(1, f)));
      if (f < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    button.innerHTML = '<span aria-hidden="true">■</span> Stop';
    button.setAttribute('aria-pressed', 'true');
    const done = (): void => {
      cancelAnimationFrame(raf);
      button.innerHTML = idle;
      button.setAttribute('aria-pressed', 'false');
      tick?.(-1);
    };
    const handle = { button, stop: () => { try { src.stop(); } catch { /* already stopped */ } done(); } };
    src.onended = () => { if (playing === handle) { playing = null; done(); } };
    playing = handle;
  });
}

// ---------------------------------------------------------------- the tone picture (what the receiver measures)

interface PictureView { from: number; to: number }
/** Energy per tone step (rows, tone 0 at the bottom of the frame's 8) per quarter symbol (columns), as dB on viridis. */
function drawPicture(canvas: HTMLCanvasElement, pic: Picture, cssH: number, view?: PictureView): { ctx: CanvasRenderingContext2D; w: number; h: number; x: (col: number) => number; y: (row: number) => number; cw: number; rh: number } {
  const { ctx: g, w, h } = fit(canvas, cssH);
  const from = view?.from ?? 0;
  const to = view?.to ?? pic.cols;
  const n = to - from;
  const db = new Float32Array(pic.rows * n);
  for (let r = 0; r < pic.rows; r++) for (let c = 0; c < n; c++) db[r * n + c] = 10 * Math.log10(pic.picture[r * pic.cols + from + c]! + 1e-20);
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(sorted.length * 0.5)]! - 4;
  const top = Math.max(floor + 14, sorted[Math.floor(sorted.length * 0.995)]!);
  const img = new ImageData(n, pic.rows);
  for (let r = 0; r < pic.rows; r++) {
    for (let c = 0; c < n; c++) {
      const v = Math.max(0, Math.min(1, (db[r * n + c]! - floor) / (top - floor)));
      const [R, G, B] = LUT[Math.round(v * 255)]!;
      const o = ((pic.rows - 1 - r) * n + c) * 4;
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    }
  }
  const off = document.createElement('canvas');
  off.width = n;
  off.height = pic.rows;
  off.getContext('2d')!.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(off, 0, 0, w, h);
  const cw = w / n;
  const rh = h / pic.rows;
  return { ctx: g, w, h, cw, rh, x: (col) => (col - from) * cw, y: (row) => (pic.rows - 1 - row) * rh };
}

// ---------------------------------------------------------------- header: logo and mode picker

function drawLogo(): void {
  const svg = $('logo');
  const pattern = AM.GFSK8_NORMAL.syncPattern;
  let s = '';
  for (let x = 0; x < 7; x++) {
    for (let t = 0; t < 8; t++) {
      const on = pattern[x] === t;
      s += `<rect x="${x * 5}" y="${(7 - t) * 4}" width="4" height="2.4" class="${on ? 'lm-on' : 'lm-off'}" style="--i:${x}"/>`;
    }
  }
  svg.innerHTML = s;
}

function setupMode(): void {
  const sel = $<HTMLSelectElement>('mode');
  sel.innerHTML = MODES.map((m) => `<option value="${m.id}"${m === spec ? ' selected' : ''}>${m.label} · ${m.baud} baud · ${m.slotSec} s slots</option>`).join('');
  sel.addEventListener('change', () => setMode(sel.value));
}
function setMode(id: string): void {
  const m = MODES.find((x) => x.id === id);
  if (!m || m === spec) return;
  spec = m;
  $<HTMLSelectElement>('mode').value = id;
  stopAudio();
  document.querySelectorAll('[data-mode-name]').forEach((el) => { el.textContent = spec.label; });
  for (const f of modeHooks) f();
}

// ---------------------------------------------------------------- hero

let heroPic: Picture | null = null;
async function hero(): Promise<void> {
  heroPic = await job('picture', { mode: spec.id, text: 'HELLO', snrDb: -4, dtSec: 0, dfHz: 0, seed: 11 });
  drawHero(-1);
  $('hero-caption').textContent =
    `One frame in ${spec.label} mode, heard through noise: 79 tones in ${secs(AM.frameDurationSec(spec))}, ` +
    `drawn the way the receiver measures it (energy of each tone, every quarter of a symbol). ` +
    `The three seven-step staircases are the sync pattern; the rest is data.`;
}
function drawHero(playFraction: number): void {
  const pic = heroPic;
  if (!pic) return;
  const lead = AM.windowLeadSec(spec);
  const perSym = pic.hopsPerSymbol;
  const startCol = Math.round(lead * spec.baud * perSym);
  const from = Math.max(0, startCol - 6 * perSym);
  const to = Math.min(pic.cols, startCol + 85 * perSym);
  const canvas = $<HTMLCanvasElement>('hero-pic');
  const v = drawPicture(canvas, pic, canvas.parentElement!.clientWidth < 520 ? 150 : 200, { from, to });
  const g = v.ctx;
  g.font = `500 10px ${token('--f-data')}`;
  g.textBaseline = 'top';
  for (const s of spec.syncStarts) {
    const x0 = v.x(startCol + s * perSym);
    const x1 = v.x(startCol + (s + 7) * perSym);
    g.fillStyle = 'rgba(9,11,11,0.72)';
    g.fillRect(x0, 0, x1 - x0, 14);
    g.fillStyle = token('--peak');
    g.fillText('SYNC', x0 + 3, 2);
  }
  if (playFraction >= 0) {
    const x = v.x(startCol + playFraction * 79 * perSym);
    g.fillStyle = token('--line-strong');
    g.fillRect(x - 1, 0, 2, v.h);
  }
}

// ---------------------------------------------------------------- 01 bands and channels

let bandRate = 48000;
let bandPicked = 'ultrasonic';
function bands(): void {
  const usable = bandRate * 0.45;
  const W = chartW('band-svg');
  const H = 120;
  const lo = Math.log10(50);
  const hi = Math.log10(24000);
  const X = (hz: number): number => 20 + ((Math.log10(hz) - lo) / (hi - lo)) * (W - 40);
  let s = `<defs><linearGradient id="hear" x1="0" x2="1"><stop offset="0" stop-color="var(--hear)" stop-opacity="0.32"/><stop offset="0.82" stop-color="var(--hear)" stop-opacity="0.32"/><stop offset="1" stop-color="var(--hear)" stop-opacity="0"/></linearGradient></defs>`;
  s += `<rect x="${X(50)}" y="20" width="${X(17000) - X(50)}" height="10" fill="url(#hear)"/>`;
  s += `<text x="${X(60)}" y="14" class="t-dim">Adult hearing, fading out above about 16 kHz</text>`;
  for (const hz of W < 600 ? [100, 1000, 10000] : [100, 300, 1000, 3000, 10000, 20000]) {
    s += `<line x1="${X(hz)}" x2="${X(hz)}" y1="36" y2="96" class="grid"/>`;
    s += `<text x="${X(hz)}" y="112" text-anchor="middle" class="t-dim">${hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`}</text>`;
  }
  for (const b of AM.BANDS) {
    const ok = b.highHz <= usable;
    const fits = AM.effectiveChannelCount(spec, b) > 0;
    const picked = b.name === bandPicked;
    s += `<g class="band${picked ? ' picked' : ''}${ok && fits ? '' : ' off'}" data-band="${b.name}" tabindex="0" role="button" aria-label="${b.name} band">`;
    s += `<rect x="${X(b.lowHz)}" y="44" width="${Math.max(6, X(b.highHz) - X(b.lowHz))}" height="40"/>`;
    const wide = X(b.highHz) - X(b.lowHz) > b.name.length * 9 + 12;
    s += wide
      ? `<text x="${(X(b.lowHz) + X(b.highHz)) / 2}" y="68" text-anchor="middle">${b.name}</text></g>`
      : `<text x="${X(b.lowHz) - 6}" y="68" text-anchor="end">${b.name}</text></g>`;
  }
  if (usable < 24000) {
    s += `<line x1="${X(usable)}" x2="${X(usable)}" y1="36" y2="96" class="nyq"/>`;
    s += `<text x="${Math.min(X(usable) + 6, W - 4)}" y="104" text-anchor="${X(usable) > W - 160 ? 'end' : 'start'}" class="t-bad">usable to ${+(usable / 1000).toFixed(2)} kHz</text>`;
  }
  const svg = $('band-svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = s;
  svg.querySelectorAll<SVGGElement>('.band').forEach((g) => {
    const pick = (): void => { bandPicked = g.dataset.band!; bands(); };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
  bandZoom(usable);
}
function bandZoom(usable: number): void {
  const band = AM.BANDS.find((b) => b.name === bandPicked)!;
  const channels = AM.listChannels(spec, band);
  const bw = AM.bandwidthHz(spec);
  const W = chartW('band-zoom');
  const X = (hz: number): number => 20 + ((hz - band.lowHz) / (band.highHz - band.lowHz)) * (W - 40);
  let s = `<line x1="20" x2="${W - 20}" y1="70" y2="70" class="axis"/>`;
  s += `<text x="20" y="92" class="t-dim">${band.lowHz} Hz</text><text x="${W - 20}" y="92" text-anchor="end" class="t-dim">${band.highHz} Hz</text>`;
  for (const ch of channels) {
    const x0 = X(ch.baseHz);
    const x1 = Math.max(x0 + 3, X(ch.baseHz + bw));
    s += `<rect x="${x0}" y="22" width="${x1 - x0}" height="48" class="chan"/>`;
    s += `<text x="${(x0 + x1) / 2}" y="16" text-anchor="middle" class="t-num">${ch.number}</text>`;
  }
  const svg = $('band-zoom');
  svg.setAttribute('viewBox', `0 0 ${W} 100`);
  svg.innerHTML = s;
  const carried = band.highHz <= usable;
  const max = band.channelCount;
  const spacing = channels.length > 1 ? AM.channelSpacingHz(spec, band) : 0;
  let note = `<b>${band.name[0]!.toUpperCase() + band.name.slice(1)} band</b>, ${band.lowHz}–${band.highHz} Hz. `;
  if (channels.length === 0) note += `${spec.label} is ${bw} Hz wide, wider than the whole band, so it has no channel here. `;
  else {
    note += `${channels.length === max ? `All ${max}` : `${channels.length} of its ${max}`} channels fit ${spec.label}, `;
    note += `each ${bw} Hz wide${spacing ? `, ${spacing} Hz apart` : ''}: numbers ${channels[0]!.number}–${channels[channels.length - 1]!.number}. `;
  }
  note += carried ? `A ${bandRate / 1000} kHz sound card carries it.` : `<span class="bad">A ${bandRate / 1000} kHz sound card cannot carry it.</span>`;
  $('band-note').innerHTML = note;
}
function setupBands(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((b) => {
    b.addEventListener('click', () => {
      bandRate = Number(b.dataset.rate);
      document.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      bands();
    });
  });
  bands();
  modeHooks.push(bands);
}

// ---------------------------------------------------------------- 02 text becomes bits

interface Field { f: string; bits: number; label: string }
function fieldsOf(frame: { kind: 'first' | 'next'; seq?: number; last?: number; dst?: number; text: string }): Field[] {
  const out: Field[] = [
    { f: 'kind', bits: 2, label: frame.kind === 'first' ? 'kind: first' : 'kind: next' },
    { f: 'src', bits: 10, label: 'from #101' },
    { f: 'msg', bits: 4, label: 'msg 5' },
  ];
  if (frame.kind === 'first') {
    out.push({ f: 'seq', bits: 4, label: `last ${frame.last! + 1}` });
    out.push({ f: 'dst', bits: 10, label: frame.dst ? `to #${frame.dst}` : 'to all' });
  } else out.push({ f: 'seq', bits: 4, label: `frame ${frame.seq! + 1}` });
  for (const ch of frame.text) out.push({ f: 'text', bits: 6, label: ch === ' ' ? '␣' : ch });
  if (frame.kind === 'first') out.push({ f: 'spare', bits: 2, label: 'spare' });
  out.push({ f: 'via', bits: 3, label: 'via' });
  return out;
}

let message = { text: '', dst: 0, chunks: [] as string[], frames: [] as Uint8Array[] };
let showAllFrames = false;
function bits(): void {
  const raw = $<HTMLInputElement>('msg-text').value;
  const dst = Number($<HTMLSelectElement>('msg-to').value);
  const text = AM.normalizeText(raw).trim() || ' ';
  const chunks = AM.splitText(text);
  const frames = chunks.map((c, i) => AM.encodeFrame(i === 0
    ? { kind: 'first', src: 101, msgId: 5, last: chunks.length - 1, dst, text: c }
    : { kind: 'next', src: 101, msgId: 5, seq: i, text: c }));
  message = { text, dst, chunks, frames };
  $('msg-norm').textContent = text;
  const sizes = chunks.map((c, i) => (i === chunks.length - 1 ? text.length - (i === 0 ? 0 : AM.FIRST_CHARS + (i - 1) * AM.NEXT_CHARS) : c.length));
  $('msg-stats').innerHTML =
    `${text.length} characters → <b>${chunks.length} frame${chunks.length > 1 ? 's' : ''}</b> (${sizes.join(' + ')}). ` +
    `One frame per slot: <b>${duration(chunks.length * spec.slotSec)}</b> on air in <span data-mode-name>${spec.label}</span>` +
    (dst ? ', plus an answer from #202.' : '.');
  const shown = showAllFrames ? frames.length : Math.min(3, frames.length);
  let html = '';
  for (let i = 0; i < shown; i++) {
    const f = frames[i]!;
    const fields = fieldsOf(i === 0 ? { kind: 'first', last: chunks.length - 1, dst, text: chunks[i]! } : { kind: 'next', seq: i, text: chunks[i]! });
    let pos = 0;
    html += `<div class="frame"><div class="frame-head"><span>Frame ${i + 1} of ${chunks.length}</span><span class="dim">${i === 0 ? 'first' : 'next'} · “${esc(chunks[i]!.trimEnd())}”</span></div><div class="fields">`;
    for (const fl of fields) {
      let b = '';
      for (let k = 0; k < fl.bits; k++) b += f[pos + k];
      pos += fl.bits;
      html += `<span class="fld" data-f="${fl.f}"><span class="fl">${esc(fl.label)}</span><span class="fb">${b}</span></span>`;
    }
    html += '</div></div>';
  }
  if (frames.length > 3) html += `<button class="link" id="msg-more" type="button">${showAllFrames ? 'Show fewer frames' : `Show all ${frames.length} frames`}</button>`;
  $('msg-frames').innerHTML = html;
  const more = document.getElementById('msg-more');
  more?.addEventListener('click', () => { showAllFrames = !showAllFrames; bits(); });
  breakIt();
  tones();
}
function setupBits(): void {
  $('msg-text').addEventListener('input', bits);
  $('msg-to').addEventListener('change', bits);
  modeHooks.push(bits);
  bits();
}

// ---------------------------------------------------------------- 03 armour: CRC and LDPC

const codec = new AM.Gfsk8Codec(AM.GFSK8_NORMAL);
const SYNC = new Set<number>();
for (const s of AM.GFSK8_NORMAL.syncStarts) for (let i = 0; i < 7; i++) SYNC.add(s + i);
const DATA = [...Array(79).keys()].filter((i) => !SYNC.has(i));
const damage = new Map<number, 'erase' | 'wrong'>();
let brush: 'erase' | 'wrong' = 'erase';

function breakIt(): void {
  const payload = message.frames[0];
  if (!payload) return;
  const symbols = codec.encode(payload);
  const grid = $('fec-grid');
  if (!grid.childElementCount) {
    let html = '';
    for (let k = 0; k < 79; k++) {
      html += SYNC.has(k) ? `<span class="sym sync" title="sync symbol ${k}"></span>` : `<button type="button" class="sym" data-k="${k}" aria-label="data symbol ${k}"></button>`;
    }
    grid.innerHTML = html;
  }
  grid.querySelectorAll<HTMLElement>('.sym[data-k]').forEach((el) => {
    const k = Number(el.dataset.k);
    el.dataset.state = damage.get(k) ?? 'ok';
    el.textContent = String(symbols[k]);
  });
  // The receiver's view of each symbol: energy in each of the 8 tones.
  const e = new Float32Array(79 * 8);
  for (let k = 0; k < 79; k++) {
    for (let t = 0; t < 8; t++) e[k * 8 + t] = 0.02 + 0.01 * ((k * 7 + t * 3) % 5);
    const d = damage.get(k);
    if (d === 'erase') { for (let t = 0; t < 8; t++) e[k * 8 + t] = 0.3; continue; }
    e[k * 8 + (d === 'wrong' ? (symbols[k]! + 3) % 8 : symbols[k]!)] = 1;
  }
  const out = codec.decode(e);
  const right = !!out && out.every((b, i) => b === payload[i]);
  const erased = [...damage.values()].filter((v) => v === 'erase').length;
  const wrong = damage.size - erased;
  const r = $('fec-result');
  r.dataset.ok = String(right);
  const frame = out ? AM.decodeFrame(out) : null;
  r.innerHTML = right
    ? `<b>Decoded.</b> All 83 parity checks pass and the CRC matches: “${esc(frame && frame.kind === 'first' ? frame.text.trimEnd() : '')}”.`
    : out
      ? '<b>Wrong payload.</b> This should never happen.'
      : '<b>Refused.</b> No codeword fits what was heard, so the receiver drops the frame. It never guesses.';
  $('fec-count').textContent = `${erased} erased · ${wrong} wrong · ${58 - damage.size} intact`;
}
function setupFec(): void {
  const grid = $('fec-grid');
  let painting: 'add' | 'remove' | null = null;
  const apply = (el: Element | null): void => {
    const k = el instanceof HTMLElement && el.dataset.k ? Number(el.dataset.k) : NaN;
    if (Number.isNaN(k) || !painting) return;
    if (painting === 'add') damage.set(k, brush);
    else damage.delete(k);
    breakIt();
  };
  grid.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
    if (!el) return;
    e.preventDefault();
    painting = damage.get(Number(el.dataset.k)) === brush ? 'remove' : 'add';
    apply(el);
  });
  grid.addEventListener('pointermove', (e) => { if (painting) apply(document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-k]') ?? null); });
  window.addEventListener('pointerup', () => { painting = null; });
  grid.addEventListener('keydown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
    if (!el || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const k = Number(el.dataset.k);
    if (damage.get(k) === brush) damage.delete(k); else damage.set(k, brush);
    breakIt();
    grid.querySelector<HTMLElement>(`[data-k="${k}"]`)?.focus();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach((b) => {
    b.addEventListener('click', () => {
      brush = b.dataset.brush as 'erase' | 'wrong';
      document.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  });
  const random = rng(5);
  const pickRandom = (n: number, kind: 'erase' | 'wrong'): void => {
    damage.clear();
    const pool = [...DATA];
    for (let i = 0; i < n; i++) damage.set(pool.splice(Math.floor(random() * pool.length), 1)[0]!, kind);
    breakIt();
  };
  $('fec-erase20').addEventListener('click', () => pickRandom(20, 'erase'));
  $('fec-erase26').addEventListener('click', () => pickRandom(26, 'erase'));
  $('fec-wrong5').addEventListener('click', () => pickRandom(5, 'wrong'));
  $('fec-wrong10').addEventListener('click', () => pickRandom(10, 'wrong'));
  $('fec-reset').addEventListener('click', () => { damage.clear(); breakIt(); });
}

// ---------------------------------------------------------------- 04 bits become tones

let toneSymbols: Uint8Array = new Uint8Array(79);
let tonePlay = -1;
function tones(): void {
  const payload = message.frames[0];
  if (!payload) return;
  toneSymbols = codec.encode(payload);
  drawTones();
  drawGlide();
  $('tone-stats').innerHTML =
    `In <span data-mode-name>${spec.label}</span>: ${spec.baud} symbols a second, tones ${spec.toneSpacingHz} Hz apart, ` +
    `${AM.bandwidthHz(spec)} Hz wide in all, ${secs(AM.frameDurationSec(spec))} on air.`;
}
function drawTones(): void {
  const canvas = $<HTMLCanvasElement>('tone-grid');
  const narrow = canvas.parentElement!.clientWidth < 520;
  const { ctx: g, w, h } = fit(canvas, narrow ? 120 : 150);
  const padL = 18;
  const padB = 18;
  const cw = (w - padL) / 79;
  const rh = (h - padB) / 8;
  g.clearRect(0, 0, w, h);
  g.fillStyle = token('--panel-2');
  g.fillRect(padL, 0, w - padL, h - padB);
  g.strokeStyle = token('--line');
  g.lineWidth = 1;
  for (let t = 1; t < 8; t++) { g.beginPath(); g.moveTo(padL, t * rh + 0.5); g.lineTo(w, t * rh + 0.5); g.stroke(); }
  for (let k = 0; k < 79; k++) {
    const t = toneSymbols[k]!;
    const sync = SYNC.has(k);
    const played = tonePlay >= 0 && k < tonePlay * 79;
    g.fillStyle = sync ? token('--peak') : played ? token('--line-strong') : token('--accent-hi');
    g.fillRect(padL + k * cw + 0.5, (7 - t) * rh + rh * 0.2, Math.max(1, cw - 1), rh * 0.6);
  }
  g.fillStyle = token('--dim');
  g.font = `10px ${token('--f-data')}`;
  g.textBaseline = 'middle';
  for (let t = 0; t < 8; t++) g.fillText(String(t), 2, (7 - t) * rh + rh / 2);
  g.textBaseline = 'alphabetic';
  const dur = AM.frameDurationSec(spec);
  for (const k of [0, 36, 72, 79]) {
    const x = padL + k * cw;
    g.fillText(secs((k / 79) * dur), Math.min(w - 34, x), h - 4);
  }
  if (tonePlay >= 0) {
    g.fillStyle = token('--line-strong');
    g.fillRect(padL + tonePlay * 79 * cw - 1, 0, 2, h - padB);
  }
}
const PULSE_SCALE = Math.PI * Math.sqrt(2 / Math.LN2);
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-a * a));
}
const pulse = (x: number): number => 0.5 * (erf(PULSE_SCALE * 2 * (x + 0.5)) - erf(PULSE_SCALE * 2 * (x - 0.5)));
function drawGlide(): void {
  const canvas = $<HTMLCanvasElement>('tone-glide');
  const { ctx: g, w, h } = fit(canvas, 130);
  const N = 14;
  const first = 36;
  const padL = 18;
  const X = (sym: number): number => padL + (sym / N) * (w - padL - 4);
  const Y = (tone: number): number => 8 + (7 - tone) * ((h - 26) / 7);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = token('--line');
  g.lineWidth = 1;
  for (let t = 0; t < 8; t++) { g.beginPath(); g.moveTo(padL, Y(t) + 0.5); g.lineTo(w, Y(t) + 0.5); g.stroke(); }
  const sym = (k: number): number => toneSymbols[Math.max(0, Math.min(78, first + k))]!;
  g.setLineDash([4, 4]);
  g.strokeStyle = token('--dim');
  g.beginPath();
  for (let k = 0; k < N; k++) { g.lineTo(X(k), Y(sym(k))); g.lineTo(X(k + 1), Y(sym(k))); }
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = token('--accent-hi');
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 400; i++) {
    const t = (i / 400) * N;
    let dev = 0;
    for (let k = Math.floor(t) - 2; k <= Math.floor(t) + 2; k++) dev += sym(k) * pulse(t - (k + 0.5));
    if (i === 0) g.moveTo(X(t), Y(dev)); else g.lineTo(X(t), Y(dev));
  }
  g.stroke();
  g.fillStyle = token('--dim');
  g.font = `10px ${token('--f-data')}`;
  g.fillText(`symbols ${first}–${first + N - 1}`, padL, h - 4);
  g.textAlign = 'right';
  g.fillText('dashed: jumping · solid: the Gaussian glide audiomesh sends', w - 4, h - 4);
  g.textAlign = 'left';
}
function setupTones(): void {
  const gray = $('gray-table');
  const rows: string[] = [];
  for (let tone = 7; tone >= 0; tone--) {
    const b = AM.GRAY_TO_TONE.indexOf(tone as 0);
    rows.push(`<tr><td class="num">${tone}</td><td class="bits">${b.toString(2).padStart(3, '0')}</td></tr>`);
  }
  gray.innerHTML = `<thead><tr><th>Tone</th><th>Bits</th></tr></thead><tbody>${rows.join('')}</tbody>`;
  bindPlay($<HTMLButtonElement>('tone-play'), (rate) => ({ samples: AM.synthesizeFrame(toneSymbols, 1000, rate, spec), rate }), (f) => { tonePlay = f; drawTones(); });
}

// ---------------------------------------------------------------- 05 Costas sync

let syncPic: Picture | null = null;
let syncTruth = { col: 0, f: 0 };
let tpl = { col: 0, f: -3 };
let syncCurve: Float32Array | null = null;
let syncCurveLen = 0;
let syncSearching = false;
let syncSeed = 21;
const BLOCKS = (): { start: number; tone: number }[] => {
  const out: { start: number; tone: number }[] = [];
  for (const s of spec.syncStarts) spec.syncPattern.forEach((tone, i) => out.push({ start: s + i, tone }));
  return out;
};
function syncScore(col: number, f: number): number {
  const pic = syncPic!;
  let hit = 0;
  let all = 0;
  for (const { start, tone } of BLOCKS()) {
    const c = col + start * pic.hopsPerSymbol;
    if (c < 0 || c >= pic.cols) continue;
    for (let t = 0; t < 8; t++) {
      const row = pic.rowsBelow + f + t;
      const e = pic.picture[row * pic.cols + c]!;
      all += e;
      if (t === tone) hit += e;
    }
  }
  return all > 0 ? hit / all : 0;
}
const fRange = (): [number, number] => [-syncPic!.rowsBelow, syncPic!.rows - syncPic!.rowsBelow - 8];
const colRange = (): number => syncPic!.cols - 78 * syncPic!.hopsPerSymbol - 1;
async function newSync(): Promise<void> {
  const snrDb = Number($<HTMLInputElement>('sync-snr').value);
  const random = rng(syncSeed++);
  const dtSec = (random() - 0.5) * 1.6 * spec.maxTimeOffsetSec;
  const fTones = Math.floor(random() * 3) - 1;
  syncPic = await job('picture', { mode: spec.id, text: 'HELLO', snrDb, dtSec, dfHz: fTones * spec.toneSpacingHz, seed: syncSeed * 7 });
  syncTruth = { col: Math.round((AM.windowLeadSec(spec) + dtSec) * spec.baud * syncPic.hopsPerSymbol), f: fTones };
  tpl = { col: Math.round(colRange() * 0.08), f: -3 };
  syncCurve = null;
  syncCurveLen = 0;
  drawSync();
}
function drawSync(): void {
  const pic = syncPic;
  if (!pic) return;
  const canvas = $<HTMLCanvasElement>('sync-pic');
  const v = drawPicture(canvas, pic, canvas.parentElement!.clientWidth < 520 ? 170 : 230);
  const g = v.ctx;
  const score = syncScore(tpl.col, tpl.f);
  const good = score >= 0.3;
  g.lineWidth = 1.5;
  g.strokeStyle = good ? token('--peak') : token('--line-strong');
  for (const { start, tone } of BLOCKS()) {
    const x = v.x(tpl.col + start * pic.hopsPerSymbol);
    const y = v.y(pic.rowsBelow + tpl.f + tone);
    g.strokeRect(x + 0.75, y + 0.75, v.cw * pic.hopsPerSymbol - 1.5, v.rh - 1.5);
  }
  const fy0 = v.y(pic.rowsBelow + tpl.f + 7);
  const fy1 = v.y(pic.rowsBelow + tpl.f) + v.rh;
  const x0 = v.x(tpl.col);
  const x1 = v.x(tpl.col + 79 * pic.hopsPerSymbol);
  g.setLineDash([3, 4]);
  g.strokeStyle = 'rgba(230,235,234,0.45)';
  g.strokeRect(x0, fy0, x1 - x0, fy1 - fy0);
  g.setLineDash([]);
  $('sync-score').textContent = score.toFixed(2);
  $('sync-score-bar').style.setProperty('--v', String(Math.min(1, score)));
  $('sync-verdict').textContent = good ? 'Looks like a frame' : score > 0.2 ? 'Noise level' : 'Nothing here';
  $('sync-verdict').dataset.good = String(good);
  const dt = (tpl.col / pic.hopsPerSymbol / spec.baud) - AM.windowLeadSec(spec);
  $('sync-where').textContent = `start ${signed(dt, 2)} s from the slot boundary · ${signed(tpl.f * spec.toneSpacingHz, 2)} Hz`;
  drawSyncCurve();
}
function drawSyncCurve(): void {
  const canvas = $<HTMLCanvasElement>('sync-curve');
  const { ctx: g, w, h } = fit(canvas, 90);
  g.clearRect(0, 0, w, h);
  const Y = (s: number): number => h - 14 - s * (h - 22) / 0.8;
  g.strokeStyle = token('--line');
  g.lineWidth = 1;
  g.fillStyle = token('--dim');
  g.font = `10px ${token('--f-data')}`;
  for (const [s, label] of [[0.23, 'noise ≈ 0.23'], [0.5, '0.5']] as const) {
    g.setLineDash(s === 0.23 ? [3, 4] : []);
    g.beginPath(); g.moveTo(0, Y(s) + 0.5); g.lineTo(w, Y(s) + 0.5); g.stroke();
    g.fillText(label, 4, Y(s) - 3);
  }
  g.setLineDash([]);
  const pic = syncPic!;
  const n = pic.cols;
  const X = (col: number): number => (col / n) * w;
  if (syncCurve) {
    g.strokeStyle = token('--accent-hi');
    g.lineWidth = 1.5;
    g.beginPath();
    for (let c = 0; c < syncCurveLen; c++) { if (c === 0) g.moveTo(X(c), Y(syncCurve[c]!)); else g.lineTo(X(c), Y(syncCurve[c]!)); }
    g.stroke();
  } else {
    g.fillText('Search to see the score at every start time (best pitch at each)', 4, h - 2);
  }
  g.fillStyle = token('--line-strong');
  g.fillRect(X(tpl.col) - 1, 4, 2, h - 18);
}
function setupSync(): void {
  const canvas = $<HTMLCanvasElement>('sync-pic');
  let dragging = false;
  const place = (e: PointerEvent): void => {
    if (!syncPic || syncSearching) return;
    const r = canvas.getBoundingClientRect();
    const col = Math.round(((e.clientX - r.left) / r.width) * syncPic.cols - 39 * syncPic.hopsPerSymbol);
    const row = syncPic.rows - 1 - Math.floor(((e.clientY - r.top) / r.height) * syncPic.rows);
    const [fl, fh] = fRange();
    tpl = { col: Math.max(0, Math.min(colRange(), col)), f: Math.max(fl, Math.min(fh, row - syncPic.rowsBelow - 4)) };
    drawSync();
  };
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); place(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) place(e); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('keydown', (e) => {
    if (!syncPic) return;
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (!step) return;
    e.preventDefault();
    const [fl, fh] = fRange();
    tpl = { col: Math.max(0, Math.min(colRange(), tpl.col + step[0]! * (e.shiftKey ? 8 : 1))), f: Math.max(fl, Math.min(fh, tpl.f + step[1]!)) };
    drawSync();
  });
  $('sync-search').addEventListener('click', () => {
    if (!syncPic || syncSearching) return;
    const [fl, fh] = fRange();
    const n = colRange();
    const curve = new Float32Array(n + 1);
    const bestF = new Int8Array(n + 1);
    let best = { col: 0, f: 0, s: -1 };
    for (let c = 0; c <= n; c++) {
      let m = -1;
      for (let f = fl; f <= fh; f++) {
        const s = syncScore(c, f);
        if (s > m) { m = s; bestF[c] = f; }
        if (s > best.s) best = { col: c, f, s };
      }
      curve[c] = m;
    }
    syncCurve = curve;
    if (reducedMotion()) { syncCurveLen = n + 1; tpl = { col: best.col, f: best.f }; drawSync(); return; }
    syncSearching = true;
    const t0 = performance.now();
    const step = (): void => {
      const k = Math.min(n, Math.floor(((performance.now() - t0) / 1400) * n));
      syncCurveLen = k + 1;
      tpl = { col: k, f: bestF[k]! };
      if (k >= n) { syncSearching = false; tpl = { col: best.col, f: best.f }; drawSync(); return; }
      drawSync();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  $('sync-new').addEventListener('click', () => void newSync());
  $('sync-snr').addEventListener('input', () => { $('sync-snr-out').textContent = `${minus(Number($<HTMLInputElement>('sync-snr').value))} dB`; });
  $('sync-snr').addEventListener('change', () => void newSync());
  $('sync-show').addEventListener('click', () => { if (syncPic) { tpl = { ...syncTruth }; drawSync(); } });
  modeHooks.push(() => void newSync());
  void newSync();
}

// ---------------------------------------------------------------- 06 slots and clocks

function slots(): void {
  const skew = Number($<HTMLInputElement>('skew').value);
  const deep = $<HTMLInputElement>('deep').checked;
  const slot = spec.slotSec;
  const frame = AM.frameDurationSec(spec);
  const allow = spec.maxTimeOffsetSec;
  const extra = deep ? AM.deepExtraSec(spec) : 0;
  const W = (slotW = chartW('slot-svg'));
  const lo = -0.45 * slot;
  const hi = 1.45 * slot;
  const X = (s: number): number => 10 + ((s - lo) / (hi - lo)) * (W - 20);
  const ok = Math.abs(skew) <= allow + extra + 1e-9;
  let s = '';
  s += `<line x1="${X(lo)}" x2="${X(hi)}" y1="120" y2="120" class="axis"/>`;
  for (const b of [0, slot]) {
    s += `<line x1="${X(b)}" x2="${X(b)}" y1="8" y2="128" class="bound"/>`;
    s += `<text x="${X(b) + 5}" y="18" class="t-dim">${b === 0 ? 'slot starts' : 'next slot'}</text>`;
  }
  s += `<rect x="${X(-allow - extra)}" y="34" width="${X(frame + allow + extra) - X(-allow - extra)}" height="30" class="win${deep ? ' deep' : ''}"/>`;
  s += `<rect x="${X(-allow)}" y="34" width="${X(frame + allow) - X(-allow)}" height="30" class="win-core"/>`;
  s += `<text x="${X(-allow - extra) + 6}" y="53" class="t-acc">we record ${secs(frame + 2 * (allow + extra))}</text>`;
  s += `<rect x="${X(skew)}" y="76" width="${X(skew + frame) - X(skew)}" height="30" class="their ${ok ? 'ok' : 'lost'}"/>`;
  s += `<text x="${X(skew) + 6}" y="95" class="t-ink">their frame, ${secs(frame)}</text>`;
  for (const t of [-allow - extra, frame + allow + extra]) s += `<text x="${X(t)}" y="138" text-anchor="middle" class="t-dim">${signed(t, 2)} s</text>`;
  const svg = $('slot-svg');
  svg.setAttribute('viewBox', `0 0 ${W} 146`);
  svg.innerHTML = s + '<line id="slot-now" x1="0" x2="0" y1="8" y2="128" class="now"/>';
  $('skew-out').textContent = `${signed(skew, 2)} s`;
  const v = $('slot-verdict');
  v.dataset.good = String(ok);
  v.textContent = ok
    ? Math.abs(skew) <= allow ? `Inside the ±${allow} s the receiver allows for: it decodes.` : `Outside ±${allow} s, but Deep decode searches ${extra} s further: it decodes.`
    : `The frame falls off the edge of the window: nothing decodes, though the waterfall shows it.`;
  $('slot-facts').innerHTML =
    `<span data-mode-name>${spec.label}</span>: ${slot} s slots, ${secs(frame)} frames, clock allowance ±${allow} s` +
    `${AM.deepExtraSec(spec) ? `, Deep decode ${AM.deepExtraSec(spec)} s more each side` : ''}.`;
}
let slotW = 1000;
function clockTick(): void {
  const now = Date.now();
  const slotMs = spec.slotSec * 1000;
  const n = Math.floor(now / slotMs);
  const into = (now - n * slotMs) / 1000;
  const d = new Date(now);
  const pad = (x: number, l = 2): string => String(x).padStart(l, '0');
  $('clock-utc').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${Math.floor(d.getUTCMilliseconds() / 100)}`;
  $('clock-slot').textContent = n.toLocaleString('en-US').replace(/,/g, ' ');
  $('clock-into').textContent = `${into.toFixed(1)} of ${spec.slotSec} s`;
  const W = slotW;
  const lo = -0.45 * spec.slotSec;
  const hi = 1.45 * spec.slotSec;
  const x = 10 + ((into - lo) / (hi - lo)) * (W - 20);
  const line = document.getElementById('slot-now');
  line?.setAttribute('x1', String(x));
  line?.setAttribute('x2', String(x));
}
function setupSlots(): void {
  const skew = $<HTMLInputElement>('skew');
  const range = (): void => {
    const lim = Math.min(spec.slotSec * 0.45, (spec.maxTimeOffsetSec + AM.deepExtraSec(spec)) * 1.4);
    skew.min = String(-lim);
    skew.max = String(lim);
    skew.step = String(+(lim / 60).toFixed(3));
    skew.value = String(+(spec.maxTimeOffsetSec * 0.6).toFixed(2));
  };
  range();
  skew.addEventListener('input', slots);
  $('deep').addEventListener('change', slots);
  modeHooks.push(() => { range(); slots(); });
  slots();
  clockTick();
  setInterval(clockTick, 100);
}

// ---------------------------------------------------------------- 07 the receiver, end to end

let labPic: Picture | null = null;
const labStats = new Map<number, { ok: number; n: number }>();
let labWrong = 0;
let labBusy = false;
let labSeed = 1000;
function labParams(): { text: string; snrDb: number; dtSec: number; dfHz: number } {
  return {
    text: AM.normalizeText($<HTMLInputElement>('lab-text').value).slice(0, AM.FIRST_CHARS) || 'HELLO',
    snrDb: Number($<HTMLInputElement>('lab-snr').value),
    dtSec: Number($<HTMLInputElement>('lab-dt').value),
    dfHz: Number($<HTMLInputElement>('lab-df').value),
  };
}
function labOutputs(): void {
  const p = labParams();
  $('lab-snr-out').textContent = `${minus(p.snrDb)} dB`;
  $('lab-dt-out').textContent = `${signed(p.dtSec, 2)} s`;
  $('lab-df-out').textContent = `${signed(p.dfHz, 1)} Hz`;
  $('lab-snr-hint').textContent = p.snrDb <= -10
    ? `In 2500 Hz the noise is about ${Math.round(10 ** (-p.snrDb / 10))} times stronger than the signal.`
    : p.snrDb < 0 ? 'Noise a little stronger than the signal.' : 'Signal stronger than the noise.';
}
async function labRun(trials: number): Promise<void> {
  if (labBusy) return;
  labBusy = true;
  document.querySelectorAll<HTMLButtonElement>('.lab-go').forEach((b) => { b.disabled = true; });
  const p = labParams();
  let ok = 0;
  try {
    for (let i = 0; i < trials; i++) {
      $('lab-progress').textContent = trials > 1 ? `Trial ${i + 1} of ${trials}…` : 'Decoding…';
      const r = await job('decode', { mode: spec.id, ...p, seed: labSeed++ });
      const good = r.frames!.some((f) => f.right);
      if (r.frames!.some((f) => !f.right)) labWrong++;
      if (good) ok++;
      const st = labStats.get(p.snrDb) ?? { ok: 0, n: 0 };
      st.n++;
      if (good) st.ok++;
      labStats.set(p.snrDb, st);
      if (i === 0 || i === trials - 1) { labPic = r; drawLab(); labResult(r, p); }
      drawLabChart();
    }
    $('lab-progress').textContent = trials > 1 ? `${ok} of ${trials} decoded at ${minus(p.snrDb)} dB.` : '';
  } finally {
    labBusy = false;
    document.querySelectorAll<HTMLButtonElement>('.lab-go').forEach((b) => { b.disabled = false; });
  }
}
function labResult(r: Picture, p: { snrDb: number; dtSec: number; dfHz: number }): void {
  const f = r.frames!.find((x) => x.right) ?? r.frames![0];
  const el = $('lab-result');
  el.dataset.ok = String(!!f?.right);
  if (f) {
    el.innerHTML =
      `<div class="res-head"><b>Decoded</b><span class="res-text">“${esc((f.text ?? '').trimEnd())}”</span></div>` +
      `<dl class="res-grid"><dt>Signal</dt><dd>${minus(f.snrDb, 1)} dB <span class="dim">(sent ${minus(p.snrDb)})</span></dd>` +
      `<dt>Timing</dt><dd>${signed(f.dtSec, 2)} s <span class="dim">(sent ${signed(p.dtSec, 2)})</span></dd>` +
      `<dt>Pitch</dt><dd>${signed(f.dfHz, 1)} Hz <span class="dim">(sent ${signed(p.dfHz, 1)})</span></dd>` +
      `<dt>Work</dt><dd>${Math.round(r.ms!)} ms${f.pass ? `, harder pass “${esc(f.pass)}”` : ''}</dd></dl>`;
  } else {
    el.innerHTML =
      `<div class="res-head"><b>Nothing decoded</b></div>` +
      `<dl class="res-grid"><dt>Best sync</dt><dd>${r.sync ? `${r.sync.score.toFixed(2)} at ${signed(r.sync.dt, 2)} s` : '—'} <span class="dim">${r.sync && r.sync.score >= 0.3 ? '(a frame is there, too weak to read)' : '(noise level)'}</span></dd>` +
      `<dt>Work</dt><dd>${Math.round(r.ms!)} ms, ${r.frames!.length} wrong payloads</dd></dl>`;
  }
}
function drawLab(): void {
  if (!labPic) return;
  const canvas = $<HTMLCanvasElement>('lab-pic');
  const v = drawPicture(canvas, labPic, canvas.parentElement!.clientWidth < 520 ? 140 : 180);
  const g = v.ctx;
  const lead = AM.windowLeadSec(spec);
  const xs = v.x(Math.round(lead * spec.baud * labPic.hopsPerSymbol));
  g.strokeStyle = 'rgba(230,235,234,0.55)';
  g.setLineDash([3, 4]);
  g.beginPath(); g.moveTo(xs + 0.5, 0); g.lineTo(xs + 0.5, v.h); g.stroke();
  g.setLineDash([]);
  g.fillStyle = 'rgba(230,235,234,0.7)';
  g.font = `10px ${token('--f-data')}`;
  g.fillText('slot boundary', xs + 4, 12);
}
function drawLabChart(): void {
  const W = chartW('lab-chart');
  const H = 220;
  const lo = -28;
  const hi = 6;
  const X = (db: number): number => 46 + ((db - lo) / (hi - lo)) * (W - 66);
  const Y = (f: number): number => 16 + (1 - f) * (H - 52);
  let s = '';
  for (const f of [0, 0.5, 1]) s += `<line x1="${X(lo)}" x2="${X(hi)}" y1="${Y(f)}" y2="${Y(f)}" class="grid"/><text x="38" y="${Y(f) + 4}" text-anchor="end" class="t-dim">${f * 100}%</text>`;
  for (let db = lo; db <= hi; db += W < 560 ? 8 : 4) s += `<text x="${X(db)}" y="${H - 16}" text-anchor="middle" class="t-dim">${minus(db)}</text>`;
  s += `<text x="${X(hi)}" y="${H - 2}" text-anchor="end" class="t-dim">SNR in 2500 Hz, dB</text>`;
  const floor = FLOOR_DB[spec.id]!;
  s += `<line x1="${X(floor)}" x2="${X(floor)}" y1="${Y(1) - 6}" y2="${Y(0)}" class="ref"/>`;
  s += `<text x="${X(floor) + 6}" y="${Y(1) - 2}" class="t-acc">measured: reliable to ${minus(floor)} dB</text>`;
  const pts = [...labStats.entries()].sort((a, b) => a[0] - b[0]);
  for (const [db, st] of pts) {
    const r = 4 + Math.min(8, Math.sqrt(st.n) * 1.6);
    s += `<circle cx="${X(db)}" cy="${Y(st.ok / st.n)}" r="${r}" class="pt"><title>${minus(db)} dB: ${st.ok} of ${st.n}</title></circle>`;
  }
  if (!pts.length) s += `<text x="${X(-11)}" y="${Y(0.5)}" text-anchor="middle" class="t-dim">Your trials land here, one dot per SNR</text>`;
  const svg = $('lab-chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = s;
  $('lab-wrong').textContent = `${labWrong}`;
}
function setupLab(): void {
  const dt = $<HTMLInputElement>('lab-dt');
  const range = (): void => {
    const a = spec.maxTimeOffsetSec;
    dt.min = String(-a);
    dt.max = String(a);
    dt.step = String(+(a / 20).toFixed(3));
    dt.value = String(+(a * 0.3).toFixed(2));
    labStats.clear();
    labWrong = 0;
    labOutputs();
    drawLabChart();
  };
  range();
  for (const id of ['lab-snr', 'lab-dt', 'lab-df', 'lab-text']) $(id).addEventListener('input', labOutputs);
  $('lab-send').addEventListener('click', () => void labRun(1));
  $('lab-run').addEventListener('click', () => void labRun(20));
  $('lab-clear').addEventListener('click', () => { labStats.clear(); labWrong = 0; drawLabChart(); });
  bindPlay($<HTMLButtonElement>('lab-play'), () => {
    if (!labPic) return null;
    const w = labPic.window;
    let peak = 0;
    for (let i = 0; i < w.length; i++) peak = Math.max(peak, Math.abs(w[i]!));
    const out = new Float32Array(w.length);
    for (let i = 0; i < w.length; i++) out[i] = (w[i]! / peak) * 0.9;
    return { samples: out, rate: labPic.rate };
  });
  modeHooks.push(() => { range(); labPic = null; $('lab-result').innerHTML = ''; void labRun(1); });
  void labRun(1);
}

// ---------------------------------------------------------------- timelines (08 acks, 10 repeaters)

interface Tx { slot: number; lane: number; label: string; sub: string; kind: 'msg' | 'ack' | 'beacon' | 'repeat'; lost?: boolean }
function describe(p: Uint8Array): { label: string; sub: string; kind: Tx['kind'] } {
  const f = AM.decodeFrame(p);
  const rep = AM.viaOf(p) !== 0;
  const pre = rep ? '↻ ' : '';
  const kind: Tx['kind'] = rep ? 'repeat' : f?.kind === 'ack' ? 'ack' : f?.kind === 'sound' || f?.kind === 'hello' ? 'beacon' : 'msg';
  if (!f) return { label: '?', sub: '', kind };
  if (f.kind === 'first') return { label: `${pre}F1`, sub: `to #${f.dst}`, kind };
  if (f.kind === 'next') return { label: `${pre}F${f.seq + 1}`, sub: 'next', kind };
  if (f.kind === 'ack') {
    let dots = '';
    for (let i = 0; i < ackFramesTotal; i++) dots += (f.received >> i) & 1 ? '●' : '○';
    return { label: `${pre}ACK`, sub: dots, kind };
  }
  if (f.kind === 'sound') return { label: `${pre}BEACON`, sub: f.repeater ? 'repeater' : '', kind };
  if (f.kind === 'hello') return { label: `${pre}HELLO`, sub: f.name.trim(), kind };
  return { label: f.kind, sub: '', kind };
}
let ackFramesTotal = 3;
function renderTimeline(el: HTMLElement, lanes: string[], txs: Tx[], last: number): void {
  const cols = last + 1;
  let html = `<div class="tl" style="--cols:${cols}"><div class="tl-h"></div>`;
  for (let s = 0; s < cols; s++) html += `<div class="tl-h"><span>${s}</span><span class="dim">${duration(s * spec.slotSec).replace(' min', 'm').replace(' s', 's')}</span></div>`;
  lanes.forEach((name, lane) => {
    html += `<div class="tl-lane">${name}</div>`;
    for (let s = 0; s < cols; s++) {
      const t = txs.find((x) => x.lane === lane && x.slot === s);
      html += t
        ? `<div class="tl-c"><span class="chip" data-k="${t.kind}"${t.lost ? ' data-lost="true"' : ''}><b>${esc(t.label)}</b><i>${esc(t.lost ? 'lost' : t.sub)}</i></span></div>`
        : '<div class="tl-c"></div>';
    }
  });
  el.innerHTML = html + '</div>';
}

// ---------------------------------------------------------------- 08 acks and retries

const ACK_TEXT = 'SEE YOU AT THE BRIDGE';
const lose = { frames: new Set<number>([1]), ack: false };
function acks(): void {
  const a = new AM.ChatSession({ stationId: 101 });
  const b = new AM.ChatSession({ stationId: 202 });
  let bDone = false;
  b.events.incoming = () => { bDone = true; };
  const msg = a.send(202, ACK_TEXT);
  ackFramesTotal = msg.frames;
  const txs: Tx[] = [];
  const sent: { p: Uint8Array | null; lost: boolean }[][] = [];
  const seen = new Map<string, number>();
  let gotAt = -1;
  let doneAt = -1;
  for (let t = 0; t < 60; t++) {
    const old = sent[t - 2];
    if (old) {
      if (!old[1]!.p && old[0]!.p && !old[0]!.lost) { b.receive(old[0]!.p, t - 2, -10, 12); if (gotAt < 0 && bDone) gotAt = t - 2; }
      if (!old[0]!.p && old[1]!.p && !old[1]!.lost) a.receive(old[1]!.p, t - 2, -10, 12);
    }
    const row = [a.nextTx(t), b.nextTx(t)].map((p, lane) => {
      if (!p) return { p, lost: false };
      const d = describe(p);
      const key = `${lane}:${d.label}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const lost = n === 1 && (lane === 0 ? lose.frames.has(Number(d.label.slice(1)) - 1) : d.kind === 'ack' && lose.ack);
      txs.push({ slot: t, lane, ...d, lost });
      return { p, lost };
    });
    sent.push(row);
    if ((msg.state === 'delivered' || msg.state === 'failed') && doneAt < 0) doneAt = t;
    if (doneAt >= 0 && t >= doneAt + 3 && !row[0]!.p && !row[1]!.p) break;
  }
  const last = Math.max(...txs.map((x) => x.slot), doneAt);
  renderTimeline($('ack-timeline'), ['A #101', 'B #202'], txs, last);
  const frames = txs.filter((x) => x.lane === 0).length;
  const res = $('ack-result');
  res.dataset.ok = String(msg.state === 'delivered');
  res.innerHTML = msg.state === 'delivered'
    ? `<b>Delivered.</b> B had the whole message after slot ${gotAt}; A knew it in slot ${doneAt} (${duration(doneAt * spec.slotSec)} in <span data-mode-name>${spec.label}</span>), after ${msg.round} round${msg.round > 1 ? 's' : ''} and ${frames} frame transmissions.`
    : `<b>Failed</b> after ${msg.round} rounds without a complete ack.`;
}
function setupAcks(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-lose]').forEach((btn) => {
    const v = btn.dataset.lose!;
    const sync = (): void => btn.setAttribute('aria-pressed', String(v === 'ack' ? lose.ack : lose.frames.has(Number(v))));
    sync();
    btn.addEventListener('click', () => {
      if (v === 'ack') lose.ack = !lose.ack;
      else if (lose.frames.has(Number(v))) lose.frames.delete(Number(v)); else lose.frames.add(Number(v));
      sync();
      acks();
    });
  });
  modeHooks.push(acks);
  acks();
}

// ---------------------------------------------------------------- 09 choosing a channel

let aleSeed = 3;
const busy = new Map<number, number>();
function ale(): void {
  const band = AM.BANDS.find((b) => b.name === 'ultrasonic')!;
  const channels = AM.listChannels(spec, band).map((c) => c.number);
  const random = rng(aleSeed);
  const lqa = new AM.LqaTable();
  const slot = 10000;
  const stations = [201, 202];
  const reports = new Map<string, number>();
  for (const st of stations) {
    const phase = random() * 6;
    const tilt = (random() - 0.5) * 10;
    channels.forEach((ch, i) => {
      const x = i / Math.max(1, channels.length - 1);
      const snr = Math.round(-9 + 5 * Math.sin(phase + x * 5) + tilt * (x - 0.5) + (random() - 0.5) * 5);
      reports.set(`${st}:${ch}`, snr);
      lqa.reported(st, ch, snr, slot - 2);
    });
  }
  const load = new Map<number, number>([...busy.entries()].filter(([ch, n]) => n > 0 && channels.includes(ch)));
  const ranked = new Map(lqa.rankChannels(stations, channels, slot).map((r) => [r.channel, r.score]));
  const picks = new Map<number, number>();
  const pr = rng(99);
  const N = 400;
  for (let i = 0; i < N; i++) {
    const c = lqa.chooseChannel(stations, channels, slot, pr, { load })!;
    picks.set(c, (picks.get(c) ?? 0) + 1);
  }
  const lvl = (snr: number): string => (snr >= -12 ? 'good' : snr >= -18 ? 'warn' : 'bad');
  let html = '<table class="ale"><thead><tr><th scope="row">Channel</th>';
  for (const ch of channels) html += `<th scope="col">${ch}</th>`;
  html += '</tr></thead><tbody>';
  for (const st of stations) {
    html += `<tr><th scope="row">#${st} hears us</th>`;
    for (const ch of channels) { const v = reports.get(`${st}:${ch}`)!; html += `<td data-l="${lvl(v)}">${minus(v)}</td>`; }
    html += '</tr>';
  }
  html += '<tr class="worst"><th scope="row">Worst case</th>';
  for (const ch of channels) { const v = ranked.get(ch)!; html += `<td data-l="${lvl(v)}">${minus(v)}</td>`; }
  html += '</tr><tr><th scope="row">Busy</th>';
  for (const ch of channels) {
    const n = busy.get(ch) ?? 0;
    html += `<td><button type="button" class="busy" data-ch="${ch}" aria-pressed="${n > 0}" aria-label="channel ${ch} busy: ${n} other stations">${n ? '●'.repeat(n) : '·'}</button></td>`;
  }
  html += '</tr><tr class="picked"><th scope="row">Picked</th>';
  for (const ch of channels) {
    const p = (picks.get(ch) ?? 0) / N;
    html += `<td><span class="pick" style="--p:${p}"></span><span class="pct">${p ? `${Math.round(p * 100)}%` : ''}</span></td>`;
  }
  html += '</tr></tbody></table>';
  $('ale-wrap').innerHTML = html;
  $('ale-wrap').querySelectorAll<HTMLButtonElement>('.busy').forEach((b) => {
    b.addEventListener('click', () => {
      const ch = Number(b.dataset.ch);
      busy.set(ch, ((busy.get(ch) ?? 0) + 1) % 3);
      ale();
      $('ale-wrap').querySelector<HTMLButtonElement>(`.busy[data-ch="${ch}"]`)?.focus();
    });
  });
}
function setupAle(): void {
  $('ale-new').addEventListener('click', () => { aleSeed++; ale(); });
  modeHooks.push(ale);
  ale();
}

// ---------------------------------------------------------------- 10 repeaters

function repeaters(): void {
  const on = $<HTMLInputElement>('rpt-on').checked;
  const a = new AM.ChatSession({ stationId: 101 });
  const r = new AM.ChatSession({ stationId: 202 });
  const c = new AM.ChatSession({ stationId: 303 });
  const st = [a, r, c];
  if (on) r.setRepeater(true);
  let got = -1;
  c.events.incoming = () => { if (got < 0) got = -2; };
  const hears = (i: number, j: number): boolean => Math.abs(i - j) === 1;
  const txs: Tx[] = [];
  const sent: (Uint8Array | null)[][] = [];
  let msg: OutMessage | null = null;
  let doneAt = -1;
  ackFramesTotal = AM.frameCount('MEET AT THE BRIDGE'.length);
  for (let t = 0; t < 50; t++) {
    if (t === 2) msg = a.send(303, 'MEET AT THE BRIDGE');
    const old = sent[t - 2];
    if (old) {
      st.forEach((rx, i) => {
        if (old[i]) return;
        old.forEach((p, j) => { if (p && i !== j && hears(i, j)) rx.receive(p, t - 2, -10, 12); });
      });
      if (got === -2) got = t - 2;
    }
    const row = st.map((s) => s.nextTx(t));
    row.forEach((p, lane) => { if (p) txs.push({ slot: t, lane, ...describe(p) }); });
    sent.push(row);
    if (msg && (msg.state === 'delivered' || msg.state === 'failed') && doneAt < 0) doneAt = t;
    if (doneAt >= 0 && t >= doneAt + 2 && row.every((p) => !p)) break;
  }
  const last = Math.max(...txs.map((x) => x.slot), doneAt);
  renderTimeline($('rpt-timeline'), ['A #101', on ? 'R #202 ↻' : 'R #202', 'C #303'], txs, last);
  const res = $('rpt-result');
  res.dataset.ok = String(msg?.state === 'delivered');
  res.innerHTML = msg?.state === 'delivered'
    ? `<b>Delivered through R.</b> C had the message after slot ${got}, and C's ack came back to A the same way: A knew in slot ${doneAt}. A's frames go out three slots apart while a repeater is around, so R can fit its repeats in between.`
    : `<b>Failed.</b> A tried ${msg?.round ?? 0} rounds. C never heard a frame, so it never sent an ack.`;
  document.getElementById('rpt-map')?.setAttribute('data-on', String(on));
}
function setupRepeaters(): void {
  $('rpt-on').addEventListener('change', repeaters);
  modeHooks.push(repeaters);
  repeaters();
}

// ---------------------------------------------------------------- 11 modes

function modes(): void {
  const W = chartW('modes-chart');
  const H = 300;
  const lo = -25;
  const hi = -7;
  const X = (db: number): number => 60 + ((hi - db) / (hi - lo)) * (W - 120);
  const cpm = (m: Spec): number => (AM.NEXT_CHARS * 60) / m.slotSec;
  const Y = (v: number): number => H - 40 - (Math.log2(v / 6) / Math.log2(300 / 6)) * (H - 70);
  let s = '';
  for (const v of [9, 18, 36, 54, 108, 216]) s += `<line x1="60" x2="${W - 40}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="52" y="${Y(v) + 4}" text-anchor="end" class="t-dim">${v}</text>`;
  for (let db = -24; db <= -8; db += W < 560 ? 8 : 4) s += `<text x="${X(db)}" y="${H - 18}" text-anchor="middle" class="t-dim">${minus(db)} dB</text>`;
  s += `<text x="${W - 40}" y="${H - 2}" text-anchor="end" class="t-dim">${W < 560 ? 'reliable down to →' : 'decodes reliably down to (SNR in 2500 Hz) →'}</text>`;
  s += `<text x="60" y="14" class="t-dim">characters per minute, one frame per slot</text>`;
  s += `<polyline class="trend" points="${MODES.map((m) => `${X(FLOOR_DB[m.id]!)},${Y(cpm(m))}`).join(' ')}"/>`;
  for (const m of MODES) {
    const on = m === spec;
    s += `<g class="mode-pt${on ? ' on' : ''}" data-id="${m.id}" tabindex="0" role="button" aria-label="${m.label}"><circle cx="${X(FLOOR_DB[m.id]!)}" cy="${Y(cpm(m))}" r="${on ? 9 : 6}"/>` +
      `<text x="${X(FLOOR_DB[m.id]!) + 14}" y="${Y(cpm(m)) + 4}">${m.label}</text></g>`;
  }
  const svg = $('modes-chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = s;
  svg.querySelectorAll<SVGGElement>('.mode-pt').forEach((g) => {
    g.addEventListener('click', () => setMode(g.dataset.id!));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode(g.dataset.id!); } });
  });
  let t = '<thead><tr><th>Mode</th><th>Baud</th><th>Frame</th><th>Slot</th><th>Width</th><th>Clock</th><th>Reliable to</th></tr></thead><tbody>';
  for (const m of MODES) {
    t += `<tr${m === spec ? ' class="on"' : ''}><th scope="row"><button type="button" class="link" data-mode="${m.id}">${m.label}</button></th><td>${m.baud}</td><td>${secs(AM.frameDurationSec(m))}</td><td>${m.slotSec} s</td><td>${AM.bandwidthHz(m)} Hz</td><td>±${m.maxTimeOffsetSec} s</td><td>${minus(FLOOR_DB[m.id]!)} dB</td></tr>`;
  }
  $('modes-table').innerHTML = t + '</tbody>';
  $('modes-table').querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode!)));
}

// ---------------------------------------------------------------- start

function start(): void {
  drawLogo();
  setupMode();
  void hero();
  setupBands();
  setupBits();
  setupFec();
  setupTones();
  setupSync();
  setupSlots();
  setupLab();
  setupAcks();
  setupAle();
  setupRepeaters();
  modes();
  modeHooks.push(modes, () => void hero());
  bindPlay($<HTMLButtonElement>('hero-play'), (rate) => {
    if (!heroPic) return null;
    return { samples: AM.synthesizeFrame(heroPic.symbols, 1000, rate, spec), rate };
  }, (f) => drawHero(f));
  let w = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - w) < 8) return;
    w = window.innerWidth;
    drawHero(-1); drawTones(); drawGlide(); drawSync(); drawLab();
    bands(); slots(); drawLabChart(); modes();
  });
}
start();
