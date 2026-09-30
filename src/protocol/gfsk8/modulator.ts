/**
 * 8-GFSK modulator: channel symbols -> audio.
 *
 * Each symbol selects one of 8 tones spaced `toneSpacingHz` apart. Instead of
 * jumping between tones (which splatters energy far outside the channel), the
 * instantaneous frequency is the sum of Gaussian-smoothed pulses, one per
 * symbol. Phase is the running integral of that frequency, so it is continuous
 * by construction and there is never a click at a symbol boundary.
 *
 * Bandwidth-time product 2.0 with a pulse that spans three symbols is the FT8
 * choice: about as narrow as it gets while keeping the tones separable.
 *
 * Samples are rendered on the fly, one block at a time, from a small running
 * state (symbol position and phase). fill() and cancel() allocate nothing, and
 * scheduling a frame copies only its 79 symbols, so nothing here can stall the
 * audio thread. Rendering the whole 600k-sample frame up front would: it
 * blocks the thread for a noticeable time, and the frame would start late.
 */

import type { Modulator } from '../protocol';
import { symbolDurationSec, type ProtocolSpec } from '../spec';

/** Gaussian bandwidth-time product of the frequency pulse. */
const BT = 2.0;

/** sqrt(2/ln2) * pi: converts BT into the erf argument scale of the Gaussian pulse. */
const PULSE_SCALE = Math.PI * Math.sqrt(2 / Math.LN2);

/**
 * Fade the amplitude in and out over 1/8 of a symbol (20 ms at 6.25 baud). The
 * frequency trajectory is held flat at the frame edges, so this only has to
 * hide the start and stop of the carrier itself. A hard edge would splatter.
 */
const RAMP_SYMBOL_FRACTION = 1 / 8;

/** The pulse is negligible beyond +-1.5 symbols from its centre at BT = 2. */
const PULSE_HALF_SPAN = 1.5;

/** Abramowitz & Stegun 7.1.26, |error| < 1.5e-7: far below anything audible. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-a * a));
}

/**
 * Frequency pulse of one symbol, centred on x = 0, x in symbols. A Gaussian
 * filter applied to a one-symbol rectangle. Copies centred one symbol apart
 * sum to exactly 1, so a run of identical symbols gives a perfectly flat tone.
 */
function pulse(x: number): number {
  return 0.5 * (erf(PULSE_SCALE * BT * (x + 0.5)) - erf(PULSE_SCALE * BT * (x - 0.5)));
}

/**
 * Renders one frame sample by sample. State is only the sample index and the
 * running phase, so blocks of any size give bit-identical output.
 */
class FrameStream {
  readonly total: number;
  private readonly samplesPerSymbol: number;
  private readonly rampLen: number;
  private readonly radPerSampleHz: number;
  private index = 0;
  private phase = 0;

  constructor(
    private readonly symbols: Uint8Array,
    private readonly baseFreqHz: number,
    sampleRate: number,
    private readonly spec: ProtocolSpec,
  ) {
    if (symbols.length === 0) throw new RangeError('a frame needs at least one symbol');
    for (const s of symbols) {
      if (s >= spec.toneCount) throw new RangeError(`symbol ${s} is not a tone in 0..${spec.toneCount - 1}`);
    }
    // Not assumed to be an integer: 22.05 kHz gives 3528, but a rate the symbol
    // length does not divide would drift if rounded per symbol.
    this.samplesPerSymbol = sampleRate * symbolDurationSec(spec);
    this.total = Math.round(symbols.length * this.samplesPerSymbol);
    this.rampLen = Math.max(1, Math.round(this.samplesPerSymbol * RAMP_SYMBOL_FRACTION));
    this.radPerSampleHz = (2 * Math.PI) / sampleRate;
  }

  get done(): boolean {
    return this.index >= this.total;
  }

  /** Write up to `count` samples at out[offset..]; returns how many were written. */
  render(out: Float32Array, offset: number, count: number): number {
    const { symbols, spec } = this;
    const lastSymbol = symbols.length - 1;
    const n = Math.min(count, this.total - this.index);
    for (let j = 0; j < n; j++) {
      const i = this.index + j;
      const t = i / this.samplesPerSymbol; // position in symbols
      const centre = Math.floor(t);
      let deviation = 0; // in tone spacings above tone 0
      for (let k = centre - 1; k <= centre + 2; k++) {
        const x = t - (k + 0.5);
        if (x <= -PULSE_HALF_SPAN || x >= PULSE_HALF_SPAN) continue;
        // Beyond either end, repeat the edge symbol so the frequency stays flat
        // there instead of sliding toward tone 0.
        deviation += symbols[k < 0 ? 0 : k > lastSymbol ? lastSymbol : k]! * pulse(x);
      }

      this.phase += this.radPerSampleHz * (this.baseFreqHz + spec.toneSpacingHz * deviation);
      if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI;

      const edge = Math.min(i, this.total - 1 - i);
      const gain = edge < this.rampLen ? 0.5 * (1 - Math.cos((Math.PI * edge) / this.rampLen)) : 1;
      out[offset + j] = gain * Math.sin(this.phase);
    }
    this.index += n;
    return n;
  }
}

/**
 * Render a whole frame at once. `symbols` are tone indices, 0..toneCount-1, with
 * tone 0 at `baseFreqHz`. Output is peak-normalised to 1 (scale it with a gain
 * node). For tests and offline use; the live path streams via Gfsk8Modulator.
 */
export function synthesizeFrame(
  symbols: Uint8Array,
  baseFreqHz: number,
  sampleRate: number,
  spec: ProtocolSpec,
): Float32Array {
  const stream = new FrameStream(symbols, baseFreqHz, sampleRate, spec);
  const out = new Float32Array(stream.total);
  stream.render(out, 0, stream.total);
  return out;
}

export class Gfsk8Modulator implements Modulator {
  private stream: FrameStream | null = null;
  private startSample = 0;
  private started = false;

  constructor(
    private readonly sampleRate: number,
    private readonly spec: ProtocolSpec,
  ) {}

  get busy(): boolean {
    return this.stream !== null;
  }

  /**
   * Queue a frame. If `startSample` has already passed by the time the next
   * block is filled, the frame starts at that block instead: it is never cut short.
   */
  schedule(symbols: Uint8Array, baseFreqHz: number, startSample: number): void {
    this.stream = new FrameStream(symbols.slice(), baseFreqHz, this.sampleRate, this.spec);
    this.startSample = startSample;
    this.started = false;
  }

  /** Blocks must be consecutive: once a frame has started it plays on without gaps. */
  fill(out: Float32Array, firstSample: number): void {
    out.fill(0);
    const stream = this.stream;
    if (!stream) return;

    let dest = 0;
    if (!this.started) {
      const start = Math.max(this.startSample, firstSample);
      if (start >= firstSample + out.length) return; // not yet
      dest = start - firstSample;
      this.started = true;
    }
    stream.render(out, dest, out.length - dest);
    if (stream.done) this.stream = null;
  }

  cancel(): void {
    this.stream = null;
  }
}
