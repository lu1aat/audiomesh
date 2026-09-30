import { describe, expect, it } from 'vitest';
import { LqaTable } from '../src/ale/lqa';
import { describeFrame, frameFields } from '../src/chat/describe';
import { BROADCAST, decodeFrame, encodeFrame, frameKey, viaOf, withVia } from '../src/chat/frames';
import { Repeater } from '../src/chat/repeater';
import { ChatSession, type InMessage } from '../src/chat/session';
import {
  MAX_SPRITE_FRAMES,
  SPRITE_BODY_BITS,
  SPRITE_HEAD_BITS,
  SpriteAssembly,
  bayer,
  bodyPixels,
  encodeSprite,
  fillHoles,
  fixedIndices,
  headPixels,
  pixelOrder,
  pixelsToString,
  quantize,
  spriteColours,
  spriteFits,
  spriteFrameCount,
  viewFromStrings,
  viewOf,
  type Sprite,
} from '../src/chat/sprite';
import { SPRITE_GALLERY, parseRows, toRows } from '../src/chat/sprite-gallery';
import { rng } from './helpers';

/** A sprite of random fixed-palette colours, quantized to `bpp`. */
function randomSprite(side: number, bpp: number, seed: number): Sprite {
  const random = rng(seed);
  const colours = Array.from({ length: side * side }, () => Math.floor(random() * 16));
  return quantize(colours, side, bpp);
}

/** Feed an assembly the frames of `sprite` whose index passes `keep`. */
function assemble(sprite: Sprite, keep: (seq: number) => boolean): SpriteAssembly {
  const frames = encodeSprite(sprite);
  const a = new SpriteAssembly(sprite.side, sprite.bpp);
  frames.forEach((data, seq) => {
    if (keep(seq)) expect(a.accept(seq, data)).toBe('added');
  });
  return a;
}

describe('sprite frame budget', () => {
  it('matches the frame counts of the design table', () => {
    const table: Record<number, number[]> = {
      // side: frames for 1, 2, 3, 4 bits per pixel (2, 4, 8, 16 colours)
      4: [1, 2, 2, 2], 5: [1, 2, 3, 3], 6: [2, 3, 4, 4], 7: [2, 3, 5, 5], 8: [2, 4, 6, 6],
      10: [3, 6, 8, 10], 12: [4, 8, 11, 14], 13: [5, 9, 13, 16], 16: [6, 13, 18, 24],
    };
    for (const [side, counts] of Object.entries(table)) {
      counts.forEach((n, i) => expect(spriteFrameCount(Number(side), i + 1), `${side}x${side} at ${i + 1} bpp`).toBe(n));
    }
  });

  it('has the pixels-per-frame numbers of the design', () => {
    expect([1, 2, 3, 4].map(headPixels)).toEqual([31, 11, 2, 9]);
    expect([1, 2, 3, 4].map(bodyPixels)).toEqual([45, 22, 15, 11]);
  });

  it('cannot send what takes over 16 frames', () => {
    expect(spriteFits(13, 4)).toBe(true);
    expect(spriteFits(14, 4)).toBe(false);
    expect(spriteFits(16, 3)).toBe(false);
    expect(spriteFits(16, 2)).toBe(true);
    expect(() => encodeSprite(randomSprite(16, 4, 1))).toThrow(/over 16/);
  });
});

describe('pixel order', () => {
  it('is a permutation for every side, and fixed', () => {
    for (let side = 1; side <= 16; side++) {
      const order = pixelOrder(side);
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: side * side }, (_, i) => i));
      expect(pixelOrder(side)).toBe(order);
    }
  });

  it('is the 16x16 Bayer matrix', () => {
    expect(bayer(0, 0)).toBe(0);
    expect(new Set(Array.from({ length: 256 }, (_, p) => bayer(p % 16, Math.floor(p / 16)))).size).toBe(256);
    // The first four of a 16x16 sprite sit in different quadrants of the picture.
    const quadrant = (p: number): number => (p % 16 < 8 ? 0 : 1) + (Math.floor(p / 16) < 8 ? 0 : 2);
    expect(new Set([...pixelOrder(16)].slice(0, 4).map(quadrant)).size).toBe(4);
  });

  it('spreads the first pixels over the picture instead of running along a row', () => {
    for (let side = 4; side <= 16; side++) {
      const half = side / 2;
      const quadrant = (p: number): number => (p % side < half ? 0 : 1) + (Math.floor(p / side) < half ? 0 : 2);
      const first = [...pixelOrder(side)].slice(0, 9);
      expect(new Set(first.map(quadrant)).size, `${side}x${side}`).toBe(4);
    }
  });
});

describe('sprite encoding', () => {
  it('round-trips every side and every depth that fits in 16 frames', () => {
    for (let side = 1; side <= 16; side++) {
      for (let bpp = 1; bpp <= 4; bpp++) {
        if (!spriteFits(side, bpp)) continue;
        const sprite = randomSprite(side, bpp, side * 10 + bpp);
        const frames = encodeSprite(sprite);
        expect(frames).toHaveLength(spriteFrameCount(side, bpp));
        expect(frames.length).toBeLessThanOrEqual(MAX_SPRITE_FRAMES);
        frames.forEach((f, i) => expect(f).toHaveLength(i === 0 ? SPRITE_HEAD_BITS : SPRITE_BODY_BITS));
        const a = assemble(sprite, () => true);
        expect(a.complete).toBe(true);
        expect([...a.pixels]).toEqual([...sprite.pixels]);
        expect([...a.known].every((k) => k === 1)).toBe(true);
        expect(a.paletteKnown).toBe(true);
        expect(a.palette && [...a.palette]).toEqual(sprite.palette && [...sprite.palette]);
      }
    }
  });

  it('leaves the bits after the last pixel of a frame zero', () => {
    const sprite = randomSprite(5, 2, 4); // 2 bpp: head 16 + 11*2 = 38 of 39 bits used
    const frames = encodeSprite(sprite);
    expect(frames[0]![38]).toBe(0);
    for (const bits of frames.slice(1)) {
      const used = bits.lastIndexOf(1);
      expect(used).toBeLessThan(bits.length);
    }
    const last = frames[frames.length - 1]!;
    expect([...last.slice(2 * (25 - 11 - 22 * (frames.length - 2)))].every((b) => b === 0)).toBe(true);
  });

  it('gives every subset of frames exactly the pixels of the frames received', () => {
    const shapes: [number, number][] = [[4, 2], [5, 3], [6, 4], [7, 1], [8, 4], [10, 2]];
    for (const [side, bpp] of shapes) {
      const sprite = randomSprite(side, bpp, side + bpp);
      const count = spriteFrameCount(side, bpp);
      const random = rng(99);
      // Every subset for up to ~10 frames; random samples beyond that.
      const masks = count <= 10 ? Array.from({ length: 1 << count }, (_, m) => m) : Array.from({ length: 300 }, () => Math.floor(random() * (1 << count)));
      const order = pixelOrder(side);
      for (const mask of masks) {
        const a = assemble(sprite, (seq) => (mask >> seq & 1) === 1);
        const expectedKnown = new Uint8Array(side * side);
        const head = headPixels(bpp);
        const body = bodyPixels(bpp);
        for (let i = 0; i < side * side; i++) {
          const seq = i < head ? 0 : 1 + Math.floor((i - head) / body);
          if ((mask >> seq) & 1) expectedKnown[order[i]!] = 1;
        }
        expect([...a.known], `${side}x${side} ${bpp} bpp mask ${mask}`).toEqual([...expectedKnown]);
        for (let p = 0; p < side * side; p++) if (a.known[p]) expect(a.pixels[p]).toBe(sprite.pixels[p]);
        expect(a.paletteKnown).toBe(bpp === 4 || (mask & 1) === 1);
      }
    }
  });

  it('places the pixels of a body frame when the head is lost; only the palette is missing', () => {
    const sprite = randomSprite(8, 3, 5);
    const a = assemble(sprite, (seq) => seq !== 0);
    expect(a.paletteKnown).toBe(false);
    expect(a.palette).toBeNull();
    const head = headPixels(3);
    const order = pixelOrder(8);
    for (let i = 0; i < 64; i++) expect(a.known[order[i]!]).toBe(i < head ? 0 : 1);
    // Without the palette the indices show as a grey ramp, never as a wrong colour.
    const colours = spriteColours(a, 'checker');
    const known = colours.filter((c): c is string => c !== null);
    expect(known.length).toBe(64 - head);
    expect(known.every((c) => c.startsWith('rgb('))).toBe(true);
    // A 16-colour sprite needs no palette: it decodes fully without its head.
    const full = randomSprite(6, 4, 6);
    const b = assemble(full, (seq) => seq !== 0);
    expect(b.paletteKnown).toBe(true);
    expect(spriteColours(b, 'checker').filter((c) => c !== null).length).toBe(36 - headPixels(4));
  });

  it('refuses frames past the last, wrong sizes, and tells a reused message id from a repeat', () => {
    const sprite = randomSprite(5, 2, 7);
    const frames = encodeSprite(sprite);
    const a = new SpriteAssembly(5, 2);
    expect(a.accept(frames.length, frames[1]!)).toBe('invalid');
    expect(a.accept(0, frames[1]!)).toBe('invalid');
    expect(a.accept(0, frames[0]!)).toBe('added');
    expect(a.accept(0, frames[0]!)).toBe('duplicate');
    expect(a.conflicts(0, frames[0]!)).toBe(false);
    const other = frames[0]!.slice();
    other[20] ^= 1;
    expect(a.conflicts(0, other)).toBe(true);
    expect(a.matches(5, 2)).toBe(true);
    expect(a.matches(5, 3)).toBe(false);
  });
});

describe('filling holes', () => {
  it('gives an unknown pixel the value of the nearest known one, and leaves known ones alone', () => {
    const view = { side: 3, pixels: Uint8Array.from([5, 0, 0, 0, 0, 0, 0, 0, 9]), known: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 1]) };
    const out = fillHoles(view);
    expect(out[0]).toBe(5);
    expect(out[8]).toBe(9);
    expect(out[1]).toBe(5); // nearer the top-left one
    expect(out[7]).toBe(9);
    expect(out[4]).toBe(5); // a tie: the lower index
    expect([...view.pixels]).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 9]); // the input is untouched
  });

  it('shows a picture from the first frames alone, and nothing invented when no pixel is known', () => {
    const sprite = randomSprite(8, 4, 8);
    const head = assemble(sprite, (seq) => seq === 0);
    expect(spriteColours(head, 'fill').every((c) => c !== null)).toBe(true);
    expect(spriteColours(head, 'checker').filter((c) => c === null)).toHaveLength(64 - headPixels(4));
    const none = new SpriteAssembly(4, 4);
    expect(spriteColours(none, 'fill').every((c) => c !== null)).toBe(true);
    expect(spriteColours(none, 'checker').every((c) => c === null)).toBe(true);
  });
});

describe('quantize and storage form', () => {
  it('keeps the most used colours and maps the rest to the nearest', () => {
    // 8 x colour 8 (red), 7 x colour 10 (yellow), 1 x colour 9 (orange): with 2 colours orange joins red or yellow.
    const px = [...Array(8).fill(8), ...Array(7).fill(10), 9];
    const q = quantize(px, 4, 1);
    expect([...q.palette!].slice(0, 2)).toEqual([8, 10]);
    expect(q.pixels[15]).toBe(1); // orange (#ffa300) is closer to yellow (#ffec27) than to red (#ff004d)
    expect([...fixedIndices(q)].slice(0, 8)).toEqual(Array(8).fill(8));
    const same = quantize(px, 4, 4);
    expect(same.palette).toBeNull();
    expect([...same.pixels]).toEqual(px);
  });

  it('round-trips through the stored strings and rejects damaged ones', () => {
    const sprite = randomSprite(6, 3, 9);
    const a = assemble(sprite, (seq) => seq !== 2);
    const text = pixelsToString(a);
    expect(text).toHaveLength(36);
    expect(text).toContain('.');
    const back = viewFromStrings(6, 3, [...a.palette!].map((v) => v.toString(16)).join(''), text)!;
    expect([...back.known]).toEqual([...a.known]);
    expect(back.paletteKnown).toBe(true);
    expect(viewFromStrings(6, 3, undefined, text)!.paletteKnown).toBe(false);
    expect(viewFromStrings(17, 3, undefined, text)).toBeNull();
    expect(viewFromStrings(6, 3, undefined, text.slice(1))).toBeNull();
    expect(viewFromStrings(6, 3, undefined, 'z'.repeat(36))).toBeNull();
    expect(viewFromStrings(6, 1, undefined, '7'.repeat(36))).toBeNull(); // a value past 2^bpp
    expect(viewFromStrings(6, 4, '0123', text)).toBeNull(); // a 16-colour sprite has no palette
  });
});

describe('gallery', () => {
  it('has only sprites that parse to their size, in palette colours', () => {
    for (const group of SPRITE_GALLERY) {
      expect(group.sprites.length).toBeGreaterThan(0);
      for (const s of group.sprites) {
        const px = parseRows(s.rows, group.side);
        expect(px).toHaveLength(group.side * group.side);
        expect(px.every((v) => v >= 0 && v < 16)).toBe(true);
        expect(s.rows.every((r) => r.length <= group.side)).toBe(true);
        expect(s.rows.length).toBeLessThanOrEqual(group.side);
      }
    }
  });

  it('round-trips rows and centres a smaller drawing', () => {
    const px = parseRows(['88', '88'], 4);
    expect(toRows(px, 4)).toEqual(['....', '.88.', '.88.', '....']);
  });
});

describe('sprite frames on the wire', () => {
  const head = (over: object = {}) => ({
    kind: 'spriteHead' as const, src: 101, msgId: 9, dst: 202, side: 8, bpp: 3, data: Uint8Array.from({ length: 39 }, (_, i) => (i * 7) % 3 === 0 ? 1 : 0), ...over,
  });

  it('encodes and decodes head and body, limit values included', () => {
    const h = head();
    expect(decodeFrame(encodeFrame(h))).toEqual(h);
    const body = { kind: 'spriteBody' as const, src: 1023, msgId: 15, seq: 15, side: 16, bpp: 4, data: new Uint8Array(45).fill(1) };
    expect(decodeFrame(encodeFrame(body))).toEqual(body);
    const small = { kind: 'spriteBody' as const, src: 1, msgId: 0, seq: 1, side: 1, bpp: 1, data: new Uint8Array(45) };
    expect(decodeFrame(encodeFrame(small))).toEqual(small);
    expect(decodeFrame(encodeFrame(head({ dst: BROADCAST, side: 1, bpp: 1 })))).toMatchObject({ dst: 0, side: 1, bpp: 1 });
  });

  it('never makes the all-zero payload, and pads short data with zeros', () => {
    const bits = encodeFrame(head({ data: new Uint8Array(4) }));
    expect(bits.some((b) => b === 1)).toBe(true);
    expect(decodeFrame(bits)).toMatchObject({ kind: 'spriteHead' });
  });

  it('rejects values out of range and a body with seq 0', () => {
    expect(() => encodeFrame(head({ side: 17 }))).toThrow();
    expect(() => encodeFrame(head({ side: 0 }))).toThrow();
    expect(() => encodeFrame(head({ bpp: 5 }))).toThrow();
    expect(() => encodeFrame(head({ msgId: 16 }))).toThrow();
    expect(() => encodeFrame(head({ data: new Uint8Array(40) }))).toThrow();
    const body = { kind: 'spriteBody' as const, src: 1, msgId: 0, seq: 0, side: 4, bpp: 4, data: new Uint8Array(45) };
    expect(() => encodeFrame(body)).toThrow();
    expect(() => encodeFrame({ ...body, seq: 16 })).toThrow();
    const raw = encodeFrame({ ...body, seq: 1 });
    raw.fill(0, 27, 31); // seq bits (after kind 2, src 10, subtype 3, msgId 4 = bit 19..22 hold seq)
    for (let i = 19; i < 23; i++) raw[i] = 0;
    expect(decodeFrame(raw)).toBeNull();
  });

  it('carries the via tag in the last three bits and keeps the key without it', () => {
    const bits = encodeFrame(head());
    const rep = withVia(bits, 5);
    expect(viaOf(rep)).toBe(5);
    expect(frameKey(rep)).toBe(frameKey(bits));
    expect(decodeFrame(rep)).toEqual({ ...head(), via: 5 });
    // The data's last bit (bit 73) is data, not the repeater flag of hello and sound.
    const busy = encodeFrame(head({ data: new Uint8Array(39).fill(1) }));
    expect(decodeFrame(busy)).not.toHaveProperty('repeater');
  });

  it('is described in the frame log', () => {
    const name = (id: number): string => `S${id}`;
    const bits = encodeFrame(head());
    expect(describeFrame(bits, name)).toBe('S101 → S202 · msg 9 sprite 8×8, 8 colours · frame 1/6');
    const body = encodeFrame({ kind: 'spriteBody', src: 101, msgId: 9, seq: 2, side: 8, bpp: 3, data: new Uint8Array(45) });
    expect(describeFrame(body, name)).toBe('S101 · msg 9 sprite 8×8 · frame 3/6');
    expect(frameFields(bits, name)).toMatchObject({ type: 'spriteHead', src: 101, dst: 202, msgId: 9 });
    expect(frameFields(body, name)).toMatchObject({ type: 'spriteBody', src: 101, msgId: 9 });
  });
});

// --- session ---------------------------------------------------------------------

/** Two stations on one channel: like tests/chat-session.test.ts. `lose` decides which transmissions vanish. */
function run(stations: ChatSession[], slots: number, lose: (slot: number, from: number, n: number) => boolean = () => false, startSlot = 0): void {
  const counters = new Map<number, number>();
  for (let slot = startSlot; slot < startSlot + slots; slot++) {
    const sent = stations.map((s) => s.nextTx(slot));
    stations.forEach((rx, i) => {
      if (sent[i]) return;
      stations.forEach((_tx, j) => {
        const payload = sent[j];
        if (!payload || i === j) return;
        const n = (counters.get(j) ?? 0) + 1;
        counters.set(j, n);
        if (!lose(slot, j, n)) rx.receive(payload, slot, -10);
      });
    });
  }
}

function pair(): { a: ChatSession; b: ChatSession; heard: InMessage[]; progress: InMessage[] } {
  const a = new ChatSession({ stationId: 11 });
  const b = new ChatSession({ stationId: 22 });
  const heard: InMessage[] = [];
  const progress: InMessage[] = [];
  b.events.incoming = (m) => heard.push(m);
  b.events.spriteProgress = (m) => progress.push(m);
  return { a, b, heard, progress };
}

describe('sprite in a session', () => {
  const sprite = randomSprite(8, 3, 21); // 6 frames

  it('delivers a directed sprite, shows progress frame by frame, and gets the ack', () => {
    const { a, b, heard, progress } = pair();
    const m = a.sendSprite(22, sprite);
    expect(m.frames).toBe(6);
    expect(m.content.kind).toBe('sprite');
    run([a, b], 30);
    expect(m.state).toBe('delivered');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ src: 11, dst: 22, frames: 6, framesGot: 6, partial: false, text: '' });
    expect([...heard[0]!.sprite!.pixels]).toEqual([...sprite.pixels]);
    expect(progress.map((p) => p.framesGot)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.slice(0, 5).every((p) => p.partial)).toBe(true);
    expect(progress[5]!.partial).toBe(false);
    // A snapshot: the early ones do not change when later frames arrive.
    expect(progress[0]!.sprite!.known.reduce((n, k) => n + k, 0)).toBe(headPixels(3));
    expect(new Set(progress.map((p) => p.uid)).size).toBe(1);
  });

  it('resends only the lost frame: ack bitmap turns a lost frame into a second round', () => {
    const { a, b, heard } = pair();
    const m = a.sendSprite(22, sprite);
    run([a, b], 60, (_slot, from, n) => from === 0 && n === 3); // a's third transmission is lost
    expect(m.state).toBe('delivered');
    expect(m.round).toBe(2);
    expect(m.framesSent).toBe(7);
    expect(heard).toHaveLength(1);
    expect([...heard[0]!.sprite!.pixels]).toEqual([...sprite.pixels]);
  });

  it('survives a lost head frame, then completes it in the next round', () => {
    const { a, b, heard, progress } = pair();
    const m = a.sendSprite(22, sprite);
    run([a, b], 60, (_slot, from, n) => from === 0 && n === 1);
    expect(m.state).toBe('delivered');
    // The first thing we saw came without the head: destination unknown, palette missing.
    expect(progress[0]).toMatchObject({ dst: null, framesGot: 1 });
    expect(progress[0]!.sprite!.paletteKnown).toBe(false);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.dst).toBe(22);
    expect(heard[0]!.sprite!.paletteKnown).toBe(true);
  });

  it('sends a broadcast once with no ack, and ends it as a partial when frames are lost', () => {
    const { a, b, heard, progress } = pair();
    const m = a.sendSprite(BROADCAST, sprite);
    run([a, b], 20, (_slot, from, n) => from === 0 && (n === 2 || n === 5));
    expect(m.state).toBe('sent');
    expect(m.framesSent).toBe(6);
    expect(heard).toHaveLength(0);
    expect(progress.at(-1)).toMatchObject({ framesGot: 4, partial: true, dst: 0 });
    // Nothing more arrives: after the reassembly time it ends as a partial, not as nothing.
    b.tick(20 + 61);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ partial: true, framesGot: 4, frames: 6, dst: 0 });
    const known = heard[0]!.sprite!.known.reduce((n, k) => n + k, 0);
    expect(known).toBeGreaterThan(0);
    expect(known).toBeLessThan(64);
    b.tick(20 + 200);
    expect(heard).toHaveLength(1);
  });

  it('does not emit a partial for a message that completed, nor keep one addressed to others', () => {
    const { a, b, heard } = pair();
    a.sendSprite(BROADCAST, sprite);
    run([a, b], 20);
    expect(heard).toHaveLength(1);
    b.tick(500);
    expect(heard).toHaveLength(1);
    const c = new ChatSession({ stationId: 33 });
    const seen: InMessage[] = [];
    c.events.incoming = (x) => seen.push(x);
    c.events.spriteProgress = (x) => seen.push(x);
    const d = new ChatSession({ stationId: 44 });
    d.sendSprite(99, sprite); // to somebody else
    run([d, c], 30);
    expect(seen).toHaveLength(0); // the head names 99: neither it nor the bodies after it are kept
    c.tick(500);
    expect(seen).toHaveLength(0);
  });

  it('shares message ids with chat and never mixes a sprite with text of the same id', () => {
    const { a, b, heard } = pair();
    a.send(22, 'HELLO THERE');
    a.sendSprite(22, sprite);
    a.send(22, 'AND ANOTHER ONE');
    run([a, b], 200);
    const texts = heard.filter((h) => !h.sprite).map((h) => h.text);
    expect(texts).toEqual(['HELLO THERE', 'AND ANOTHER ONE']);
    expect(heard.filter((h) => h.sprite)).toHaveLength(1);
    const ids = a.messages.map((x) => (x as unknown as { msgId: number }).msgId);
    expect(new Set(ids).size).toBe(3);
  });

  it('takes a reused message id for a new message: another sprite, or text over a sprite', () => {
    const b = new ChatSession({ stationId: 22 });
    const heard: InMessage[] = [];
    b.events.incoming = (m) => heard.push(m);
    const send = (s: Sprite, id: number, slot: number): void => {
      const frames = encodeSprite(s);
      frames.forEach((data, seq) => {
        const f = seq === 0
          ? { kind: 'spriteHead' as const, src: 11, msgId: id, dst: 22, side: s.side, bpp: s.bpp, data }
          : { kind: 'spriteBody' as const, src: 11, msgId: id, seq, side: s.side, bpp: s.bpp, data };
        b.receive(encodeFrame(f), slot + seq * 3, -10);
      });
    };
    send(sprite, 4, 0);
    const other = randomSprite(8, 3, 22);
    send(other, 4, 40); // same id, same shape, other pixels
    expect(heard).toHaveLength(2);
    expect([...heard[1]!.sprite!.pixels]).toEqual([...other.pixels]);
    expect(heard[1]!.uid).not.toBe(heard[0]!.uid);
    // Text with that id: a new message, not a sprite gone wrong.
    b.receive(encodeFrame({ kind: 'first', src: 11, msgId: 4, last: 0, dst: 22, text: 'HI' }), 80, -10);
    expect(heard).toHaveLength(3);
    expect(heard[2]).toMatchObject({ text: 'HI', partial: false });
    expect(heard[2]!.sprite).toBeUndefined();
  });

  it('drops frames past the last or of a sprite that cannot exist', () => {
    const b = new ChatSession({ stationId: 22 });
    const seen: InMessage[] = [];
    b.events.spriteProgress = (m) => seen.push(m);
    b.receive(encodeFrame({ kind: 'spriteBody', src: 11, msgId: 0, seq: 3, side: 4, bpp: 4, data: new Uint8Array(45) }), 0, -10); // 4x4 at 4 bpp is 2 frames
    b.receive(encodeFrame({ kind: 'spriteBody', src: 11, msgId: 1, seq: 2, side: 16, bpp: 4, data: new Uint8Array(45) }), 0, -10); // 24 frames: unsendable
    expect(seen).toHaveLength(0);
    b.receive(encodeFrame({ kind: 'spriteBody', src: 11, msgId: 2, seq: 1, side: 4, bpp: 4, data: new Uint8Array(45).fill(1) }), 0, -10);
    expect(seen).toHaveLength(1);
  });

  it('retries a failed sprite from its first frame, and counts sprite frames in the outlook', () => {
    const { a, b } = pair();
    const m = a.sendSprite(22, sprite);
    expect(a.outlook().queued).toBe(1);
    run([a, b], 400, (_s, from) => from === 1); // no ack ever comes back
    expect(m.state).toBe('failed');
    a.retry(m);
    expect(m.state).toBe('queued');
    a.nextTx(1000);
    expect(a.outlook().sending).toEqual({ dst: 22, left: 5, total: 6, sprite: true });
    const first = decodeFrame(a.nextTx(1001)!);
    expect(first).toMatchObject({ kind: 'spriteBody', seq: 1 });
  });

  it('resends the ack by hand for a sprite like for text', () => {
    const { a, b, heard } = pair();
    const m = a.sendSprite(22, sprite);
    run([a, b], 300, (_slot, from) => from === 1);
    expect(m.state).toBe('failed');
    b.resendAck(11, heard[0]!.msgId, heard[0]!.frames);
    const ack = b.nextTx(300);
    expect(decodeFrame(ack!)).toMatchObject({ kind: 'ack', received: (1 << 6) - 1 });
    a.receive(ack!, 300, -10);
    expect(m.state).toBe('delivered');
  });
});

describe('sprite through a repeater', () => {
  it('queues sprite frames like message frames, never those addressed to the repeater', () => {
    const r = new Repeater(50);
    const s = randomSprite(6, 4, 30);
    const frames = encodeSprite(s);
    const wire = (seq: number, dst: number): Uint8Array => encodeFrame(seq === 0
      ? { kind: 'spriteHead', src: 1, msgId: 3, dst, side: 6, bpp: 4, data: frames[0]! }
      : { kind: 'spriteBody', src: 1, msgId: 3, seq, side: 6, bpp: 4, data: frames[seq]! });
    r.offer(wire(0, 2), 0);
    r.offer(wire(1, 2), 3);
    expect(r.pending).toBe(2);
    expect(r.next(2)!.dst).toBe(2);
    expect(r.next(5)!.dst).toBe(2); // the body found its message's destination from the head
    const r2 = new Repeater(50);
    r2.offer(wire(0, 50), 0);
    r2.offer(wire(1, 50), 3);
    expect(r2.pending).toBe(0);
  });

  it('carries a directed sprite and its ack between stations that cannot hear each other', () => {
    const a = new ChatSession({ stationId: 101 });
    const rep = new ChatSession({ stationId: 202 });
    const c = new ChatSession({ stationId: 303, lqa: new LqaTable() });
    const heard: InMessage[] = [];
    c.events.incoming = (m) => heard.push(m);
    rep.setRepeater(true);
    const stations = [a, rep, c];
    const hears = (i: number, j: number): boolean => Math.abs(i - j) === 1;
    const sent: (Uint8Array | null)[][] = [];
    const go = (from: number, to: number): void => {
      for (let t = from; t < to; t++) {
        const old = sent[t - 2];
        if (old) {
          stations.forEach((rx, i) => {
            if (old[i]) return;
            old.forEach((p, j) => { if (p && i !== j && hears(i, j)) rx.receive(p, t - 2, -10, 5); });
          });
        }
        sent[t] = stations.map((s) => s.nextTx(t));
      }
    };
    go(0, 4);
    const sprite = randomSprite(7, 3, 40); // 5 frames
    const m = a.sendSprite(303, sprite);
    go(4, 120);
    expect(m.state).toBe('delivered');
    expect(heard).toHaveLength(1);
    expect(heard[0]!.via).toEqual({ tag: expect.any(Number), repeater: 202 });
    expect([...heard[0]!.sprite!.pixels]).toEqual([...sprite.pixels]);
    expect(m.echoedFrames).toBe(m.frames);
  });
});

describe('viewOf', () => {
  it('marks every pixel of a finished sprite known', () => {
    const s = randomSprite(3, 2, 50);
    const v = viewOf(s);
    expect(v.known.every((k) => k === 1)).toBe(true);
    expect(v.paletteKnown).toBe(true);
  });
});
