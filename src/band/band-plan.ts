/**
 * Fixed channel numbering.
 *
 * A band carries up to a fixed number of channels spread evenly across it:
 * channel 1 starts at the band's low edge and the last channel ends at its
 * high edge. "Up to": `channelCount` is the most a band ever offers, to its
 * narrowest protocols; a wider protocol that can't fit them all still uses as
 * many as do fit (`effectiveChannelCount`), spread the same way, rather than
 * being excluded outright - only when not even one fits does the whole band
 * disappear for that protocol. The plan is a pure function of (band, protocol
 * spec), with no sample rate and no runtime state, so every client numbers the
 * spectrum identically. Channel numbers are 1-based, as shown to users.
 *
 * Spreading a few channels wide (rather than packing them side by side) leaves
 * large gaps between neighbours, which is deliberate: it tolerates the poor
 * filtering and strong nearby signals of a speaker/mic path.
 *
 * Different protocols have different widths, so their spacing differs and
 * channel numbers do not line up between them. A channel number is only
 * meaningful together with a protocol id.
 *
 * Layout: three bands, numbered continuously in ascending frequency.
 *  - low        100..300 Hz    3 channels (1..3)   the sparsest: small speakers barely reproduce it
 *  - audible    300..10000 Hz  4 channels (4..7)   audible to everyone; speakers and mics roll off
 *               toward the top, so its highest channels are the weakest
 *  - ultrasonic 17500..21000 Hz 10 channels (8..17) the main band: inaudible and works well over the
 *               air. Needs an audio context above ~47 kHz, so 48 kHz or more; on 44.1 kHz devices
 *               it is out of reach. Channels sit ~330 Hz apart, tighter than the other bands.
 * Every band's edges and centre carry its three reference tones. A lower sample rate
 * (a Bluetooth headset can drop to 16 kHz) cuts off the upper bands; the UI warns.
 *
 * A station listens to and transmits on one band at a time, chosen by the user.
 */

import { bandwidthHz, type ProtocolSpec } from '../protocol/spec';

export interface Band {
  readonly name: string;
  readonly lowHz: number;
  readonly highHz: number;
  /** Plan-wide number of this band's first channel (1-based). */
  readonly firstNumber: number;
  /** Channels spread evenly across the band; 0 means the band is reserved only. */
  readonly channelCount: number;
}

export const LOW_BAND: Band = {
  name: 'low',
  lowHz: 100,
  highHz: 300,
  firstNumber: 1,
  channelCount: 3,
};

export const AUDIBLE_BAND: Band = {
  name: 'audible',
  lowHz: 300,
  highHz: 10000,
  firstNumber: 4,
  channelCount: 4,
};

export const ULTRASONIC_BAND: Band = {
  name: 'ultrasonic',
  lowHz: 17500,
  highHz: 21000,
  firstNumber: 8,
  channelCount: 10,
};

/** Every band, in ascending frequency and channel-number order. */
export const BANDS: readonly Band[] = [LOW_BAND, AUDIBLE_BAND, ULTRASONIC_BAND];

/** The band selected on first visit. */
export const DEFAULT_BAND: Band = ULTRASONIC_BAND;

/** A count of channels this wide still spread evenly across the band, at least bandwidthHz(spec) apart. */
function countFits(spec: ProtocolSpec, band: Band, count: number): boolean {
  const bw = bandwidthHz(spec);
  if (count < 2) return bw <= band.highHz - band.lowHz;
  return Math.floor((band.highHz - band.lowHz - bw) / (count - 1)) >= bw;
}

/**
 * The most channels of `band` a protocol's bandwidth allows, spread the same
 * evenly-gapped way as when they all fit: min(band.channelCount, the largest
 * count that does), or 0 if not even one does. Fewer channels only ever fit
 * more easily than more (each has the whole band's width to share out among
 * fewer neighbours), so counting down from band.channelCount always finds it.
 */
export function effectiveChannelCount(spec: ProtocolSpec, band: Band): number {
  for (let n = band.channelCount; n >= 1; n--) if (countFits(spec, band, n)) return n;
  return 0;
}

/** Whether a protocol has room for at least one channel of the band. */
export function bandFits(spec: ProtocolSpec, band: Band): boolean {
  return effectiveChannelCount(spec, band) > 0;
}

/** The bands a protocol can use, in plan order. */
export function bandsFor(spec: ProtocolSpec): Band[] {
  return BANDS.filter((b) => bandFits(spec, b));
}

/** Calibration tones: low edge, centre and high edge of a band. */
export function referenceTonesHz(band: Band): readonly number[] {
  return [band.lowHz, (band.lowHz + band.highHz) / 2, band.highHz];
}

export interface Channel {
  /** 1-based plan-wide number, fixed for a given protocol. */
  readonly number: number;
  /** Frequency of tone 0. The transmission occupies baseHz..baseHz + bandwidth. */
  readonly baseHz: number;
  readonly centerHz: number;
}

/** Channels in one band, or in the whole plan when no band is given. */
export function channelCount(band?: Band): number {
  return band ? band.channelCount : BANDS.reduce((n, b) => n + b.channelCount, 0);
}

/** The band a plan-wide channel number belongs to, or null if outside the plan. */
export function bandForChannel(channelNumber: number): Band | null {
  return (
    BANDS.find(
      (b) => channelNumber >= b.firstNumber && channelNumber < b.firstNumber + b.channelCount,
    ) ?? null
  );
}

/**
 * Distance between adjacent channel base frequencies, using as many channels as
 * actually fit (`effectiveChannelCount`), not necessarily the band's full
 * count. Rounded down to a whole Hz so every base frequency is a whole number;
 * the last channel therefore ends a few Hz short of the band's high edge
 * rather than past it.
 */
export function channelSpacingHz(spec: ProtocolSpec, band: Band): number {
  const count = effectiveChannelCount(spec, band);
  if (count === 0) {
    throw new RangeError(
      `${band.channelCount} channels of ${bandwidthHz(spec)} Hz do not fit in ${band.name} band`,
    );
  }
  if (count < 2) return 0;
  return Math.floor((band.highHz - band.lowHz - bandwidthHz(spec)) / (count - 1));
}

export function channelAt(spec: ProtocolSpec, channelNumber: number): Channel {
  const band = Number.isInteger(channelNumber) ? bandForChannel(channelNumber) : null;
  if (!band) {
    throw new RangeError(`channel ${channelNumber} is outside 1..${channelCount()}`);
  }
  const index = channelNumber - band.firstNumber;
  const count = effectiveChannelCount(spec, band);
  if (index >= count) {
    throw new RangeError(
      `channel ${channelNumber} does not exist for ${spec.name}: only ${count} of ${band.name}'s ${band.channelCount} channels fit its ${bandwidthHz(spec)} Hz bandwidth`,
    );
  }
  const baseHz = band.lowHz + index * channelSpacingHz(spec, band);
  return { number: channelNumber, baseHz, centerHz: baseHz + bandwidthHz(spec) / 2 };
}

/**
 * Channels of one band, or of every band the protocol fits when no band is given
 * (numbers keep their plan-wide values, so a skipped band, or channels a wide
 * protocol can't fit of one it partly does, leave a gap in them).
 */
export function listChannels(spec: ProtocolSpec, band?: Band): Channel[] {
  const bands = band ? [band] : bandsFor(spec);
  return bands.flatMap((b) =>
    Array.from({ length: effectiveChannelCount(spec, b) }, (_, i) => channelAt(spec, b.firstNumber + i)),
  );
}

/** The channel whose occupied width contains a frequency, or null in the gaps. */
export function channelForFrequency(spec: ProtocolSpec, freqHz: number): Channel | null {
  for (const band of bandsFor(spec)) {
    if (freqHz < band.lowHz || freqHz > band.highHz) continue;
    const i = Math.floor((freqHz - band.lowHz) / channelSpacingHz(spec, band));
    if (i >= effectiveChannelCount(spec, band)) continue;
    const ch = channelAt(spec, band.firstNumber + i);
    if (freqHz <= ch.baseHz + bandwidthHz(spec)) return ch;
  }
  return null;
}
