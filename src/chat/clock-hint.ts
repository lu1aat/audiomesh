/**
 * Clock advice without a time server: whose clock is off, judged from when other
 * stations' frames start against our UTC slots. Pure (no DOM), so tests reach it.
 *
 * A frame that starts `d` s after our slot boundary (d > 0: late) means the sender's
 * clock is `d` s behind ours, give or take the audio latency of both ends (a few
 * hundred ms). With two or more stations heard, a majority tells which clock is wrong:
 * if everyone is late by the same amount, it is ours.
 */

import type { StationDelay } from './frame-log';

/** Offsets smaller than this are latency and noise, not a wrong clock. */
export const CLOCK_OFF_SEC = 0.5;
/** A station counts once this many of its frames have been timed. */
export const MIN_TIMED_FRAMES = 2;

export interface ClockHint {
  readonly text: string;
  /** Offer to move our slot grid to this offset against UTC. */
  readonly action?: { readonly label: string; readonly offsetMs: number };
}

/** Best sync of a slot where nothing decoded. dtSec is against our (possibly shifted) grid. */
export interface UndecodedSync {
  readonly atMs: number;
  readonly score: number;
  readonly dtSec: number;
}

export interface ClockInput {
  /** Median frame start per station against UTC slots (`stationDelays`). */
  readonly delays: ReadonlyMap<number, StationDelay>;
  /** Our grid's offset against UTC. */
  readonly offsetMs: number;
  /** The protocol's usual search, +- seconds. */
  readonly maxTimeOffsetSec: number;
  /** Extra seconds searched each side (0 = deep decoding off). */
  readonly deepExtraSec: number;
  readonly deepOn: boolean;
  readonly undecoded: readonly UndecodedSync[];
  readonly nowMs: number;
  readonly slotSec: number;
  readonly name: (id: number) => string;
  readonly myId: number;
  /** Latest check of this clock against the page's server (local - server), if any. */
  readonly server?: { readonly offsetMs: number; readonly uncertaintyMs: number; readonly atMs: number } | null;
}

/** A server check older than this no longer counts. */
const SERVER_FRESH_MS = 30 * 60_000;

/** A sync this strong that did not decode is a real frame, not noise (noise peaks at about 0.23). */
const REAL_SYNC = 0.3;
/** How far back undecoded signals count. */
const UNDECODED_WINDOW_SLOTS = 12;

const secText = (v: number): string => `${Math.abs(v).toFixed(1)} s`;
const lateEarly = (d: number): string => (d > 0 ? 'late' : 'early');
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function clockHints(input: ClockInput): ClockHint[] {
  const hints: ClockHint[] = [];
  const offsetSec = input.offsetMs / 1000;
  const s = input.server;
  if (s && input.nowMs - s.atMs < SERVER_FRESH_MS && Math.abs(s.offsetMs) >= CLOCK_OFF_SEC * 1000 && Math.abs(s.offsetMs - input.offsetMs) >= 100) {
    const off = s.offsetMs / 1000;
    hints.push({
      text: `The server says this device's clock is ${secText(off)} ${off > 0 ? 'ahead' : 'behind'} (±${Math.round(s.uncertaintyMs)} ms). Best: set this device's date and time automatically. Or move the slot timing to match the server.`,
      action: { label: 'Use server time', offsetMs: Math.round(s.offsetMs) },
    });
  }
  const timed = [...input.delays]
    .filter(([id, d]) => id !== input.myId && d.n >= MIN_TIMED_FRAMES)
    .map(([id, d]) => ({ id, d: d.delaySec }));

  if (timed.length >= 2) {
    const mid = median(timed.map((t) => t.d));
    const agree = timed.every((t) => Math.abs(t.d - mid) < CLOCK_OFF_SEC);
    if (agree && Math.abs(mid) >= CLOCK_OFF_SEC) {
      hints.push({
        text: `All ${timed.length} stations heard are ${secText(mid)} ${lateEarly(mid)} against this device's clock, so this clock is probably ${secText(mid)} ${mid > 0 ? 'ahead' : 'behind'}. Best: set this device's date and time automatically. Or move the slot timing to match them.`,
        action: { label: `Sync to them (${mid >= 0 ? '+' : '−'}${Math.abs(mid).toFixed(2)} s)`, offsetMs: Math.round(mid * 1000) },
      });
    } else {
      for (const t of timed) {
        const others = timed.filter((o) => o.id !== t.id);
        const othersOnTime = others.every((o) => Math.abs(o.d) < CLOCK_OFF_SEC);
        if (Math.abs(t.d) >= CLOCK_OFF_SEC && othersOnTime) {
          hints.push({
            text: `${input.name(t.id)} is ${secText(t.d)} ${lateEarly(t.d)} while the other stations are on time: its clock is probably ${secText(t.d)} ${t.d > 0 ? 'behind' : 'ahead'}. Fix the date and time on that device (set it automatically), or press "Sync to this station" there for this one.`,
          });
        }
      }
    }
  } else if (timed.length === 1) {
    const t = timed[0]!;
    if (Math.abs(t.d) >= CLOCK_OFF_SEC) {
      hints.push({
        text: `${input.name(t.id)} is ${secText(t.d)} ${lateEarly(t.d)} against this device's clock: one of the two clocks is off by about ${secText(t.d)}. With only two stations there is no telling which; the one whose clock is wrong should set it automatically. Or sync to it.`,
        action: { label: `Sync to ${input.name(t.id)}`, offsetMs: Math.round(t.d * 1000) },
      });
    }
  }

  // Close to the edge of what we search: the next small drift loses frames.
  const reach = input.maxTimeOffsetSec + (input.deepOn ? input.deepExtraSec : 0);
  for (const t of timed) {
    const onGrid = t.d - offsetSec;
    if (Math.abs(onGrid) > 0.7 * reach) {
      hints.push({
        text: `${input.name(t.id)}'s frames start ${secText(onGrid)} ${lateEarly(onGrid)} on our slot grid, near the ±${reach.toFixed(1)} s the receiver searches: frames will be lost.${input.deepOn || input.deepExtraSec === 0 ? '' : ' Turn on Deep decode, or sync.'}`,
        action: { label: `Sync to ${input.name(t.id)}`, offsetMs: Math.round(t.d * 1000) },
      });
    }
  }

  // Signals seen but never decoded, at the edge of the search: a station out of reach in time.
  const since = input.nowMs - UNDECODED_WINDOW_SLOTS * input.slotSec * 1000;
  const edge = input.undecoded.filter((u) => u.atMs >= since && u.score >= REAL_SYNC && Math.abs(u.dtSec) >= 0.6 * reach);
  if (edge.length >= 2) {
    const dt = median(edge.map((u) => u.dtSec));
    if (!input.deepOn && input.deepExtraSec > 0) {
      hints.push({
        text: `In ${edge.length} recent slots a signal was seen but not decoded, ${secText(dt)} ${lateEarly(dt)} at the edge of the ±${reach.toFixed(1)} s timing window: a station's clock is probably off by more than that. Turn on Deep decode to hear it and measure its offset.`,
      });
    } else {
      const guess = offsetSec + dt + Math.sign(dt) * 1;
      hints.push({
        text: `In ${edge.length} recent slots a signal was seen but not decoded at the edge of the ±${reach.toFixed(1)} s timing window (${secText(dt)} ${lateEarly(dt)}). Its clock may be off by even more: try a manual offset of about ${guess >= 0 ? '+' : '−'}${Math.abs(guess).toFixed(1)} s, or fix that device's clock.`,
        action: { label: `Try ${guess >= 0 ? '+' : '−'}${Math.abs(guess).toFixed(1)} s`, offsetMs: Math.round(guess * 1000) },
      });
    }
  }
  return hints;
}
