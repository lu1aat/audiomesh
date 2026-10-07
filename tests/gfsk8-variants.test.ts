import { describe, expect, it } from 'vitest';
import { LOW_BAND, ULTRASONIC_BAND, bandFits, effectiveChannelCount } from '../src/band/band-plan';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_BURST as burst, GFSK8_NORMAL, GFSK8_SPREAD as spread } from '../src/protocol/gfsk8/spec';
import { getProtocol } from '../src/protocol/registry';
import { bandwidthHz, frameDurationSec, windowDurationSec, windowLeadSec, type ProtocolSpec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const rate = 48000;

function setup(spec: ProtocolSpec) {
  const codec = new Gfsk8Codec(spec);
  return { codec, demod: new Gfsk8Demodulator(rate, spec, codec) };
}

function makeWindow(
  spec: ProtocolSpec,
  tx: Float32Array | null,
  random: () => number,
  offsetSec: number,
  snrDb?: number,
): Float32Array {
  const total = Math.round(windowDurationSec(spec) * rate);
  const w = new Float32Array(total);
  if (tx) w.set(tx.subarray(0, total), Math.round((windowLeadSec(spec) + offsetSec) * rate));
  if (snrDb !== undefined) {
    const sigma = Math.sqrt((0.5 / 10 ** (snrDb / 10)) * (rate / 2 / 2500));
    for (let i = 0; i < total; i++) w[i] += sigma * gaussian(random);
  }
  return w;
}

const payloadOf = (random: () => number): Uint8Array => {
  const p = randomBits(random, PAYLOAD_BITS);
  p[0] = 1;
  return p;
};

/** The signal's delay swung sinusoidally: a Doppler wobble of `peakHz` at 1 kHz, `fm` times a second. */
function wobble(tx: Float32Array, peakHz: number, fm: number): Float32Array {
  const swing = peakHz / (1000 * 2 * Math.PI * fm);
  const out = new Float32Array(tx.length);
  for (let i = 0; i < tx.length; i++) {
    const pos = i - rate * swing * Math.sin((2 * Math.PI * fm * i) / rate);
    const k = Math.floor(pos);
    const f = pos - k;
    out[i] = (tx[k] ?? 0) * (1 - f) + (tx[k + 1] ?? 0) * f;
  }
  return out;
}

describe('gfsk8-spread (Q65-style)', () => {
  it('is Normal\'s timing with tones three bins wide', () => {
    expect(getProtocol('gfsk8-spread').spec).toBe(spread);
    expect(structuredClone(spread)).toEqual(spread);
    expect(spread.toneSpacingHz).toBe(3 * spread.baud);
    expect(bandwidthHz(spread)).toBe(150);
    expect(frameDurationSec(spread)).toBe(frameDurationSec(GFSK8_NORMAL));
    expect(spread.slotSec).toBe(GFSK8_NORMAL.slotSec);
  });

  it('holds one low-band channel and the full ultrasonic band', () => {
    expect(bandFits(spread, LOW_BAND)).toBe(true);
    expect(effectiveChannelCount(spread, LOW_BAND)).toBe(1);
    expect(effectiveChannelCount(spread, ULTRASONIC_BAND)).toBe(10);
  });

  it('decodes in steady noise at -14 dB, within the clock allowance', () => {
    const { codec, demod } = setup(spread);
    const random = rng(401);
    for (const offsetSec of [-1.8, 0.7]) {
      const payload = payloadOf(random);
      const tx = synthesizeFrame(codec.encode(payload), 1000, rate, spread);
      const frames = demod.decode(makeWindow(spread, tx, random, offsetSec, -14), 1000);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.payload).toEqual(payload);
      expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.02);
      expect(frames[0]!.snrDb).toBeGreaterThan(-18);
      expect(frames[0]!.snrDb).toBeLessThan(-10);
    }
  });

  // Measured: +-6 Hz peak at 0.7 Hz wobble, Normal 0/8 even at -8 dB, Spread 8/8 down to -16 dB.
  it('decodes through a Doppler wobble that defeats Normal', () => {
    const random = rng(402);
    const payload = payloadOf(random);
    const normal = setup(GFSK8_NORMAL);
    const sp = setup(spread);
    const nTx = wobble(synthesizeFrame(normal.codec.encode(payload), 1000, rate, GFSK8_NORMAL), 6, 0.7);
    const sTx = wobble(synthesizeFrame(sp.codec.encode(payload), 1000, rate, spread), 6, 0.7);
    expect(normal.demod.decode(makeWindow(GFSK8_NORMAL, nTx, random, 0.3, -8), 1000)).toHaveLength(0);
    const frames = sp.demod.decode(makeWindow(spread, sTx, random, 0.3, -12), 1000);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload).toEqual(payload);
  });

  it('finds nothing in noise and never invents a frame', () => {
    const { demod } = setup(spread);
    const random = rng(403);
    for (let i = 0; i < 2; i++) expect(demod.decode(makeWindow(spread, null, random, 0, -5), 1000)).toHaveLength(0);
  });
});

describe('gfsk8-burst (ISCAT-style)', () => {
  it('sends Fast\'s frame four times in the airtime of Normal\'s', () => {
    expect(getProtocol('gfsk8-burst').spec).toBe(burst);
    expect(structuredClone(burst)).toEqual(burst);
    expect(burst.repeats).toBe(4);
    expect(frameDurationSec(burst)).toBeCloseTo(12.64, 2);
    expect(windowDurationSec(burst)).toBe(windowDurationSec(GFSK8_NORMAL)); // 16.64 s: same clock allowance
    expect(bandwidthHz(burst)).toBe(200);
    expect(new Gfsk8Codec(burst).encode(payloadOf(rng(1)))).toHaveLength(4 * burst.symbolCount);
  });

  it('decodes in steady noise at -14 dB and reports the copies it combined', () => {
    const { codec, demod } = setup(burst);
    const random = rng(411);
    for (const offsetSec of [-1.8, 1.1]) {
      const payload = payloadOf(random);
      const tx = synthesizeFrame(codec.encode(payload), 1000, rate, burst);
      const frames = demod.decode(makeWindow(burst, tx, random, offsetSec, -14), 1000);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.payload).toEqual(payload);
      expect(frames[0]!.copies).toBe(4);
      expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.02);
    }
  });

  // One copy alone (Fast) stops at -12 dB; with a copy wiped out, the others still decode at -14 (measured 8/8).
  // Which copies end up used varies (the sum of all four often still works); the fallback to subsets was
  // seen at -14 dB with two copies wiped (3 copies used in 5 of 6 runs) and at -16 with one.
  it('survives a copy lost entirely', () => {
    const { codec, demod } = setup(burst);
    const random = rng(412);
    const payload = payloadOf(random);
    const tx = synthesizeFrame(codec.encode(payload), 1000, rate, burst);
    const per = Math.round(tx.length / 4);
    tx.fill(0, per, 2 * per);
    const frames = demod.decode(makeWindow(burst, tx, random, 0.4, -12), 1000);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload).toEqual(payload);
    expect(frames[0]!.copies).toBeGreaterThanOrEqual(3);
  });

  it('decodes when only the first two copies were heard', () => {
    const { codec, demod } = setup(burst);
    const random = rng(413);
    const payload = payloadOf(random);
    const tx = synthesizeFrame(codec.encode(payload), 1000, rate, burst);
    tx.fill(0, Math.round(tx.length / 2));
    const frames = demod.decode(makeWindow(burst, tx, random, -0.6, -9), 1000);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload).toEqual(payload);
    expect(frames[0]!.copies).toBeGreaterThanOrEqual(2);
  });

  it('finds nothing in noise and never invents a frame', () => {
    const { demod } = setup(burst);
    const random = rng(414);
    for (let i = 0; i < 2; i++) expect(demod.decode(makeWindow(burst, null, random, 0, -5), 1000)).toHaveLength(0);
  });
});
