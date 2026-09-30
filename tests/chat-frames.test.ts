import { describe, expect, it } from 'vitest';
import { CHARSET, normalizeText } from '../src/chat/charset6';
import {
  FIRST_CHARS, MAX_TEXT_CHARS, NEXT_CHARS, codeToSnr, decodeFrame, encodeFrame, frameCount, randomStationId, snrToCode, splitText,
  type ChatFrame,
} from '../src/chat/frames';
import { Gfsk8Codec, PAYLOAD_BITS } from '../src/protocol/gfsk8/codec';
import { GFSK8_NORMAL as spec } from '../src/protocol/gfsk8/spec';

describe('6-bit charset', () => {
  it('has 64 distinct symbols with the space first', () => {
    expect(CHARSET).toHaveLength(64);
    expect(new Set(CHARSET).size).toBe(64);
    expect(CHARSET[0]).toBe(' ');
  });

  it('folds case, flattens whitespace and replaces what it cannot carry', () => {
    expect(normalizeText('Hello,\n\tworld! café')).toBe('HELLO, WORLD! CAF?');
  });
});

describe('snr code', () => {
  it('rounds to whole dB and clamps to -30..+33', () => {
    expect(codeToSnr(snrToCode(-12.4))).toBe(-12);
    expect(codeToSnr(snrToCode(-99))).toBe(-30);
    expect(codeToSnr(snrToCode(99))).toBe(33);
  });
});

describe('chat frames', () => {
  const frames: ChatFrame[] = [
    { kind: 'first', src: 5, msgId: 3, last: 15, dst: 1023, text: 'ABCDEFG' },
    { kind: 'first', src: 1023, msgId: 15, last: 0, dst: 0, text: 'HI     ' },
    { kind: 'next', src: 77, msgId: 9, seq: 15, text: 'XYZ 12345' },
    { kind: 'ack', src: 12, dst: 700, msgId: 2, received: 0xa5c3, heardChannel: 17, heardSnrDb: -12 },
    { kind: 'ack', src: 12, dst: 700, msgId: 2, received: 1, heardChannel: 0, heardSnrDb: 0 },
    { kind: 'sound', src: 40, reports: [] },
    { kind: 'sound', src: 40, reports: [{ station: 5, channel: 3, snrDb: -20 }] },
    { kind: 'sound', src: 40, reports: [{ station: 1023, channel: 31, snrDb: 33 }, { station: 9, channel: 1, snrDb: -30 }] },
    { kind: 'hello', src: 300, name: 'ALICE' },
  ];

  it('round-trips every kind through 77 bits', () => {
    for (const f of frames) {
      const bits = encodeFrame(f);
      expect(bits).toHaveLength(PAYLOAD_BITS);
      expect(decodeFrame(bits)).toEqual(f);
    }
  });

  it('never yields the all-zero payload the codec refuses', () => {
    const codec = new Gfsk8Codec(spec);
    for (const f of frames) expect(() => codec.encode(encodeFrame(f))).not.toThrow();
  });

  it('rejects out-of-range fields and reserved ids', () => {
    expect(() => encodeFrame({ kind: 'next', src: 0, msgId: 0, seq: 0, text: '' })).toThrow();
    expect(() => encodeFrame({ kind: 'next', src: 1, msgId: 16, seq: 0, text: '' })).toThrow();
    expect(() => encodeFrame({ kind: 'ack', src: 1, dst: 0, msgId: 0, received: 1, heardChannel: 0, heardSnrDb: 0 })).toThrow();
    expect(() => encodeFrame({ kind: 'ack', src: 1, dst: 2, msgId: 0, received: 1, heardChannel: 32, heardSnrDb: 0 })).toThrow();
    const three = { station: 3, channel: 1, snrDb: 0 };
    expect(() => encodeFrame({ kind: 'sound', src: 1, reports: [three, three, three] })).toThrow();
  });

  it('decodes unknown control subtypes and a zero src to null', () => {
    const bits = encodeFrame({ kind: 'hello', src: 4, name: 'BOB' });
    bits[12] = 1; // subtype 1
    expect(decodeFrame(bits)).toBeNull();
    expect(decodeFrame(new Uint8Array(PAYLOAD_BITS))).toBeNull();
    expect(decodeFrame(new Uint8Array(10))).toBeNull();
  });

  it('picks station ids in 1..1023', () => {
    expect(randomStationId(() => 0)).toBe(1);
    expect(randomStationId(() => 0.999999)).toBe(1023);
  });
});

describe('splitting', () => {
  it('sizes: 7 characters in the first frame, 9 in each later one, 142 at most', () => {
    expect(MAX_TEXT_CHARS).toBe(142);
    expect(frameCount(1)).toBe(1);
    expect(frameCount(7)).toBe(1);
    expect(frameCount(8)).toBe(2);
    expect(frameCount(16)).toBe(2);
    expect(frameCount(17)).toBe(3);
    expect(frameCount(142)).toBe(16);
    for (const n of [1, 7, 8, 16, 17, 50, 142]) expect(splitText('A'.repeat(n))).toHaveLength(frameCount(n));
  });

  it('pads only through the end, so joining and trimming restores the text', () => {
    const text = 'THE QUICK BROWN FOX JUMPS';
    const chunks = splitText(text);
    expect(chunks[0]).toHaveLength(FIRST_CHARS);
    expect(chunks.slice(1).every((c) => c.length === NEXT_CHARS)).toBe(true);
    expect(chunks.join('').trimEnd()).toBe(text);
  });

  it('refuses empty and over-long text', () => {
    expect(() => splitText('')).toThrow();
    expect(() => splitText('A'.repeat(143))).toThrow();
  });
});
