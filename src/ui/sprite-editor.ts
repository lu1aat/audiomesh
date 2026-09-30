/**
 * The sprite editor: a dialog opened from the chat composer with a gallery of ready-made
 * sprites, a pixel canvas, a palette, the size and colour count, and a live count of
 * frames and airtime. Sending hands a `Sprite` to the caller.
 *
 * The picture is always drawn in the 16 fixed colours; the colour count only decides how
 * it is quantized when sent ("as sent" shows the result), which is what the design page did.
 */

import {
  SPRITE_BACKGROUND,
  SPRITE_PALETTE,
  MAX_SPRITE_FRAMES,
  fixedIndices,
  quantize,
  spriteColours,
  spriteFrameCount,
  viewOf,
  type Sprite,
} from '../chat/sprite';
import { SPRITE_GALLERY, parseRows, toRows } from '../chat/sprite-gallery';
import { drawSprite, formatDuration, maxSideFor } from './sprite-view';

export interface SpriteEditorOptions {
  /** Seconds per slot: one frame goes out per slot. */
  slotSec: number;
  /** Pixel size setting, in CSS pixels. */
  pixelPx: () => number;
  /** Who a sent sprite goes to, in words, and whether sending is possible right now. */
  recipient: () => { label: string; canSend: boolean };
  /** Send it; returns an error text to show, or null when queued. */
  send: (sprite: Sprite) => string | null;
}

/** The gallery's cards stay small even when the pixel size setting is large. */
const GALLERY_MAX_PX = 10;
const EDITOR_MIN_WIDTH_PX = 240;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class SpriteEditor {
  private readonly dialog = byId<HTMLDialogElement>('sprite-dialog');
  private readonly canvas = byId<HTMLCanvasElement>('sprite-canvas');
  private readonly sizeSelect = byId<HTMLSelectElement>('sprite-size');
  private readonly coloursSelect = byId<HTMLSelectElement>('sprite-colours');
  private readonly stats = byId<HTMLElement>('sprite-stats');
  private readonly text = byId<HTMLTextAreaElement>('sprite-text');
  private readonly to = byId<HTMLElement>('sprite-to');
  private readonly error = byId<HTMLElement>('sprite-error');
  private readonly sendButton = byId<HTMLButtonElement>('sprite-send');
  private readonly gallery = byId<HTMLElement>('sprite-gallery');
  private side = 8;
  private bpp = 4;
  private colour = 8;
  private painting: 0 | 1 | 2 = 0;
  private pixels: Uint8Array = new Uint8Array(64).fill(SPRITE_BACKGROUND);

  constructor(private readonly opts: SpriteEditorOptions) {
    this.sizeSelect.replaceChildren(...Array.from({ length: 16 }, (_, i) => new Option(`${i + 1}×${i + 1}`, String(i + 1))));
    this.sizeSelect.value = String(this.side);
    this.coloursSelect.replaceChildren(
      new Option('2 colours', '1'), new Option('4 colours', '2'), new Option('8 colours', '3'), new Option('16 colours', '4'),
    );
    this.coloursSelect.value = String(this.bpp);
    this.buildSwatches();
    this.sizeSelect.addEventListener('change', () => this.resize(Number(this.sizeSelect.value)));
    this.coloursSelect.addEventListener('change', () => {
      this.bpp = Number(this.coloursSelect.value);
      this.refresh();
    });
    byId('sprite-fill').addEventListener('click', () => { this.pixels.fill(this.colour); this.refresh(); });
    byId('sprite-clear').addEventListener('click', () => { this.pixels.fill(SPRITE_BACKGROUND); this.refresh(); });
    byId('sprite-apply').addEventListener('click', () => {
      const rows = this.text.value.split('\n').map((r) => r.trim()).filter(Boolean);
      this.pixels = parseRows(rows, this.side);
      this.refresh();
    });
    byId('sprite-close').addEventListener('click', () => this.dialog.close());
    this.sendButton.addEventListener('click', () => this.onSend());
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      this.painting = e.button === 2 ? 2 : 1;
      this.canvas.setPointerCapture(e.pointerId);
      this.paintAt(e);
    });
    this.canvas.addEventListener('pointermove', (e) => { if (this.painting) this.paintAt(e); });
    this.canvas.addEventListener('pointerup', () => { this.painting = 0; });
    this.canvas.addEventListener('pointercancel', () => { this.painting = 0; });
    this.buildGallery();
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    this.error.textContent = '';
    if (!this.dialog.open) this.dialog.showModal();
    this.refresh();
  }

  /** Put a sprite into the canvas (a gallery card, or a failed message to send again). */
  load(pixels: ArrayLike<number>, side: number, bpp: number): void {
    this.side = side;
    this.bpp = bpp;
    this.pixels = Uint8Array.from(pixels);
    this.sizeSelect.value = String(side);
    this.coloursSelect.value = String(bpp);
    this.refresh();
  }

  private resize(side: number): void {
    this.pixels = parseRows(toRows(this.pixels, this.side), side);
    this.side = side;
    this.refresh();
  }

  private buildSwatches(): void {
    const box = byId('sprite-swatches');
    box.replaceChildren(...SPRITE_PALETTE.map((hex, i) => {
      const b = el('button');
      b.type = 'button';
      b.style.background = hex;
      b.title = `colour ${i.toString(16)}`;
      b.dataset.c = String(i);
      b.addEventListener('click', () => { this.colour = i; this.markSwatch(); });
      return b;
    }));
    this.markSwatch();
  }

  private markSwatch(): void {
    for (const b of byId('sprite-swatches').querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('sel', Number(b.dataset.c) === this.colour);
  }

  private paintAt(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.side);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.side);
    if (x < 0 || y < 0 || x >= this.side || y >= this.side) return;
    const c = this.painting === 2 ? SPRITE_BACKGROUND : this.colour;
    const p = y * this.side + x;
    if (this.pixels[p] !== c) {
      this.pixels[p] = c;
      this.refresh();
    }
  }

  private onSend(): void {
    const err = this.opts.send(quantize(this.pixels, this.side, this.bpp));
    this.error.textContent = err ?? '';
    if (!err) this.dialog.close();
  }

  /** Redraw everything: call after a change of size, colours, pixels or the pixel size setting. */
  refresh(): void {
    const n = this.side;
    const px = this.opts.pixelPx();
    const cell = Math.max(px, Math.floor(EDITOR_MIN_WIDTH_PX / n));
    drawSprite(this.canvas, n, cell, Array.from(this.pixels, (v) => SPRITE_PALETTE[v]!), true);
    const sent = quantize(this.pixels, n, this.bpp);
    const shown = spriteColours(viewOf(sent), 'checker');
    const box = byId('sprite-previews');
    box.replaceChildren();
    for (const [label, size] of [['as sent', Math.max(4, Math.floor(160 / n))], ['1×', 1], ['2×', 2]] as const) {
      const c = el('canvas', 'sprite-canvas');
      drawSprite(c, n, size, shown, false);
      const cap = el('figure');
      cap.append(c, el('figcaption', undefined, label));
      box.append(cap);
    }
    const frames = spriteFrameCount(n, this.bpp);
    const fits = frames <= MAX_SPRITE_FRAMES;
    this.stats.replaceChildren();
    const big = el('span', fits ? (frames <= 2 ? 'f1' : frames <= 4 ? 'f2' : 'f3') : 'f4', `${frames} frame${frames === 1 ? '' : 's'}`);
    this.stats.append(big, ` · ${formatDuration(frames * this.opts.slotSec)} on air (one frame per ${this.opts.slotSec} s slot)`);
    if (!fits) {
      this.stats.append(el('div', 'sprite-over', `Over ${MAX_SPRITE_FRAMES} frames: it cannot be sent. At ${1 << this.bpp} colours the largest is ${maxSideFor(this.bpp)}×${maxSideFor(this.bpp)}; or use fewer colours.`));
    }
    if (document.activeElement !== this.text) this.text.value = toRows(this.pixels, n).join('\n');
    const rcpt = this.opts.recipient();
    this.to.textContent = `To: ${rcpt.label}`;
    this.sendButton.disabled = !fits || !rcpt.canSend;
    this.sendButton.title = !rcpt.canSend ? 'Turn audio on and allow transmit first' : '';
    this.refreshGallery();
  }

  private buildGallery(): void {
    this.gallery.replaceChildren();
    for (const group of SPRITE_GALLERY) {
      const section = el('section', 'sprite-group');
      section.dataset.side = String(group.side);
      section.append(el('h4', undefined, `${group.side}×${group.side}`));
      const cards = el('div', 'sprite-cards');
      for (const s of group.sprites) {
        const card = el('button', 'sprite-card');
        card.type = 'button';
        card.title = `Load ${s.name} into the editor`;
        card.dataset.name = s.name;
        card.append(el('canvas', 'sprite-canvas'), el('span', 'sprite-card-name', s.name), el('span', 'sprite-card-info'));
        card.addEventListener('click', () => this.load(parseRows(s.rows, group.side), group.side, this.bpp));
        cards.append(card);
      }
      section.append(cards);
      this.gallery.append(section);
    }
  }

  /** Cards show each sprite as it would be sent at the chosen colour count. */
  private refreshGallery(): void {
    const px = Math.min(GALLERY_MAX_PX, this.opts.pixelPx());
    for (const section of this.gallery.querySelectorAll<HTMLElement>('.sprite-group')) {
      const side = Number(section.dataset.side);
      const group = SPRITE_GALLERY.find((g) => g.side === side)!;
      const frames = spriteFrameCount(side, this.bpp);
      section.querySelectorAll<HTMLElement>('.sprite-card').forEach((card, i) => {
        const sprite = quantize(parseRows(group.sprites[i]!.rows, side), side, this.bpp);
        drawSprite(card.querySelector('canvas')!, side, px, spriteColours(viewOf(sprite), 'checker'), false);
        const info = card.querySelector('.sprite-card-info')!;
        info.textContent = frames > MAX_SPRITE_FRAMES ? `${frames} frames: too big` : `${frames} frame${frames === 1 ? '' : 's'}`;
        info.classList.toggle('sprite-over', frames > MAX_SPRITE_FRAMES);
      });
    }
  }

  /** Load a sent sprite back (a failed message the user taps to send again). */
  loadSprite(sprite: Sprite): void {
    this.load(fixedIndices(sprite), sprite.side, sprite.bpp);
  }
}
