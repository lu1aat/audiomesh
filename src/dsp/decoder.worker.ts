/// <reference lib="webworker" />
/**
 * Decoder worker: runs a protocol's demodulator on every listened channel of one slot window at a time,
 * off both the audio thread and the UI thread. Analysis allocates and takes
 * hundreds of milliseconds, so neither may do it.
 */

import type { Demodulator } from '../protocol/protocol';
import { decodeChannels, type ChannelDecode } from '../protocol/multi-decode';
import { getProtocol } from '../protocol/registry';
import type { ProtocolId } from '../protocol/spec';

export interface DecodeRequest {
  id: number;
  protocolId: ProtocolId;
  sampleRate: number;
  baseFreqsHz: readonly number[];
  window: Float32Array;
  /** Audio before the slot boundary at the window's start; longer than the protocol's with deep decoding. */
  leadSec: number;
}

export type DecodeResponse =
  | { id: number; ok: true; channels: ChannelDecode[]; decodeMs: number; peak: number; clipped: number }
  | { id: number; ok: false; error: string };

/** A sample this close to full scale is pinned (browsers deliver a clipped ADC as exactly +-1). */
const CLIP_LEVEL = 0.999;

const cache = new Map<string, Demodulator>();

function demodulatorFor(protocolId: ProtocolId, sampleRate: number): Demodulator {
  const key = `${protocolId}@${sampleRate}`;
  let d = cache.get(key);
  if (!d) {
    // Building one designs its filters and tone tables; do it once per rate.
    d = getProtocol(protocolId).createDemodulator(sampleRate);
    cache.set(key, d);
  }
  return d;
}

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const { id, protocolId, sampleRate, baseFreqsHz, window, leadSec } = event.data;
  try {
    // Input overload: clipping flattens the wave tops against full scale, so it shows as
    // runs of samples pinned there. A lone loud peak is not clipping.
    let peak = 0;
    let clipped = 0;
    let run = 0;
    for (let i = 0; i < window.length; i++) {
      const a = Math.abs(window[i]!);
      if (a > peak) peak = a;
      if (a >= CLIP_LEVEL) {
        run++;
        if (run === 2) clipped += 2;
        else if (run > 2) clipped++;
      } else run = 0;
    }
    const t0 = performance.now();
    const demodulator = demodulatorFor(protocolId, sampleRate);
    const channels = decodeChannels(demodulator, window, baseFreqsHz, leadSec);
    const response: DecodeResponse = { id, ok: true, channels, decodeMs: performance.now() - t0, peak, clipped };
    self.postMessage(response);
  } catch (err) {
    const response: DecodeResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
};
