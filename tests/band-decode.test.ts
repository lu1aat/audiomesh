import { describe, expect, it } from 'vitest';
import { LOW_BAND, ULTRASONIC_BAND, listChannels } from '../src/band/band-plan';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_NORMAL as spec } from '../src/protocol/gfsk8/spec';
import { windowDurationSec, windowLeadSec } from '../src/protocol/spec';
import { randomBits, rng } from './helpers';

const codec = new Gfsk8Codec(spec);

describe('decoding in the low and ultrasonic bands', () => {
  for (const [band, rate] of [
    [LOW_BAND, 48000],
    [ULTRASONIC_BAND, 48000],
    [ULTRASONIC_BAND, 96000],
  ] as const) {
    it(`decodes every ${band.name} channel at ${rate} Hz`, () => {
      const demod = new Gfsk8Demodulator(rate, spec, codec);
      const random = rng(7);
      for (const ch of listChannels(spec, band)) {
        const payload = randomBits(random, PAYLOAD_BITS);
        payload[0] = 1;
        const w = new Float32Array(Math.round(windowDurationSec(spec) * rate));
        w.set(synthesizeFrame(codec.encode(payload), ch.baseHz, rate, spec), Math.round(windowLeadSec(spec) * rate));
        const frames = demod.decode(w, ch.baseHz);
        expect(frames.length, `channel ${ch.number}`).toBeGreaterThan(0);
        expect(frames[0]!.payload).toEqual(payload);
      }
    });
  }

  it('decodes an ultrasonic channel next to a 30 dB stronger neighbour', () => {
    const rate = 48000;
    const demod = new Gfsk8Demodulator(rate, spec, codec);
    const random = rng(11);
    const channels = listChannels(spec, ULTRASONIC_BAND);
    for (const i of [0, 4, 9]) {
      const ours = channels[i]!;
      const other = channels[i === 9 ? i - 1 : i + 1]!;
      const payload = randomBits(random, PAYLOAD_BITS);
      payload[0] = 1;
      const w = new Float32Array(Math.round(windowDurationSec(spec) * rate));
      const at = Math.round(windowLeadSec(spec) * rate);
      w.set(synthesizeFrame(codec.encode(payload), ours.baseHz, rate, spec), at);
      const noise = randomBits(random, PAYLOAD_BITS);
      noise[0] = 1;
      const loud = synthesizeFrame(codec.encode(noise), other.baseHz, rate, spec);
      const g = 10 ** (30 / 20);
      for (let k = 0; k < loud.length; k++) w[at + k] += g * loud[k]!;
      const frames = demod.decode(w, ours.baseHz);
      expect(frames[0]?.payload, `channel ${ours.number}`).toEqual(payload);
    }
  });
});
