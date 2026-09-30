import { describe, expect, it } from 'vitest';
import { LOW_BAND, ULTRASONIC_BAND, bandsFor, listChannels } from '../src/band/band-plan';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_LONG as spec, GFSK8_NORMAL } from '../src/protocol/gfsk8/spec';
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

describe('gfsk8-long', () => {
  it('is half Normal\'s baud, in a 30 s slot, with the same clock allowance', () => {
    expect(getProtocol('gfsk8-long').spec).toBe(spec);
    expect(structuredClone(spec)).toEqual(spec);
    expect(bandwidthHz(spec)).toBe(25);
    expect(frameDurationSec(spec)).toBeCloseTo(25.28, 2);
    expect(windowDurationSec(spec)).toBeLessThan(spec.slotSec);
    expect(spec.maxTimeOffsetSec).toBe(GFSK8_NORMAL.maxTimeOffsetSec);
    expect(GFSK8_NORMAL.slotSec / spec.slotSec).toBe(0.5);
  });

  it('fits every band, including the low one', () => {
    expect(bandsFor(spec).map((b) => b.name)).toEqual(['low', 'audible', 'ultrasonic']);
    const ch = listChannels(spec, ULTRASONIC_BAND);
    expect(ch).toHaveLength(10);
    expect(ch[1]!.baseHz - (ch[0]!.baseHz + bandwidthHz(spec))).toBeGreaterThan(300);
    expect(bandsFor(spec)).toContainEqual(LOW_BAND);
  });

  it('decodes anywhere in the +-2 s clock allowance', () => {
    const random = rng(101);
    for (const offsetSec of [-1.9, -1, 0, 1, 1.9]) {
      const payload = payloadOf(random);
      const frames = demod.decode(makeWindow(payload, random, offsetSec), 1000);
      expect(frames, `offset ${offsetSec}`).toHaveLength(1);
      expect(frames[0]!.payload).toEqual(payload);
      expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.02);
    }
  });

  // Measured (48 kHz, unknown timing, nominal frequency): reliable to -21 dB,
  // falling off at -22/-23, gone by -24. Never a wrong payload at any SNR tried,
  // including well past where it stops decoding at all.
  it('decodes reliably at -21 dB in 2500 Hz and never returns a wrong payload below that', () => {
    const random = rng(102);
    for (const [snrDb, mustDecode] of [[-21, true], [-24, false]] as const) {
      for (let t = 0; t < 4; t++) {
        const payload = payloadOf(random);
        const frames = demod.decode(makeWindow(payload, random, (random() - 0.5) * 3.2, snrDb), 1000);
        for (const f of frames) expect(f.payload).toEqual(payload);
        if (mustDecode) expect(frames, `snr ${snrDb}`).toHaveLength(1);
      }
    }
  });

  it('decodes every band\'s channels', () => {
    const random = rng(103);
    for (const band of bandsFor(spec)) {
      for (const ch of listChannels(spec, band)) {
        const payload = payloadOf(random);
        expect(demod.decode(makeWindow(payload, random, 0, undefined, ch.baseHz), ch.baseHz)[0]?.payload, `channel ${ch.number}`).toEqual(payload);
      }
    }
  });
});

describe('long protocol through the slot recorder', () => {
  it('cuts 29.28 s windows every 30 s and decodes a frame sent in each slot', async () => {
    const { SlotRecorder } = await import('../src/dsp/slot-recorder');
    const random = rng(111);
    const recorder = new SlotRecorder(rate, spec);
    recorder.setSlotOrigin(0);
    const payloads = [payloadOf(random), payloadOf(random)];
    const stream = new Float32Array(rate * spec.slotSec * 3);
    payloads.forEach((p, i) => {
      const at = Math.round((spec.slotSec * (i + 1) + 0.4) * rate);
      stream.set(synthesizeFrame(codec.encode(p), 1000, rate, spec), at);
    });
    const got: { slot: number; payload: Uint8Array }[] = [];
    for (let at = 0; at < stream.length; at += 512) {
      const w = recorder.process(stream.slice(at, at + 512), at);
      if (!w) continue;
      for (const f of demod.decode(w.samples, 1000)) got.push({ slot: w.slotIndex, payload: f.payload });
    }
    expect(got.map((g) => g.slot)).toEqual([1, 2]);
    got.forEach((g, i) => expect(g.payload).toEqual(payloads[i]!));
  });
});
