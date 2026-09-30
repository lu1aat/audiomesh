import type { Demodulator, FrameCodec, Modulator, Protocol } from '../protocol';
import type { ProtocolSpec } from '../spec';
import { Gfsk8Codec } from './codec';
import { Gfsk8Demodulator } from './demodulator';
import { Gfsk8Modulator } from './modulator';
import { GFSK8_DEEP, GFSK8_FAST, GFSK8_LONG, GFSK8_MEDIUM, GFSK8_NORMAL } from './spec';

function gfsk8(spec: ProtocolSpec): Protocol {
  return {
    spec,
    createCodec(): FrameCodec {
      return new Gfsk8Codec(spec);
    },
    createModulator(sampleRate: number): Modulator {
      return new Gfsk8Modulator(sampleRate, spec);
    },
    createDemodulator(sampleRate: number): Demodulator {
      return new Gfsk8Demodulator(sampleRate, spec, new Gfsk8Codec(spec));
    },
  };
}

/** Same spec, codec and modem family at five speeds. */
export const gfsk8Normal: Protocol = gfsk8(GFSK8_NORMAL);
export const gfsk8Medium: Protocol = gfsk8(GFSK8_MEDIUM);
export const gfsk8Fast: Protocol = gfsk8(GFSK8_FAST);
export const gfsk8Long: Protocol = gfsk8(GFSK8_LONG);
export const gfsk8Deep: Protocol = gfsk8(GFSK8_DEEP);
