/**
 * Drawing sprites on a canvas, shared by the chat lines, the editor and its gallery.
 * Pure DOM, no state. Colours come from `spriteColours` (sprite.ts).
 */

import { MAX_SPRITE_SIDE, spriteFits } from '../chat/sprite';

export type HoleStyle = 'checker' | 'fill';

export const MIN_PIXEL_PX = 2;
export const MAX_PIXEL_PX = 40;
export const DEFAULT_PIXEL_PX = 10;

/** A setting read back from storage, so clamp it. */
export const clampPixelPx = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_PIXEL_PX, Math.max(MIN_PIXEL_PX, n)) : DEFAULT_PIXEL_PX;
};

/**
 * Paint `side` x `side` pixels of `cellPx` CSS pixels each. A `null` colour is a pixel
 * that never arrived: drawn as a checker tile. The grid lines only when cells are big
 * enough to take them. The bitmap follows the device pixel ratio so edges stay sharp.
 */
export function drawSprite(canvas: HTMLCanvasElement, side: number, cellPx: number, colours: readonly (string | null)[], grid: boolean): void {
  const dpr = window.devicePixelRatio || 1;
  const cell = cellPx * dpr;
  canvas.width = Math.round(side * cell);
  canvas.height = Math.round(side * cell);
  canvas.style.width = `${side * cellPx}px`;
  const g = canvas.getContext('2d');
  if (!g) return;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const x0 = Math.round(x * cell);
      const y0 = Math.round(y * cell);
      const w = Math.round((x + 1) * cell) - x0;
      const h = Math.round((y + 1) * cell) - y0;
      const c = colours[y * side + x];
      if (c) {
        g.fillStyle = c;
        g.fillRect(x0, y0, w, h);
        continue;
      }
      g.fillStyle = '#23262e';
      g.fillRect(x0, y0, w, h);
      if (cell >= 6) {
        g.fillStyle = '#30343e';
        g.fillRect(x0, y0, w / 2, h / 2);
        g.fillRect(x0 + w / 2, y0 + h / 2, w / 2, h / 2);
      }
    }
  }
  if (grid && cellPx >= 6) {
    g.strokeStyle = 'rgba(0,0,0,.35)';
    g.lineWidth = Math.max(1, dpr * 0.75);
    g.beginPath();
    for (let i = 1; i < side; i++) {
      const v = Math.round(i * cell) + 0.5;
      g.moveTo(v, 0);
      g.lineTo(v, canvas.height);
      g.moveTo(0, v);
      g.lineTo(canvas.width, v);
    }
    g.stroke();
  }
}

/** "45 s", "1 min", "1 min 30 s". */
export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** The largest side that still fits 16 frames at this depth. */
export function maxSideFor(bpp: number): number {
  let side = MAX_SPRITE_SIDE;
  while (side > 1 && !spriteFits(side, bpp)) side--;
  return side;
}
