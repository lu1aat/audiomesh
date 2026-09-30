import { describe, expect, it } from 'vitest';
import { hexGrid, layoutGraph, linkLength, snapToHexGrid, type LayoutBox } from '../src/ui/graph-layout';

const box: LayoutBox = { size: 360, margin: 33, minDist: 55, maxDist: 143, minSep: 56, clearance: 27 };
const dist = (p: { x: number; y: number }, q: { x: number; y: number }): number => Math.hypot(p.x - q.x, p.y - q.y);

describe('graph layout', () => {
  it('maps a stronger signal to a shorter link', () => {
    expect(linkLength(0, box)).toBe(55);
    expect(linkLength(-24, box)).toBe(143);
    expect(linkLength(undefined, box)).toBe(143);
    expect(linkLength(-6, box)).toBeLessThan(linkLength(-18, box));
  });

  it('pins us in the middle and puts the strong station closer than the weak one', () => {
    const pos = layoutGraph([1, 2, 3], [{ a: 1, b: 2, snrDb: -2 }, { a: 3, b: 1, snrDb: -20 }], 1, box);
    expect(pos.get(1)).toEqual({ x: 180, y: 180 });
    const near = dist(pos.get(1)!, pos.get(2)!), far = dist(pos.get(1)!, pos.get(3)!);
    expect(near).toBeLessThan(far);
    expect(near).toBeCloseTo(linkLength(-2, box), -1);
    expect(far).toBeCloseTo(linkLength(-20, box), -1);
  });

  it('keeps nodes apart and inside the box, and is deterministic', () => {
    const nodes = [1, 2, 3, 4, 5, 6];
    const links = nodes.slice(1).map((b) => ({ a: 1, b, snrDb: 5 }));
    const pos = layoutGraph(nodes, links, 1, box);
    for (const i of nodes) {
      const p = pos.get(i)!;
      expect(p.x).toBeGreaterThanOrEqual(33);
      expect(p.x).toBeLessThanOrEqual(327);
      for (const j of nodes) if (j > i) expect(dist(p, pos.get(j)!)).toBeGreaterThan(box.minSep - 6);
    }
    expect(layoutGraph(nodes, links, 1, box)).toEqual(pos);
  });

  it('bends a chain of three instead of stacking it on one line', () => {
    // Measured: we hear SAMSUNG well, SAMSUNG hears LIVING well, LIVING reaches us weakly.
    const pos = layoutGraph([940, 1, 2], [{ a: 940, b: 1, snrDb: -1 }, { a: 1, b: 2, snrDb: -2 }, { a: 2, b: 940, snrDb: -14 }], 940, box);
    const me = pos.get(940)!, s = pos.get(1)!, l = pos.get(2)!;
    for (const [p, q] of [[me, s], [s, l], [me, l]] as const) expect(dist(p, q)).toBeGreaterThan(box.minSep - 1);
    // SAMSUNG stays off the me-LIVING line.
    const cross = Math.abs((l.x - me.x) * (s.y - me.y) - (l.y - me.y) * (s.x - me.x)) / dist(me, l);
    expect(cross).toBeGreaterThan(box.clearance - 1);
  });
});

describe('graph layout, us at the bottom', () => {
  const bottom: LayoutBox = { ...box, minDist: 130, maxDist: 280, minSep: 95, anchor: { x: 180, y: 337 } };

  it('keeps us fixed at the anchor with everyone above', () => {
    const pos = layoutGraph([940, 1, 2], [{ a: 940, b: 1, snrDb: -1 }, { a: 1, b: 2, snrDb: -2 }, { a: 2, b: 940, snrDb: -14 }], 940, bottom);
    expect(pos.get(940)).toEqual({ x: 180, y: 337 });
    for (const id of [1, 2]) expect(pos.get(id)!.y).toBeLessThan(337 - 60);
    expect(dist(pos.get(1)!, pos.get(2)!)).toBeGreaterThan(94);
  });
});

describe('honeycomb', () => {
  const R = 24, W = 360;
  const cells = hexGrid(W, R);

  it('has our cell at the bottom centre and neighbours sqrt(3) r apart', () => {
    expect(cells[0]!.x).toBeCloseTo(180);
    expect(cells[0]!.y).toBeCloseTo(W - 2 - R);
    const inside = cells.filter((c) => c.inside);
    for (const c of inside) {
      expect(c.x - (Math.sqrt(3) * R) / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y - R).toBeGreaterThanOrEqual(-1e-9);
    }
    const nearest = Math.min(...cells.slice(1).map((c) => Math.hypot(c.x - cells[0]!.x, c.y - cells[0]!.y)));
    expect(nearest).toBeCloseTo(Math.sqrt(3) * R);
  });

  it('snaps the measured network to cells: us at the bottom, the strong station nearer, a free cell between', () => {
    const box3: LayoutBox = { size: W, margin: 40, minDist: 120, maxDist: 290, minSep: 105, clearance: 37, anchor: { x: 180, y: cells[0]!.y } };
    const ideal = layoutGraph([940, 1, 2], [{ a: 940, b: 1, snrDb: -1 }, { a: 1, b: 2, snrDb: -2 }, { a: 2, b: 940, snrDb: -14 }], 940, box3);
    const pos = snapToHexGrid(ideal, [1, 2], 940, cells, R, W);
    expect(pos.get(940)).toBe(cells[0]);
    const me = pos.get(940)!, s = pos.get(1)!, l = pos.get(2)!;
    expect(dist(me, s)).toBeLessThan(dist(me, l));
    for (const [p, q] of [[me, s], [s, l], [me, l]] as const) expect(dist(p, q)).toBeGreaterThan(2.5 * R);
    for (const p of [s, l]) expect(p.y).toBeLessThan(me.y);
  });

  it('centres a lone station above us', () => {
    const ideal = new Map([[1, { x: 180, y: 336 }], [2, { x: 250, y: 200 }]]);
    const pos = snapToHexGrid(ideal, [2], 1, cells, R, W);
    expect(pos.get(2)!.x).toBeCloseTo(180, 0);
  });

  it('places us alone, at the bottom-centre cell, when no other station is known', () => {
    const cells = hexGrid(360, 24);
    const ideal = layoutGraph([7], [], 7, { ...box, anchor: { x: 180, y: cells[0]!.y } });
    const pos = snapToHexGrid(ideal, [], 7, cells, 24, 360);
    expect(pos.get(7)).toMatchObject({ x: cells[0]!.x, y: cells[0]!.y });
  });
});
