import { describe, expect, it } from 'vitest';
import { AUDIBLE_BAND, LOW_BAND, ULTRASONIC_BAND, bandFits, bandsFor, effectiveChannelCount, listChannels } from '../src/band/band-plan';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_FAST, GFSK8_TURBO as spec } from '../src/protocol/gfsk8/spec';
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

describe('gfsk8-turbo', () => {
  it('is 8x Normal\'s baud, in a 2.5 s slot, with the tightest clock allowance here', () => {
    expect(getProtocol('gfsk8-turbo').spec).toBe(spec);
    expect(structuredClone(spec)).toEqual(spec);
    expect(bandwidthHz(spec)).toBe(400);
    expect(frameDurationSec(spec)).toBeCloseTo(1.58, 2);
    expect(windowDurationSec(spec)).toBeLessThan(spec.slotSec);
    expect(spec.maxTimeOffsetSec).toBeLessThan(GFSK8_FAST.maxTimeOffsetSec);
  });

  it('is too wide for even one low-band channel, but fits 8 of the ultrasonic band\'s 10', () => {
    // 400 Hz alone exceeds the low band's entire 200 Hz width: no channel count helps here.
    expect(bandFits(spec, LOW_BAND)).toBe(false);
    expect(effectiveChannelCount(spec, LOW_BAND)).toBe(0);
    expect(bandFits(spec, ULTRASONIC_BAND)).toBe(true);
    expect(effectiveChannelCount(spec, ULTRASONIC_BAND)).toBe(8);
    expect(bandsFor(spec)).toEqual([AUDIBLE_BAND, ULTRASONIC_BAND]);
    const audible = listChannels(spec, AUDIBLE_BAND);
    expect(audible).toHaveLength(4);
    expect(audible[1]!.baseHz - (audible[0]!.baseHz + bandwidthHz(spec))).toBeGreaterThan(2500);
    const ultra = listChannels(spec, ULTRASONIC_BAND);
    expect(ultra).toHaveLength(8);
    expect(ultra.map((c) => c.number)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]); // 16 and 17 don't exist for this protocol
    expect(ultra[1]!.baseHz - (ultra[0]!.baseHz + bandwidthHz(spec))).toBeGreaterThan(0);
  });

  it('decodes anywhere in the +-0.45 s clock allowance', () => {
    const random = rng(301);
    for (const offsetSec of [-0.43, -0.2, 0, 0.2, 0.43]) {
      const payload = payloadOf(random);
      const frames = demod.decode(makeWindow(payload, random, offsetSec), 1000);
      expect(frames, `offset ${offsetSec}`).toHaveLength(1);
      expect(frames[0]!.payload).toEqual(payload);
      expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.01);
    }
  });

  // Measured (48 kHz, unknown timing, nominal frequency): reliable to -9 dB,
  // falling off at -10/-11, gone by -12. Never a wrong payload at any SNR tried.
  it('decodes reliably at -9 dB in 2500 Hz and never returns a wrong payload below that', () => {
    const random = rng(302);
    for (const [snrDb, mustDecode] of [[-9, true], [-12, false]] as const) {
      for (let t = 0; t < 4; t++) {
        const payload = payloadOf(random);
        const frames = demod.decode(makeWindow(payload, random, (random() - 0.5) * 0.72, snrDb), 1000);
        for (const f of frames) expect(f.payload).toEqual(payload);
        if (mustDecode) expect(frames, `snr ${snrDb}`).toHaveLength(1);
      }
    }
  });

  it('decodes every audible and ultrasonic channel', () => {
    const random = rng(303);
    for (const band of [AUDIBLE_BAND, ULTRASONIC_BAND]) {
      for (const ch of listChannels(spec, band)) {
        const payload = payloadOf(random);
        expect(demod.decode(makeWindow(payload, random, 0, undefined, ch.baseHz), ch.baseHz)[0]?.payload, `channel ${ch.number}`).toEqual(payload);
      }
    }
  });
});

describe('turbo protocol through the slot recorder', () => {
  it('cuts 2.48 s windows every 2.5 s and decodes a frame sent in each slot', async () => {
    const { SlotRecorder } = await import('../src/dsp/slot-recorder');
    const random = rng(311);
    const recorder = new SlotRecorder(rate, spec);
    recorder.setSlotOrigin(0);
    const payloads = [payloadOf(random), payloadOf(random), payloadOf(random)];
    const stream = new Float32Array(Math.round(rate * spec.slotSec * 5));
    payloads.forEach((p, i) => {
      const at = Math.round((spec.slotSec * (i + 1) + 0.1) * rate);
      stream.set(synthesizeFrame(codec.encode(p), 1000, rate, spec), at);
    });
    const got: { slot: number; payload: Uint8Array }[] = [];
    for (let at = 0; at < stream.length; at += 128) {
      const w = recorder.process(stream.slice(at, at + 128), at);
      if (!w) continue;
      for (const f of demod.decode(w.samples, 1000)) got.push({ slot: w.slotIndex, payload: f.payload });
    }
    expect(got.map((g) => g.slot)).toEqual([1, 2, 3]);
    got.forEach((g, i) => expect(g.payload).toEqual(payloads[i]!));
  });
});
