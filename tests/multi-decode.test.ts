import { describe, expect, it } from 'vitest';
import { ULTRASONIC_BAND, listChannels } from '../src/band/band-plan';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_NORMAL as spec } from '../src/protocol/gfsk8/spec';
import { decodeChannels, distinctFrames, type ChannelDecode } from '../src/protocol/multi-decode';
import { windowDurationSec, windowLeadSec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const rate = 48000;
const codec = new Gfsk8Codec(spec);

describe('decodeChannels', () => {
  it('decodes stations on different channels of one window, and nothing on the empty ones', () => {
    const random = rng(21);
    const channels = listChannels(spec, ULTRASONIC_BAND);
    const w = new Float32Array(Math.round(windowDurationSec(spec) * rate));
    for (let i = 0; i < w.length; i++) w[i] = 0.02 * gaussian(random);
    const at = Math.round(windowLeadSec(spec) * rate);
    const sent = new Map<number, Uint8Array>();
    // Different start offsets and levels: the stations are not in lockstep.
    for (const [i, delaySamples, gain] of [[1, 0, 0.3], [4, 2400, 0.1], [8, -3600, 0.5]] as const) {
      const payload = randomBits(random, PAYLOAD_BITS);
      payload[0] = 1;
      sent.set(i, payload);
      const s = synthesizeFrame(codec.encode(payload), channels[i]!.baseHz, rate, spec);
      for (let k = 0; k < s.length; k++) w[at + delaySamples + k] += gain * s[k]!;
    }
    const demod = new Gfsk8Demodulator(rate, spec, codec);
    const result = decodeChannels(demod, w, channels.map((c) => c.baseHz));
    expect(result).toHaveLength(channels.length);
    channels.forEach((c, i) => {
      const want = sent.get(i);
      if (want) expect(result[i]!.frames[0]?.payload, `channel ${c.number}`).toEqual(want);
      else expect(result[i]!.frames, `channel ${c.number} is empty`).toHaveLength(0);
      expect(result[i]!.baseFreqHz).toBe(c.baseHz);
    });
  });
});

describe('distinctFrames', () => {
  const frame = (bits: number[], snrDb: number) => ({ payload: Uint8Array.from(bits), freqHz: 0, timeOffsetSec: 0, snrDb });
  const ch = (baseFreqHz: number, ...frames: ReturnType<typeof frame>[]): ChannelDecode => ({ baseFreqHz, frames, sync: null });

  it('keeps the strongest copy of a frame heard on two channels', () => {
    const heard = distinctFrames([ch(1000, frame([1, 0, 1], -12)), ch(1050, frame([1, 0, 1], -3))]);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.baseFreqHz).toBe(1050);
  });

  it('keeps different frames and orders them strongest first', () => {
    const heard = distinctFrames([ch(1000, frame([1, 0, 1], -12)), ch(1050, frame([0, 1, 1], -3))]);
    expect(heard.map((h) => h.baseFreqHz)).toEqual([1050, 1000]);
  });
});
