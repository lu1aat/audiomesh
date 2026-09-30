/**
 * Decoding several channels from one window: the receiver hears the whole band at
 * once, so "scanning" costs only CPU. Pure and DOM-free so it runs in the worker
 * and in Node tests.
 */

import type { DecodedFrame, Demodulator, SyncReport } from './protocol';

/** What one channel of one window produced. */
export interface ChannelDecode {
  /** Frequency of the channel's tone 0. */
  readonly baseFreqHz: number;
  readonly frames: readonly DecodedFrame[];
  /** Best sync candidate, even when nothing decoded. */
  readonly sync: SyncReport | null;
}

/** Decode `window` once per channel. Results are in the order of `baseFreqsHz`. */
export function decodeChannels(
  demodulator: Demodulator,
  window: Float32Array,
  baseFreqsHz: readonly number[],
  leadSec?: number,
): ChannelDecode[] {
  return baseFreqsHz.map((baseFreqHz) => {
    const frames = demodulator.decode(window, baseFreqHz, leadSec);
    return { baseFreqHz, frames, sync: demodulator.lastSync };
  });
}

/** A frame together with the channel it was heard on. */
export interface HeardFrame {
  readonly baseFreqHz: number;
  readonly frame: DecodedFrame;
}

/**
 * Every distinct payload of a slot, once. A strong signal leaks into the channels
 * next to it, so the same frame can decode on two channels; only the strongest copy
 * is real. Ordered strongest first.
 */
export function distinctFrames(channels: readonly ChannelDecode[]): HeardFrame[] {
  const best = new Map<string, HeardFrame>();
  for (const ch of channels) {
    for (const frame of ch.frames) {
      const key = frame.payload.join('');
      const have = best.get(key);
      if (!have || frame.snrDb > have.frame.snrDb) best.set(key, { baseFreqHz: ch.baseFreqHz, frame });
    }
  }
  return [...best.values()].sort((a, b) => b.frame.snrDb - a.frame.snrDb);
}
