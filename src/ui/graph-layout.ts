/**
 * Where the network graph puts its stations: the stronger the signal between two
 * stations, the closer they sit. Pure and deterministic (same input, same picture),
 * so a redraw does not reshuffle the graph.
 */

import { snrLevel } from '../ale/link-model';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface LayoutLink {
  readonly a: number;
  readonly b: number;
  /** Best known SNR between the pair, either direction; undefined = linked, strength unknown (a relay). */
  readonly snrDb?: number;
}

export interface LayoutBox {
  /** Square viewBox side. */
  readonly size: number;
  /** Keep node centres this far from the edge (node radius plus its label). */
  readonly margin: number;
  /** Strongest link length; the weakest is `maxDist`. */
  readonly minDist: number;
  readonly maxDist: number;
  /** No two nodes closer than this. */
  readonly minSep: number;
  /** A node keeps at least this far from a link it is not an end of. */
  readonly clearance: number;
  /** Where the pinned node sits; default the middle of the box. */
  readonly anchor?: { readonly x: number; readonly y: number };
}

/** Target length of a link: strong = `minDist`, at the decoder floor or unknown = `maxDist`. */
export function linkLength(snrDb: number | undefined, box: LayoutBox): number {
  const t = snrDb === undefined ? 0 : snrLevel(snrDb);
  return box.maxDist - t * (box.maxDist - box.minDist);
}

/**
 * Spring layout. `centre` (us) is pinned at `box.anchor`; the rest start around it in
 * `nodes` order, golden-angle apart (never exactly opposite: a straight line of three
 * would never bend), or, when the anchor is off the middle, in a symmetrical fan facing
 * the middle (straight in first, then alternating right and left). Links pull or push to their target lengths, every pair keeps
 * `minSep` and nodes stay `clearance` off links they are not part of, so a line never
 * runs under a node. Stations with no link at all settle `maxDist` from the anchor.
 */
export function layoutGraph(
  nodes: readonly number[],
  links: readonly LayoutLink[],
  centre: number | null,
  box: LayoutBox,
  iterations = 300,
): Map<number, { x: number; y: number }> {
  const C = box.size / 2;
  const ax = box.anchor?.x ?? C, ay = box.anchor?.y ?? C;
  const inward = Math.hypot(C - ax, C - ay) > 1 ? Math.atan2(C - ay, C - ax) : null;
  const n = nodes.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  const index = new Map(nodes.map((id, i) => [id, i]));
  const pinned = centre !== null && index.has(centre) ? index.get(centre)! : -1;
  const ring = nodes.length - (pinned >= 0 ? 1 : 0);
  let k = 0;
  nodes.forEach((_, i) => {
    if (i === pinned) {
      xs[i] = ax;
      ys[i] = ay;
      return;
    }
    // Off-middle anchor: a fan facing inwards, symmetrical: straight in, then right, left, further right...
    const step = (0.8 * Math.PI) / Math.max(2, ring);
    const a = inward === null ? -Math.PI / 2 + GOLDEN_ANGLE * k : inward + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
    k++;
    xs[i] = ax + box.maxDist * Math.cos(a);
    ys[i] = ay + box.maxDist * Math.sin(a);
  });

  const springs = links
    .filter((l) => l.a !== l.b && index.has(l.a) && index.has(l.b))
    .map((l) => ({ i: index.get(l.a)!, j: index.get(l.b)!, len: linkLength(l.snrDb, box) }));
  const linked = new Uint8Array(n);
  for (const s of springs) linked[s.i] = linked[s.j] = 1;

  const move = (i: number, dx: number, dy: number): void => {
    if (i === pinned) return;
    xs[i] += dx;
    ys[i] += dy;
  };
  // Pull i and j to distance `len`; all of it on one side when the other is pinned.
  const relax = (i: number, j: number, len: number, rate: number): void => {
    let dx = xs[j]! - xs[i]!, dy = ys[j]! - ys[i]!;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) {
      dx = Math.cos(i + j);
      dy = Math.sin(i + j);
      d = 1;
    }
    const f = ((d - len) / d) * rate;
    const wi = i === pinned ? 0 : j === pinned ? 1 : 0.5;
    const wj = j === pinned ? 0 : i === pinned ? 1 : 0.5;
    move(i, dx * f * wi, dy * f * wi);
    move(j, -dx * f * wj, -dy * f * wj);
  };

  // Push k off the segment i-j when it is within `clearance`; the ends give way a little.
  const clear = (k: number, i: number, j: number, rate: number): void => {
    const sx = xs[j]! - xs[i]!, sy = ys[j]! - ys[i]!;
    const len2 = sx * sx + sy * sy;
    if (len2 < 1e-6) return;
    const t = ((xs[k]! - xs[i]!) * sx + (ys[k]! - ys[i]!) * sy) / len2;
    if (t <= 0 || t >= 1) return;
    const px = xs[i]! + t * sx, py = ys[i]! + t * sy;
    let dx = xs[k]! - px, dy = ys[k]! - py;
    let d = Math.hypot(dx, dy);
    if (d >= box.clearance) return;
    if (d < 1e-6) {
      // Exactly on the line: step to the left of it.
      dx = -sy;
      dy = sx;
      d = Math.sqrt(len2);
      dx /= d;
      dy /= d;
      d = 1e-6;
    } else {
      dx /= d;
      dy /= d;
    }
    const push = (box.clearance - d) * rate;
    const wk = k === pinned ? 0 : 1;
    move(k, dx * push * wk, dy * push * wk);
    move(i, -dx * push * (1 - t) * 0.5, -dy * push * (1 - t) * 0.5);
    move(j, -dx * push * t * 0.5, -dy * push * t * 0.5);
  };

  const lo = box.margin, hi = box.size - box.margin;
  for (let it = 0; it < iterations; it++) {
    const rate = 0.5 * (1 - it / iterations) + 0.05;
    for (const s of springs) relax(s.i, s.j, s.len, rate);
    for (const s of springs) for (let k = 0; k < n; k++) if (k !== s.i && k !== s.j) clear(k, s.i, s.j, rate);
    for (let i = 0; i < n; i++) {
      // Separation wins over the springs: at full strength every pass.
      for (let j = i + 1; j < n; j++) {
        if (Math.hypot(xs[j]! - xs[i]!, ys[j]! - ys[i]!) < box.minSep) relax(i, j, box.minSep, 1);
      }
      if (!linked[i] && pinned >= 0 && i !== pinned) relax(pinned, i, box.maxDist, rate * 0.5);
    }
    for (let i = 0; i < n; i++) {
      if (i === pinned) continue;
      xs[i] = Math.min(hi, Math.max(lo, xs[i]!));
      ys[i] = Math.min(hi, Math.max(lo, ys[i]!));
    }
  }
  return new Map(nodes.map((id, i) => [id, { x: xs[i]!, y: ys[i]! }]));
}

/** One cell of the background honeycomb (pointy-top hexagons). */
export interface HexCell {
  readonly x: number;
  readonly y: number;
  /** Whole cell inside the box: a station may sit here. */
  readonly inside: boolean;
}

/**
 * Pointy-top hexagons of circumradius `r` covering a `size` square, cells cut by the
 * edge included (the background runs off the edge). Row 0 sits at the bottom with a
 * cell centred on the vertical axis, `bottomGap` above the edge: that is our cell, cells[0].
 */
export function hexGrid(size: number, r: number, bottomGap = 2): HexCell[] {
  const w = Math.sqrt(3) * r, C = size / 2;
  const y0 = size - bottomGap - r;
  const cells: HexCell[] = [];
  for (let row = 0; y0 - row * 1.5 * r + r > 0; row++) {
    const y = y0 - row * 1.5 * r;
    const shift = row % 2 ? w / 2 : 0;
    const reach = Math.ceil(C / w) + 1;
    // Centre column first, then outwards: cells[0] is our cell.
    for (let k = 0; k <= 2 * reach; k++) {
      const col = k % 2 ? (k + 1) / 2 : -k / 2;
      const x = C + col * w + shift;
      if (x + w / 2 < 0 || x - w / 2 > size) continue;
      cells.push({ x, y, inside: x - w / 2 >= 0 && x + w / 2 <= size && y - r >= 0 && y + r <= size });
    }
  }
  return cells;
}

/**
 * Put each node in the free cell nearest its layout position, strongest claim first
 * (`order`), keeping one empty cell between stations so arrows have room. The other
 * stations are first centred on the vertical axis, so the picture is balanced around us.
 */
export function snapToHexGrid(
  pos: ReadonlyMap<number, { x: number; y: number }>,
  order: readonly number[],
  pinned: number | null,
  cells: readonly HexCell[],
  r: number,
  size: number,
): Map<number, HexCell> {
  const others = [...pos.keys()].filter((id) => id !== pinned);
  const shift = others.length ? size / 2 - others.reduce((sum, id) => sum + pos.get(id)!.x, 0) / others.length : 0;
  const out = new Map<number, HexCell>();
  const taken: HexCell[] = [];
  // Neighbouring cell centres are sqrt(3) r apart, the next ring 3 r: 2.5 r blocks exactly the neighbours.
  const free = (c: HexCell): boolean => taken.every((t) => Math.hypot(t.x - c.x, t.y - c.y) > 2.5 * r);
  const seq = [...(pinned !== null && pos.has(pinned) ? [pinned] : []), ...order.filter((id) => id !== pinned && pos.has(id))];
  for (const id of pos.keys()) if (!seq.includes(id)) seq.push(id);
  for (const id of seq) {
    const p = pos.get(id)!;
    const tx = id === pinned ? p.x : p.x + shift, ty = p.y;
    let best: HexCell | undefined, bestD = Infinity;
    for (const c of cells) {
      if (!c.inside || !free(c)) continue;
      const d = Math.hypot(c.x - tx, c.y - ty);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) continue; // no room left: not drawn
    out.set(id, best);
    taken.push(best);
  }
  return out;
}
