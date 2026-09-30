/**
 * 6-bit text code: 64 symbols, so a 77-bit frame carries about a third more text
 * than 7-bit ASCII. Case is folded to upper case and anything outside the set
 * becomes '?', the same trade JS8 and FT8 make. Index 0 is the space, which is
 * also the padding character.
 */

export const CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?!\'-/:@#()+=";%&*_<>[]$|~';

export const CHAR_BITS = 6;

const CODE_OF = new Map<string, number>([...CHARSET].map((c, i) => [c, i]));
const UNKNOWN_CODE = CODE_OF.get('?')!;

/** What a character will arrive as: upper-cased, or '?' if the code cannot carry it. */
export function normalizeChar(ch: string): string {
  const up = ch.toUpperCase();
  return CODE_OF.has(up) ? up : '?';
}

/** Whole text, as it will arrive. Line breaks and tabs become spaces. */
export function normalizeText(text: string): string {
  let out = '';
  for (const ch of text.replace(/\s+/g, ' ')) out += normalizeChar(ch);
  return out;
}

export function charToCode(ch: string): number {
  return CODE_OF.get(ch.toUpperCase()) ?? UNKNOWN_CODE;
}

export function codeToChar(code: number): string {
  return CHARSET[code & 0x3f]!;
}
