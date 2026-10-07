/**
 * Protocol parameters as plain data, plus the free functions that derive
 * everything else from them.
 *
 * Same rule as hellschreiber2026's HellMode: a spec must stay structured-cloneable
 * (it crosses into AudioWorklets via processorOptions), so it is a readonly data
 * object and every derived value is a free function, never a method.
 *
 * Numbers live here and nowhere else. Do not inline 6.25, 79 or 50 elsewhere.
 */

/** Add a member here when a new protocol is registered in registry.ts. */
export type ProtocolId =
  | 'gfsk8-normal'
  | 'gfsk8-medium'
  | 'gfsk8-fast'
  | 'gfsk8-long'
  | 'gfsk8-deep'
  | 'gfsk8-turbo'
  | 'gfsk8-spread'
  | 'gfsk8-burst';

export interface ProtocolSpec {
  readonly id: ProtocolId;
  readonly name: string;
  /** Name shown to users (Turbo, Fast, Medium, Normal, Long, Deep). */
  readonly label: string;
  /** Normalised one-letter code (A normal, B medium, C fast, L long, D deep, T turbo); reference only, not shown as the name. */
  readonly letter: string;
  /** Number of FSK tones (8 for 8-GFSK). Bits per symbol is log2 of this. */
  readonly toneCount: number;
  readonly baud: number;
  /** Equal to `baud` for the JS8/FT8 family: orthogonal non-coherent FSK. */
  readonly toneSpacingHz: number;
  /** Channel symbols per frame, sync included. */
  readonly symbolCount: number;
  /** Sync tone patterns and the symbol index each one starts at. */
  readonly syncPattern: readonly number[];
  readonly syncStarts: readonly number[];
  /** Transmit slot length. Frames start on multiples of this on the UTC clock. */
  readonly slotSec: number;
  /**
   * How far from the slot boundary a frame may start and still be found: the
   * allowance for the two stations' clocks disagreeing. The receiver searches
   * +-this much, so frame + 2 x this must fit inside the slot.
   */
  readonly maxTimeOffsetSec: number;
  /** Information bits per frame handed to the framing layer, before FEC and CRC. */
  readonly payloadBits: number;
  /**
   * Q65-style spread tolerance (default 1 = none). Each tone is `binsPerTone` fine bins wide
   * (`toneSpacingHz` = binsPerTone x baud, odd) and the receiver adds the energy of the bins of a
   * tone, so a tone smeared by Doppler, wobble or sound-card drift is still collected. The price
   * is noise from all those bins: about 10 log10(binsPerTone) dB at no spread.
   */
  readonly binsPerTone?: number;
  /**
   * ISCAT-style repetition (default 1 = none). The frame (`symbolCount` symbols, Costas included)
   * is sent this many times back to back in one slot, and the receiver adds the copies' tone
   * energies before the LDPC decode. A copy lost to a fade or a burst of noise only costs its share.
   */
  readonly repeats?: number;
}

export const symbolDurationSec = (spec: ProtocolSpec): number => 1 / spec.baud;

export const binsPerTone = (spec: ProtocolSpec): number => spec.binsPerTone ?? 1;

export const repeatCount = (spec: ProtocolSpec): number => spec.repeats ?? 1;

/** Symbols actually transmitted per slot: every copy of the frame. */
export const transmitSymbolCount = (spec: ProtocolSpec): number => repeatCount(spec) * spec.symbolCount;

/** Time on air for one transmission (all copies). Always shorter than the slot; the rest is guard. */
export const frameDurationSec = (spec: ProtocolSpec): number => transmitSymbolCount(spec) / spec.baud;

/** Occupied width of one transmission, lowest tone to highest tone plus one spacing. */
export const bandwidthHz = (spec: ProtocolSpec): number => spec.toneCount * spec.toneSpacingHz;

export const bitsPerSymbol = (spec: ProtocolSpec): number => Math.log2(spec.toneCount);

/** The receiver's audio window starts this long before the slot boundary. */
export const windowLeadSec = (spec: ProtocolSpec): number => spec.maxTimeOffsetSec;

/**
 * Length of audio analysed per slot: the frame itself plus the allowed clock
 * error on both sides, so a frame that starts early or late is still whole inside it.
 */
export const windowDurationSec = (spec: ProtocolSpec): number =>
  frameDurationSec(spec) + 2 * spec.maxTimeOffsetSec;

/**
 * Deep decoding: how much further than `maxTimeOffsetSec` the receiver looks on each
 * side, for a station whose clock is off by more than the protocol allows. Up to 3 s,
 * but the search of one slot must never reach into the next one's (else one frame
 * would decode in two slots): lead + extra stays a quarter second short of half a slot.
 */
export const deepExtraSec = (spec: ProtocolSpec): number =>
  Math.max(0, Math.min(3, spec.slotSec / 2 - 0.25 - spec.maxTimeOffsetSec));
