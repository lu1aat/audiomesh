/// <reference lib="webworker" />
/**
 * Decoder worker: runs a protocol's demodulator on every listened channel of one slot window at a time,
 * off both the audio thread and the UI thread. Analysis allocates and takes
 * hundreds of milliseconds, so neither may do it.
 */

import type { ApHint, Demodulator } from '../protocol/protocol';
import type { ChannelDecode } from '../protocol/multi-decode';
import { CandidatePool, decodeChannelsCombining } from '../protocol/combine';
import { getProtocol } from '../protocol/registry';
import type { ProtocolId } from '../protocol/spec';

export interface DecodeRequest {
  id: number;
  protocolId: ProtocolId;
  sampleRate: number;
  baseFreqsHz: readonly number[];
  window: Float32Array;
  /** Wall-clock start of the slot this window belongs to: orders windows for retransmission combining. */
  slotStartUtcMs: number;
  /** Audio before the slot boundary at the window's start; longer than the protocol's with deep decoding. */
  leadSec: number;
  /** What the chat layer knows about frames that may be in this window (ack and sound layouts, acks it waits for). */
  hints?: readonly ApHint[];
}

export type DecodeResponse =
  | { id: number; ok: true; channels: ChannelDecode[]; decodeMs: number; peak: number; clipped: number }
  | { id: number; ok: false; error: string };

/** A sample this close to full scale is pinned (browsers deliver a clipped ADC as exactly +-1). */
const CLIP_LEVEL = 0.999;

/**
 * Share of a slot after which a window's remaining channels get the plain decode only, without the
 * harder passes (other soft metrics, hints): windows keep coming once per slot, and a slow device
 * must not fall behind them. Desktop Node decodes a whole band plainly in under a fifth of a slot.
 */
const HARDER_BUDGET_SLOT_FRACTION = 0.4;

interface Decoder {
  demodulator: Demodulator;
  /** Failed candidates of earlier windows, to add a retransmission to. */
  pool: CandidatePool;
}

const cache = new Map<string, Decoder>();

function decoderFor(protocolId: ProtocolId, sampleRate: number): Decoder {
  const key = `${protocolId}@${sampleRate}`;
  let d = cache.get(key);
  if (!d) {
    // Building one designs its filters and tone tables; do it once per rate.
    const protocol = getProtocol(protocolId);
    d = { demodulator: protocol.createDemodulator(sampleRate), pool: new CandidatePool(protocol.createCodec(), protocol.spec) };
    cache.set(key, d);
  }
  return d;
}

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const { id, protocolId, sampleRate, baseFreqsHz, window, slotStartUtcMs, leadSec, hints } = event.data;
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
    const { demodulator, pool } = decoderFor(protocolId, sampleRate);
    const harderBudgetMs = HARDER_BUDGET_SLOT_FRACTION * getProtocol(protocolId).spec.slotSec * 1000;
    const channels = decodeChannelsCombining(demodulator, pool, window, baseFreqsHz, leadSec, slotStartUtcMs, { hints, harderBudgetMs });
    const response: DecodeResponse = { id, ok: true, channels, decodeMs: performance.now() - t0, peak, clipped };
    self.postMessage(response);
  } catch (err) {
    const response: DecodeResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
};
