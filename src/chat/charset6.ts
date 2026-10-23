/**
 * 6-bit text code: 64 symbols, so a 77-bit frame carries about a third more text
 * than 7-bit ASCII. Case is folded to upper case, accents are dropped (Spanish text
 * reads without them, as in FT8 and JS8) and anything else outside the set becomes
 * '?'. Index 0 is the space, which is also the padding character.
 */

export const CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?!\'-/:@#()+=";%&*_<>[]$|~';

export const CHAR_BITS = 6;

const CODE_OF = new Map<string, number>([...CHARSET].map((c, i) => [c, i]));
const UNKNOWN_CODE = CODE_OF.get('?')!;

/** Spanish opening marks, read as the closing ones the code has. */
const INVERTED: Readonly<Record<string, string>> = { '¡': '!', '¿': '?' };

/** What a character will arrive as: upper-cased, without its accent (É -> E, Ñ -> N), or '?' if the code cannot carry it. */
export function normalizeChar(ch: string): string {
  const up = ch.toUpperCase();
  if (CODE_OF.has(up)) return up;
  const base = up.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (base.length === 1 && CODE_OF.has(base)) return base;
  return INVERTED[ch] ?? '?';
}

/** Whole text, as it will arrive. Line breaks and tabs become spaces. */
export function normalizeText(text: string): string {
  let out = '';
  for (const ch of text.replace(/\s+/g, ' ')) out += normalizeChar(ch);
  return out;
}

export function charToCode(ch: string): number {
  return CODE_OF.get(normalizeChar(ch)) ?? UNKNOWN_CODE;
}

export function codeToChar(code: number): string {
  return CHARSET[code & 0x3f]!;
}
