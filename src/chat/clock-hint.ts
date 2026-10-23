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
import { num, t } from '../i18n/i18n';

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

const secText = (v: number): string => `${num(Math.abs(v), 1)} s`;
const signedSec = (v: number, digits: number): string => `${v >= 0 ? '+' : '−'}${num(Math.abs(v), digits)} s`;
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
    const vars = { s: secText(off), pm: Math.round(s.uncertaintyMs) };
    hints.push({
      text: (off > 0 ? t("The server says this device's clock is {s} ahead (±{pm} ms).", vars) : t("The server says this device's clock is {s} behind (±{pm} ms).", vars)) + ' ' +
        t("Best: set this device's date and time automatically. Or move the slot timing to match the server."),
      action: { label: t('Use server time'), offsetMs: Math.round(s.offsetMs) },
    });
  }
  const timed = [...input.delays]
    .filter(([id, d]) => id !== input.myId && d.n >= MIN_TIMED_FRAMES)
    .map(([id, d]) => ({ id, d: d.delaySec }));

  if (timed.length >= 2) {
    const mid = median(timed.map((t) => t.d));
    const agree = timed.every((t) => Math.abs(t.d - mid) < CLOCK_OFF_SEC);
    if (agree && Math.abs(mid) >= CLOCK_OFF_SEC) {
      const vars = { n: timed.length, s: secText(mid) };
      hints.push({
        text: (mid > 0 ? t("All {n} stations heard are {s} late against this device's clock, so this clock is probably {s} ahead.", vars)
          : t("All {n} stations heard are {s} early against this device's clock, so this clock is probably {s} behind.", vars)) + ' ' +
          t("Best: set this device's date and time automatically. Or move the slot timing to match them."),
        action: { label: t('Sync to them ({s})', { s: signedSec(mid, 2) }), offsetMs: Math.round(mid * 1000) },
      });
    } else {
      for (const st of timed) {
        const others = timed.filter((o) => o.id !== st.id);
        const othersOnTime = others.every((o) => Math.abs(o.d) < CLOCK_OFF_SEC);
        if (Math.abs(st.d) >= CLOCK_OFF_SEC && othersOnTime) {
          const vars = { name: input.name(st.id), s: secText(st.d) };
          hints.push({
            text: (st.d > 0 ? t('{name} is {s} late while the other stations are on time: its clock is probably {s} behind.', vars)
              : t('{name} is {s} early while the other stations are on time: its clock is probably {s} ahead.', vars)) + ' ' +
              t('Fix the date and time on that device (set it automatically), or press "Sync to this station" there for this one.'),
          });
        }
      }
    }
  } else if (timed.length === 1) {
    const st = timed[0]!;
    if (Math.abs(st.d) >= CLOCK_OFF_SEC) {
      const vars = { name: input.name(st.id), s: secText(st.d) };
      hints.push({
        text: (st.d > 0 ? t("{name} is {s} late against this device's clock: one of the two clocks is off by about {s}.", vars)
          : t("{name} is {s} early against this device's clock: one of the two clocks is off by about {s}.", vars)) + ' ' +
          t('With only two stations there is no telling which; the one whose clock is wrong should set it automatically. Or sync to it.'),
        action: { label: t('Sync to {name}', vars), offsetMs: Math.round(st.d * 1000) },
      });
    }
  }

  // Close to the edge of what we search: the next small drift loses frames.
  const reach = input.maxTimeOffsetSec + (input.deepOn ? input.deepExtraSec : 0);
  for (const st of timed) {
    const onGrid = st.d - offsetSec;
    if (Math.abs(onGrid) > 0.7 * reach) {
      const vars = { name: input.name(st.id), s: secText(onGrid), reach: num(reach, 1) };
      hints.push({
        text: (onGrid > 0 ? t("{name}'s frames start {s} late on our slot grid, near the ±{reach} s the receiver searches: frames will be lost.", vars)
          : t("{name}'s frames start {s} early on our slot grid, near the ±{reach} s the receiver searches: frames will be lost.", vars)) +
          (input.deepOn || input.deepExtraSec === 0 ? '' : ' ' + t('Turn on Deep decode, or sync.')),
        action: { label: t('Sync to {name}', vars), offsetMs: Math.round(st.d * 1000) },
      });
    }
  }

  // Signals seen but never decoded, at the edge of the search: a station out of reach in time.
  const since = input.nowMs - UNDECODED_WINDOW_SLOTS * input.slotSec * 1000;
  const edge = input.undecoded.filter((u) => u.atMs >= since && u.score >= REAL_SYNC && Math.abs(u.dtSec) >= 0.6 * reach);
  if (edge.length >= 2) {
    const dt = median(edge.map((u) => u.dtSec));
    if (!input.deepOn && input.deepExtraSec > 0) {
      const vars = { n: edge.length, s: secText(dt), reach: num(reach, 1) };
      hints.push({
        text: (dt > 0 ? t("In {n} recent slots a signal was seen but not decoded, {s} late at the edge of the ±{reach} s timing window: a station's clock is probably off by more than that.", vars)
          : t("In {n} recent slots a signal was seen but not decoded, {s} early at the edge of the ±{reach} s timing window: a station's clock is probably off by more than that.", vars)) + ' ' +
          t('Turn on Deep decode to hear it and measure its offset.'),
      });
    } else {
      const guess = offsetSec + dt + Math.sign(dt) * 1;
      const vars = { n: edge.length, s: secText(dt), reach: num(reach, 1), guess: signedSec(guess, 1) };
      hints.push({
        text: (dt > 0 ? t('In {n} recent slots a signal was seen but not decoded at the edge of the ±{reach} s timing window ({s} late).', vars)
          : t('In {n} recent slots a signal was seen but not decoded at the edge of the ±{reach} s timing window ({s} early).', vars)) + ' ' +
          t("Its clock may be off by even more: try a manual offset of about {guess}, or fix that device's clock.", vars),
        action: { label: t('Try {guess}', vars), offsetMs: Math.round(guess * 1000) },
      });
    }
  }
  return hints;
}
