import type { ProtocolSpec } from '../spec';

/**
 * 8-GFSK at 6.25 baud: the JS8 "Normal" / FT8 physical layer, used as our
 * starting point. This is JS8-inspired, NOT wire-compatible with JS8Call.
 * Interop would need JS8's exact LDPC matrices, Costas tables and Huffman table.
 *
 * Reference numbers:
 *   79 symbols = 3 x 7 sync + 2 x 29 data. 58 data symbols x 3 bits = 174 bits.
 *   0.16 s per symbol, 12.64 s on air, 15 s slot, 50 Hz occupied.
 */
export const GFSK8_NORMAL: ProtocolSpec = {
  id: 'gfsk8-normal',
  name: '8-GFSK 6.25 baud',
  toneCount: 8,
  baud: 6.25,
  toneSpacingHz: 6.25,
  symbolCount: 79,
  // FT8's Costas array. Our own choice of sync pattern; free to change until
  // the codec exists, since nothing interoperates with it yet.
  syncPattern: [3, 1, 4, 0, 6, 5, 2],
  syncStarts: [0, 36, 72],
  slotSec: 15,
  // 12.64 s frame + 2 x 2 s = 16.64 s window: a frame up to 2 s early or late is
  // still whole inside it.
  maxTimeOffsetSec: 2,
  // 77 payload + 14 CRC = 91 information bits, + 83 parity = the 174-bit codeword.
  payloadBits: 77,
};

/**
 * The same 8-GFSK, LDPC and Costas frame at 4x the symbol rate, like JS8's Fast and
 * Turbo submodes: 25 baud, 0.04 s symbols, 3.16 s on air in a 5 s slot, 200 Hz
 * occupied. Three times the throughput of Normal, and 6 dB less sensitive per
 * frame (four times the bandwidth, a quarter of the energy per symbol). That is a
 * good trade for speaker and microphone in a room, where signal is plentiful.
 *
 * The clock allowance shrinks with the slot: +-0.9 s, the most a 5 s slot leaves.
 * It has to cover both stations' clocks AND the audio latency of the speaker and
 * microphone paths (tens to a few hundred ms each; Bluetooth much more), so it is
 * as wide as it can be. The 100..300 Hz band cannot hold a 200 Hz channel, so this
 * protocol has no low band. 0.04 s symbols are also short against room echo, which
 * smears one tone into the next; if that hurts, use Medium.
 */
export const GFSK8_FAST: ProtocolSpec = {
  ...GFSK8_NORMAL,
  id: 'gfsk8-fast',
  name: '8-GFSK 25 baud (fast)',
  baud: 25,
  toneSpacingHz: 25,
  slotSec: 5,
  // 3.16 s frame + 2 x 0.9 s = 4.96 s window, just inside the 5 s slot.
  maxTimeOffsetSec: 0.9,
};

/**
 * Between the two: 12.5 baud, 0.08 s symbols, 6.32 s on air in a 10 s slot, 100 Hz
 * occupied, +-1.5 s clock allowance. 1.5x the throughput of Normal and about 3 dB
 * more sensitive than Fast. Symbols twice as long as Fast's ride out more room echo. No low band either (100 Hz channels do not fit
 * three times into 200 Hz).
 */
export const GFSK8_MEDIUM: ProtocolSpec = {
  ...GFSK8_NORMAL,
  id: 'gfsk8-medium',
  name: '8-GFSK 12.5 baud (medium)',
  baud: 12.5,
  toneSpacingHz: 12.5,
  slotSec: 10,
  // 6.32 s frame + 2 x 1.5 s = 9.32 s window, inside the 10 s slot.
  maxTimeOffsetSec: 1.5,
};

/**
 * Half Normal's baud: the JS8 "Slow" physical layer, called "Long" here (a slot
 * this long isn't really "slow" for a text chat, but it is a long wait). 3.125
 * baud, 0.32 s symbols, 25.28 s on air in a 30 s slot, 25 Hz occupied - the same
 * bandwidth as JS8's own Slow submode. Same clock allowance as Normal (+-2 s):
 * halving the baud without widening the allowance keeps the frame's share of the
 * slot the same (84%) as Normal's, rather than wasting the extra time as guard.
 * Half Normal's throughput; expected a few dB more sensitive (halving the baud
 * roughly doubles the energy per symbol, worth about 3 dB) - not yet measured.
 */
export const GFSK8_LONG: ProtocolSpec = {
  ...GFSK8_NORMAL,
  id: 'gfsk8-long',
  name: '8-GFSK 3.125 baud (long)',
  baud: 3.125,
  toneSpacingHz: 3.125,
  slotSec: 30,
  // 25.28 s frame + 2 x 2 s = 29.28 s window, inside the 30 s slot.
  maxTimeOffsetSec: 2,
};

/**
 * A quarter of Normal's baud: further than JS8 goes. 1.5625 baud, 0.64 s
 * symbols, 50.56 s on air in a 60 s slot, 12.5 Hz occupied. Clock allowance +-3 s
 * (deepExtraSec's own cap, reused here as the baseline allowance - the most
 * forgiving of clocks disagreeing among these protocols, useful for a link with
 * no other timing reference). A quarter of Normal's throughput; expected a few
 * more dB of sensitivity than Long - not yet measured. Meant for a link too weak
 * or too poorly timed for anything else, not for chat: a message takes minutes.
 */
/**
 * 8x Normal's baud: further than JS8 goes (JS8's own fastest, Turbo, is roughly
 * 4x its Normal - about our own Fast). 50 baud, 0.02 s symbols, 1.58 s on air,
 * 400 Hz occupied - too wide for the low band (200 Hz total) or the ultrasonic
 * band's fixed 10 channels (spacing would need to be >=400 Hz across 3500 Hz,
 * which only 9 channels allow; `bandsFor` drops it, leaving only the audible
 * band). A protocol this fast is squarely audible there (its lowest channel
 * starts right at the band's 300 Hz floor), so this is a testing tool for
 * nearby devices, not a mode meant for daily use. Clock allowance +-0.45 s,
 * half of Fast's - the tightest of any protocol here, likely tighter even than
 * the +-0.5 s Fast originally shipped with before its own real-world decode
 * problems led to widening it to +-0.9 s. Expect this one to need both
 * stations' clocks closely synced to decode at all.
 */
export const GFSK8_TURBO: ProtocolSpec = {
  ...GFSK8_NORMAL,
  id: 'gfsk8-turbo',
  name: '8-GFSK 50 baud (turbo)',
  baud: 50,
  toneSpacingHz: 50,
  slotSec: 2.5,
  // 1.58 s frame + 2 x 0.45 s = 2.48 s window, inside the 2.5 s slot.
  maxTimeOffsetSec: 0.45,
};

export const GFSK8_DEEP: ProtocolSpec = {
  ...GFSK8_NORMAL,
  id: 'gfsk8-deep',
  name: '8-GFSK 1.5625 baud (deep)',
  baud: 1.5625,
  toneSpacingHz: 1.5625,
  slotSec: 60,
  // 50.56 s frame + 2 x 3 s = 56.56 s window, inside the 60 s slot.
  maxTimeOffsetSec: 3,
};
