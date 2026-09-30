/**
 * Adding up retransmissions. A frame that was sent again (a missing frame in a retransmit
 * round, the second copy of a complete ack) is the very same 79 symbols, so two receptions
 * that each failed to decode can be added, tone energy by tone energy, before the LDPC: two
 * equal copies are worth about 3 dB. Pure and DOM-free (runs in the decoder worker, tested in Node).
 *
 * The receiver does not know which failed candidates are copies of one frame, so it pairs
 * them blindly and lets the code be the judge: a pair that is not one frame does not satisfy
 * the parity checks and the CRC, exactly like any other wrong candidate. Two cheap filters keep the
 * number of attempts small: copies come from different slots, and from one sender's clock, so
 * they start at about the same time against the slot grid (`timeOffsetSec` within a tolerance).
 */

import type { ChannelDecode } from './multi-decode';
import type { DecodedFrame, Demodulator, FrameCodec, UndecodedCandidate } from './protocol';
import { symbolDurationSec, type ProtocolSpec } from './spec';

/**
 * How far apart two copies' start times may be: 0.75 symbol, but never less than 0.15 s. One sender's
 * start against the slot grid is not steady: three transmissions of one frame heard over the air
 * (Fast, tests/replay-captures) started 0.267, 0.156 and 0.166 s after the boundary, 0.11 s apart,
 * which is nearly 3 symbols at 25 baud.
 */
export const DT_TOLERANCE_SYMBOLS = 0.75;
export const DT_TOLERANCE_MIN_SEC = 0.15;
/**
 * Older candidates are forgotten. A directed message of 16 frames, one per slot, is resent 5 + 2
 * slots after its last frame, so a frame's copy is ~23 slots after the first; with a repeater about
 * the frames are paced 3 slots apart and it is longer still.
 */
export const POOL_MAX_AGE_SLOTS = 40;
export const POOL_MAX_ENTRIES = 96;
/**
 * Decode attempts per candidate. The frames of one message come from one sender, so they share a start
 * time and all pair with each other (as pairs, and as triples, by the dozen); the right partner is the
 * strongest few, so the search stops after this many.
 */
const MAX_TRIALS = 48;
/** Most receptions combined into one frame (the new one plus earlier ones). */
const MAX_COPIES = 3;

interface Entry {
  readonly slotStartUtcMs: number;
  readonly cand: UndecodedCandidate;
}

export interface Combined {
  readonly payload: Uint8Array;
  /** Energies of every reception used, the new one first. */
  readonly energies: readonly Float32Array[];
}

export class CandidatePool {
  private entries: Entry[] = [];
  private readonly dtToleranceSec: number;

  constructor(
    private readonly codec: FrameCodec,
    private readonly spec: ProtocolSpec,
    private readonly maxEntries = POOL_MAX_ENTRIES,
  ) {
    this.dtToleranceSec = Math.max(DT_TOLERANCE_SYMBOLS * symbolDurationSec(spec), DT_TOLERANCE_MIN_SEC);
  }

  get size(): number {
    return this.entries.length;
  }

  /** Try to decode `cand`, heard in the window of `slotStartUtcMs`, together with earlier failed receptions. */
  resolve(slotStartUtcMs: number, cand: UndecodedCandidate): Combined | null {
    const maxAgeMs = POOL_MAX_AGE_SLOTS * this.spec.slotSec * 1000;
    const near = this.entries
      .filter(
        (e) =>
          e.slotStartUtcMs < slotStartUtcMs &&
          slotStartUtcMs - e.slotStartUtcMs <= maxAgeMs &&
          Math.abs(e.cand.timeOffsetSec - cand.timeOffsetSec) <= this.dtToleranceSec,
      )
      .sort((a, b) => b.cand.score - a.cand.score);
    // Pairs first (the usual case), then triples: a frame sent three times.
    let trials = 0;
    for (let size = 1; size < MAX_COPIES; size++) {
      for (const partners of subsets(near, size)) {
        if (++trials > MAX_TRIALS) return null;
        const energies = [cand.energies, ...partners.map((p) => p.cand.energies)];
        const payload = this.codec.decodeCombined(energies);
        if (!payload) continue;
        this.entries = this.entries.filter((e) => !partners.includes(e));
        return { payload, energies };
      }
    }
    return null;
  }

  add(slotStartUtcMs: number, cand: UndecodedCandidate): void {
    this.entries.push({ slotStartUtcMs, cand });
    // Over the cap, the weakest sync goes first.
    while (this.entries.length > this.maxEntries) {
      let weakest = 0;
      for (let i = 1; i < this.entries.length; i++) if (this.entries[i]!.cand.score < this.entries[weakest]!.cand.score) weakest = i;
      this.entries.splice(weakest, 1);
    }
  }

  /** Forget what is too old to be a retransmission of anything still being sent. */
  prune(nowSlotStartMs: number): void {
    const maxAgeMs = POOL_MAX_AGE_SLOTS * this.spec.slotSec * 1000;
    this.entries = this.entries.filter((e) => nowSlotStartMs - e.slotStartUtcMs <= maxAgeMs);
  }
}

/** Subsets of `items` with exactly `size` members, in order of the best items first. */
function* subsets<T>(items: readonly T[], size: number, from = 0, chosen: T[] = []): Generator<T[]> {
  if (chosen.length === size) {
    yield [...chosen];
    return;
  }
  for (let i = from; i < items.length; i++) {
    chosen.push(items[i]!);
    yield* subsets(items, size, i + 1, chosen);
    chosen.pop();
  }
}

/**
 * `decodeChannels`, plus retransmission combining: a candidate that fails on its own is tried
 * together with earlier failed ones, and kept for later slots when it still fails.
 */
export function decodeChannelsCombining(
  demodulator: Demodulator,
  pool: CandidatePool,
  window: Float32Array,
  baseFreqsHz: readonly number[],
  leadSec: number | undefined,
  slotStartUtcMs: number,
): ChannelDecode[] {
  const later: UndecodedCandidate[] = [];
  const out = baseFreqsHz.map((baseFreqHz) => {
    const frames: DecodedFrame[] = [...demodulator.decode(window, baseFreqHz, leadSec)];
    const sync = demodulator.lastSync;
    for (const cand of demodulator.lastUndecoded) {
      const hit = pool.resolve(slotStartUtcMs, cand);
      if (!hit) {
        later.push(cand);
        continue;
      }
      frames.push({
        payload: hit.payload,
        freqHz: cand.freqHz,
        timeOffsetSec: cand.timeOffsetSec,
        // The best copy's SNR: adding copies raises what can be decoded, not what was received.
        snrDb: Math.max(...hit.energies.map((e) => demodulator.snrDbOf(e, hit.payload))),
        copies: hit.energies.length,
      });
    }
    return { baseFreqHz, frames, sync };
  });
  // Added only now, so a window never pairs with itself (a strong frame leaking into a neighbouring channel).
  for (const cand of later) pool.add(slotStartUtcMs, cand);
  pool.prune(slotStartUtcMs);
  return out;
}
