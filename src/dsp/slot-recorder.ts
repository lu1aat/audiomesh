/**
 * Cuts one window of audio per slot out of a continuous stream. Cheap enough for
 * the audio thread: it only copies samples. The analysis of each window happens
 * elsewhere (a Web Worker).
 *
 * Timing is by sample counting against the caller's sample clock. The caller says
 * which sample index is a slot boundary (`setSlotOrigin`); slots then repeat every
 * `slotSec` after that. A window covers [slot start - lead, slot start - lead +
 * windowDuration], so a frame that starts up to `maxTimeOffsetSec` early or late
 * lies wholly inside it.
 *
 * A window is only emitted if every sample of it was really recorded, so starting
 * mid-slot or a gap in the input skips that slot rather than sending a partial
 * window with a hole in it.
 */

import { windowDurationSec, windowLeadSec, type ProtocolSpec } from '../protocol/spec';

export interface SlotWindow {
  /** Which slot: the slot boundary is at origin + slotIndex * slotSec. */
  readonly slotIndex: number;
  readonly samples: Float32Array;
}

export class SlotRecorder {
  private readonly ring: Float32Array;
  private readonly windowSamples: number;
  private readonly leadSamples: number;
  private readonly slotSamples: number;

  private origin: number | null = null;
  private ringEnd = -1; // absolute index just past the last sample written
  private validFrom = 0; // earliest absolute index of the current unbroken run
  private nextSlot: number | null = null;

  /** Seconds of audio before the slot boundary at the start of each window. */
  readonly leadSec: number;

  /** `extraSec` widens every window by that much on both sides (deep decoding). */
  constructor(
    sampleRate: number,
    private readonly spec: ProtocolSpec,
    extraSec = 0,
  ) {
    this.leadSec = windowLeadSec(spec) + extraSec;
    this.windowSamples = Math.round((windowDurationSec(spec) + 2 * extraSec) * sampleRate);
    this.leadSamples = Math.round(this.leadSec * sampleRate);
    this.slotSamples = spec.slotSec * sampleRate;
    // A second of slack beyond one window: blocks may be up to that long.
    this.ring = new Float32Array(this.windowSamples + Math.round(sampleRate));
  }

  get slotSec(): number {
    return this.spec.slotSec;
  }

  /**
   * `sample` is the index, on the same clock as process()'s `firstSample`, of a slot
   * boundary. May be called again to nudge the grid as the audio clock drifts from
   * the wall clock: slot numbers stay continuous, so the next slot due is unchanged
   * and only where its window is cut moves.
   */
  setSlotOrigin(sample: number): void {
    this.origin = sample;
  }

  /**
   * Feed consecutive blocks with their absolute start index. Returns a window when
   * one has just completed, else null. Blocks must be shorter than the ring's slack
   * (1 s), and at most one window can complete per block.
   *
   * Allocates the returned window: once per slot, not per block.
   */
  process(input: Float32Array, firstSample: number): SlotWindow | null {
    const cap = this.ring.length;
    if (input.length === 0) return null;
    if (firstSample !== this.ringEnd) {
      // First block, or samples went missing: start a new unbroken run.
      this.validFrom = firstSample;
      this.nextSlot = null;
    }
    let at = firstSample % cap;
    for (let i = 0; i < input.length; i++) {
      this.ring[at] = input[i]!;
      if (++at === cap) at = 0;
    }
    this.ringEnd = firstSample + input.length;

    if (this.origin === null) return null;
    if (this.nextSlot === null) {
      // First slot whose whole window lies inside the run recorded so far.
      this.nextSlot = Math.ceil((this.validFrom + this.leadSamples - this.origin) / this.slotSamples);
    }
    const slot = this.nextSlot;
    const start = Math.round(this.origin + slot * this.slotSamples) - this.leadSamples;
    if (this.ringEnd < start + this.windowSamples) return null;

    this.nextSlot = slot + 1;
    if (start < this.validFrom || start < this.ringEnd - cap) return null; // no longer (or never) intact

    const samples = new Float32Array(this.windowSamples);
    const from = start % cap;
    const firstPart = Math.min(this.windowSamples, cap - from);
    samples.set(this.ring.subarray(from, from + firstPart), 0);
    if (firstPart < this.windowSamples) samples.set(this.ring.subarray(0, this.windowSamples - firstPart), firstPart);
    return { slotIndex: slot, samples };
  }
}
