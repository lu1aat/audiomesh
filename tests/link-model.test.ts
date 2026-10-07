import { describe, expect, it } from 'vitest';
import { ageColor, buildLinkModel, formatAge, snrLevel, stationStatus } from '../src/ale/link-model';
import { LqaTable } from '../src/ale/lqa';

describe('link model helpers', () => {
  it('classifies stations by how long ago they were heard', () => {
    expect(stationStatus(30)).toBe('active');
    expect(stationStatus(120)).toBe('active');
    expect(stationStatus(300)).toBe('recent');
    expect(stationStatus(3600)).toBe('quiet');
  });

  it('maps SNR onto 0..1, clamped', () => {
    expect(snrLevel(-40)).toBe(0);
    expect(snrLevel(10)).toBe(1);
    expect(snrLevel(-12)).toBeCloseTo(0.5);
  });

  it('formats ages', () => {
    expect([3, 45, 400, 7200].map(formatAge)).toEqual(['just now', '45 s ago', '7 min ago', '2 h ago']);
  });
});

describe('buildLinkModel', () => {
  it('summarises stations, ranks channels and keeps the top three', () => {
    const t = new LqaTable();
    t.heard(7, 2, -8, 100);
    t.heard(7, 3, -14, 101);
    t.reported(7, 2, -6, 101);
    t.reported(7, 3, -16, 101);
    t.reported(7, 4, -10, 101);
    t.reported(7, 5, -12, 101);
    t.heard(8, 3, -20, 40);
    const m = buildLinkModel(t, [1, 2, 3, 4, 5], 102, 15);
    expect(m.stations.map((s) => s.id)).toEqual([7, 8]);
    const s7 = m.stations[0]!;
    expect(s7).toMatchObject({ status: 'active', lastChannel: 3, lastSnrDb: -14, best: { channel: 2, measured: true } });
    expect(m.stations[1]).toMatchObject({ status: 'quiet' });
    expect(m.channels.find((c) => c.channel === 1)).toEqual({ channel: 1 });
    const ranks = m.channels.filter((c) => c.rank).sort((a, b) => a.rank! - b.rank!).map((c) => c.channel);
    expect(ranks).toHaveLength(3);
    expect(ranks[0]).toBe(2);
  });

  it('is empty when nothing has been heard', () => {
    const m = buildLinkModel(new LqaTable(), [1, 2], 0, 15);
    expect(m.stations).toEqual([]);
    expect(m.channels).toEqual([{ channel: 1 }, { channel: 2 }]);
  });
});

describe('link graph', () => {
  it('links us to stations both ways and adds what others report about each other', () => {
    const t = new LqaTable();
    t.heard(7, 2, -8, 100); // 7 -> me strong
    t.reported(7, 2, -15, 100); // me -> 7 fair
    t.overheard(7, 9, 3, -20, 100); // 9 -> 7 weak
    const m = buildLinkModel(t, [1, 2, 3], 101, 15, 1);
    expect(m.nodes).toEqual([1, 7, 9]);
    const edge = (from: number, to: number) => m.edges.find((e) => e.from === from && e.to === to);
    expect(edge(7, 1)).toMatchObject({ snrDb: -8, level: 'good' });
    expect(edge(1, 7)).toMatchObject({ snrDb: -15, level: 'fair' });
    expect(edge(9, 7)).toMatchObject({ snrDb: -20, level: 'weak' }); // we never heard 9, 7 does
    expect(m.lastPacket).toEqual({ station: 7, ageSec: 15 });
    const t2 = new LqaTable();
    t2.restore(JSON.parse(JSON.stringify(t.serialize())));
    expect(t2.thirdPartyLinks(101)).toHaveLength(1);
  });

  it('marks stations not heard for more than ten minutes as stale, without removing them', () => {
    const t = new LqaTable();
    t.heard(7, 2, -8, 100);
    t.reported(7, 2, -15, 100);
    t.heard(8, 2, -8, 150);
    const m = buildLinkModel(t, [1, 2, 3], 160, 15, 1); // 7 is 15 min old, 8 is 2.5 min old
    expect(m.nodes).toEqual([1, 7, 8]);
    expect(m.staleNodes).toEqual([7]);
    expect(m.edges.filter((e) => e.stale).every((e) => e.from === 7 || e.to === 7)).toBe(true);
    expect(m.edges.filter((e) => !e.stale).length).toBeGreaterThan(0);
  });

  it('marks repeaters and draws stations heard only through one', () => {
    const t = new LqaTable();
    t.heard(20, 5, -8, 100); // the repeater, heard direct
    const relay = {
      repeaters: new Map([[20, 100], [30, 1]]), // 30 was a repeater long ago
      framesVia: new Map([[20, 4]]),
      paths: [{ from: 40, via: 20, slot: 100 }],
      self: false,
    };
    const m = buildLinkModel(t, [5], 100, 15, 1, relay);
    expect(m.stations.find((s) => s.id === 20)).toMatchObject({ repeater: true, framesVia: 4 });
    expect(m.relays).toEqual([{ from: 40, via: 20, stale: false }]);
    expect(m.nodes).toEqual([1, 20, 40]);
    expect(m.repeaters).toEqual([20]);
    expect(buildLinkModel(t, [5], 100, 15, 1, { ...relay, self: true }).repeaters).toEqual([1, 20]);
  });

  it('lists stations heard only through a repeater as heard, with when and through whom', () => {
    const t = new LqaTable();
    t.heard(20, 5, -8, 90); // the repeater, heard direct
    t.heard(50, 5, -10, 60); // heard direct long ago, through the repeater lately
    const relay = {
      repeaters: new Map([[20, 90]]),
      framesVia: new Map([[20, 3]]),
      paths: [{ from: 40, via: 20, slot: 98 }],
      relayed: new Map([
        [40, { slot: 98, via: 20, tag: 7 }],
        [50, { slot: 99, via: null, tag: 3 }],
        [60, { slot: -50, via: 20, tag: 7 }], // beyond the 30 min repeater memory
        [1, { slot: 99, via: 20, tag: 7 }], // us, heard back
      ]),
      self: false,
    };
    const m = buildLinkModel(t, [5], 100, 15, 1, relay);
    expect(m.stations.map((s) => s.id)).toEqual([20, 40, 50]);
    expect(m.stations.find((s) => s.id === 40)).toMatchObject({ lastSlot: 98, status: 'active', direct: false, relayed: { via: 20, ageSec: 30 } });
    expect(m.stations.find((s) => s.id === 40)!.lastSnrDb).toBeUndefined();
    expect(m.stations.find((s) => s.id === 50)).toMatchObject({ lastSlot: 99, status: 'active', direct: true, relayed: { via: null, tag: 3 } });
    expect(m.lastPacket).toEqual({ station: 50, ageSec: 15 });
    // Channel ranking rests on stations with link quality of their own.
    expect(m.channels[0]!.score).toBe(buildLinkModel(t, [5], 100, 15, 1).channels[0]!.score);
  });
});

describe('ageColor', () => {
  it('is green for the first 10 s, then passes lime, amber and rose to slate at 10 minutes', () => {
    expect(ageColor(0).fill).toBe('rgb(74,222,128)');
    expect(ageColor(9).fill).toBe('rgb(74,222,128)');
    expect(ageColor(120).fill).toBe('rgb(251,191,36)');
    expect(ageColor(300).fill).toBe('rgb(251,113,133)');
    expect(ageColor(600).fill).toBe('rgb(100,116,139)');
    expect(ageColor(Infinity).fill).toBe('rgb(100,116,139)');
    expect(ageColor(0).darkText).toBe(true);
    expect(ageColor(Infinity).darkText).toBe(false);
  });

  it('drops a notch every 10 s and holds the colour in between', () => {
    expect(ageColor(10).fill).not.toBe(ageColor(20).fill);
    expect(ageColor(20).fill).toBe(ageColor(29.9).fill);
    expect(ageColor(30).fill).not.toBe(ageColor(29.9).fill);
  });
});
