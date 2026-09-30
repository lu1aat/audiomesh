import { describe, expect, it } from 'vitest';
import { LOW_BAND, ULTRASONIC_BAND, bandsFor, listChannels } from '../src/band/band-plan';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_DEEP as spec, GFSK8_LONG } from '../src/protocol/gfsk8/spec';
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

describe('gfsk8-deep', () => {
  it('is a quarter of Normal\'s baud, in a 60 s slot, with the widest clock allowance', () => {
    expect(getProtocol('gfsk8-deep').spec).toBe(spec);
    expect(structuredClone(spec)).toEqual(spec);
    expect(bandwidthHz(spec)).toBe(12.5);
    expect(frameDurationSec(spec)).toBeCloseTo(50.56, 2);
    expect(windowDurationSec(spec)).toBeLessThan(spec.slotSec);
    expect(spec.maxTimeOffsetSec).toBeGreaterThan(GFSK8_LONG.maxTimeOffsetSec);
    expect(spec.slotSec).toBe(GFSK8_LONG.slotSec * 2);
  });

  it('fits every band, including the low one, with the widest gaps of any protocol', () => {
    expect(bandsFor(spec).map((b) => b.name)).toEqual(['low', 'audible', 'ultrasonic']);
    const ch = listChannels(spec, ULTRASONIC_BAND);
    expect(ch).toHaveLength(10);
    expect(ch[1]!.baseHz - (ch[0]!.baseHz + bandwidthHz(spec))).toBeGreaterThan(350);
    expect(bandsFor(spec)).toContainEqual(LOW_BAND);
  });

  it('decodes anywhere in the +-3 s clock allowance', () => {
    const random = rng(201);
    for (const offsetSec of [-2.9, -1.5, 0, 1.5, 2.9]) {
      const payload = payloadOf(random);
      const frames = demod.decode(makeWindow(payload, random, offsetSec), 1000);
      expect(frames, `offset ${offsetSec}`).toHaveLength(1);
      expect(frames[0]!.payload).toEqual(payload);
      // Deep's decimated resolution is 1/(32*1.5625Hz) = 20 ms, coarser than the other protocols'.
      expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.03);
    }
  });

  // Measured (48 kHz, unknown timing, nominal frequency): reliable to -23 dB,
  // still mostly decoding at -24/-25, gone by -28. Never a wrong payload at any
  // SNR tried, including well past where it stops decoding at all.
  it('decodes reliably at -23 dB in 2500 Hz and never returns a wrong payload below that', () => {
    const random = rng(202);
    for (const [snrDb, mustDecode] of [[-23, true], [-28, false]] as const) {
      for (let t = 0; t < 4; t++) {
        const payload = payloadOf(random);
        const frames = demod.decode(makeWindow(payload, random, (random() - 0.5) * 4.8, snrDb), 1000);
        for (const f of frames) expect(f.payload).toEqual(payload);
        if (mustDecode) expect(frames, `snr ${snrDb}`).toHaveLength(1);
      }
    }
  });

  it('decodes every band\'s channels', () => {
    const random = rng(203);
    for (const band of bandsFor(spec)) {
      for (const ch of listChannels(spec, band)) {
        const payload = payloadOf(random);
        expect(demod.decode(makeWindow(payload, random, 0, undefined, ch.baseHz), ch.baseHz)[0]?.payload, `channel ${ch.number}`).toEqual(payload);
      }
    }
  });
});

describe('deep protocol through the slot recorder', () => {
  it('cuts 56.56 s windows every 60 s and decodes a frame sent in each slot', async () => {
    const { SlotRecorder } = await import('../src/dsp/slot-recorder');
    const random = rng(211);
    const recorder = new SlotRecorder(rate, spec);
    recorder.setSlotOrigin(0);
    const payload = payloadOf(random);
    const stream = new Float32Array(rate * spec.slotSec * 2);
    const at = Math.round((spec.slotSec * 1 + 0.4) * rate);
    stream.set(synthesizeFrame(codec.encode(payload), 1000, rate, spec), at);
    const got: { slot: number; payload: Uint8Array }[] = [];
    for (let pos = 0; pos < stream.length; pos += 512) {
      const w = recorder.process(stream.slice(pos, pos + 512), pos);
      if (!w) continue;
      for (const f of demod.decode(w.samples, 1000)) got.push({ slot: w.slotIndex, payload: f.payload });
    }
    expect(got.map((g) => g.slot)).toEqual([1]);
    expect(got[0]!.payload).toEqual(payload);
  });
});
