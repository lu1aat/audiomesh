import { describe, expect, it } from 'vitest';
import { LOAD_WINDOW_SLOTS, channelLoad, quietestChannel } from '../src/ale/channel-load';

describe('channel load', () => {
  it('counts distinct transmitters per channel over the last few slots', () => {
    const load = channelLoad(
      [
        { slot: 99, channel: 5, transmitter: 's1' },
        { slot: 98, channel: 5, transmitter: 's1' }, // same station again
        { slot: 97, channel: 5, transmitter: 'r3' }, // a repeater
        { slot: 96, channel: 6, transmitter: 's2' },
        { slot: 100 - LOAD_WINDOW_SLOTS - 1, channel: 7, transmitter: 's4' }, // too old
        { slot: 100, channel: 8, transmitter: 's5' }, // not over yet
      ],
      100,
    );
    expect([...load].sort()).toEqual([[5, 2], [6, 1]]);
  });

  it('picks the quietest channel, the home channel on a tie, else the nearest to it', () => {
    expect(quietestChannel([1, 2, 3, 4], new Map(), 3)).toBe(3);
    expect(quietestChannel([1, 2, 3, 4], new Map([[3, 1]]), 3)).toBe(2);
    expect(quietestChannel([1, 2, 3, 4], new Map([[1, 1], [2, 1], [3, 2], [4, 1]]), 3)).toBe(2);
  });
});
