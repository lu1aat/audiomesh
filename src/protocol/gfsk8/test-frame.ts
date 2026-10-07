import { repeatCount, type ProtocolSpec } from '../spec';

/** Small seeded PRNG (mulberry32): a test signal that changes between runs is a flaky test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A frame-shaped test signal: the protocol's sync blocks at their real
 * positions, pseudo-random tones everywhere else. It carries no data and has no
 * FEC; it exists to exercise the modulator and to look like a signal on the
 * waterfall until the codec is written.
 */
export function buildTestFrame(spec: ProtocolSpec, seed = 1): Uint8Array {
  const random = mulberry32(seed);
  const symbols = new Uint8Array(spec.symbolCount);
  for (let i = 0; i < symbols.length; i++) symbols[i] = Math.floor(random() * spec.toneCount);
  for (const start of spec.syncStarts) symbols.set(spec.syncPattern, start);
  const repeats = repeatCount(spec);
  if (repeats === 1) return symbols;
  const all = new Uint8Array(repeats * symbols.length);
  for (let k = 0; k < repeats; k++) all.set(symbols, k * symbols.length);
  return all;
}
