import { describe, expect, it } from 'vitest';
import { DEFAULT_PROTOCOL_ID, getProtocol, isProtocolId, listProtocols } from '../src/protocol/registry';
import { bitsPerSymbol, frameDurationSec } from '../src/protocol/spec';

describe('protocol registry', () => {
  it('registers every protocol under its own id', () => {
    for (const p of listProtocols()) expect(getProtocol(p.spec.id)).toBe(p);
  });

  it('has a default that exists', () => {
    expect(isProtocolId(DEFAULT_PROTOCOL_ID)).toBe(true);
    expect(isProtocolId('nope')).toBe(false);
  });

  it('keeps specs structured-cloneable (they cross into worklets)', () => {
    for (const p of listProtocols()) expect(structuredClone(p.spec)).toEqual(p.spec);
  });
});

describe('gfsk8-normal spec', () => {
  const { spec } = getProtocol('gfsk8-normal');

  it('matches the FT8/JS8 Normal timing', () => {
    expect(frameDurationSec(spec)).toBeCloseTo(12.64, 2);
    expect(frameDurationSec(spec)).toBeLessThan(spec.slotSec);
  });

  it('has 3 sync blocks + 58 data symbols carrying 174 bits', () => {
    const syncSymbols = spec.syncStarts.length * spec.syncPattern.length;
    expect(syncSymbols).toBe(21);
    expect((spec.symbolCount - syncSymbols) * bitsPerSymbol(spec)).toBe(174);
  });

  it('uses each tone once per sync pattern (Costas property precondition)', () => {
    expect([...spec.syncPattern].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
