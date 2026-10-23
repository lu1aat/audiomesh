import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ES_APP, SAME_APP } from '../src/i18n/es-app';
import { ES_HOW } from '../src/i18n/es-how';
import { lang, normText, pickLang, t, tn } from '../src/i18n/i18n';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

function tsFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const p = `${dir}/${name}`;
    return statSync(join(ROOT, p)).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const STR = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
const unescape = (s: string): string => s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c));
/** Every key handed to t() and tn() in the source, as single- or double-quoted literals. */
function codeKeys(): Set<string> {
  const one = new RegExp(String.raw`(?<![\w.])t\(\s*(?:${STR})`, 'g');
  const two = new RegExp(String.raw`(?<![\w.])tn\([^,()]+(?:\([^()]*\))?[^,()]*,\s*(?:${STR})\s*,\s*(?:${STR})`, 'g');
  const keys = new Set<string>();
  for (const f of tsFiles('src')) {
    if (f.startsWith('src/i18n/es-')) continue;
    const src = read(f);
    for (const m of src.matchAll(one)) keys.add(unescape(m[1] ?? m[2]!));
    for (const m of src.matchAll(two)) {
      keys.add(unescape(m[1] ?? m[2]!));
      keys.add(unescape(m[3] ?? m[4]!));
    }
  }
  return keys;
}

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'source', 'wbr', 'hr', 'area', 'col', 'embed', 'param', 'track']);
const SKIP = new Set(['script', 'style', 'textarea', 'code']);
const LETTER = /[A-Za-zÀ-ÿ]/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m);

interface Tag { name: string; attrs: Map<string, string>; close: boolean; selfClose: boolean }
/** A small tokenizer for our own static pages: tags (with attributes) and text, in order. */
function tokens(html: string): (Tag | string)[] {
  const out: (Tag | string)[] = [];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  for (const m of html.matchAll(re)) {
    if (m[5] !== undefined) out.push(decode(m[5]));
    else if (m[2]) {
      const attrs = new Map<string, string>();
      for (const a of (m[3] ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs.set(a[1]!.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
      out.push({ name: m[2].toLowerCase(), attrs, close: m[1] === '/', selfClose: m[4] === '/' });
    }
  }
  return out;
}

/** What translatePage (i18n.ts) looks up in a static page: text nodes, data-i18n units (their text) and titles / labels / placeholders. */
function pageKeys(html: string): { keys: Set<string>; units: Map<string, string[]> } {
  const keys = new Set<string>();
  const units = new Map<string, string[]>();
  const add = (s: string): void => {
    const k = normText(s);
    if (k && LETTER.test(k)) keys.add(k);
  };
  const stack: { name: string; skip: boolean }[] = [];
  let unit: { text: string; depth: number; ids: string[] } | null = null;
  for (const tok of tokens(html)) {
    if (typeof tok === 'string') {
      if (unit) unit.text += tok;
      else if (!stack.some((s) => s.skip)) add(tok);
      continue;
    }
    const isVoid = VOID.has(tok.name) || tok.selfClose;
    if (unit) {
      if (!tok.close && tok.attrs.has('id')) unit.ids.push(tok.attrs.get('id')!);
      if (!isVoid) unit.depth += tok.close ? -1 : 1;
      if (unit.depth === 0) {
        add(unit.text);
        units.set(normText(unit.text), unit.ids);
        unit = null;
        stack.pop();
      }
      continue;
    }
    if (tok.close) {
      while (stack.length && stack.pop()!.name !== tok.name);
      continue;
    }
    const skip = tok.attrs.get('translate') === 'no' || SKIP.has(tok.name);
    if (!skip && !stack.some((s) => s.skip)) {
      for (const a of ['title', 'aria-label', 'placeholder']) if (tok.attrs.get(a)) add(tok.attrs.get(a)!);
      if (tok.attrs.has('data-i18n') && !isVoid) {
        unit = { text: '', depth: 1, ids: [] };
        stack.push({ name: tok.name, skip: false });
        continue;
      }
    }
    if (!isVoid) stack.push({ name: tok.name, skip });
  }
  return { keys, units };
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('language choice', () => {
  it('takes an explicit request, then the stored choice, then the browser, else English', () => {
    expect(pickLang('es', 'en', ['en-US'])).toBe('es');
    expect(pickLang(null, 'es', ['en-US'])).toBe('es');
    expect(pickLang('fr', null, ['pt-BR', 'es-AR', 'en'])).toBe('es');
    expect(pickLang(null, null, ['en-GB', 'es'])).toBe('en');
    expect(pickLang(undefined, 'xx', ['de', 'fr'])).toBe('en');
  });

  it('is English without a page, and t() then fills placeholders and drops a key context', () => {
    expect(lang).toBe('en');
    expect(t('Channel {n} blocked for sending', { n: 12 })).toBe('Channel 12 blocked for sending');
    expect(t('Sync|button')).toBe('Sync');
    expect(tn(1, '{n} frame', '{n} frames')).toBe('1 frame');
    expect(tn(3, '{n} frame', '{n} frames')).toBe('3 frames');
  });
});

describe('Spanish dictionary', () => {
  const dict = new Map([...Object.entries(ES_APP), ...Object.entries(ES_HOW)]);
  const code = codeKeys();
  const page = pageKeys(read('index.html'));

  it('covers every text the code builds', () => {
    expect([...code].filter((k) => !dict.has(k))).toEqual([]);
  });

  it("covers every text of the app's page", () => {
    expect([...page.keys].filter((k) => !dict.has(k) && !SAME_APP.has(k))).toEqual([]);
  });

  it('holds no entry that nothing uses', () => {
    const used = new Set([...code, ...page.keys]);
    expect([...dict.keys()].filter((k) => !used.has(k))).toEqual([]);
    expect([...SAME_APP].filter((k) => !page.keys.has(k))).toEqual([]);
  });

  it('keeps every placeholder, and a word shared by both files reads the same', () => {
    expect([...dict].filter(([k, v]) => placeholders(k).join() !== placeholders(v).join()).map(([k]) => k)).toEqual([]);
    expect(Object.keys(ES_HOW).filter((k) => k in ES_APP)).toEqual([]);
  });

  it('page units hold no ids, and their Spanish brings none in', () => {
    for (const [key, ids] of page.units) {
      expect(ids, key).toEqual([]);
      expect(dict.get(key) ?? '', key).not.toMatch(/\sid=/);
    }
  });
});

describe('How it works in two languages', () => {
  const en = read('how-it-works.html');
  const es = read('como-funciona.html');
  const shape = (html: string): string[] =>
    tokens(html).flatMap((tok) =>
      typeof tok === 'string' || tok.close ? [] : [...tok.attrs].filter(([a]) => a === 'id' || (a.startsWith('data-') && a !== 'data-lang-fixed')).map(([a, v]) => `${a}=${v}`));

  it('has the same ids and data attributes in the same order on both pages', () => {
    expect(shape(es)).toEqual(shape(en));
  });

  it('declares each page fixed to its language and links to the other one', () => {
    expect(en).toMatch(/<html lang="en" data-lang-fixed>/);
    expect(es).toMatch(/<html lang="es" data-lang-fixed>/);
    expect(en).toMatch(/id="lang-switch" href="\.\/como-funciona\.html"/);
    expect(es).toMatch(/id="lang-switch" href="\.\/how-it-works\.html"/);
  });
});
