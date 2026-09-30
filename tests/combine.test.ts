import { describe, expect, it } from 'vitest';
import { CandidatePool, POOL_MAX_AGE_SLOTS, decodeChannelsCombining } from '../src/protocol/combine';
import type { FrameCodec, UndecodedCandidate } from '../src/protocol/protocol';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_FAST as spec } from '../src/protocol/gfsk8/spec';
import { getProtocol } from '../src/protocol/registry';
import { windowDurationSec, windowLeadSec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const SLOT_MS = spec.slotSec * 1000;
const PAYLOAD = Uint8Array.from({ length: PAYLOAD_BITS }, (_, i) => i % 2);

/** A codec that accepts any combination whose first energy is the marker, to test the pool's bookkeeping alone. */
function stubCodec(accept: (copies: readonly Float32Array[]) => boolean): FrameCodec & { calls: number } {
  const c = {
    calls: 0,
    encode: () => new Uint8Array(0),
    decode: () => null,
    decodeCombined(copies: readonly Float32Array[]) {
      c.calls++;
      return accept(copies) ? PAYLOAD : null;
    },
  };
  return c;
}

const cand = (dt: number, score = 0.4, tag = 0): UndecodedCandidate => ({
  energies: Float32Array.of(tag), score, freqHz: 1000, timeOffsetSec: dt,
});

describe('CandidatePool bookkeeping', () => {
  it('pairs a candidate only with earlier slots and with the same start time', () => {
    const codec = stubCodec(() => true);
    const pool = new CandidatePool(codec, spec);
    pool.add(10 * SLOT_MS, cand(0.1));
    expect(pool.resolve(10 * SLOT_MS, cand(0.1))).toBeNull(); // the same window never pairs with itself
    expect(pool.resolve(11 * SLOT_MS, cand(0.5))).toBeNull(); // a different start time is a different frame
    expect(codec.calls).toBe(0);
    const hit = pool.resolve(11 * SLOT_MS, cand(0.1 + 0.005));
    expect(hit?.energies).toHaveLength(2);
    expect(pool.size).toBe(0); // the used reception is consumed
  });

  it('tolerates the start time wandering as it does on the air (0.267 s and 0.156 s for one sender)', () => {
    const pool = new CandidatePool(stubCodec(() => true), spec);
    pool.add(SLOT_MS, cand(0.267));
    expect(pool.resolve(2 * SLOT_MS, cand(0.156))?.energies).toHaveLength(2);
    pool.add(SLOT_MS, cand(0.267));
    expect(pool.resolve(2 * SLOT_MS, cand(0.5))).toBeNull(); // 0.23 s apart is too far
  });

  it('forgets receptions that are too old, and keeps the strongest when full', () => {
    const pool = new CandidatePool(stubCodec(() => true), spec, 3);
    pool.add(0, cand(0.1, 0.3));
    pool.prune((POOL_MAX_AGE_SLOTS + 1) * SLOT_MS);
    expect(pool.size).toBe(0);
    const tried: number[] = [];
    const full = new CandidatePool(stubCodec((copies) => { if (copies.length === 2) tried.push(copies[1]![0]!); return false; }), spec, 3);
    for (const score of [0.5, 0.3, 0.4, 0.6]) full.add(SLOT_MS, cand(0.1, score, score * 10));
    expect(full.size).toBe(3);
    full.resolve(2 * SLOT_MS, cand(0.1));
    expect(tried).toEqual([6, 5, 4]); // strongest first; the 0.3 reception was dropped
  });

  it('tries triples when no pair decodes, never more than three receptions', () => {
    const pool = new CandidatePool(stubCodec((copies) => copies.length === 3), spec);
    pool.add(SLOT_MS, cand(0.1));
    pool.add(2 * SLOT_MS, cand(0.1));
    const hit = pool.resolve(3 * SLOT_MS, cand(0.1));
    expect(hit?.energies).toHaveLength(3);
    expect(pool.size).toBe(0);
  });
});

it('stops after a bounded number of attempts per candidate', () => {
  const codec = stubCodec(() => false);
  const pool = new CandidatePool(codec, spec);
  for (let i = 0; i < 30; i++) pool.add(SLOT_MS * (1 + i % 5), cand(0.1, 0.3 + i / 1000));
  pool.resolve(10 * SLOT_MS, cand(0.1));
  expect(codec.calls).toBeLessThanOrEqual(48);
  expect(codec.calls).toBeGreaterThan(30); // all the pairs were tried first
});

describe('codec.decodeCombined', () => {
  const codec = new Gfsk8Codec(spec);

  it('decodes clean copies of a frame, like decode, and refuses copies of different frames', () => {
    const energiesOf = (payload: Uint8Array): Float32Array => {
      const symbols = codec.encode(payload);
      const e = new Float32Array(79 * 8).fill(0.01);
      symbols.forEach((tone, k) => { e[k * 8 + tone] = 1; });
      return e;
    };
    const a = energiesOf(PAYLOAD);
    expect(codec.decodeCombined([a])).toEqual(PAYLOAD);
    expect(codec.decodeCombined([a, a])).toEqual(PAYLOAD);
    const other = Uint8Array.from(PAYLOAD, (b, i) => (i < 40 ? 1 - b : b));
    expect(codec.decodeCombined([a, energiesOf(other)])).toBeNull();
  });

  it('scales each copy first, so a loud reception does not drown a quiet one', () => {
    const symbols = codec.encode(PAYLOAD);
    const make = (gain: number): Float32Array => {
      const e = new Float32Array(79 * 8).fill(0.01 * gain);
      symbols.forEach((tone, k) => { e[k * 8 + tone] = gain; });
      return e;
    };
    expect(codec.decodeCombined([make(1), make(1000)])).toEqual(PAYLOAD);
  });
});

describe('retransmission combining through the demodulator (Fast, 48 kHz)', () => {
  const rate = 48000;
  const base = 19000;
  const codec = new Gfsk8Codec(spec);
  const protocol = getProtocol('gfsk8-fast');
  const lead = windowLeadSec(spec);

  function windowWith(payload: Uint8Array | null, snrDb: number, random: () => number): Float32Array {
    const total = Math.round(windowDurationSec(spec) * rate);
    const w = new Float32Array(total);
    if (payload) w.set(synthesizeFrame(codec.encode(payload), base, rate, spec), Math.round((lead + 0.3) * rate));
    const sigma = Math.sqrt((0.5 / 10 ** (snrDb / 10)) * (rate / 2 / 2500));
    for (let i = 0; i < total; i++) w[i] += sigma * gaussian(random);
    return w;
  }

  it('decodes a frame sent twice at -15 dB, where one copy alone never decodes', () => {
    let alone = 0;
    let combined = 0;
    const runs = 6;
    for (let r = 0; r < runs; r++) {
      const random = rng(40 + r);
      const payload = randomBits(random, PAYLOAD_BITS);
      payload[0] = 1;
      const demodulator = protocol.createDemodulator(rate);
      const pool = new CandidatePool(protocol.createCodec(), spec);
      const first = decodeChannelsCombining(demodulator, pool, windowWith(payload, -15, random), [base], lead, 0)[0]!;
      const second = decodeChannelsCombining(demodulator, pool, windowWith(payload, -15, random), [base], lead, 10 * SLOT_MS)[0]!;
      alone += first.frames.length;
      const hit = second.frames.find((f) => f.copies === 2);
      if (hit) {
        combined++;
        expect(Array.from(hit.payload)).toEqual(Array.from(payload));
      }
      expect(second.frames.every((f) => Array.from(f.payload).join() === Array.from(payload).join())).toBe(true);
    }
    expect(alone).toBe(0);
    expect(combined).toBeGreaterThanOrEqual(4); // measured 10/12
  }, 60_000);

  it('never combines receptions of different frames, nor makes frames out of noise', () => {
    const random = rng(99);
    const demodulator = protocol.createDemodulator(rate);
    const pool = new CandidatePool(protocol.createCodec(), spec);
    let frames = 0;
    for (let k = 0; k < 12; k++) {
      // Every odd window carries a different weak frame at the same start time; the rest is noise.
      const payload = k % 2 ? randomBits(random, PAYLOAD_BITS) : null;
      if (payload) payload[0] = 1;
      frames += decodeChannelsCombining(demodulator, pool, windowWith(payload, -15, random), [base], lead, k * 5 * SLOT_MS)[0]!.frames.length;
    }
    expect(frames).toBe(0);
  }, 60_000);
});
