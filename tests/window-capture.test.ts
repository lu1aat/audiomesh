import { describe, expect, it } from 'vitest';
import { WindowCapture, captureMeta, type CaptureInput } from '../src/dsp/window-capture';
import { decodeWav16, encodeWav16, floatToInt16 } from '../src/dsp/wav';

const frame = { payload: new Uint8Array(10).fill(1), snrDb: -10, timeOffsetSec: 0 };

function input(over: Partial<CaptureInput> & { score?: number; frames?: number; imbalance?: number }): CaptureInput {
  const { score = 0.4, frames = 0, imbalance, ...rest } = over;
  return {
    slotStartUtcMs: 0,
    channels: [{ baseFreqHz: 1000, frames: Array.from({ length: frames }, () => frame), sync: { score, timeOffsetSec: 0.1, ...(imbalance === undefined ? {} : { blockImbalanceDb: imbalance }) } }],
    window: new Float32Array(1000),
    leadSec: 1,
    sampleRate: 8000,
    ...rest,
  } as CaptureInput;
}

describe('WindowCapture', () => {
  it('keeps nothing while off', () => {
    const c = new WindowCapture('gfsk8-normal');
    expect(c.offer(input({}))).toBe(false);
    expect(c.windows).toHaveLength(0);
  });

  it('keeps only windows with a real sync and no decode by default', () => {
    const c = new WindowCapture('gfsk8-normal');
    c.enabled = true;
    expect(c.offer(input({ score: 0.2 }))).toBe(false); // noise
    expect(c.offer(input({ frames: 1 }))).toBe(false); // decoded fine
    expect(c.offer(input({ ownTx: true }))).toBe(false); // our own speaker
    expect(c.offer(input({}))).toBe(true);
    c.mode = 'all';
    expect(c.offer(input({ score: 0.1 }))).toBe(true);
  });

  it('drops windows whose sync is one loud block (a neighbour slot\'s tail or head), keeps them flagged in "all"', () => {
    const c = new WindowCapture('gfsk8-normal');
    c.enabled = true;
    expect(c.offer(input({ score: 0.53, imbalance: 13.3 }))).toBe(false); // measured: 20-58-45, 19032 Hz
    expect(c.offer(input({ score: 0.34, imbalance: 0.3 }))).toBe(true); // measured: a real weak Fast frame
    expect(c.offer(input({ score: 0.4 }))).toBe(true); // a protocol that reports no imbalance is not judged on it
    expect(c.windows.map((w) => w.partial)).toEqual([false, false]);
    c.mode = 'all';
    expect(c.offer(input({ score: 0.53, imbalance: 13.3 }))).toBe(true);
    expect(c.windows[2]!.partial).toBe(true);
    expect(c.windows[2]!.channels[0]!.sync!.blockImbalanceDb).toBe(13.3);
  });

  it('stamps the note typed at the time, and puts it in the metadata only when there is one', () => {
    const c = new WindowCapture('gfsk8-normal');
    c.enabled = true;
    c.note = '  tx 40 %, 2 m ';
    c.offer(input({ slotStartUtcMs: 1 }));
    c.note = 'tx 30 %, 2 m';
    c.offer(input({ slotStartUtcMs: 2 }));
    c.note = '';
    c.offer(input({ slotStartUtcMs: 3 }));
    expect(c.windows.map((w) => w.note)).toEqual(['tx 40 %, 2 m', 'tx 30 %, 2 m', '']);
    expect((captureMeta(c.windows[0]!) as { note?: string }).note).toBe('tx 40 %, 2 m');
    expect('note' in captureMeta(c.windows[2]!)).toBe(false);
  });

  it('drops the oldest windows over the byte cap but keeps the newest', () => {
    const c = new WindowCapture('gfsk8-normal', 5000);
    c.enabled = true;
    for (let i = 0; i < 5; i++) c.offer(input({ slotStartUtcMs: i }));
    expect(c.windows.map((w) => w.slotStartUtcMs)).toEqual([3, 4]);
    expect(c.dropped).toBe(3);
  });
});

describe('wav', () => {
  it('round-trips 16-bit samples', () => {
    const src = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const wav = decodeWav16(encodeWav16(floatToInt16(src), 48000));
    expect(wav.sampleRate).toBe(48000);
    src.forEach((v, i) => expect(wav.samples[i]).toBeCloseTo(v, 3));
  });
});
