/** Pure rules behind where and when automatic transmissions go; kept out of the UI so tests can reach them. */

/**
 * Why every frame (sounds included) must go on the selected channel, or null when it need not.
 * Needs a selected channel and either Auto channel off or Auto beacon off.
 */
export function pinnedReason(selected: boolean, autoChannel: boolean, autoSound: boolean): string | null {
  if (!selected) return null;
  if (!autoChannel) return 'selected channel, auto channel off';
  if (!autoSound) return 'selected channel, auto beacon off';
  return null;
}

/** Whether the periodic Auto beacon is due. Independent of Auto channel. */
export function autoBeaconDue(autoSound: boolean, audioRunning: boolean, lastSoundMs: number, nowMs: number, intervalMin: number): boolean {
  return autoSound && audioRunning && nowMs - lastSoundMs >= intervalMin * 60_000;
}
