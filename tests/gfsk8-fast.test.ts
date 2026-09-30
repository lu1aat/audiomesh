import { describe, expect, it } from 'vitest';
import {
  AUDIBLE_BAND, LOW_BAND, ULTRASONIC_BAND, bandFits, bandsFor, channelAt, channelForFrequency, effectiveChannelCount, listChannels,
} from '../src/band/band-plan';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_FAST as spec, GFSK8_NORMAL } from '../src/protocol/gfsk8/spec';
import { getProtocol } from '../src/protocol/registry';
import { bandwidthHz, frameDurationSec, windowDurationSec, windowLeadSec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const codec = new Gfsk8Codec(spec);
const BASE_HZ = 1000;

const payloadOf = (random: () => number): Uint8Array => {
  const p = randomBits(random, PAYLOAD_BITS);
  p[0] = 1;
  return p;
};

interface Options {
  rate: number;
  payload: Uint8Array;
  baseHz?: number;
  offsetSec?: number;
  freqOffsetHz?: number;
  snrDb?: number;
  random: () => number;
  /** A second signal: [baseHz, level relative to ours in dB]. */
  interferer?: [number, number];
}

function makeWindow(o: Options): Float32Array {
  const { rate, random } = o;
  const total = Math.round(windowDurationSec(spec) * rate);
  const w = new Float32Array(total);
  const at = Math.round((windowLeadSec(spec) + (o.offsetSec ?? 0)) * rate);
  const base = o.baseHz ?? BASE_HZ;
  w.set(synthesizeFrame(codec.encode(o.payload), base + (o.freqOffsetHz ?? 0), rate, spec), at);
  if (o.interferer) {
    const [hz, db] = o.interferer;
    const other = synthesizeFrame(codec.encode(payloadOf(random)), hz, rate, spec);
    const g = 10 ** (db / 20);
    for (let i = 0; i < other.length; i++) w[at + i] += g * other[i]!;
  }
  if (o.snrDb !== undefined) {
    const sigma = Math.sqrt((0.5 / 10 ** (o.snrDb / 10)) * (rate / 2 / 2500));
    for (let i = 0; i < total; i++) w[i] += sigma * gaussian(random);
  }
  return w;
}

const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

describe('gfsk8-fast spec and registry', () => {
  it('is registered, cloneable, and 25 baud with the same frame layout', () => {
    expect(getProtocol('gfsk8-fast').spec).toBe(spec);
    expect(structuredClone(spec)).toEqual(spec);
    expect(spec.symbolCount).toBe(GFSK8_NORMAL.symbolCount);
    expect(spec.payloadBits).toBe(GFSK8_NORMAL.payloadBits);
    expect(bandwidthHz(spec)).toBe(200);
  });

  it('fits its frame and the clock allowance in its slot, and is 3x the throughput', () => {
    expect(frameDurationSec(spec)).toBeCloseTo(3.16, 2);
    expect(windowDurationSec(spec)).toBeLessThan(spec.slotSec);
    expect(GFSK8_NORMAL.slotSec / spec.slotSec).toBe(3);
  });
});

describe('band plan for gfsk8-fast', () => {
  it('fits only 1 of the low band\'s 3 channels (edge to edge, no guard margin), and keeps the rest whole', () => {
    expect(bandFits(spec, LOW_BAND)).toBe(true);
    expect(effectiveChannelCount(spec, LOW_BAND)).toBe(1);
    expect(bandsFor(spec)).toEqual([LOW_BAND, AUDIBLE_BAND, ULTRASONIC_BAND]);
    expect(bandsFor(GFSK8_NORMAL)).toHaveLength(3);
    const ch1 = channelAt(spec, 1);
    expect(ch1.baseHz).toBe(100);
    expect(ch1.baseHz + bandwidthHz(spec)).toBe(300); // fills the whole 200 Hz band, no margin
    expect(() => channelAt(spec, 2)).toThrow(RangeError); // channels 2 and 3 don't exist for this protocol
    expect(() => channelAt(spec, 3)).toThrow(RangeError);
    expect(listChannels(spec).map((c) => c.number)).toEqual([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('keeps channels apart with room to spare', () => {
    for (const band of [AUDIBLE_BAND, ULTRASONIC_BAND]) {
      const ch = listChannels(spec, band);
      for (let i = 0; i + 1 < ch.length; i++) {
        expect(ch[i + 1]!.baseHz - (ch[i]!.baseHz + bandwidthHz(spec))).toBeGreaterThan(150);
      }
    }
    expect(channelForFrequency(spec, 150)).toBeNull();
    expect(channelForFrequency(spec, 17520)?.number).toBe(8);
  });
});

describe('Gfsk8Demodulator at 25 baud', () => {
  for (const rate of [44100, 48000, 96000]) {
    describe(`${rate} Hz`, () => {
      const demod = new Gfsk8Demodulator(rate, spec, codec);

      it('finds a clean frame and reports where it was', () => {
        const random = rng(rate);
        const payload = payloadOf(random);
        const frames = demod.decode(makeWindow({ rate, payload, offsetSec: 0.2, random }), BASE_HZ);
        expect(frames).toHaveLength(1);
        expect(same(frames[0]!.payload, payload)).toBe(true);
        expect(Math.abs(frames[0]!.timeOffsetSec - 0.2)).toBeLessThan(0.01);
        expect(Math.abs(frames[0]!.freqHz - BASE_HZ)).toBeLessThan(2.5);
      });

      it('finds it anywhere in the allowed +-0.9 s of clock error', () => {
        const random = rng(rate + 1);
        for (const offsetSec of [-0.88, -0.5, 0, 0.1, 0.6, 0.88]) {
          const payload = payloadOf(random);
          const frames = demod.decode(makeWindow({ rate, payload, offsetSec, random }), BASE_HZ);
          expect(frames, `offset ${offsetSec}`).toHaveLength(1);
          expect(same(frames[0]!.payload, payload)).toBe(true);
          expect(Math.abs(frames[0]!.timeOffsetSec - offsetSec)).toBeLessThan(0.01);
        }
      });

      it('follows a transmitter several Hz off the nominal channel', () => {
        const random = rng(rate + 2);
        for (const freqOffsetHz of [-7.5, -3.3, 2.7, 6, 7.5]) {
          const payload = payloadOf(random);
          const frames = demod.decode(makeWindow({ rate, payload, freqOffsetHz, random }), BASE_HZ);
          expect(frames, `freq offset ${freqOffsetHz}`).toHaveLength(1);
          expect(same(frames[0]!.payload, payload)).toBe(true);
        }
      });
    });
  }

  const rate = 48000;
  const demod = new Gfsk8Demodulator(rate, spec, codec);

  it('decodes through noise at -8 dB in 2500 Hz', () => {
    const random = rng(21);
    let ok = 0;
    for (let t = 0; t < 6; t++) {
      const payload = payloadOf(random);
      const offsetSec = (random() - 0.5) * 1.6;
      const frames = demod.decode(makeWindow({ rate, payload, offsetSec, snrDb: -8, random }), BASE_HZ);
      if (frames.length === 1 && same(frames[0]!.payload, payload)) ok++;
    }
    expect(ok).toBe(6);
  });

  it('never returns a wrong payload, even where decoding starts to fail', () => {
    const random = rng(22);
    for (const snrDb of [-13, -15]) {
      for (let t = 0; t < 4; t++) {
        const payload = payloadOf(random);
        const frames = demod.decode(makeWindow({ rate, payload, snrDb, random }), BASE_HZ);
        for (const f of frames) expect(same(f.payload, payload), `snr ${snrDb}`).toBe(true);
      }
    }
  });

  it('finds nothing in silence or noise', () => {
    const random = rng(23);
    const silence = new Float32Array(Math.round(windowDurationSec(spec) * rate));
    expect(demod.decode(silence, BASE_HZ)).toEqual([]);
    for (let t = 0; t < 10; t++) expect(demod.decode(silence.map(() => gaussian(random)), BASE_HZ)).toEqual([]);
  });

  it('decodes every low, audible and ultrasonic channel, including the low band\'s single edge-to-edge one', () => {
    const random = rng(24);
    for (const band of [LOW_BAND, AUDIBLE_BAND, ULTRASONIC_BAND]) {
      for (const ch of listChannels(spec, band)) {
        const payload = payloadOf(random);
        const frames = demod.decode(makeWindow({ rate, payload, baseHz: ch.baseHz, random }), ch.baseHz);
        expect(same(frames[0]?.payload, payload), `channel ${ch.number}`).toBe(true);
      }
    }
  });

  it('decodes an ultrasonic channel next to a 30 dB stronger neighbour, and hears only its own channel', () => {
    const random = rng(25);
    const ch = listChannels(spec, ULTRASONIC_BAND);
    for (const i of [0, 4, 9]) {
      const ours = ch[i]!;
      const other = ch[i === 9 ? i - 1 : i + 1]!;
      const payload = payloadOf(random);
      const w = makeWindow({ rate, payload, baseHz: ours.baseHz, snrDb: 0, random, interferer: [other.baseHz, 30] });
      expect(same(demod.decode(w, ours.baseHz)[0]?.payload, payload), `channel ${ours.number}`).toBe(true);
    }
    // A loud station (+40 dB) on channel 12 must not appear on its neighbours.
    const loud = ch[4]!;
    const w = makeWindow({ rate, payload: payloadOf(random), baseHz: loud.baseHz, snrDb: 40, random });
    expect(demod.decode(w, loud.baseHz)).toHaveLength(1);
    for (const other of [ch[3]!, ch[5]!, ch[2]!, ch[6]!]) expect(demod.decode(w, other.baseHz)).toEqual([]);
  });
});

describe('fast protocol through the slot recorder', () => {
  it('cuts 4.16 s windows every 5 s and decodes a frame sent in each slot', async () => {
    const { SlotRecorder } = await import('../src/dsp/slot-recorder');
    const rate = 48000;
    const random = rng(31);
    const demod = new Gfsk8Demodulator(rate, spec, codec);
    const recorder = new SlotRecorder(rate, spec);
    recorder.setSlotOrigin(0);
    const payloads = [payloadOf(random), payloadOf(random), payloadOf(random)];
    const stream = new Float32Array(rate * 20);
    // Frames start 0.2 s late in slots 1, 2 and 3 (slot 0 is skipped: it starts before recording).
    payloads.forEach((p, i) => {
      const at = Math.round((spec.slotSec * (i + 1) + 0.2) * rate);
      stream.set(synthesizeFrame(codec.encode(p), BASE_HZ, rate, spec), at);
    });
    const got: { slot: number; payload: Uint8Array }[] = [];
    const lengths = new Set<number>();
    for (let at = 0; at < stream.length; at += 128) {
      const w = recorder.process(stream.slice(at, at + 128), at);
      if (!w) continue;
      lengths.add(w.samples.length);
      for (const f of demod.decode(w.samples, BASE_HZ)) got.push({ slot: w.slotIndex, payload: f.payload });
    }
    expect([...lengths]).toEqual([Math.round(windowDurationSec(spec) * rate)]);
    expect(got.map((g) => g.slot)).toEqual([1, 2, 3]); // slot 4's window would end at 23.7 s, past the recording
    got.forEach((g, i) => expect(same(g.payload, payloads[i]!)).toBe(true));
  });
});
