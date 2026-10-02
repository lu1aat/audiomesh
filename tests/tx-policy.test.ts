import { describe, expect, it } from 'vitest';
import { autoBeaconDue, pinnedReason } from '../src/ale/tx-policy';

describe('pinnedReason', () => {
  it('pins everything to the selected channel when Auto channel is off, even with Auto beacon on', () => {
    expect(pinnedReason(true, false, true)).not.toBeNull();
    expect(pinnedReason(true, false, false)).not.toBeNull();
  });
  it('pins when Auto beacon is off with a channel selected', () => {
    expect(pinnedReason(true, true, false)).not.toBeNull();
  });
  it('does not pin with both on, or with no channel selected', () => {
    expect(pinnedReason(true, true, true)).toBeNull();
    expect(pinnedReason(false, false, false)).toBeNull();
  });
});

describe('autoBeaconDue', () => {
  const min = 60_000;
  it('fires after the interval whatever Auto channel says (it is not a parameter)', () => {
    expect(autoBeaconDue(true, true, 0, 5 * min, 5)).toBe(true);
  });
  it('waits out the interval', () => {
    expect(autoBeaconDue(true, true, 0, 5 * min - 1, 5)).toBe(false);
  });
  it('stays quiet with Auto beacon off or audio stopped', () => {
    expect(autoBeaconDue(false, true, 0, 60 * min, 5)).toBe(false);
    expect(autoBeaconDue(true, false, 0, 60 * min, 5)).toBe(false);
  });
});
