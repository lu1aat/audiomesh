/**
 * Keeps the raw audio of a few receive windows so a decode that failed on the air can be
 * replayed offline (tests/replay-captures.test.ts). Pure and DOM-free. Memory only, never
 * stored, and off until someone switches it on: a window is seconds of audio.
 */

import { distinctFrames, type ChannelDecode } from '../protocol/multi-decode';
import type { ProtocolId } from '../protocol/spec';
import { floatToInt16 } from './wav';

/** 'undecoded' = a real sync was seen but nothing decoded; 'all' = every window. */
export type CaptureMode = 'undecoded' | 'all';

/** A frame scores 0.3+ on sync; pure noise tops out near 0.23 (see SyncReport). */
export const CAPTURE_MIN_SYNC = 0.3;
/**
 * The loudest sync block may be at most this many dB above the middle one. Measured: frames and noise 0.0-1.3 dB
 * (real captures 0.1-0.4); the tail or head of a neighbour slot's frame 4.6, 5.6 and 13.3 dB.
 */
export const CAPTURE_MAX_BLOCK_IMBALANCE_DB = 3;
/** Audio kept in memory, 16-bit: about 12 windows of Normal at 48 kHz. */
export const CAPTURE_MAX_BYTES = 24 * 1024 * 1024;

/** What a capture needs from one analysed window (a subset of the engine's DecodeResult). */
export interface CaptureInput {
  readonly slotStartUtcMs: number;
  readonly channels: readonly ChannelDecode[];
  readonly ownTx?: boolean;
  readonly error?: string;
  readonly skipped?: 'sending';
  readonly window?: Float32Array;
  readonly leadSec?: number;
  readonly sampleRate?: number;
}

export interface CapturedWindow {
  readonly id: number;
  readonly slotStartUtcMs: number;
  readonly protocolId: ProtocolId;
  readonly sampleRate: number;
  readonly leadSec: number;
  readonly samples: Int16Array;
  readonly channels: readonly {
    readonly baseFreqHz: number;
    readonly decoded: number;
    readonly sync: { readonly score: number; readonly timeOffsetSec: number; readonly blocks?: readonly number[]; readonly blockImbalanceDb?: number } | null;
  }[];
  /** Distinct frames decoded in the window (0 for an 'undecoded' capture). */
  readonly decoded: number;
  readonly bestSync: number;
  /** Sync seen, but loud in one block only: the tail or head of a neighbour slot's frame, not a whole frame. */
  readonly partial: boolean;
  /** Free text typed in the Capture section when this window was kept (e.g. "tx 40 %, 2 m"). */
  readonly note: string;
}

export class WindowCapture {
  enabled = false;
  mode: CaptureMode = 'undecoded';
  /** Windows dropped to stay under the memory cap. */
  dropped = 0;
  /** Stamped on every window kept from now on; changing it does not touch windows already kept. */
  note = '';
  onChange: () => void = () => {};
  private readonly kept: CapturedWindow[] = [];
  private nextId = 1;

  constructor(private readonly protocolId: ProtocolId, private readonly maxBytes = CAPTURE_MAX_BYTES) {}

  get windows(): readonly CapturedWindow[] {
    return this.kept;
  }

  get bytes(): number {
    return this.kept.reduce((sum, w) => sum + w.samples.byteLength, 0);
  }

  /** True when `result` was kept. */
  offer(result: CaptureInput): boolean {
    if (!this.enabled || !result.window || !result.sampleRate) return false;
    if (result.error || result.skipped || result.ownTx || result.channels.length === 0) return false;
    const decoded = distinctFrames(result.channels).length;
    let bestSync = 0;
    let frameLike = false;
    for (const c of result.channels) {
      if (!c.sync) continue;
      if (c.sync.score > bestSync) bestSync = c.sync.score;
      if (c.sync.score >= CAPTURE_MIN_SYNC && (c.sync.blockImbalanceDb ?? 0) <= CAPTURE_MAX_BLOCK_IMBALANCE_DB) frameLike = true;
    }
    // Sync that is strong overall but loud in one block only is a neighbour slot's tail or head, not a frame that failed to decode.
    if (this.mode === 'undecoded' && (decoded > 0 || !frameLike)) return false;
    this.kept.push({
      id: this.nextId++,
      slotStartUtcMs: result.slotStartUtcMs,
      protocolId: this.protocolId,
      sampleRate: result.sampleRate,
      leadSec: result.leadSec ?? 0,
      samples: floatToInt16(result.window),
      channels: result.channels.map((c) => ({
        baseFreqHz: c.baseFreqHz,
        decoded: c.frames.length,
        sync: c.sync ? { score: c.sync.score, timeOffsetSec: c.sync.timeOffsetSec, blocks: c.sync.blocks, blockImbalanceDb: c.sync.blockImbalanceDb } : null,
      })),
      decoded,
      bestSync,
      partial: !frameLike && bestSync >= CAPTURE_MIN_SYNC,
      note: this.note.trim(),
    });
    // The newest window always stays, even when it alone is over the cap.
    while (this.kept.length > 1 && this.bytes > this.maxBytes) {
      this.kept.shift();
      this.dropped++;
    }
    this.onChange();
    return true;
  }

  clear(): void {
    this.kept.length = 0;
    this.dropped = 0;
    this.onChange();
  }

  remove(id: number): void {
    const i = this.kept.findIndex((w) => w.id === id);
    if (i >= 0) this.kept.splice(i, 1);
    this.onChange();
  }
}

/** The JSON that travels next to a window's WAV (read back by the replay test). */
export function captureMeta(w: CapturedWindow): object {
  return {
    format: 1,
    protocolId: w.protocolId,
    sampleRate: w.sampleRate,
    leadSec: w.leadSec,
    slotStartUtcMs: w.slotStartUtcMs,
    ...(w.note ? { note: w.note } : {}),
    baseFreqsHz: w.channels.map((c) => c.baseFreqHz),
    channels: w.channels,
  };
}

export function captureFileStem(w: CapturedWindow): string {
  return `audiomesh-${w.protocolId}-${new Date(w.slotStartUtcMs).toISOString().replace(/[:.]/g, '-')}`;
}
