import { describe, expect, it } from 'vitest';
import {
  AUDIBLE_BAND,
  BANDS,
  LOW_BAND,
  ULTRASONIC_BAND,
  bandForChannel,
  channelAt,
  channelCount,
  channelForFrequency,
  channelSpacingHz,
  listChannels,
  referenceTonesHz,
} from '../src/band/band-plan';
import { GFSK8_NORMAL } from '../src/protocol/gfsk8/spec';
import { bandwidthHz } from '../src/protocol/spec';

describe('band plan (gfsk8-normal)', () => {
  it('has a low, an audible and an ultrasonic band, numbered continuously', () => {
    expect(BANDS).toEqual([LOW_BAND, AUDIBLE_BAND, ULTRASONIC_BAND]);
    expect([LOW_BAND, AUDIBLE_BAND, ULTRASONIC_BAND].map((b) => b.channelCount)).toEqual([3, 4, 10]);
    expect(channelCount()).toBe(17);
    const all = listChannels(GFSK8_NORMAL);
    expect(all.map((c) => c.number)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    for (let i = 1; i < all.length; i++) expect(all[i]!.baseHz).toBeGreaterThan(all[i - 1]!.baseHz);
    expect(bandForChannel(3)).toBe(LOW_BAND);
    expect(bandForChannel(4)).toBe(AUDIBLE_BAND);
    expect(bandForChannel(8)).toBe(ULTRASONIC_BAND);
  });

  it('keeps every band in its range with a gap between neighbours', () => {
    for (const band of BANDS) {
      const channels = listChannels(GFSK8_NORMAL, band);
      expect(channels[0]!.baseHz).toBe(band.lowHz);
      const topHz = channels[channels.length - 1]!.baseHz + bandwidthHz(GFSK8_NORMAL);
      expect(topHz).toBeLessThanOrEqual(band.highHz);
      expect(band.highHz - topHz).toBeLessThan(15);
      for (let i = 0; i + 1 < channels.length; i++) {
        const gap = channels[i + 1]!.baseHz - (channels[i]!.baseHz + bandwidthHz(GFSK8_NORMAL));
        expect(gap).toBeGreaterThan(band === LOW_BAND ? 0 : band === ULTRASONIC_BAND ? 300 : 500);
      }
    }
  });

  it('spaces channels evenly, with whole-Hz base frequencies', () => {
    const spacing = channelSpacingHz(GFSK8_NORMAL, AUDIBLE_BAND);
    expect(spacing).toBe(3216);
    for (const [i, ch] of listChannels(GFSK8_NORMAL, AUDIBLE_BAND).entries()) {
      expect(ch.baseHz).toBe(300 + i * spacing);
    }
  });

  it('leaves a wide gap between neighbours and no overlap', () => {
    const channels = listChannels(GFSK8_NORMAL, AUDIBLE_BAND);
    for (let i = 0; i + 1 < channels.length; i++) {
      const gap = channels[i + 1]!.baseHz - (channels[i]!.baseHz + bandwidthHz(GFSK8_NORMAL));
      expect(gap).toBeGreaterThan(500);
    }
  });

  it('rejects channel numbers outside the plan', () => {
    expect(() => channelAt(GFSK8_NORMAL, 0)).toThrow(RangeError);
    expect(() => channelAt(GFSK8_NORMAL, 18)).toThrow(RangeError);
    expect(() => channelAt(GFSK8_NORMAL, 1.5)).toThrow(RangeError);
  });

  it('maps a frequency back to its channel, and gaps to null', () => {
    expect(channelForFrequency(GFSK8_NORMAL, 110)?.number).toBe(1);
    expect(channelForFrequency(GFSK8_NORMAL, 320)?.number).toBe(4);
    expect(channelForFrequency(GFSK8_NORMAL, 700)).toBeNull(); // gap between 4 and 5
    expect(channelForFrequency(GFSK8_NORMAL, 3530)?.number).toBe(5);
    expect(channelForFrequency(GFSK8_NORMAL, 9960)?.number).toBe(7);
    expect(channelForFrequency(GFSK8_NORMAL, 50)).toBeNull();
    expect(channelForFrequency(GFSK8_NORMAL, 10100)).toBeNull();
    expect(channelForFrequency(GFSK8_NORMAL, 17510)?.number).toBe(8);
    expect(channelForFrequency(GFSK8_NORMAL, 21500)).toBeNull();
  });

  it('refuses a band whose channels would overlap', () => {
    const crowded = { name: 'crowded', lowHz: 0, highHz: 300, firstNumber: 1, channelCount: 16 };
    expect(() => channelSpacingHz(GFSK8_NORMAL, crowded)).toThrow(RangeError);
  });

  it('places reference tones at each bands edges and centre', () => {
    expect(referenceTonesHz(LOW_BAND)).toEqual([100, 200, 300]);
    expect(referenceTonesHz(AUDIBLE_BAND)).toEqual([300, 5150, 10000]);
    expect(referenceTonesHz(ULTRASONIC_BAND)).toEqual([17500, 19250, 21000]);
  });
});
