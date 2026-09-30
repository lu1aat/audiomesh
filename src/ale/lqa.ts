/**
 * Link quality analysis (LQA), the heart of ALE: which channel works between me and
 * that station. Pure, no audio, no DOM; time is a UTC slot index like the chat layer.
 *
 * Two kinds of evidence, both per (station, channel), both smoothed in dB:
 *  - heard:    I decoded a frame from `station` on `channel` at this SNR (near end).
 *  - reported: `station` told me it heard ME on `channel` at this SNR (far end).
 *
 * The far end is what matters for transmitting: speakers, microphones and rooms
 * differ, so A hearing B well does not make B heard well by A. Heard values are
 * only a fallback (assuming the link is roughly reciprocal, with a penalty).
 *
 * Channels are opaque numbers here (the plan-wide channel number, 1..MAX_CHANNEL).
 */

/** "I hear `station` on `channel` at `snrDb`", as carried in sound and ack frames. */
export interface LinkReport {
  readonly station: number;
  readonly channel: number;
  readonly snrDb: number;
}

/** The report fields are 5 bits wide. */
export const MAX_CHANNEL = 31;

/** What a heard-only score is docked, since nothing says the far end hears equally well. */
export const RECIPROCITY_PENALTY_DB = 3;
/** Score assumed for a (station, channel) pair with no evidence when several stations must be reached. */
export const UNKNOWN_SNR_DB = -10;
/** Channels within this many dB of the best are equally good; one is picked at random to spread load. */
export const TIE_DB = 3;
/** Each other transmitter heard lately on a channel counts as this many dB against it. */
export const LOAD_PENALTY_DB = 4;
/** A channel must score at least this to be chosen over a better one because it is less busy (the decoder is reliable to about -18 dB). */
export const VIABLE_DB = -15;

export interface ChannelChoice {
  /** Channel -> other transmitters heard on it lately (see `channelLoad`). */
  readonly load?: ReadonlyMap<number, number>;
  /** Keep this channel (the one used last for the same destination) while it is among the best. */
  readonly prefer?: number;
}

/** One line of the link quality view. `lastSlot` is the slot of the newest evidence. */
export interface LqaRow {
  station: number;
  channel: number;
  heardDb?: number;
  reportedDb?: number;
  heardCount: number;
  reportedCount: number;
  lastSlot: number;
}

const pairKey = (station: number, channel: number): string => `${station}:${channel}`;

interface Entry {
  snrDb: number;
  slot: number;
  /** Measurements folded into snrDb. */
  count: number;
}

/** One raw decode, kept for the signal history chart. */
export interface Sample {
  readonly slot: number;
  readonly station: number;
  readonly channel: number;
  readonly snrDb: number;
}

const MAX_SAMPLES = 1000;

/** The persisted form: [station, [[channel, snrDb, slot, count], ...]] per side, plus the raw decodes. */
export interface LqaState {
  heard: (readonly [number, readonly (readonly [number, number, number, number])[]])[];
  reported: (readonly [number, readonly (readonly [number, number, number, number])[]])[];
  samples: readonly Sample[];
  /** Third-party links: [listener, talker, channel, snrDb, slot, count]. Absent in older saves. */
  overheard?: readonly (readonly [number, number, number, number, number, number])[];
  /** Slot length the slot numbers above count in; absent in older saves. */
  slotSec?: number;
}

export interface LqaOptions {
  /** Evidence older than this many slots is ignored. Default 120 (30 min of 15 s slots). */
  maxAgeSlots?: number;
  /** Weight of a new measurement in the running value, 0..1. Default 0.5. */
  smoothing?: number;
  /**
   * A station not heard on any channel for more than this many slots is left out of
   * our sound reports: its link is no longer active, and reporting it would keep a dead
   * link alive in other stations' graphs. Default 40 (10 min of 15 s slots).
   */
  reportSilenceSlots?: number;
  /** Slot length of the protocol in use (seconds). Saved with the evidence so a protocol change can convert it. */
  slotSec?: number;
}

export class LqaTable {
  private readonly maxAgeSlots: number;
  private readonly smoothing: number;
  private readonly slotSec: number | undefined;
  private readonly reportSilenceSlots: number;
  private readonly heardBy = new Map<number, Map<number, Entry>>(); // station -> channel -> entry
  private readonly reportedBy = new Map<number, Map<number, Entry>>();
  /** Slot at which we last put a report about a (station, channel) pair on the air. */
  private readonly samples: Sample[] = [];
  private readonly lastReportSlot = new Map<string, number>();
  /** What other stations say they hear of each other (not us): `listener>talker:channel` -> entry. */
  private readonly overheardBy = new Map<string, Entry & { listener: number; talker: number; channel: number }>();

  constructor(options: LqaOptions = {}) {
    this.maxAgeSlots = options.maxAgeSlots ?? 120;
    this.slotSec = options.slotSec;
    this.smoothing = options.smoothing ?? 0.5;
    this.reportSilenceSlots = options.reportSilenceSlots ?? 40;
  }

  /** We decoded `station` on `channel`. */
  heard(station: number, channel: number, snrDb: number, slot: number): void {
    this.put(this.heardBy, station, channel, snrDb, slot);
    this.samples.push({ slot, station, channel, snrDb });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.onChange?.();
  }

  /** Called after any change to the evidence, e.g. to schedule a save. */
  onChange: (() => void) | null = null;

  /** Everything kept, as plain JSON-safe data for `restore`. */
  serialize(): LqaState {
    const side = (m: Map<number, Map<number, Entry>>): LqaState['heard'] =>
      [...m].map(([station, row]) => [station, [...row].map(([channel, e]) => [channel, e.snrDb, e.slot, e.count] as const)] as const);
    const overheard = [...this.overheardBy.values()].map((e) => [e.listener, e.talker, e.channel, e.snrDb, e.slot, e.count] as const);
    return { heard: side(this.heardBy), reported: side(this.reportedBy), samples: this.samples, overheard, slotSec: this.slotSec };
  }

  /** Load what `serialize` produced (from storage, so anything may be malformed: bad parts are skipped). */
  restore(state: unknown, nowMs = Date.now()): void {
    const s = state as Partial<LqaState> | undefined;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    // Slot numbers count in the slot length of the protocol that saved them. After a switch
    // (Fast 5 s -> Normal 15 s) an old number lies in the future, and its age would clamp to 0 s.
    // Convert by time; a save without a slot length cannot be converted, but a future slot is
    // known to be wrong and is dropped.
    const ratio = this.slotSec !== undefined && num(s?.slotSec) && s.slotSec > 0 ? s.slotSec / this.slotSec : 1;
    const nowSlot = this.slotSec !== undefined ? Math.floor(nowMs / (this.slotSec * 1000)) : Infinity;
    const slotOf = (slot: number): number | null => {
      const converted = Math.round(slot * ratio);
      return converted > nowSlot + 1 ? null : converted;
    };
    const side = (into: Map<number, Map<number, Entry>>, data: unknown): void => {
      if (!Array.isArray(data)) return;
      for (const item of data) {
        if (!Array.isArray(item) || !num(item[0]) || !Array.isArray(item[1])) continue;
        const row = new Map<number, Entry>();
        for (const e of item[1]) {
          const slot = Array.isArray(e) && num(e[2]) ? slotOf(e[2]) : null;
          if (Array.isArray(e) && num(e[0]) && num(e[1]) && slot !== null && num(e[3])) row.set(e[0], { snrDb: e[1], slot, count: e[3] });
        }
        if (row.size > 0) into.set(item[0], row);
      }
    };
    side(this.heardBy, s?.heard);
    side(this.reportedBy, s?.reported);
    if (Array.isArray(s?.overheard)) {
      for (const e of s.overheard) {
        const slot = Array.isArray(e) && num(e[4]) ? slotOf(e[4]) : null;
        if (Array.isArray(e) && e.length === 6 && e.every(num) && slot !== null) this.overheardPut(e[0], e[1], e[2], e[3], slot, e[5]);
      }
    }
    if (Array.isArray(s?.samples)) {
      for (const x of s.samples) {
        const slot = x && num(x.slot) ? slotOf(x.slot) : null;
        if (x && slot !== null && num(x.station) && num(x.channel) && num(x.snrDb)) this.samples.push({ slot, station: x.station, channel: x.channel, snrDb: x.snrDb });
      }
      this.samples.splice(0, Math.max(0, this.samples.length - MAX_SAMPLES));
    }
  }

  /** Forget all link statistics. */
  clear(): void {
    this.heardBy.clear();
    this.reportedBy.clear();
    this.samples.length = 0;
    this.overheardBy.clear();
    this.lastReportSlot.clear();
    this.onChange?.();
  }

  /** Raw decodes from `sinceSlot` on, oldest first, for the history chart. */
  history(sinceSlot: number): readonly Sample[] {
    return this.samples.filter((x) => x.slot >= sinceSlot);
  }

  /** `station` says it hears us on `channel`. */
  reported(station: number, channel: number, snrDb: number, slot: number): void {
    this.put(this.reportedBy, station, channel, snrDb, slot);
    this.onChange?.();
  }

  /** `listener` says it hears `talker` (neither is us) on `channel`. */
  overheard(listener: number, talker: number, channel: number, snrDb: number, slot: number): void {
    const key = `${listener}>${talker}:${channel}`;
    const old = this.overheardBy.get(key);
    const fresh = old !== undefined && slot - old.slot <= this.maxAgeSlots;
    this.overheardPut(listener, talker, channel, fresh ? old.snrDb + this.smoothing * (snrDb - old.snrDb) : snrDb, slot, fresh ? old.count + 1 : 1);
    this.onChange?.();
  }

  private overheardPut(listener: number, talker: number, channel: number, snrDb: number, slot: number, count: number): void {
    this.overheardBy.set(`${listener}>${talker}:${channel}`, { listener, talker, channel, snrDb, slot, count });
  }

  /** Links between other stations, fresh ones only: the best channel of each (talker, listener) pair. */
  thirdPartyLinks(slot: number): { talker: number; listener: number; channel: number; snrDb: number; slot: number }[] {
    const best = new Map<string, { talker: number; listener: number; channel: number; snrDb: number; slot: number }>();
    for (const e of this.overheardBy.values()) {
      if (slot - e.slot > this.maxAgeSlots) continue;
      const key = `${e.talker}>${e.listener}`;
      const b = best.get(key);
      if (!b || e.snrDb > b.snrDb) best.set(key, { talker: e.talker, listener: e.listener, channel: e.channel, snrDb: e.snrDb, slot: e.slot });
    }
    return [...best.values()];
  }

  private put(into: Map<number, Map<number, Entry>>, station: number, channel: number, snrDb: number, slot: number): void {
    let row = into.get(station);
    if (!row) into.set(station, (row = new Map()));
    const old = row.get(channel);
    const fresh = old !== undefined && slot - old.slot <= this.maxAgeSlots;
    row.set(channel, {
      snrDb: fresh ? old.snrDb + this.smoothing * (snrDb - old.snrDb) : snrDb,
      slot,
      count: fresh ? old.count + 1 : 1,
    });
  }

  /** Stations heard within the age limit. */
  stations(slot: number): number[] {
    return [...this.heardBy.keys()].filter((s) => this.latestHeard(s, slot) !== undefined);
  }

  /** The most recent thing heard from `station`, for the ack that answers it. */
  latestHeard(station: number, slot?: number): { channel: number; snrDb: number } | undefined {
    let best: { channel: number; snrDb: number; at: number } | undefined;
    for (const [channel, e] of this.heardBy.get(station) ?? []) {
      if (slot !== undefined && slot - e.slot > this.maxAgeSlots) continue;
      if (!best || e.slot > best.at) best = { channel, snrDb: e.snrDb, at: e.slot };
    }
    return best && { channel: best.channel, snrDb: best.snrDb };
  }

  /** Smoothed SNR of `station` heard on `channel`, or undefined when unknown or stale. */
  heardSnr(station: number, channel: number, slot: number): number | undefined {
    return this.fresh(this.heardBy.get(station)?.get(channel), slot);
  }

  /** Smoothed SNR at which `station` reports hearing us on `channel`, or undefined. */
  reportedSnr(station: number, channel: number, slot: number): number | undefined {
    return this.fresh(this.reportedBy.get(station)?.get(channel), slot);
  }

  private fresh(e: Entry | undefined, slot: number): number | undefined {
    return e && slot - e.slot <= this.maxAgeSlots ? e.snrDb : undefined;
  }

  /**
   * How well `station` should hear us on `channel`: the far end's own report. Only
   * while it has reported nothing at all (on any channel) do we guess from what we
   * heard of it, docked; once it has told us anything, a channel it did not
   * report is unknown, not "probably like the near end".
   */
  txScore(station: number, channel: number, slot: number): number | undefined {
    const row = this.reportedBy.get(station);
    if (row && [...row.values()].some((e) => slot - e.slot <= this.maxAgeSlots)) {
      return this.reportedSnr(station, channel, slot);
    }
    const near = this.heardSnr(station, channel, slot);
    return near === undefined ? undefined : near - RECIPROCITY_PENALTY_DB;
  }

  /** Everything currently known, for display: one row per (station, channel), by station then channel. */
  snapshot(slot: number): LqaRow[] {
    const rows = new Map<string, LqaRow>();
    const row = (station: number, channel: number) => {
      const key = pairKey(station, channel);
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { station, channel, heardCount: 0, reportedCount: 0, lastSlot: 0 }));
      return r;
    };
    for (const [station, chs] of this.heardBy) for (const channel of chs.keys()) {
      const v = this.heardSnr(station, channel, slot);
      if (v !== undefined) {
        const r = row(station, channel);
        r.heardDb = v;
        r.heardCount = chs.get(channel)!.count;
        r.lastSlot = Math.max(r.lastSlot, chs.get(channel)!.slot);
      }
    }
    for (const [station, chs] of this.reportedBy) for (const channel of chs.keys()) {
      const v = this.reportedSnr(station, channel, slot);
      if (v !== undefined) {
        const r = row(station, channel);
        r.reportedDb = v;
        r.reportedCount = chs.get(channel)!.count;
        r.lastSlot = Math.max(r.lastSlot, chs.get(channel)!.slot);
      }
    }
    return [...rows.values()].sort((a, b) => a.station - b.station || a.channel - b.channel);
  }

  /**
   * Up to `count` reports about (station, channel) pairs we have heard, the ones
   * reported longest ago first, so successive sounds rotate through every station
   * and every channel of it. (Reporting only the latest channel would hide the good
   * ones.) Marks them as reported. A station silent for over `reportSilenceSlots`
   * is not reported at all, on any channel; each channel's own evidence must also be
   * younger than `maxAgeSlots`.
   */
  reportsToSend(count: number, slot: number, first?: number): LinkReport[] {
    const pairs: { station: number; channel: number; snrDb: number; last: number }[] = [];
    for (const [station, row] of this.heardBy) {
      const newest = Math.max(...[...row.values()].map((e) => e.slot));
      if (slot - newest > this.reportSilenceSlots) continue;
      for (const [channel, e] of row) {
        if (slot - e.slot > this.maxAgeSlots) continue;
        pairs.push({ station, channel, snrDb: e.snrDb, last: this.lastReportSlot.get(pairKey(station, channel)) ?? -Infinity });
      }
    }
    // `first`: the station asking (a probe) gets its reports ahead of the rotation.
    pairs.sort((a, b) => Number(b.station === first) - Number(a.station === first) || a.last - b.last);
    return pairs.slice(0, count).map(({ station, channel, snrDb }) => {
      this.lastReportSlot.set(pairKey(station, channel), slot);
      return { station, channel, snrDb };
    });
  }

  /**
   * Channels ranked (best first) for reaching every station in `to`: the worst-case
   * score over them, a station with no evidence on a channel counting as
   * UNKNOWN_SNR_DB. Channels nothing is known about are left out.
   */
  rankChannels(to: readonly number[], channels: readonly number[], slot: number): { channel: number; score: number }[] {
    const scored: { channel: number; score: number }[] = [];
    for (const channel of channels) {
      let known = 0;
      let worst = Infinity;
      for (const station of to) {
        const s = this.txScore(station, channel, slot);
        if (s !== undefined) known++;
        worst = Math.min(worst, s ?? UNKNOWN_SNR_DB);
      }
      if (known > 0) scored.push({ channel, score: worst });
    }
    return scored.sort((a, b) => b.score - a.score || a.channel - b.channel);
  }

  /** The best channel for reaching one station, and whether that rests on its own report or a guess from what we heard. */
  bestFor(station: number, channels: readonly number[], slot: number): { channel: number; score: number; measured: boolean } | undefined {
    const top = this.rankChannels([station], channels, slot)[0];
    if (!top) return undefined;
    return { ...top, measured: this.reportedSnr(station, top.channel, slot) !== undefined };
  }

  /**
   * The channel to transmit on so that every station in `to` hears us: the best
   * worst-case score, with a random pick among those within TIE_DB of the best so
   * stations do not all pile onto one channel. Undefined when nothing is known
   * about any of them on any of `channels`.
   *
   * Busy channels: each other transmitter heard on a channel lately docks it
   * LOAD_PENALTY_DB, so a crowded channel gives way to a quieter one, but only to a
   * channel that still scores VIABLE_DB (when nothing does, only the link counts);
   * among channels that tie, the least busy ones.
   * `prefer` (the channel used last for this destination) is kept while it is among
   * the best, so each station settles on a channel instead of hopping.
   */
  chooseChannel(
    to: readonly number[],
    channels: readonly number[],
    slot: number,
    random: () => number = Math.random,
    choice: ChannelChoice = {},
  ): number | undefined {
    const scored = this.rankChannels(to, channels, slot);
    if (scored.length === 0) return undefined;
    const best = Math.max(...scored.map((s) => s.score));
    const load = (ch: number): number => choice.load?.get(ch) ?? 0;
    const usable = best >= VIABLE_DB ? scored.filter((s) => s.score >= VIABLE_DB) : scored.filter((s) => s.score >= best - TIE_DB);
    const effective = usable.map((s) => ({ channel: s.channel, score: s.score - LOAD_PENALTY_DB * load(s.channel) }));
    const bestEff = Math.max(...effective.map((s) => s.score));
    // Among channels that tie, the least busy: a crowded one never wins a coin toss.
    const tied = effective.filter((s) => s.score >= bestEff - TIE_DB);
    const quiet = Math.min(...tied.map((s) => load(s.channel)));
    const near = tied.filter((s) => load(s.channel) === quiet);
    const kept = near.find((s) => s.channel === choice.prefer);
    if (kept) return kept.channel;
    return near[Math.floor(random() * near.length)]!.channel;
  }
}

/**
 * Which channel a station sounds on: a rotation offset by the station id, so
 * stations sounding in the same slot usually use different channels.
 */
export function soundChannel(stationId: number, soundCount: number, channels: readonly number[]): number {
  return channels[(stationId + soundCount) % channels.length]!;
}
