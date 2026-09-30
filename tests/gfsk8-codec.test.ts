import { describe, expect, it } from 'vitest';
import { PAYLOAD_BITS, Gfsk8Codec } from '../src/protocol/gfsk8/codec';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_NORMAL as spec } from '../src/protocol/gfsk8/spec';
import { symbolDurationSec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const BASE_HZ = 1000;
const TONES = spec.toneCount;

/** Per-symbol tone power by Goertzel over each symbol's window: an ideal-timing, ideal-frequency receiver. */
function toneEnergies(audio: Float32Array, rate: number): Float32Array {
  const sps = rate * symbolDurationSec(spec);
  const out = new Float32Array(spec.symbolCount * TONES);
  for (let k = 0; k < spec.symbolCount; k++) {
    const from = Math.round(k * sps);
    const to = Math.round((k + 1) * sps);
    for (let tone = 0; tone < TONES; tone++) {
      const w = (2 * Math.PI * (BASE_HZ + tone * spec.toneSpacingHz)) / rate;
      const coeff = 2 * Math.cos(w);
      let s1 = 0;
      let s2 = 0;
      for (let i = from; i < to; i++) {
        const s0 = audio[i]! + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      out[k * TONES + tone] = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    }
  }
  return out;
}

/** One-hot energies for a symbol sequence, plus a noise floor. */
function idealEnergies(symbols: Uint8Array, floor = 0.001): Float32Array {
  const e = new Float32Array(symbols.length * TONES).fill(floor);
  symbols.forEach((s, k) => (e[k * TONES + s] = 1));
  return e;
}

const codec = new Gfsk8Codec(spec);

describe('Gfsk8Codec.encode', () => {
  const payload = randomBits(rng(1), PAYLOAD_BITS);
  const symbols = codec.encode(payload);

  it('makes a 79-symbol frame with the sync blocks in place', () => {
    expect(symbols).toHaveLength(79);
    for (const s of symbols) expect(s).toBeLessThan(8);
    for (const start of spec.syncStarts) {
      expect([...symbols.subarray(start, start + 7)]).toEqual([...spec.syncPattern]);
    }
  });

  it('is deterministic, and different payloads give different frames', () => {
    expect([...codec.encode(payload)]).toEqual([...symbols]);
    expect([...codec.encode(randomBits(rng(2), PAYLOAD_BITS))]).not.toEqual([...symbols]);
  });

  it('uses all 8 tones across a random payload', () => {
    expect(new Set(symbols).size).toBe(8);
  });

  it('rejects a wrong-sized or non-binary payload', () => {
    expect(() => codec.encode(new Uint8Array(76))).toThrow(RangeError);
    expect(() => codec.encode(new Uint8Array(PAYLOAD_BITS).fill(2))).toThrow(RangeError);
  });
});

describe('Gray mapping', () => {
  it('makes neighbouring tones differ in exactly one bit', () => {
    const gray = [0, 1, 3, 2, 5, 6, 4, 7]; // bits -> tone, as in the codec
    const bitsOfTone = new Map(gray.map((tone, bits) => [tone, bits]));
    for (let t = 0; t < 7; t++) {
      const diff = bitsOfTone.get(t)! ^ bitsOfTone.get(t + 1)!;
      expect([1, 2, 4]).toContain(diff);
    }
  });
});

describe('Gfsk8Codec.decode from ideal tone energies', () => {
  it('recovers the payload for many random messages', () => {
    const random = rng(3);
    for (let i = 0; i < 100; i++) {
      const payload = randomBits(random, PAYLOAD_BITS);
      payload[0] = 1; // an all-zero payload is refused on purpose, see below
      const decoded = codec.decode(idealEnergies(codec.encode(payload)));
      expect(decoded).not.toBeNull();
      expect([...decoded!]).toEqual([...payload]);
    }
  });

  /**
   * Damage `count` random data symbols: the wrong tone gets full energy, the right
   * one gets `correctEnergy`. Counts what the decoder did with each of `trials`
   * random payloads.
   */
  function outcomes(count: number, correctEnergy: number, trials: number, seed: number) {
    const random = rng(seed);
    const dataPositions = Array.from({ length: spec.symbolCount }, (_, i) => i).filter(
      (i) => !spec.syncStarts.some((start) => i >= start && i < start + spec.syncPattern.length),
    );
    const result = { ok: 0, refused: 0, wrong: 0 };
    for (let t = 0; t < trials; t++) {
      const payload = randomBits(random, PAYLOAD_BITS);
      payload[0] = 1;
      const symbols = codec.encode(payload);
      const e = idealEnergies(symbols);
      const shuffled = [...dataPositions].sort(() => random() - 0.5).slice(0, count);
      for (const k of shuffled) {
        const wrong = (symbols[k]! + 1 + Math.floor(random() * 7)) % 8;
        e[k * TONES + symbols[k]!] = correctEnergy;
        e[k * TONES + wrong] = 1;
      }
      const decoded = codec.decode(e);
      if (decoded === null) result.refused++;
      else if (decoded.every((b, i) => b === payload[i])) result.ok++;
      else result.wrong++;
    }
    return result;
  }

  // Measured, 300 payloads per point (this decoder, random error positions):
  //   confidently wrong symbols (right tone at the noise floor): 3 and 4 -> 300/300,
  //     5 -> 290/300. Errors the decoder cannot tell from good symbols are limited
  //     by the code's distance, so this is the hard edge.
  //   ambiguous errors (right tone at 0.6 of the wrong one): 8, 12, 16 -> 300/300,
  //     20 -> 300/300 in one run and 1 in 30 refused in another, 30 -> ~70%.
  //     This is the realistic case: noise makes a symbol doubtful, not confidently
  //     wrong, and soft decoding uses that.
  // The tests sit inside the reliable region so they stay deterministic.
  it('corrects confidently wrong symbols, up to the code\'s limit', () => {
    expect(outcomes(4, 0.001, 30, 41).ok).toBe(30);
  });

  it('corrects a fifth of the data symbols when the errors are ambiguous', () => {
    expect(outcomes(12, 0.6, 30, 42).ok).toBe(30);
  });

  it('never returns wrong data: past its limit it refuses the frame', () => {
    for (const [count, energy] of [[8, 0.001], [30, 0.6]] as const) {
      const r = outcomes(count, energy, 100, 43);
      expect(r.wrong).toBe(0);
      expect(r.refused).toBeGreaterThan(0); // really is past the limit, so the check means something
    }
  });

  it('ignores whatever is in the sync symbols', () => {
    const payload = randomBits(rng(5), PAYLOAD_BITS);
    payload[0] = 1;
    const symbols = codec.encode(payload);
    const scrambled = symbols.slice();
    for (const start of spec.syncStarts) for (let i = 0; i < 7; i++) scrambled[start + i] = (i * 5) % 8;
    expect([...codec.decode(idealEnergies(scrambled))!]).toEqual([...payload]);
  });

  it('refuses noise, every time', () => {
    const random = rng(6);
    let falseDecodes = 0;
    for (let i = 0; i < 200; i++) {
      const e = new Float32Array(spec.symbolCount * TONES);
      // Exponentially distributed power = the energy of a complex Gaussian noise bin.
      for (let j = 0; j < e.length; j++) e[j] = -Math.log(random() + 1e-12);
      if (codec.decode(e) !== null) falseDecodes++;
    }
    expect(falseDecodes).toBe(0);
  });

  it('refuses silence and flat energy without throwing', () => {
    expect(codec.decode(new Float32Array(spec.symbolCount * TONES))).toBeNull();
    expect(codec.decode(new Float32Array(spec.symbolCount * TONES).fill(1))).toBeNull();
  });

  it('never returns the all-zero payload', () => {
    // It has CRC 0 and a valid codeword: exactly what BP settles on for noise.
    expect(codec.decode(idealEnergies(codec.encode(new Uint8Array(PAYLOAD_BITS))))).toBeNull();
  });

  it('rejects a wrong-sized energy array', () => {
    expect(() => codec.decode(new Float32Array(10))).toThrow(RangeError);
  });
});

describe('transmit-side loopback: codec -> modulator audio -> tone energies -> codec', () => {
  for (const rate of [44100, 48000, 96000]) {
    it(`recovers the payload from audio at ${rate} Hz`, () => {
      const random = rng(rate);
      const payload = randomBits(random, PAYLOAD_BITS);
      payload[0] = 1;
      const audio = synthesizeFrame(codec.encode(payload), BASE_HZ, rate, spec);
      const decoded = codec.decode(toneEnergies(audio, rate));
      expect(decoded).not.toBeNull();
      expect([...decoded!]).toEqual([...payload]);
    });
  }

  it('still decodes with a lot of white noise added', () => {
    // Noise power measured in a 2500 Hz reference bandwidth, the usual way to quote
    // weak-signal SNR. Ideal timing and frequency are assumed, so this is the
    // codec's limit, not a full receiver's. One-off sweep, 8 frames per point:
    //   -18 dB: 8/8, -19 dB: 7/8, -20 dB: 1/8, -22 dB: 0/8, and never a wrong payload.
    // FT8 quotes about -21 dB. -10 dB here leaves a wide margin so the test is stable.
    const rate = 12000;
    const snrDb = -10;
    const random = rng(99);
    const sigma = Math.sqrt((0.5 / 10 ** (snrDb / 10)) * (rate / 2 / 2500));
    let ok = 0;
    const trials = 10;
    for (let t = 0; t < trials; t++) {
      const payload = randomBits(random, PAYLOAD_BITS);
      payload[0] = 1;
      const audio = synthesizeFrame(codec.encode(payload), BASE_HZ, rate, spec);
      for (let i = 0; i < audio.length; i++) audio[i] += sigma * gaussian(random);
      const decoded = codec.decode(toneEnergies(audio, rate));
      if (decoded && decoded.every((b, i) => b === payload[i])) ok++;
    }
    expect(ok).toBe(trials);
  });
});
