/**
 * The seam between a modem and the rest of the app.
 *
 * A Protocol is everything that turns frames of payload bits into audio and
 * back. Chat framing (nicknames, text coding, message splitting) sits ABOVE this
 * and knows nothing about tones; the band plan sits BESIDE it and only needs the
 * spec. Adding a protocol means implementing this interface and registering it in
 * registry.ts. Nothing else should need to change.
 *
 * Layers, bottom to top:
 *   audio  <->  Modulator / Demodulator  <->  FrameCodec  <->  chat framing
 *
 * All cores are plain classes with no DOM or AudioWorkletGlobalScope imports, so
 * loopback tests can run them in Node. Buffers are caller-owned.
 */

import type { ProtocolSpec } from './spec';

/** One decoded frame and where it was found. */
export interface DecodedFrame {
  readonly payload: Uint8Array;
  /** Frequency of tone 0 as measured, Hz. Differs a little from the nominal channel base. */
  readonly freqHz: number;
  /** Start offset relative to the slot boundary, seconds. Positive = late. */
  readonly timeOffsetSec: number;
  /** In a 2500 Hz reference bandwidth, the usual weak-signal convention. */
  readonly snrDb: number;
  /** Set when several receptions of this frame (a retransmission heard in other slots) were combined to decode it. */
  readonly copies?: number;
}

/**
 * A candidate that looked like a frame (real sync) but did not decode: its tone
 * energies are kept so a later retransmission of the same frame can be added to it.
 */
export interface UndecodedCandidate {
  /** symbolCount * toneCount linear tone energies, as given to FrameCodec.decode. */
  readonly energies: Float32Array;
  readonly score: number;
  readonly freqHz: number;
  readonly timeOffsetSec: number;
}

/** Payload bits <-> channel symbols: CRC, FEC and sync insertion. Pure, no audio. */
export interface FrameCodec {
  /** payloadBits bits (one per byte, 0/1) -> symbolCount symbols in 0..toneCount-1. */
  encode(payload: Uint8Array): Uint8Array;
  /** Soft tone energies, symbolCount * toneCount, row-major by symbol. null on CRC fail. */
  decode(toneEnergies: Float32Array): Uint8Array | null;
  /**
   * Several receptions of the same frame (same payload, so the same symbols): their soft
   * values are added before decoding, which is worth up to ~3 dB for two copies.
   * null when they do not decode together, which includes receptions of different frames.
   */
  decodeCombined(copies: readonly Float32Array[]): Uint8Array | null;
}

/** Symbols -> audio. Continuous phase across symbols; never a hard switch. */
export interface Modulator {
  /** True while a frame is queued or still playing. */
  readonly busy: boolean;
  /** Queue a frame to start at `startSample` on the caller's sample clock. */
  schedule(symbols: Uint8Array, baseFreqHz: number, startSample: number): void;
  /** Always fills `out` completely, with silence when idle. */
  fill(out: Float32Array, firstSample: number): void;
  cancel(): void;
}

/**
 * Audio -> frames, one slot at a time. Analysis is heavy (a search over time and
 * frequency, then belief propagation), so it never runs on the audio thread: a
 * SlotRecorder cuts one window of audio per slot, and this decodes it in a Web
 * Worker.
 *
 * The window starts windowLeadSec(spec) before the slot boundary and lasts
 * windowDurationSec(spec). One channel per call.
 */
/** What the last decode() saw, decoded or not: says why a slot produced nothing. */
export interface SyncReport {
  /** Fraction of the sync symbols' energy in the tones the sync pattern predicts. The best of the search on pure noise is about 0.23; a frame is far above. */
  readonly score: number;
  /** Where the best candidate started, relative to the slot boundary, seconds. */
  readonly timeOffsetSec: number;
  /** The same score for each sync block on its own (diagnostic: a block at noise level scores 0.1-0.3). */
  readonly blocks?: readonly number[];
  /**
   * How much louder the loudest sync block is than the middle one, dB. A frame has all its blocks at about the
   * same level (under ~3 dB apart, even in noise); the tail or head of a NEIGHBOUR slot's frame, which a window
   * wider than the slot always catches, has one block at +7..15 dB over the others and still scores 0.3-0.5 as a
   * whole because the score is weighted by energy.
   */
  readonly blockImbalanceDb?: number;
}

export interface Demodulator {
  /** Best sync candidate of the last decode(), or null if there was none. */
  readonly lastSync: SyncReport | null;
  /** Candidates of the last decode() that had a real sync but did not decode (best few). */
  readonly lastUndecoded: readonly UndecodedCandidate[];
  /** SNR (2500 Hz reference) of tone energies once the frame's payload is known. */
  snrDbOf(energies: Float32Array, payload: Uint8Array): number;
  /**
   * Every distinct frame found on the channel whose tone 0 sits at `baseFreqHz`,
   * strongest first. Empty when there is nothing decodable, which is normal.
   * `leadSec`: how much audio precedes the slot boundary (default windowLeadSec);
   * a longer window with a longer lead is searched over +-leadSec (deep decoding).
   */
  decode(window: Float32Array, baseFreqHz: number, leadSec?: number): DecodedFrame[];
}

export interface Protocol {
  readonly spec: ProtocolSpec;
  createCodec(): FrameCodec;
  createModulator(sampleRate: number): Modulator;
  createDemodulator(sampleRate: number): Demodulator;
}
