/**
 * Interface language: English (the source text) or Spanish. The English text is the key
 * (gettext style): `t('Send')` returns the Spanish from `ES` when the page is in Spanish,
 * and the English itself otherwise or when no translation exists, so a missing entry
 * shows English instead of breaking. `{name}` placeholders are filled from `vars`.
 *
 * Keys must be single-quoted string literals inside `t(...)` / `tn(n, ..., ...)`, so
 * tests/i18n.test.ts can find them all and check that es-app.ts / es-how.ts cover them.
 *
 * The language is decided once, when this module loads, before any text is built:
 * - a page with `<html data-lang-fixed>` (how-it-works.html, como-funciona.html) is in the
 *   language of its `lang` attribute: those pages are static, one file per language;
 * - the app: `?lang=` in the address (a link that asks for a language; it is then kept),
 *   the choice stored under `audiochat:lang`, the browser's languages, else English.
 * Without a DOM (tests, workers) it is English.
 */

import { ES_APP, SAME_APP } from './es-app';
import { ES_HOW } from './es-how';

export type Lang = 'en' | 'es';
export const LANGS: readonly Lang[] = ['en', 'es'];
/** Each language named in itself, for the selectors. */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { en: 'English', es: 'Español' };
/** Separate from `audiochat:settings`: the How it works pages read and write it too. */
export const LANG_KEY = 'audiochat:lang';

const isLang = (v: unknown): v is Lang => v === 'en' || v === 'es';

/** The language to use: an explicit request, then the stored choice, then the first of the browser's languages we have. Pure. */
export function pickLang(requested: string | null | undefined, stored: string | null | undefined, browser: readonly string[]): Lang {
  for (const c of [requested, stored]) if (isLang(c)) return c;
  for (const b of browser) {
    const p = b.toLowerCase().slice(0, 2);
    if (isLang(p)) return p;
  }
  return 'en';
}

function readStored(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null; // private windows and blocked storage
  }
}

/** Remember the user's choice (both pages read it). */
export function storeLang(l: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    // See readStored.
  }
}

function detect(): Lang {
  if (typeof document === 'undefined') return 'en';
  const root = document.documentElement;
  if (root.hasAttribute('data-lang-fixed')) return root.lang.startsWith('es') ? 'es' : 'en';
  const url = new URL(location.href);
  const requested = url.searchParams.get('lang');
  const l = pickLang(requested, readStored(), navigator.languages ?? [navigator.language]);
  if (requested !== null) {
    // A link that asks for a language: keep it, and take it out of the address so a reload or a bookmark is clean.
    if (isLang(requested)) storeLang(requested);
    url.searchParams.delete('lang');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  return l;
}

export const lang: Lang = detect();

const DICT: ReadonlyMap<string, string> = new Map(lang === 'es' ? [...Object.entries(ES_APP), ...Object.entries(ES_HOW)] : []);

/** Fill `{name}` placeholders. */
function fill(text: string, vars?: Readonly<Record<string, string | number>>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

/**
 * The text in the page's language. A key may end in `|context` to tell apart English words that
 * translate differently ('Sync' the section, 'Sync|button' the verb); the context never shows.
 */
export function t(en: string, vars?: Readonly<Record<string, string | number>>): string {
  const bar = en.indexOf('|');
  return fill(DICT.get(en) ?? (bar < 0 ? en : en.slice(0, bar)), vars);
}

/** One of two texts by count (both languages here put 1 apart from every other number); `{n}` is the count. */
export function tn(n: number, one: string, other: string, vars?: Readonly<Record<string, string | number>>): string {
  return t(n === 1 ? one : other, { n, ...vars });
}

/** The text in every language, for checks against words that were stored already worded. */
export function allLangs(en: string): string[] {
  const es = ES_APP[en] ?? ES_HOW[en];
  return es === undefined ? [en] : [en, es];
}

/** A band's name in the page's language; the band's own `name` ('low', 'audible', 'ultrasonic') stays its id. */
export function bandLabel(name: string): string {
  return ({ low: t('low'), audible: t('audible'), ultrasonic: t('ultrasonic') } as Record<string, string>)[name] ?? name;
}

/** Decimal comma in Spanish: "12.64" -> "12,64". For numbers shown to people, never for values parsed back. */
export function dec(s: string): string {
  return lang === 'es' ? s.replace(/(\d)\.(\d)/g, '$1,$2') : s;
}

/** `x.toFixed(digits)` with the page's decimal mark. */
export function num(x: number, digits = 0): string {
  return dec(x.toFixed(digits));
}

// --- static HTML (index.html) ----------------------------------------------------

/** Attributes translated like text. */
const ATTRS = ['title', 'aria-label', 'placeholder'] as const;
/** Elements whose content is never interface text. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE']);

/** Whitespace runs to one space, trimmed: how the dictionary writes a key. */
export function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Translate a static page in place: every text node and title / aria-label / placeholder by
 * its whole (trimmed) text, and every element marked `data-i18n` as one unit: its text
 * (tags stripped) is the key and the translation is HTML that replaces its content. Use the
 * unit for prose with inline markup, where the words of separate text nodes would not line
 * up in another language; it must not hold elements with ids. `translate="no"` skips a
 * subtree. Run before anything holds references into the page.
 */
export function translatePage(root: Element = document.documentElement): void {
  document.documentElement.lang = lang;
  try {
    if (lang !== 'en') walkPage(root);
  } finally {
    document.documentElement.classList.remove('i18n-pending');
  }
}

function walkPage(root: Element): void {
  const walk = (node: Element): void => {
    if (node.getAttribute('translate') === 'no') return;
    for (const a of ATTRS) {
      const v = node.getAttribute(a);
      const tv = v && DICT.get(normText(v));
      if (tv) node.setAttribute(a, tv);
    }
    if (node.hasAttribute('data-i18n')) {
      const tv = DICT.get(normText(node.textContent ?? ''));
      if (tv !== undefined) node.innerHTML = tv;
      return;
    }
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const raw = child.nodeValue ?? '';
        const tv = DICT.get(normText(raw));
        if (tv !== undefined) child.nodeValue = raw.replace(/^(\s*)[\s\S]*?(\s*)$/, (_m, a: string, b: string) => a + tv + b);
      } else if (child.nodeType === Node.ELEMENT_NODE && !SKIP.has((child as Element).tagName)) walk(child as Element);
    }
  };
  walk(root);
}

/** Texts that read the same in Spanish (names, units): the coverage test accepts them without an entry. */
export const SAME: ReadonlySet<string> = SAME_APP;
