/**
 * Sprites: small square pictures (1x1 to 16x16) of palette colours, sent as a series
 * of frames like a chat message. Pure: no audio, no DOM. The wire format is also in
 * network-protocol.md (sprite head and body frames).
 *
 * The point is partial reception: any subset of the frames must give a usable picture.
 * So the pixels are raw (no compression: every pixel has a fixed place in the stream),
 * no frame splits a pixel, and the pixels are sent in a Bayer-like interleaved order,
 * not row by row: a lost frame leaves scattered single pixels (filled from their
 * neighbours) instead of a band, and the first frames already show the whole picture at
 * low resolution. Every frame repeats the side and colour depth, so a lost head frame
 * costs only the palette and the destination.
 *
 * Wire data per frame (bits, MSB first), after the frame header that frames.ts writes:
 *   head  39 bits: palette (bpp < 4: 2^bpp entries of 4 bits, each an index of the fixed
 *                  palette), then as many pixels as fit
 *   body  45 bits: pixels only
 * A pixel is `bpp` bits: with 4 bpp an index of the fixed palette itself, else an index
 * of the sprite's own palette. Bits left over at the end of a frame are zero.
 */

/** The fixed 16-colour palette (PICO-8). A pixel of a 4 bpp sprite is an index into it. */
export const SPRITE_PALETTE: readonly string[] = [
  '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
];

const PALETTE_RGB: readonly (readonly [number, number, number])[] = SPRITE_PALETTE.map((h) => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
]);

export const MIN_SPRITE_SIDE = 1;
export const MAX_SPRITE_SIDE = 16;
/** Head frame + up to 15 body frames (a 4-bit `seq`, 0 = the head). */
export const MAX_SPRITE_FRAMES = 16;
export const SPRITE_HEAD_BITS = 39;
export const SPRITE_BODY_BITS = 45;
const PALETTE_ENTRY_BITS = 4;

/** Background colour of a blank sprite: index 1 of the fixed palette (dark blue). */
export const SPRITE_BACKGROUND = 1;

/** `pixels` holds one value per pixel, row by row; `palette` (bpp < 4 only) maps them to the fixed palette. */
export interface Sprite {
  readonly side: number;
  /** Bits per pixel, 1..4 (2, 4, 8 or 16 colours). */
  readonly bpp: number;
  /** 2^bpp fixed-palette indices; null with 4 bpp (the pixel values are the fixed indices). */
  readonly palette: Uint8Array | null;
  readonly pixels: Uint8Array;
}

/** What is known of a sprite, complete or not (an assembly implements it; events carry a copy). */
export interface SpriteView {
  readonly side: number;
  readonly bpp: number;
  /** Fixed-palette index per local index; null with 4 bpp. Meaningful only when `paletteKnown`. */
  readonly palette: Uint8Array | null;
  readonly paletteKnown: boolean;
  /** Per pixel, row by row; valid only where `known` is 1. */
  readonly pixels: Uint8Array;
  /** 1 where the pixel arrived, else 0. */
  readonly known: Uint8Array;
}

export const colourCount = (bpp: number): number => 1 << bpp;

/** Palette bits in the head: 0 with 4 bpp (fixed palette), else 2^bpp entries. */
export const paletteBits = (bpp: number): number => (bpp === 4 ? 0 : colourCount(bpp) * PALETTE_ENTRY_BITS);

/** Pixels in the head frame. */
export const headPixels = (bpp: number): number => Math.floor((SPRITE_HEAD_BITS - paletteBits(bpp)) / bpp);

/** Pixels in each body frame. */
export const bodyPixels = (bpp: number): number => Math.floor(SPRITE_BODY_BITS / bpp);

/** Frames a sprite takes, head included. Above MAX_SPRITE_FRAMES it cannot be sent. */
export function spriteFrameCount(side: number, bpp: number): number {
  const rest = side * side - headPixels(bpp);
  return 1 + Math.max(0, Math.ceil(rest / bodyPixels(bpp)));
}

export const spriteFits = (side: number, bpp: number): boolean => spriteFrameCount(side, bpp) <= MAX_SPRITE_FRAMES;

/** Position of a pixel in the interleaved order: the 16x16 Bayer matrix, low coordinate bits weigh most. */
export function bayer(x: number, y: number): number {
  let v = 0;
  for (let i = 0; i < 4; i++) v = (v << 2) | ((((x ^ y) >> i) & 1) << 1) | ((y >> i) & 1);
  return v;
}

const orders = new Map<number, Uint16Array>();

/**
 * The pixels of a side x side sprite (as `y * side + x`) in the order they go on the
 * air: sorted by (bayer(x, y), y, x). Fixed per side, computed the same everywhere.
 */
export function pixelOrder(side: number): Uint16Array {
  let order = orders.get(side);
  if (!order) {
    const all = Array.from({ length: side * side }, (_, p) => p);
    const key = (p: number): number => bayer(p % side, Math.floor(p / side));
    all.sort((a, b) => key(a) - key(b) || Math.floor(a / side) - Math.floor(b / side) || (a % side) - (b % side));
    order = Uint16Array.from(all);
    orders.set(side, order);
  }
  return order;
}

/** Stream positions carried by frame `seq` (0 = head): the half-open range [from, to) of the pixel order. */
function frameRange(seq: number, side: number, bpp: number): [number, number] {
  const n = side * side;
  const head = headPixels(bpp);
  if (seq === 0) return [0, Math.min(n, head)];
  const from = head + (seq - 1) * bodyPixels(bpp);
  return [Math.min(n, from), Math.min(n, from + bodyPixels(bpp))];
}

function checkSpriteShape(side: number, bpp: number): void {
  if (!Number.isInteger(side) || side < MIN_SPRITE_SIDE || side > MAX_SPRITE_SIDE) throw new Error(`sprite side out of range: ${side}`);
  if (!Number.isInteger(bpp) || bpp < 1 || bpp > 4) throw new Error(`sprite bits per pixel out of range: ${bpp}`);
}

/**
 * Sprite -> the data bits of each frame (the head first; 39 or 45 bits each, as 0/1
 * bytes). Throws when the shape or a value is out of range, or over MAX_SPRITE_FRAMES.
 */
export function encodeSprite(sprite: Sprite): Uint8Array[] {
  const { side, bpp } = sprite;
  checkSpriteShape(side, bpp);
  if (sprite.pixels.length !== side * side) throw new Error('sprite pixel count does not match its side');
  const colours = colourCount(bpp);
  if (sprite.pixels.some((v) => v >= colours)) throw new Error(`sprite pixel value out of range for ${colours} colours`);
  if (bpp < 4) {
    if (!sprite.palette || sprite.palette.length !== colours) throw new Error(`a ${colours}-colour sprite needs ${colours} palette entries`);
    if (sprite.palette.some((v) => v > 15)) throw new Error('sprite palette entry out of range');
  }
  const count = spriteFrameCount(side, bpp);
  if (count > MAX_SPRITE_FRAMES) throw new Error(`a ${side}x${side} sprite of ${colours} colours takes ${count} frames, over ${MAX_SPRITE_FRAMES}`);
  const order = pixelOrder(side);
  const frames: Uint8Array[] = [];
  for (let seq = 0; seq < count; seq++) {
    const bits = new Uint8Array(seq === 0 ? SPRITE_HEAD_BITS : SPRITE_BODY_BITS);
    let pos = 0;
    const put = (value: number, width: number): void => {
      for (let b = width - 1; b >= 0; b--) bits[pos++] = (value >> b) & 1;
    };
    if (seq === 0 && bpp < 4) for (const entry of sprite.palette!) put(entry, PALETTE_ENTRY_BITS);
    const [from, to] = frameRange(seq, side, bpp);
    for (let i = from; i < to; i++) put(sprite.pixels[order[i]!]!, bpp);
    frames.push(bits);
  }
  return frames;
}

/**
 * The pieces of one sprite as they arrive, in any order and with holes. `accept` takes a
 * frame's data bits; frames of another shape belong to another message, which the caller
 * checks with `matches` first.
 */
export class SpriteAssembly implements SpriteView {
  readonly pixels: Uint8Array;
  readonly known: Uint8Array;
  /** Frames the whole sprite takes. */
  readonly frames: number;
  /** Bit i set = frame i arrived (0 = head). */
  framesMask = 0;
  private paletteData: Uint8Array | null;
  private readonly held: (Uint8Array | undefined)[];
  private readonly order: Uint16Array;

  constructor(readonly side: number, readonly bpp: number) {
    checkSpriteShape(side, bpp);
    this.pixels = new Uint8Array(side * side);
    this.known = new Uint8Array(side * side);
    this.frames = spriteFrameCount(side, bpp);
    this.held = new Array(this.frames).fill(undefined);
    this.order = pixelOrder(side);
    this.paletteData = null;
  }

  matches(side: number, bpp: number): boolean {
    return side === this.side && bpp === this.bpp;
  }

  get complete(): boolean {
    return this.framesMask === (1 << this.frames) - 1;
  }

  get framesGot(): number {
    let n = 0;
    for (let m = this.framesMask; m; m &= m - 1) n++;
    return n;
  }

  /** The palette is known once the head arrived, or always with 4 bpp (the fixed palette). */
  get paletteKnown(): boolean {
    return this.bpp === 4 || this.paletteData !== null;
  }

  get palette(): Uint8Array | null {
    return this.bpp === 4 ? null : this.paletteData;
  }

  /** True when frame `seq` was heard with other data than `data`: the sender reused the message id for a new sprite. */
  conflicts(seq: number, data: Uint8Array): boolean {
    const have = this.held[seq];
    return have !== undefined && have.some((b, i) => b !== data[i]);
  }

  /** Take one frame. 'invalid' for a `seq` past the sprite's last frame or data of the wrong size (dropped). */
  accept(seq: number, data: Uint8Array): 'added' | 'duplicate' | 'invalid' {
    if (seq < 0 || seq >= this.frames || data.length !== (seq === 0 ? SPRITE_HEAD_BITS : SPRITE_BODY_BITS)) return 'invalid';
    if (this.held[seq]) return 'duplicate';
    this.held[seq] = data.slice();
    this.framesMask |= 1 << seq;
    let pos = 0;
    const get = (width: number): number => {
      let v = 0;
      for (let b = 0; b < width; b++) v = (v << 1) | data[pos++]!;
      return v;
    };
    if (seq === 0 && this.bpp < 4) {
      const palette = new Uint8Array(colourCount(this.bpp));
      for (let i = 0; i < palette.length; i++) palette[i] = get(PALETTE_ENTRY_BITS);
      this.paletteData = palette;
    }
    const [from, to] = frameRange(seq, this.side, this.bpp);
    for (let i = from; i < to; i++) {
      const p = this.order[i]!;
      this.pixels[p] = get(this.bpp);
      this.known[p] = 1;
    }
    return 'added';
  }

  /** A copy that later frames do not change, for events and storage. */
  snapshot(): SpriteView {
    return {
      side: this.side, bpp: this.bpp, palette: this.palette?.slice() ?? null, paletteKnown: this.paletteKnown,
      pixels: this.pixels.slice(), known: this.known.slice(),
    };
  }
}

/** A finished sprite as a view: everything known. */
export function viewOf(sprite: Sprite): SpriteView {
  return { side: sprite.side, bpp: sprite.bpp, palette: sprite.palette, paletteKnown: true, pixels: sprite.pixels, known: new Uint8Array(sprite.pixels.length).fill(1) };
}

/**
 * Every unknown pixel takes the value of the nearest known one (ties: the lower index).
 * For display only: it never goes back into the assembly. With nothing known, zeros.
 */
export function fillHoles(view: Pick<SpriteView, 'side' | 'pixels' | 'known'>): Uint8Array {
  const { side, pixels, known } = view;
  const out = pixels.slice();
  const knownAt: number[] = [];
  for (let p = 0; p < known.length; p++) if (known[p]) knownAt.push(p);
  for (let p = 0; p < known.length; p++) {
    if (known[p]) continue;
    if (knownAt.length === 0) {
      out[p] = 0;
      continue;
    }
    const x = p % side;
    const y = Math.floor(p / side);
    let best = knownAt[0]!;
    let bestD = Infinity;
    for (const q of knownAt) {
      const d = (q % side - x) ** 2 + (Math.floor(q / side) - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    out[p] = pixels[best]!;
  }
  return out;
}

/**
 * CSS colour per pixel, row by row. `null` = nothing to show there (a hole, with
 * holes = 'checker'; the caller draws its own marker). With holes = 'fill' holes take the
 * nearest known pixel's colour. A palette that has not arrived (head lost) shows the
 * indices as a grey ramp.
 */
export function spriteColours(view: SpriteView, holes: 'checker' | 'fill'): (string | null)[] {
  const values = holes === 'fill' ? fillHoles(view) : view.pixels;
  const levels = colourCount(view.bpp);
  return Array.from(values, (v, p) => {
    if (holes === 'checker' && !view.known[p]) return null;
    if (view.bpp === 4) return SPRITE_PALETTE[v]!;
    if (view.paletteKnown && view.palette) return SPRITE_PALETTE[view.palette[v]!]!;
    const g = Math.round(60 + 150 * (v / (levels - 1)));
    return `rgb(${g},${g},${g})`;
  });
}

/** Perceptual-ish distance between two fixed-palette colours. */
function colourDistance(a: number, b: number): number {
  const [r1, g1, b1] = PALETTE_RGB[a]!;
  const [r2, g2, b2] = PALETTE_RGB[b]!;
  return 2 * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + 3 * (b1 - b2) ** 2;
}

/**
 * Fixed-palette indices (0..15, e.g. from an editor) -> a sprite of `bpp` bits: the most
 * used colours are kept (up to 2^bpp), every other pixel takes the nearest kept one.
 * 4 bpp keeps the picture as it is.
 */
export function quantize(colours: ArrayLike<number>, side: number, bpp: number): Sprite {
  checkSpriteShape(side, bpp);
  if (bpp === 4) return { side, bpp, palette: null, pixels: Uint8Array.from(colours) };
  const count = new Array<number>(16).fill(0);
  for (let i = 0; i < colours.length; i++) count[colours[i]!]!++;
  const kept = [...Array(16).keys()].filter((c) => count[c]! > 0).sort((a, b) => count[b]! - count[a]! || a - b).slice(0, colourCount(bpp));
  const palette = new Uint8Array(colourCount(bpp));
  palette.set(kept);
  const pixels = Uint8Array.from(colours, (c) => {
    let best = 0;
    let bestD = Infinity;
    kept.forEach((k, i) => {
      const d = colourDistance(c, k);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  });
  return { side, bpp, palette, pixels };
}

/** A sprite's pixels as fixed-palette indices, whatever its depth (for loading into an editor). */
export function fixedIndices(sprite: Sprite): Uint8Array {
  return sprite.palette ? Uint8Array.from(sprite.pixels, (v) => sprite.palette![v]!) : sprite.pixels.slice();
}

// --- storage form -----------------------------------------------------------------

/** One hex digit per pixel, `.` for a pixel that never arrived. */
export function pixelsToString(view: Pick<SpriteView, 'pixels' | 'known'>): string {
  return Array.from(view.pixels, (v, p) => (view.known[p] ? v.toString(16) : '.')).join('');
}

/** Read back from storage, so nothing about it can be trusted: null when it does not fit. */
export function viewFromStrings(side: unknown, bpp: unknown, palette: unknown, pixels: unknown): SpriteView | null {
  if (typeof side !== 'number' || typeof bpp !== 'number') return null;
  try {
    checkSpriteShape(side, bpp);
  } catch {
    return null;
  }
  if (typeof pixels !== 'string' || pixels.length !== side * side || !/^[0-9a-f.]+$/.test(pixels)) return null;
  let paletteData: Uint8Array | null = null;
  if (typeof palette === 'string') {
    if (palette.length !== colourCount(bpp) || bpp === 4 || !/^[0-9a-f]+$/.test(palette)) return null;
    paletteData = Uint8Array.from(palette, (c) => parseInt(c, 16));
  }
  const values = new Uint8Array(pixels.length);
  const known = new Uint8Array(pixels.length);
  for (let p = 0; p < pixels.length; p++) {
    if (pixels[p] === '.') continue;
    const v = parseInt(pixels[p]!, 16);
    if (v >= colourCount(bpp)) return null;
    values[p] = v;
    known[p] = 1;
  }
  return { side, bpp, palette: paletteData, paletteKnown: bpp === 4 || paletteData !== null, pixels: values, known };
}

/** A palette as one hex digit per entry, for storage. */
export const paletteToString = (palette: Uint8Array | null): string | undefined => (palette ? Array.from(palette, (v) => v.toString(16)).join('') : undefined);
