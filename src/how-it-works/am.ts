// Everything the How it works page uses from audiomesh itself: the real modules, unchanged.
export * from '../protocol/gfsk8/spec';
export { Gfsk8Codec, PAYLOAD_BITS } from '../protocol/gfsk8/codec';
export { Gfsk8Demodulator } from '../protocol/gfsk8/demodulator';
export { synthesizeFrame } from '../protocol/gfsk8/modulator';
export { GRAY_TO_TONE } from '../protocol/gfsk8/soft-metrics';
export {
  bandwidthHz, frameDurationSec, windowDurationSec, windowLeadSec, deepExtraSec, symbolDurationSec,
} from '../protocol/spec';
export type { ProtocolSpec } from '../protocol/spec';
export { BANDS, listChannels, effectiveChannelCount, channelSpacingHz } from '../band/band-plan';
export {
  encodeFrame, decodeFrame, splitText, frameCount, BROADCAST, FIRST_CHARS, NEXT_CHARS, MAX_TEXT_CHARS, viaOf,
} from '../chat/frames';
export { normalizeText, CHARSET, charToCode } from '../chat/charset6';
export { ChatSession } from '../chat/session';
export { LqaTable } from '../ale/lqa';
