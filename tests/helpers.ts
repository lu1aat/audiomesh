/** Seeded PRNG (mulberry32): a flaky DSP test is worse than no DSP test. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
export function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(random() + 1e-300)) * Math.cos(2 * Math.PI * random());
}

export function randomBits(random: () => number, n: number): Uint8Array {
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) bits[i] = random() < 0.5 ? 0 : 1;
  return bits;
}
