/**
 * Spectrum and waterfall on one canvas, with the channel plan drawn over both.
 *
 * Shared frequency axis and one hit-test region, so clicking anywhere on the
 * picture selects the nearest channel. The waterfall history is a fixed-size
 * offscreen canvas that gets scaled on blit, so resizing never discards it.
 *
 * Only frequency is drawn; nothing here decodes.
 */

import type { Channel } from '../band/band-plan';
import { buildLut, DEFAULT_THEME_ID, LUT_SIZE, themeBackground, themeById, type BoxColours, type WaterfallTheme } from './waterfall-themes';

/** Default displayed span until setViewRange is called. */
const DEFAULT_VIEW_LOW_HZ = 200;
const DEFAULT_VIEW_HIGH_HZ = 3400;

/** Default colour scale, matching the analyser's min/max decibels in AudioEngine. */
export const DEFAULT_FLOOR_DB = -100;
export const DEFAULT_CEIL_DB = -30;
/** Lowest level a column can hold; below any real reading. */
const SILENCE_DB = -200;
/** Smallest floor-to-ceiling distance the scale may have. */
export const MIN_LEVEL_SPAN_DB = 10;

// ~10 Hz per column across a 10 kHz view: fine enough that a 50 Hz channel spans several.
const HISTORY_W = 1024;
const HISTORY_H = 256;

const AXIS_H = 20;
const AXIS_STEPS_HZ = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
/** Share of the plot (canvas minus axis) for the spectrum: 42 px of a 224 px canvas, the waterfall gets the other 162. */
const SPECTRUM_FRACTION = 42 / 204;

export class SpectrumDisplay {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly history: HTMLCanvasElement;
  private readonly historyCtx: CanvasRenderingContext2D;
  private readonly row = new ImageData(HISTORY_W, 1);
  /** Wall-clock ms at which each history row was written (0 = none yet), newest first. */
  private readonly rowTimes = new Float64Array(HISTORY_H);
  private slotMs = 0;
  /** Our slot grid against UTC, so the lines sit where we send and listen. */
  private slotOffsetMs = 0;
  /** How long ago the audio in the newest row reached the microphone. */
  private lagMs = 0;
  private readonly slotLabels = new Map<number, string>();
  private readonly columnDb = new Float32Array(HISTORY_W);
  private hasData = false;
  private floorDb = DEFAULT_FLOOR_DB;
  private ceilDb = DEFAULT_CEIL_DB;
  private theme: WaterfallTheme = themeById(DEFAULT_THEME_ID);
  private lut = buildLut(this.theme);

  private channels: readonly Channel[] = [];
  private bandwidthHz = 0;
  private markersHz: readonly number[] = [];
  private selected: number | null = null;
  private overloaded: ReadonlySet<number> = new Set();
  private blocked: ReadonlySet<number> = new Set();
  /** The channel our frame is going out on (or waiting for its slot), drawn red. */
  private sending: number | null = null;
  /** performance.now() at which each channel's white flash started (a frame from another station was decoded there). */
  private readonly flashStartMs = new Map<number, number>();
  private viewLowHz = DEFAULT_VIEW_LOW_HZ;
  private viewHighHz = DEFAULT_VIEW_HIGH_HZ;

  onSelect: (channelNumber: number) => void = () => {};

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.history = document.createElement('canvas');
    this.history.width = HISTORY_W;
    this.history.height = HISTORY_H;
    this.historyCtx = this.history.getContext('2d')!;
    this.clearHistory();
    this.columnDb.fill(SILENCE_DB);
    canvas.addEventListener('pointerdown', (e) => this.handlePointer(e));
  }

  private clearHistory(): void {
    this.historyCtx.fillStyle = themeBackground(this.theme);
    this.historyCtx.fillRect(0, 0, HISTORY_W, HISTORY_H);
  }

  /** Switch the look. Rows already in the waterfall keep the colours they were drawn with and scroll off. */
  setTheme(id: string): void {
    this.theme = themeById(id);
    this.lut = buildLut(this.theme);
    if (!this.hasData) this.clearHistory();
  }

  private rampColor(t: number, out: Uint8ClampedArray, offset: number): void {
    const i = Math.round(Math.min(1, Math.max(0, t)) * (LUT_SIZE - 1)) * 3;
    out[offset] = this.lut[i]!;
    out[offset + 1] = this.lut[i + 1]!;
    out[offset + 2] = this.lut[i + 2]!;
    out[offset + 3] = 255;
  }

  setPlan(channels: readonly Channel[], bandwidthHz: number, markersHz: readonly number[]): void {
    this.channels = channels;
    this.bandwidthHz = bandwidthHz;
    this.markersHz = markersHz;
  }

  /**
   * Where the slot lines go: our grid's offset against UTC, and how far the spectrum
   * lags the air (microphone latency plus half the FFT window), so a frame that starts
   * on the boundary starts on the line.
   */
  setTiming(slotOffsetMs: number, lagMs: number): void {
    this.slotOffsetMs = slotOffsetMs;
    this.lagMs = lagMs;
  }

  /** Slot length in ms; a horizontal line is drawn on the waterfall at every slot boundary. 0 turns it off. */
  setSlotMs(slotMs: number): void {
    this.slotMs = slotMs;
  }

  /** Frequency span shown on the horizontal axis. Clears the waterfall: old rows no longer line up. */
  setViewRange(lowHz: number, highHz: number): void {
    this.viewLowHz = lowHz;
    this.viewHighHz = highHz;
    this.clearHistory();
    this.rowTimes.fill(0);
    this.hasData = false;
  }

  /** Colour scale. Rows already in the waterfall keep the colours they were drawn with. */
  setLevelRange(floorDb: number, ceilDb: number): void {
    this.floorDb = floorDb;
    this.ceilDb = Math.max(ceilDb, floorDb + MIN_LEVEL_SPAN_DB);
  }

  get levelRange(): { floorDb: number; ceilDb: number } {
    return { floorDb: this.floorDb, ceilDb: this.ceilDb };
  }

  /**
   * Scale that fits the newest spectrum row: floor just under the noise (the
   * 10th percentile of the columns), ceiling just over the strongest peak.
   * Null until a row has been drawn.
   */
  fitLevelRange(): { floorDb: number; ceilDb: number } | null {
    if (!this.hasData) return null;
    const sorted = Float32Array.from(this.columnDb).sort();
    const floorDb = Math.round(sorted[Math.floor(sorted.length * 0.1)]! - 3);
    const ceilDb = Math.round(sorted[sorted.length - 1]! + 3);
    return { floorDb, ceilDb: Math.max(ceilDb, floorDb + MIN_LEVEL_SPAN_DB) };
  }

  /** The channel we are sending on, or null. */
  setSending(channelNumber: number | null): void {
    this.sending = channelNumber;
  }

  /** Channels to draw in yellow: the signal there overloaded the input. */
  setOverloaded(channelNumbers: ReadonlySet<number>): void {
    this.overloaded = channelNumbers;
  }

  /** Channels the user switched off for transmitting: drawn with a translucent dark box and a cross, the waterfall still visible behind. */
  setBlocked(channelNumbers: ReadonlySet<number>): void {
    this.blocked = channelNumbers;
  }

  /** Flash a channel's box white, like the channel strip's cell (three 0.3 s blinks; one 0.6 s blink with reduced motion). */
  flash(channelNumber: number): void {
    this.flashStartMs.set(channelNumber, performance.now());
  }

  /** 0..1 white overlay strength for a channel's flash right now, 0 when none is running. */
  private flashLevel(channelNumber: number, nowMs: number): number {
    const start = this.flashStartMs.get(channelNumber);
    if (start === undefined) return 0;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const periodMs = reduced ? 600 : 300;
    const t = nowMs - start;
    if (t >= periodMs * (reduced ? 1 : 3)) {
      this.flashStartMs.delete(channelNumber);
      return 0;
    }
    return Math.sin((Math.PI * (t % periodMs)) / periodMs); // 0 -> 1 at mid-period -> 0, like the CSS keyframes
  }

  setSelected(channelNumber: number | null): void {
    this.selected = channelNumber;
  }

  /** Call once per animation frame. `spectrum` is null until audio starts. */
  render(spectrum: Float32Array | null, sampleRate: number): void {
    if (spectrum) this.pushRow(spectrum, sampleRate);
    // Zero size while another screen is shown: keep the waterfall history, skip the drawing.
    if (this.canvas.clientWidth === 0) return;
    this.fitCanvas();
    this.draw();
  }

  private fitCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private pushRow(spectrum: Float32Array, sampleRate: number): void {
    // The analyser returns fftSize / 2 bins spanning 0..Nyquist.
    const binHz = sampleRate / 2 / spectrum.length;
    const span = this.viewHighHz - this.viewLowHz;
    const data = this.row.data;
    for (let c = 0; c < HISTORY_W; c++) {
      const b0 = Math.floor((this.viewLowHz + (c / HISTORY_W) * span) / binHz);
      const b1 = Math.max(b0, Math.floor((this.viewLowHz + ((c + 1) / HISTORY_W) * span) / binHz));
      // Peak, not mean: a narrow tone must not vanish when a column covers several bins.
      let peak = SILENCE_DB;
      for (let b = b0; b <= b1 && b < spectrum.length; b++) {
        const v = spectrum[b]!;
        if (v > peak) peak = v;
      }
      this.columnDb[c] = peak;
      this.rampColor((peak - this.floorDb) / (this.ceilDb - this.floorDb), data, c * 4);
    }
    // Scroll the history down one row, then write the newest row at the top. The
    // rows carry their times so slot lines can be placed without touching the pixels.
    this.historyCtx.drawImage(this.history, 0, 1);
    this.historyCtx.putImageData(this.row, 0, 0);
    this.rowTimes.copyWithin(1, 0, HISTORY_H - 1);
    this.rowTimes[0] = Date.now() - this.lagMs;
    this.hasData = true;
  }

  private xForHz(hz: number, w: number): number {
    return ((hz - this.viewLowHz) / (this.viewHighHz - this.viewLowHz)) * w;
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const axisH = AXIS_H * dpr;
    const specH = Math.round((h - axisH) * SPECTRUM_FRACTION);
    const wfTop = specH;
    const wfH = h - axisH - specH;

    ctx.fillStyle = this.theme.canvasBg;
    ctx.fillRect(0, 0, w, h);

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.history, 0, 0, HISTORY_W, HISTORY_H, 0, wfTop, w, wfH);

    this.drawSlotLines(w, wfTop, wfH, dpr);

    if (this.hasData) {
      ctx.beginPath();
      for (let c = 0; c < HISTORY_W; c++) {
        const x = ((c + 0.5) / HISTORY_W) * w;
        const t = (this.columnDb[c]! - this.floorDb) / (this.ceilDb - this.floorDb);
        const y = specH - Math.min(1, Math.max(0, t)) * (specH - 2 * dpr);
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.theme.spectrumLine;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.stroke();
    }

    this.drawChannels(w, h - axisH, dpr);
    this.drawAxis(w, h - axisH, axisH, dpr);
  }

  /**
   * A line where a slot boundary falls between two history rows, with the boundary
   * time at the right edge. Placed from the rows' timestamps, so it stays true
   * whatever the frame rate; the picture itself is never modified.
   */
  private drawSlotLines(w: number, wfTop: number, wfH: number, dpr: number): void {
    if (this.slotMs <= 0) return;
    const { ctx, rowTimes, slotMs } = this;
    ctx.strokeStyle = this.theme.slotLine;
    ctx.fillStyle = this.theme.slotText;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (let i = 0; i < HISTORY_H - 1; i++) {
      const older = rowTimes[i + 1]!;
      if (older === 0) break;
      const off = this.slotOffsetMs;
      const boundary = Math.floor((rowTimes[i]! - off) / slotMs);
      if (boundary === Math.floor((older - off) / slotMs)) continue;
      const y = wfTop + Math.round(((i + 1) / HISTORY_H) * wfH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(this.slotLabel(boundary * slotMs + off), w - 4 * dpr, y - dpr);
    }
  }

  private slotLabel(ms: number): string {
    let label = this.slotLabels.get(ms);
    if (label === undefined) {
      if (this.slotLabels.size > 32) this.slotLabels.clear();
      label = new Date(ms).toLocaleTimeString([], { hour12: false });
      this.slotLabels.set(ms, label);
    }
    return label;
  }

  private drawChannels(w: number, height: number, dpr: number): void {
    const { ctx, theme } = this;
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const nowMs = performance.now();
    for (const ch of this.channels) {
      let x0 = this.xForHz(ch.baseHz, w);
      let x1 = this.xForHz(ch.baseHz + this.bandwidthHz, w);
      // On a wide view a 50 Hz channel is only a few pixels: keep it visible and clickable-looking.
      const minWidth = 8 * dpr;
      if (x1 - x0 < minWidth) {
        const mid = (x0 + x1) / 2;
        x0 = mid - minWidth / 2;
        x1 = mid + minWidth / 2;
      }
      const isSel = ch.number === this.selected;
      const isOver = this.overloaded.has(ch.number);
      const isTx = ch.number === this.sending;
      // Sending (red) wins over overload (yellow), which wins over the selection (blue).
      const box: BoxColours = isTx ? theme.sending : isOver ? theme.overload : isSel ? theme.selected : theme.idle;
      ctx.fillStyle = box.fill;
      ctx.fillRect(x0, 0, x1 - x0, height);
      ctx.strokeStyle = box.stroke;
      ctx.lineWidth = isTx ? 2 * dpr : dpr;
      ctx.strokeRect(x0 + 0.5, 0.5, x1 - x0, height - 1);
      const flash = this.flashLevel(ch.number, nowMs);
      if (flash > 0) {
        ctx.fillStyle = `rgba(${theme.flash}, ${0.85 * flash})`;
        ctx.fillRect(x0, 0, x1 - x0, height);
      }
      ctx.fillStyle = box.text;
      ctx.fillText(String(ch.number), (x0 + x1) / 2, 4 * dpr);
      if (this.blocked.has(ch.number)) this.drawBlocked(x0, x1, height, dpr);
    }
  }

  /** A blocked channel: translucent dark box, hatching and a cross at the top; the waterfall stays visible behind. */
  private drawBlocked(x0: number, x1: number, height: number, dpr: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, height);
    ctx.clip();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(x0, 0, x1 - x0, height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = dpr;
    const step = 10 * dpr;
    ctx.beginPath();
    for (let y = -(x1 - x0); y < height; y += step) {
      ctx.moveTo(x0, y + (x1 - x0));
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
    ctx.restore();
    const mid = (x0 + x1) / 2;
    const r = Math.min(6 * dpr, (x1 - x0) / 2 - dpr);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(mid - r, 18 * dpr);
    ctx.lineTo(mid + r, 18 * dpr + 2 * r);
    ctx.moveTo(mid + r, 18 * dpr);
    ctx.lineTo(mid - r, 18 * dpr + 2 * r);
    ctx.stroke();
  }

  private drawAxis(w: number, top: number, axisH: number, dpr: number): void {
    const { ctx } = this;
    ctx.fillStyle = this.theme.axisBg;
    ctx.fillRect(0, top, w, axisH);
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.theme.axisText;
    ctx.textAlign = 'center';
    // Coarsest step that keeps the labels from crowding (about 10 across the view).
    const span = this.viewHighHz - this.viewLowHz;
    const step = AXIS_STEPS_HZ.find((s) => span / s <= 10) ?? AXIS_STEPS_HZ[AXIS_STEPS_HZ.length - 1]!;
    for (let hz = Math.ceil(this.viewLowHz / step) * step; hz < this.viewHighHz; hz += step) {
      const x = this.xForHz(hz, w);
      ctx.fillRect(x, top, dpr, 4 * dpr);
      ctx.fillText(hz >= 1000 ? `${hz / 1000} kHz` : `${hz}`, x, top + axisH * 0.65);
    }
    // Reference tones: small triangles on the axis.
    ctx.fillStyle = this.theme.marker;
    for (const hz of this.markersHz) {
      const x = this.xForHz(hz, w);
      ctx.beginPath();
      ctx.moveTo(x - 4 * dpr, top + axisH);
      ctx.lineTo(x + 4 * dpr, top + axisH);
      ctx.lineTo(x, top + axisH - 6 * dpr);
      ctx.fill();
    }
  }

  private handlePointer(e: PointerEvent): void {
    if (this.channels.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const hz = this.viewLowHz + ((e.clientX - rect.left) / rect.width) * (this.viewHighHz - this.viewLowHz);
    let best = this.channels[0]!;
    for (const ch of this.channels) {
      if (Math.abs(ch.centerHz - hz) < Math.abs(best.centerHz - hz)) best = ch;
    }
    this.onSelect(best.number);
  }
}
