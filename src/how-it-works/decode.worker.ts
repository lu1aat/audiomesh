// Decode worker for the How it works page: builds a receive window (real modulator + white noise) and runs the
// real audiomesh demodulator on it, off the page's thread.
import {
  GFSK8_DEEP, GFSK8_FAST, GFSK8_LONG, GFSK8_MEDIUM, GFSK8_NORMAL, GFSK8_TURBO, Gfsk8Codec, Gfsk8Demodulator,
  decodeFrame, encodeFrame, synthesizeFrame, windowDurationSec, windowLeadSec, type ProtocolSpec,
} from './am';

const SPECS: Record<string, ProtocolSpec> = Object.fromEntries(
  [GFSK8_TURBO, GFSK8_FAST, GFSK8_MEDIUM, GFSK8_NORMAL, GFSK8_LONG, GFSK8_DEEP].map((s) => [s.id, s]),
);
const RATE = 8000;
const BASE_HZ = 1000;
/** Rows of the tone picture: 4 tone steps below tone 0, 4 above tone 7. */
const ROWS_BELOW = 4;
const ROWS = 16;
const HOPS_PER_SYMBOL = 4;

const codecs = new Map<string, Gfsk8Codec>();
const demods = new Map<string, Gfsk8Demodulator>();
const codecFor = (spec: ProtocolSpec): Gfsk8Codec => {
  let c = codecs.get(spec.id);
  if (!c) codecs.set(spec.id, (c = new Gfsk8Codec(spec)));
  return c;
};
const demodFor = (spec: ProtocolSpec): Gfsk8Demodulator => {
  let d = demods.get(spec.id);
  if (!d) demods.set(spec.id, (d = new Gfsk8Demodulator(RATE, spec, codecFor(spec))));
  return d;
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (r: () => number): number => Math.sqrt(-2 * Math.log(r() + 1e-300)) * Math.cos(2 * Math.PI * r());

interface WindowJob { mode: string; text: string; snrDb: number; dtSec: number; dfHz: number; seed: number }

function buildWindow(job: WindowJob): { spec: ProtocolSpec; window: Float32Array; payload: Uint8Array } {
  const spec = SPECS[job.mode]!;
  const payload = encodeFrame({ kind: 'first', src: 101, msgId: 1, last: 0, dst: 0, text: job.text });
  const symbols = codecFor(spec).encode(payload);
  const total = Math.round(windowDurationSec(spec) * RATE);
  const w = new Float32Array(total);
  const frame = synthesizeFrame(symbols, BASE_HZ + job.dfHz, RATE, spec);
  const at = Math.round((windowLeadSec(spec) + job.dtSec) * RATE);
  for (let i = 0; i < frame.length; i++) {
    const j = at + i;
    if (j >= 0 && j < total) w[j] += frame[i]!;
  }
  // Noise power in a 2500 Hz reference bandwidth against a unit sine (power 0.5), as in the tests.
  const sigma = Math.sqrt((0.5 / 10 ** (job.snrDb / 10)) * (RATE / 2 / 2500));
  const random = rng(job.seed);
  for (let i = 0; i < total; i++) w[i] += sigma * gaussian(random);
  return { spec, window: w, payload };
}

/** Energy of each tone step (rows) every quarter symbol (columns), over one symbol: what the receiver measures. */
function tonePicture(spec: ProtocolSpec, w: Float32Array): { data: Float32Array; cols: number } {
  const L = Math.round(RATE / spec.baud);
  const hop = L / HOPS_PER_SYMBOL;
  const cols = Math.max(0, Math.floor((w.length - L) / hop) + 1);
  const cos = new Float32Array(ROWS * L);
  const sin = new Float32Array(ROWS * L);
  for (let r = 0; r < ROWS; r++) {
    const f = BASE_HZ + (r - ROWS_BELOW) * spec.toneSpacingHz;
    for (let n = 0; n < L; n++) {
      cos[r * L + n] = Math.cos((2 * Math.PI * f * n) / RATE);
      sin[r * L + n] = Math.sin((2 * Math.PI * f * n) / RATE);
    }
  }
  const data = new Float32Array(ROWS * cols);
  for (let c = 0; c < cols; c++) {
    const s = Math.round(c * hop);
    for (let r = 0; r < ROWS; r++) {
      let re = 0;
      let im = 0;
      const o = r * L;
      for (let n = 0; n < L; n++) {
        const x = w[s + n]!;
        re += x * cos[o + n]!;
        im -= x * sin[o + n]!;
      }
      data[r * cols + c] = (re * re + im * im) / (L * L);
    }
  }
  return { data, cols };
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { id: number; type: 'picture' | 'decode' } & WindowJob;
  const { spec, window, payload } = buildWindow(msg);
  const picture = tonePicture(spec, window);
  const reply: Record<string, unknown> = {
    id: msg.id, rate: RATE, baseHz: BASE_HZ, rowsBelow: ROWS_BELOW, rows: ROWS, hopsPerSymbol: HOPS_PER_SYMBOL,
    picture: picture.data, cols: picture.cols, window, symbols: codecFor(spec).encode(payload),
  };
  if (msg.type === 'decode') {
    const demod = demodFor(spec);
    const t0 = performance.now();
    const frames = demod.decode(window, BASE_HZ);
    reply.ms = performance.now() - t0;
    reply.sync = demod.lastSync ? { score: demod.lastSync.score, dt: demod.lastSync.timeOffsetSec } : null;
    reply.frames = frames.map((f) => {
      const frame = decodeFrame(f.payload);
      const right = f.payload.every((b, i) => b === payload[i]);
      return {
        text: frame && frame.kind === 'first' ? frame.text : null, right,
        snrDb: f.snrDb, dtSec: f.timeOffsetSec, dfHz: f.freqHz - BASE_HZ, pass: f.pass ?? null,
      };
    });
  }
  self.postMessage(reply, { transfer: [window.buffer, picture.data.buffer] });
};
