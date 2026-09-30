import { describe, expect, it } from 'vitest';
import { CAPTURE_MAX_BLOCK_IMBALANCE_DB } from '../src/dsp/window-capture';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_FAST as spec } from '../src/protocol/gfsk8/spec';
import { getProtocol } from '../src/protocol/registry';
import { symbolDurationSec, windowDurationSec, windowLeadSec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const rate = 48000;
const base = 19000;
const codec = new Gfsk8Codec(spec);
const lead = windowLeadSec(spec);

function windowWith(keepSymbols: number, snrDb: number, seed: number): Float32Array {
  const random = rng(seed);
  const payload = randomBits(random, PAYLOAD_BITS);
  payload[0] = 1;
  const total = Math.round(windowDurationSec(spec) * rate);
  const w = new Float32Array(total);
  const frame = synthesizeFrame(codec.encode(payload), base, rate, spec);
  // A neighbour slot's frame seen through the edge of the window: only its first symbols are in it.
  const kept = Math.min(frame.length, Math.round(keepSymbols * symbolDurationSec(spec) * rate));
  w.set(frame.subarray(0, kept), Math.round((lead + 0.3) * rate));
  const sigma = Math.sqrt((0.5 / 10 ** (snrDb / 10)) * (rate / 2 / 2500));
  for (let i = 0; i < total; i++) w[i] += sigma * gaussian(random);
  return w;
}

describe('SyncReport.blocks', () => {
  const demodulator = getProtocol('gfsk8-fast').createDemodulator(rate);

  it('are level with each other for a whole frame, even a weak one, and for noise', () => {
    for (const [snr, seed] of [[-5, 1], [-14, 2]] as const) {
      demodulator.decode(windowWith(79, snr, seed), base, lead);
      const sync = demodulator.lastSync!;
      expect(sync.blocks).toHaveLength(3);
      expect(sync.blockImbalanceDb!).toBeLessThan(CAPTURE_MAX_BLOCK_IMBALANCE_DB);
    }
  });

  it('show one loud block for the head of a frame (the rest of the window is noise), although the whole-window score is high', () => {
    demodulator.decode(windowWith(7, 0, 3), base, lead);
    const sync = demodulator.lastSync!;
    expect(sync.score).toBeGreaterThan(0.3); // what fooled the first capture filter
    expect(Math.max(...sync.blocks!)).toBeGreaterThan(0.6);
    expect(sync.blockImbalanceDb!).toBeGreaterThan(CAPTURE_MAX_BLOCK_IMBALANCE_DB);
  });

  it('do not flag noise-only windows as lopsided', () => {
    for (const seed of [5, 6, 7]) {
      demodulator.decode(windowWith(0, -60, seed), base, lead);
      const sync = demodulator.lastSync;
      if (sync) expect(sync.blockImbalanceDb!).toBeLessThan(CAPTURE_MAX_BLOCK_IMBALANCE_DB);
    }
  });
});
