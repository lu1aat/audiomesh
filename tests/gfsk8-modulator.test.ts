import { describe, expect, it } from 'vitest';
import { Gfsk8Modulator, synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { GFSK8_NORMAL as spec } from '../src/protocol/gfsk8/spec';
import { buildTestFrame } from '../src/protocol/gfsk8/test-frame';
import { bandwidthHz, frameDurationSec, symbolDurationSec } from '../src/protocol/spec';

const RATES = [44100, 48000, 96000];
const BASE_HZ = 1000;

/** Power of `signal` at one frequency (Goertzel), normalised by length. */
function powerAt(signal: Float32Array, from: number, to: number, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = signal[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const n = to - from;
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
}

function peak(signal: Float32Array): number {
  let max = 0;
  for (const v of signal) max = Math.max(max, Math.abs(v));
  return max;
}

/** Index of the first difference, or -1. Far faster than toEqual on 600k samples. */
function firstMismatch(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function allZero(signal: Float32Array): boolean {
  for (const v of signal) if (v !== 0) return false;
  return true;
}

describe('synthesizeFrame loopback', () => {
  for (const rate of RATES) {
    describe(`${rate} Hz`, () => {
      const symbols = buildTestFrame(spec);
      const audio = synthesizeFrame(symbols, BASE_HZ, rate, spec);
      const sps = rate * symbolDurationSec(spec);

      it('lasts one frame', () => {
        expect(audio.length).toBe(Math.round(frameDurationSec(spec) * rate));
      });

      it('recovers every symbol by matching each symbol window against the 8 tones', () => {
        let wrong = 0;
        for (let k = 0; k < symbols.length; k++) {
          const from = Math.round(k * sps);
          const to = Math.round((k + 1) * sps);
          let best = 0;
          let bestPower = -1;
          for (let tone = 0; tone < spec.toneCount; tone++) {
            const p = powerAt(audio, from, to, BASE_HZ + tone * spec.toneSpacingHz, rate);
            if (p > bestPower) {
              bestPower = p;
              best = tone;
            }
          }
          if (best !== symbols[k]) wrong++;
        }
        expect(wrong).toBe(0);
      });

      it('never steps faster than the carrier itself (continuous phase, no clicks)', () => {
        const topHz = BASE_HZ + (spec.toneCount - 1) * spec.toneSpacingHz;
        const slewLimit = 2 * Math.PI * topHz / rate;
        let maxStep = 0;
        for (let i = 1; i < audio.length; i++) {
          maxStep = Math.max(maxStep, Math.abs(audio[i]! - audio[i - 1]!));
        }
        expect(maxStep).toBeLessThanOrEqual(slewLimit * 1.01);
      });

      it('starts and ends silent and never exceeds unit amplitude', () => {
        expect(Math.abs(audio[0]!)).toBeLessThan(1e-3);
        expect(Math.abs(audio[audio.length - 1]!)).toBeLessThan(0.05);
        expect(peak(audio)).toBeLessThanOrEqual(1.0001);
      });
    });
  }
});

describe('synthesizeFrame spectrum', () => {
  const rate = 48000;
  const audio = synthesizeFrame(buildTestFrame(spec), BASE_HZ, rate, spec);
  const inBandHz = [BASE_HZ + 10, BASE_HZ + 22, BASE_HZ + 34];
  const inBand = Math.max(...inBandHz.map((f) => powerAt(audio, 0, audio.length, f, rate)));
  const dbBelow = (hz: number) => 10 * Math.log10(powerAt(audio, 0, audio.length, hz, rate) / inBand);

  it('keeps energy out of the neighbouring channels', () => {
    // Neighbouring channels are >600 Hz apart in the plan, so anything 100 Hz outside
    // the 50 Hz channel is deep in the gap: this is a much stricter check than needed.
    for (const offset of [-150, -100, bandwidthHz(spec) + 100, bandwidthHz(spec) + 150]) {
      expect(dbBelow(BASE_HZ + offset)).toBeLessThan(-50);
    }
  });

  it('rolls off quickly just outside the channel', () => {
    expect(dbBelow(BASE_HZ - 25)).toBeLessThan(-25);
    expect(dbBelow(BASE_HZ + bandwidthHz(spec) + 25)).toBeLessThan(-25);
  });
});

describe('a constant-tone frame', () => {
  it('is a clean sine at the chosen tone', () => {
    const rate = 48000;
    const symbols = new Uint8Array(spec.symbolCount).fill(5);
    const audio = synthesizeFrame(symbols, BASE_HZ, rate, spec);
    const mid = Math.floor(audio.length / 2);
    // Zero crossings over one second: a 1031.25 Hz sine has ~2062 of them.
    let crossings = 0;
    for (let i = mid; i < mid + rate; i++) if (audio[i - 1]! <= 0 !== audio[i]! <= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(2061);
    expect(crossings).toBeLessThanOrEqual(2064);
  });
});

describe('synthesizeFrame input checks', () => {
  it('rejects symbols that are not tones', () => {
    expect(() => synthesizeFrame(new Uint8Array([0, 8]), BASE_HZ, 48000, spec)).toThrow(RangeError);
  });
  it('rejects an empty frame', () => {
    expect(() => synthesizeFrame(new Uint8Array(0), BASE_HZ, 48000, spec)).toThrow(RangeError);
  });
});

describe('Gfsk8Modulator streaming', () => {
  const rate = 48000;
  const symbols = buildTestFrame(spec);
  const whole = synthesizeFrame(symbols, BASE_HZ, rate, spec);

  function play(startSample: number, blockSize: number, totalSamples: number): Float32Array {
    const mod = new Gfsk8Modulator(rate, spec);
    mod.schedule(symbols, BASE_HZ, startSample);
    const out = new Float32Array(totalSamples);
    const block = new Float32Array(blockSize);
    for (let at = 0; at < totalSamples; at += blockSize) {
      mod.fill(block, at);
      out.set(block.subarray(0, Math.min(blockSize, totalSamples - at)), at);
    }
    return out;
  }

  it('is silent until the start sample, then plays the whole frame', () => {
    const start = 1000;
    const out = play(start, 128, start + whole.length + 500);
    expect(allZero(out.subarray(0, start))).toBe(true);
    expect(firstMismatch(out.subarray(start, start + whole.length), whole)).toBe(-1);
    expect(allZero(out.subarray(start + whole.length))).toBe(true);
  });

  it('is identical whatever the block size, including a start mid-block', () => {
    const a = play(777, 128, 777 + whole.length + 300);
    const b = play(777, 480, 777 + whole.length + 300);
    expect(firstMismatch(a, b)).toBe(-1);
  });

  it('starts at the first block when its start sample has already passed, never cut short', () => {
    const mod = new Gfsk8Modulator(rate, spec);
    mod.schedule(symbols, BASE_HZ, 0);
    const out = new Float32Array(5000 + whole.length + 100);
    const block = new Float32Array(128);
    // Blocks arrive late: the first fill is at sample 5000, well after the start.
    for (let at = 5000; at < out.length; at += 128) {
      mod.fill(block, at);
      out.set(block.subarray(0, Math.min(128, out.length - at)), at);
    }
    expect(firstMismatch(out.subarray(5000, 5000 + whole.length), whole)).toBe(-1);
  });

  it('reports busy from schedule until the last sample has been played', () => {
    const mod = new Gfsk8Modulator(rate, spec);
    const block = new Float32Array(128);
    expect(mod.busy).toBe(false);
    mod.schedule(symbols, BASE_HZ, 0);
    expect(mod.busy).toBe(true);
    let at = 0;
    while (at < whole.length) {
      mod.fill(block, at);
      at += 128;
    }
    expect(mod.busy).toBe(false);
  });

  it('cancel silences immediately', () => {
    const mod = new Gfsk8Modulator(rate, spec);
    const block = new Float32Array(128);
    mod.schedule(symbols, BASE_HZ, 0);
    mod.fill(block, 0);
    mod.cancel();
    mod.fill(block, 128);
    expect(block.every((v) => v === 0)).toBe(true);
    expect(mod.busy).toBe(false);
  });

  it('fills silence when idle', () => {
    const mod = new Gfsk8Modulator(rate, spec);
    const block = new Float32Array(128).fill(0.5);
    mod.fill(block, 0);
    expect(block.every((v) => v === 0)).toBe(true);
  });
});

describe('buildTestFrame', () => {
  it('carries the sync pattern at every sync position and is deterministic', () => {
    const a = buildTestFrame(spec);
    expect(a).toHaveLength(spec.symbolCount);
    for (const start of spec.syncStarts) {
      expect([...a.subarray(start, start + spec.syncPattern.length)]).toEqual([...spec.syncPattern]);
    }
    expect(buildTestFrame(spec)).toEqual(a);
    expect(buildTestFrame(spec, 2)).not.toEqual(a);
  });
});
