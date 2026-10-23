/**
 * The harder passes (FrameCodec.decodeHarder): other soft metrics and a priori hints, on candidates the
 * plain decode refuses. Fast at 48 kHz, unknown timing, a few Hz off the channel, white noise.
 */
import { describe, expect, it } from 'vitest';
import { ackHint, encodeFrame, soundHint } from '../src/chat/frames';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { Gfsk8Demodulator } from '../src/protocol/gfsk8/demodulator';
import { synthesizeFrame } from '../src/protocol/gfsk8/modulator';
import { SoftMetrics, logI0 } from '../src/protocol/gfsk8/soft-metrics';
import { GFSK8_FAST as spec } from '../src/protocol/gfsk8/spec';
import { LDPC_N } from '../src/protocol/gfsk8/ldpc';
import type { ApHint, DecodeOptions } from '../src/protocol/protocol';
import { windowDurationSec, windowLeadSec } from '../src/protocol/spec';
import { gaussian, randomBits, rng } from './helpers';

const rate = 48000;
const BASE_HZ = 1000;
const codec = new Gfsk8Codec(spec);
const KINDS: readonly ApHint[] = [ackHint(), soundHint()];

const payloadOf = (random: () => number): Uint8Array => {
  const p = randomBits(random, PAYLOAD_BITS);
  p[0] = 1;
  return p;
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function windowWith(payload: Uint8Array | null, snrDb: number, random: () => number): Float32Array {
  const total = Math.round(windowDurationSec(spec) * rate);
  const w = new Float32Array(total);
  if (payload) {
    const at = Math.round((windowLeadSec(spec) + (random() - 0.5) * 1.4 * spec.maxTimeOffsetSec) * rate);
    w.set(synthesizeFrame(codec.encode(payload), BASE_HZ + (random() - 0.5) * 4, rate, spec), at);
  }
  const sigma = Math.sqrt(0.5 * (rate / 2 / 2500));
  const amp = 10 ** (snrDb / 20);
  for (let i = 0; i < total; i++) w[i] = amp * w[i]! + sigma * gaussian(random);
  return w;
}

describe('soft metrics', () => {
  const layout = (() => {
    const sync = new Set<number>();
    for (const s of spec.syncStarts) for (let i = 0; i < spec.syncPattern.length; i++) sync.add(s + i);
    return Uint8Array.from({ length: spec.symbolCount }, (_, k) => k).filter((k) => !sync.has(k));
  })();
  const metrics = new SoftMetrics(layout, spec.syncStarts, spec.syncPattern, spec.symbolCount);

  /** The codeword bits behind a payload's 58 data symbols, from its tones. */
  function codeBits(symbols: Uint8Array): number[] {
    const toneBits = [0, 1, 3, 2, 6, 4, 5, 7]; // inverse of the Gray map
    return Array.from(layout).flatMap((k) => [2, 1, 0].map((s) => (toneBits[symbols[k]!]! >> s) & 1));
  }

  it('give every bit the right sign on a clean frame', () => {
    const symbols = codec.encode(payloadOf(rng(1)));
    const energies = new Float32Array(spec.symbolCount * 8).fill(0.01);
    symbols.forEach((t, k) => (energies[k * 8 + t] = 1));
    // Phase-continuous complex values: tone t turns by `advance` over a symbol.
    const advance = Float32Array.from({ length: spec.symbolCount * 8 }, (_, i) => 0.7 + (i % 8) * 1.3);
    const re = new Float32Array(spec.symbolCount * 8);
    const im = new Float32Array(spec.symbolCount * 8);
    let phase = 0.4;
    symbols.forEach((t, k) => {
      re[k * 8 + t] = Math.cos(phase);
      im[k * 8 + t] = Math.sin(phase);
      phase += advance[k * 8 + t]!;
    });
    const bits = codeBits(symbols);
    const out = new Float32Array(LDPC_N);
    const check = () => bits.forEach((b, i) => expect(out[i]! > 0 ? 1 : 0, `bit ${i}`).toBe(b));
    metrics.magnitude(energies, out);
    check();
    expect(metrics.exact(energies, out)).toBe(true);
    check();
    for (const nsym of [2, 3] as const) {
      metrics.coherent({ re, im, advance }, nsym, out);
      check();
    }
  });

  it('refuses silence instead of dividing by zero', () => {
    expect(metrics.exact(new Float32Array(spec.symbolCount * 8), new Float32Array(LDPC_N))).toBe(false);
  });

  it('computes ln I0 across both of its approximations', () => {
    for (const x of [0, 0.5, 3.7, 3.8, 10, 100]) {
      let sum = 0;
      for (let k = 0, term = 1; k < 200; k++) {
        sum += term;
        term *= (x / 2) ** 2 / ((k + 1) * (k + 1));
      }
      expect(logI0(x)).toBeCloseTo(Math.log(sum), 5);
    }
  });
});

describe('harder passes through the demodulator (Fast, 48 kHz)', () => {
  const d = new Gfsk8Demodulator(rate, spec, codec);
  const decode = (w: Float32Array, options: DecodeOptions) => d.decode(w, BASE_HZ, undefined, options);

  it('decode more weak frames than the plain decode, never a wrong one', () => {
    const random = rng(7);
    let plain = 0;
    let harder = 0;
    for (let t = 0; t < 12; t++) {
      const payload = payloadOf(random);
      const w = windowWith(payload, -14, random);
      const a = decode(w, { harder: false });
      const b = decode(w, { hints: KINDS });
      for (const f of [...a, ...b]) expect(same(f.payload, payload)).toBe(true);
      plain += a.length;
      harder += b.length;
      for (const f of b) if (!a.length) expect(f.pass).toMatch(/^(mag|exact|coh2|coh3)/);
    }
    // Measured on 96 frames: 17 plain, 47 harder.
    expect(harder).toBeGreaterThanOrEqual(plain + 3);
  }, 60_000);

  it('decode an ack it waits for where the plain decode cannot', () => {
    const random = rng(8);
    let plain = 0;
    let expected = 0;
    for (let t = 0; t < 12; t++) {
      const ack = { src: 1 + Math.floor(random() * 1023), dst: 1 + Math.floor(random() * 1023), msgId: Math.floor(random() * 16), received: 3 };
      const payload = encodeFrame({ kind: 'ack', ...ack, heardChannel: 9, heardSnrDb: -14 });
      const w = windowWith(payload, -15, random);
      const hints = [ackHint(ack), ackHint({ src: ack.src, dst: ack.dst, msgId: ack.msgId }), ...KINDS];
      const a = decode(w, { harder: false });
      const b = decode(w, { hints });
      for (const f of [...a, ...b]) expect(same(f.payload, payload)).toBe(true);
      plain += a.length;
      expected += b.length;
    }
    expect(expected).toBeGreaterThanOrEqual(plain + 4);
  }, 60_000);

  it('make nothing out of noise, whatever they expect', () => {
    const random = rng(9);
    const hints = [ackHint({ src: 5, dst: 6, msgId: 7, received: 1 }), ackHint({ src: 5, dst: 6, msgId: 7 }), ...KINDS];
    for (let t = 0; t < 12; t++) expect(decode(windowWith(null, 0, random), { hints })).toEqual([]);
  }, 60_000);
});
