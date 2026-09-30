/**
 * Slot arithmetic on the wall clock. Slots start at multiples of `slotSec` since
 * the Unix epoch, so any two stations with the right UTC time agree on them without
 * talking to each other. (Unix time ignores leap seconds; every station does.)
 */

import type { ProtocolSpec } from './spec';

const slotMs = (spec: ProtocolSpec): number => spec.slotSec * 1000;

export const slotIndexAt = (wallMs: number, spec: ProtocolSpec): number =>
  Math.floor(wallMs / slotMs(spec));

export const slotStartMs = (index: number, spec: ProtocolSpec): number => index * slotMs(spec);

/**
 * The first slot boundary at least `minLeadMs` from now. The lead gives a message
 * sent to another thread time to arrive before the boundary it is aimed at.
 */
export function nextSlotStartMs(wallMs: number, spec: ProtocolSpec, minLeadMs = 0): number {
  return Math.ceil((wallMs + minLeadMs) / slotMs(spec)) * slotMs(spec);
}
