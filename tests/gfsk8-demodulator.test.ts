import { describe, expect, it } from 'vitest';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_NORMAL as spec } from '../src/protocol/gfsk8/spec';
import { deepExtraSec, windowDurationSec, windowLeadSec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const BASE_HZ = 1000;
const codec = new Gfsk8Codec(spec);

function randomPayload(random: () => number): Uint8Array {
  const p = randomBits(random, PAYLOAD_BITS);
  p[0] = 1;
  return p;
}

interface Options {
  rate: number;
  payload: Uint8Array;
  /** Frame start relative to the slot boundary, seconds. */
  offsetSec?: number;
  /** Offset of the actual signal from the nominal channel, Hz. */
  freqOffsetHz?: number;
  snrDb?: number;
  random: () => number;
  /** A second, stronger signal on another frequency: [baseHz, level relative to ours in dB]. */
  interferer?: [number, number];
  /** Deep decoding: the window is this much wider on each side. */
  extraSec?: number;
}

/** A slot window as the recorder would cut it: lead time of quiet, then the frame at its offset. */
function makeWindow(o: Options): Float32Array {
  const { rate, random } = o;
  const extra = o.extraSec ?? 0;
  const total = Math.round((windowDurationSec(spec) + 2 * extra) * rate);
  const w = new Float32Array(total);
  const at = Math.round((windowLeadSec(spec) + extra + (o.offsetSec ?? 0)) * rate);
  const frame = synthesizeFrame(codec.encode(o.payload), BASE_HZ + (o.freqOffsetHz ?? 0), rate, spec);
  w.set(frame, at);
  if (o.interferer) {
    const [hz, db] = o.interferer;
    const other = synthesizeFrame(codec.encode(randomPayload(random)), hz, rate, spec);
    const g = 10 ** (db / 20);
    for (let i = 0; i < other.length; i++) w[at + i] += g * other[i]!;
  }
  if (o.snrDb !== undefined) {
    // Noise power in a 2500 Hz reference bandwidth, against a unit-amplitude sine (power 0.5).
    const sigma = Math.sqrt((0.5 / 10 ** (o.snrDb / 10)) * (rate / 2 / 2500));
    for (let i = 0; i < total; i++) w[i] += sigma * gaussian(random);
  }
  return w;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe('Gfsk8Demodulator', () => {
  for (const rate of [12000, 44100, 48000]) {
    describe(`${rate} Hz`, () => {
      const demod = new Gfsk8Demodulator(rate, spec, codec);

      it('finds a clean frame and reports where it was', () => {
        const random = rng(rate);
        const payload = randomPayload(random);
        const frames = demod.decode(makeWindow({ rate, payload, offsetSec: 0.5, random }), BASE_HZ);
        expect(frames).toHaveLength(1);
        expect(same(frames[0]!.payload, payload)).toBe(true);
        expect(frames[0]!.timeOffsetSec).toBeCloseTo(0.5, 1);
        expect(Math.abs(frames[0]!.timeOffsetSec - 0.5)).toBeLessThan(0.02);
        expect(Math.abs(frames[0]!.freqHz - BASE_HZ)).toBeLessThan(0.6);
      });

      it('finds it anywhere in the allowed +-2 s of clock error', () => {
        const random = rng(rate + 1);
        for (const offsetSec of [-1.95, -1, 0, 0.3, 1, 1.95]) {
          const payload = randomPayload(random);
          const frames = demod.decode(makeWindow({ rate, payload, offsetSec, random }), BASE_HZ);
          expect(frames, `offset ${offsetSec}`).toHaveLength(1);
          expect(same(frames[0]!.payload, payload)).toBe(true);
          expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.02);
        }
      });

      it('with deep decoding, finds a frame up to 3 s beyond the usual +-2 s', () => {
        const random = rng(rate + 7);
        const extraSec = deepExtraSec(spec);
        expect(extraSec).toBe(3);
        const lead = windowLeadSec(spec) + extraSec;
        for (const offsetSec of [-4.9, -3.1, 0.2, 2.6, 4.9]) {
          const payload = randomPayload(random);
          const window = makeWindow({ rate, payload, offsetSec, random, extraSec, snrDb: -10 });
          const frames = demod.decode(window, BASE_HZ, lead);
          expect(frames, `offset ${offsetSec}`).toHaveLength(1);
          expect(same(frames[0]!.payload, payload)).toBe(true);
          expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.02);
        }
      });

      it('follows a transmitter a few Hz off the nominal channel', () => {
        const random = rng(rate + 2);
        for (const freqOffsetHz of [-4.4, -1.6, 2.7, 4.0]) {
          const payload = randomPayload(random);
          const frames = demod.decode(makeWindow({ rate, payload, freqOffsetHz, random }), BASE_HZ);
          expect(frames, `freq offset ${freqOffsetHz}`).toHaveLength(1);
          expect(same(frames[0]!.payload, payload)).toBe(true);
          expect(Math.abs(frames[0]!.freqHz - (BASE_HZ + freqOffsetHz))).toBeLessThan(0.8);
        }
      });
    });
  }

  const rate = 12000;
  const demod = new Gfsk8Demodulator(rate, spec, codec);

  it('decodes through heavy noise', () => {
    const random = rng(11);
    let ok = 0;
    for (let t = 0; t < 6; t++) {
      const payload = randomPayload(random);
      const offsetSec = (random() - 0.5) * 3.6;
      const frames = demod.decode(makeWindow({ rate, payload, offsetSec, snrDb: -14, random }), BASE_HZ);
      if (frames.length === 1 && same(frames[0]!.payload, payload)) ok++;
    }
    expect(ok).toBe(6);
  });

  it('is not thrown by a much stronger signal in the next channel', () => {
    // 196 Hz is a far closer neighbour than the plan ever has (643 Hz), so this is a
    // worst case: a loud station right beside a weak one, +20 dB.
    const random = rng(12);
    for (const neighbour of [BASE_HZ - 196, BASE_HZ + 196]) {
      const payload = randomPayload(random);
      const frames = demod.decode(
        makeWindow({ rate, payload, snrDb: -8, random, interferer: [neighbour, 20] }),
        BASE_HZ,
      );
      expect(frames).toHaveLength(1);
      expect(same(frames[0]!.payload, payload)).toBe(true);
    }
  });

  it('finds nothing in silence or noise, and never invents a frame', () => {
    const random = rng(13);
    const silence = new Float32Array(Math.round(windowDurationSec(spec) * rate));
    expect(demod.decode(silence, BASE_HZ)).toEqual([]);
    for (let t = 0; t < 10; t++) {
      const noise = silence.map(() => gaussian(random));
      expect(demod.decode(noise, BASE_HZ)).toEqual([]);
    }
  });

  it('listens only to its own channel', () => {
    // A very strong station (+40 dB SNR) on the next channel. The low-pass leaves
    // a residue ~74 dB down, well under any real noise floor, so it must not show
    // up on the neighbouring channels. (With no noise at all that residue would
    // still be decodable, which is why the noise is here.)
    const random = rng(14);
    const payload = randomPayload(random);
    const w = makeWindow({ rate, payload, snrDb: 40, random });
    expect(demod.decode(w, BASE_HZ)).toHaveLength(1); // the station itself is heard
    for (const other of [BASE_HZ + 196, BASE_HZ - 196, BASE_HZ + 392, BASE_HZ - 392]) {
      expect(demod.decode(w, other), `channel at ${other} Hz`).toEqual([]);
    }
  });

  it('reports one frame, not several, for one transmission', () => {
    const random = rng(15);
    const payload = randomPayload(random);
    expect(demod.decode(makeWindow({ rate, payload, random }), BASE_HZ)).toHaveLength(1);
  });

  it('estimates SNR to within a few dB', () => {
    // Estimates against the true SNR the test put in, in a 2500 Hz reference bandwidth.
    const random = rng(16);
    for (const snrDb of [-6, -10, -14]) {
      const errors: number[] = [];
      for (let t = 0; t < 4; t++) {
        const payload = randomPayload(random);
        const frames = demod.decode(makeWindow({ rate, payload, snrDb, random }), BASE_HZ);
        expect(frames).toHaveLength(1);
        errors.push(frames[0]!.snrDb - snrDb);
      }
      const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
      expect(Math.abs(mean), `snr ${snrDb}: mean error ${mean.toFixed(1)} dB`).toBeLessThan(3);
    }
  });
});
