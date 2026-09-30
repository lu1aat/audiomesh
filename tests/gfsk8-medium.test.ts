import { describe, expect, it } from 'vitest';
import { LOW_BAND, ULTRASONIC_BAND, bandsFor, effectiveChannelCount, listChannels } from '../src/band/band-plan';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_FAST, GFSK8_MEDIUM as spec, GFSK8_NORMAL } from '../src/protocol/gfsk8/spec';
import { getProtocol } from '../src/protocol/registry';
import { bandwidthHz, frameDurationSec, windowDurationSec, windowLeadSec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const codec = new Gfsk8Codec(spec);
const rate = 48000;
const demod = new Gfsk8Demodulator(rate, spec, codec);

const payloadOf = (random: () => number): Uint8Array => {
  const p = randomBits(random, PAYLOAD_BITS);
  p[0] = 1;
  return p;
};

function makeWindow(payload: Uint8Array | null, random: () => number, offsetSec = 0, snrDb?: number, baseHz = 1000): Float32Array {
  const total = Math.round(windowDurationSec(spec) * rate);
  const w = new Float32Array(total);
  if (payload) w.set(synthesizeFrame(codec.encode(payload), baseHz, rate, spec), Math.round((windowLeadSec(spec) + offsetSec) * rate));
  if (snrDb !== undefined) {
    const sigma = Math.sqrt((0.5 / 10 ** (snrDb / 10)) * (rate / 2 / 2500));
    for (let i = 0; i < total; i++) w[i] += sigma * gaussian(random);
  }
  return w;
}

describe('gfsk8-medium', () => {
  it('sits between Normal and Fast', () => {
    expect(getProtocol('gfsk8-medium').spec).toBe(spec);
    expect(structuredClone(spec)).toEqual(spec);
    expect(bandwidthHz(spec)).toBe(100);
    expect(frameDurationSec(spec)).toBeCloseTo(6.32, 2);
    expect(windowDurationSec(spec)).toBeLessThan(spec.slotSec);
    expect(GFSK8_FAST.slotSec).toBeLessThan(spec.slotSec);
    expect(spec.slotSec).toBeLessThan(GFSK8_NORMAL.slotSec);
  });

  it('fits only 2 of the low band\'s 3 channels (packed edge to edge), and ten ultrasonic channels with wide gaps', () => {
    expect(bandsFor(spec).map((b) => b.name)).toEqual(['low', 'audible', 'ultrasonic']);
    expect(bandsFor(spec)).toContain(LOW_BAND);
    expect(effectiveChannelCount(spec, LOW_BAND)).toBe(2);
    const low = listChannels(spec, LOW_BAND);
    expect(low).toHaveLength(2);
    expect(low[0]!.baseHz).toBe(100);
    expect(low[1]!.baseHz).toBe(200); // no gap: 2 channels of 100 Hz exactly fill 200 Hz
    const ch = listChannels(spec, ULTRASONIC_BAND);
    expect(ch).toHaveLength(10);
    expect(ch[1]!.baseHz - (ch[0]!.baseHz + bandwidthHz(spec))).toBeGreaterThan(250);
  });

  it('decodes anywhere in the +-1.5 s clock allowance', () => {
    const random = rng(41);
    for (const offsetSec of [-1.45, -0.7, 0, 0.9, 1.45]) {
      const payload = payloadOf(random);
      const frames = demod.decode(makeWindow(payload, random, offsetSec), 1000);
      expect(frames, `offset ${offsetSec}`).toHaveLength(1);
      expect(frames[0]!.payload).toEqual(payload);
      expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.02);
    }
  });

  it('decodes reliably at -12 dB in 2500 Hz and never returns a wrong payload below that', () => {
    const random = rng(42);
    for (const [snrDb, mustDecode] of [[-12, true], [-17, false]] as const) {
      for (let t = 0; t < 4; t++) {
        const payload = payloadOf(random);
        const frames = demod.decode(makeWindow(payload, random, (random() - 0.5) * 2.4, snrDb), 1000);
        for (const f of frames) expect(f.payload).toEqual(payload);
        if (mustDecode) expect(frames, `snr ${snrDb}`).toHaveLength(1);
      }
    }
  });

  it('decodes every low and ultrasonic channel, including the low band\'s two packed ones', () => {
    const random = rng(43);
    for (const ch of [...listChannels(spec, LOW_BAND), ...listChannels(spec, ULTRASONIC_BAND)]) {
      const payload = payloadOf(random);
      expect(demod.decode(makeWindow(payload, random, 0, undefined, ch.baseHz), ch.baseHz)[0]?.payload, `channel ${ch.number}`).toEqual(payload);
    }
  });
});

describe('sync report (why a slot did not decode)', () => {
  it('is null before any decode and in silence, and low on pure noise', () => {
    const random = rng(51);
    const d = new Gfsk8Demodulator(rate, spec, codec);
    expect(d.lastSync).toBeNull();
    expect(d.decode(makeWindow(null, random), 1000)).toEqual([]);
    for (let t = 0; t < 3; t++) {
      d.decode(makeWindow(null, random, 0, 0), 1000);
      expect(d.lastSync!.score).toBeLessThan(0.28);
    }
  });

  it('is high, with the right timing, for a signal that is there but too weak to decode', () => {
    const random = rng(52);
    const d = new Gfsk8Demodulator(rate, spec, codec);
    let seen = 0;
    for (let t = 0; t < 4; t++) {
      const frames = d.decode(makeWindow(payloadOf(random), random, 0.8, -16), 1000);
      if (frames.length === 0 && d.lastSync!.score > 0.28) {
        seen++;
        expect(Math.abs(d.lastSync!.timeOffsetSec - 0.8)).toBeLessThan(0.3);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('reports the frame it decoded', () => {
    const random = rng(53);
    const d = new Gfsk8Demodulator(rate, spec, codec);
    d.decode(makeWindow(payloadOf(random), random, -0.6), 1000);
    expect(d.lastSync!.score).toBeGreaterThan(0.9);
    expect(d.lastSync!.timeOffsetSec).toBeCloseTo(-0.6, 1);
  });
});
