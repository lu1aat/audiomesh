import { describe, expect, it } from 'vitest';
import { pickRetryChannel } from '../src/ale/retry-channel';

const band = [8, 9, 10, 11, 12, 13, 14, 15];

describe('pickRetryChannel', () => {
  it('never repeats a channel the message already used while others are left', () => {
    expect(pickRetryChannel([8], band, [8, 9])).toBe(9);
    expect(pickRetryChannel([8, 9], band, [8, 9, 10])).toBe(10);
  });

  it('takes the best ranked candidate', () => {
    expect(pickRetryChannel([8], band, [8, 12, 11])).toBe(12);
  });

  it('with no link data goes to the middle of the band, not an edge', () => {
    expect(pickRetryChannel([8], band, [])).toBe(11);
    expect(pickRetryChannel([11], band, [])).toBe(12);
  });

  it('ignores ranked channels outside the band', () => {
    expect(pickRetryChannel([8], band, [40, 10])).toBe(10);
  });

  it('once every channel was tried, avoids only the last one', () => {
    expect(pickRetryChannel(band, band, [])).not.toBe(15);
    expect(pickRetryChannel(band, band, [])).toBe(11);
  });

  it('works with a single channel and with none', () => {
    expect(pickRetryChannel([4], [4], [])).toBe(4);
    expect(pickRetryChannel([], [], [])).toBeUndefined();
  });
});
