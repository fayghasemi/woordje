// Automatic word lookup using free, key-less APIs:
//  - Google Translate (public gtx endpoint)  -> translation + alternatives by part of speech
//  - MyMemory                                -> translation fallback
//  - Wiktionary                              -> de/het article, plural, part of speech, definitions
//  - Tatoeba                                 -> real example sentences with translations

export const LANGS = {
  en: { name: 'English', t3: 'eng' },
  fa: { name: 'فارسی (Persian)', t3: 'pes' },
  ar: { name: 'العربية (Arabic)', t3: 'ara' },
  tr: { name: 'Türkçe (Turkish)', t3: 'tur' },
  de: { name: 'Deutsch (German)', t3: 'deu' },
  fr: { name: 'Français (French)', t3: 'fra' },
  es: { name: 'Español (Spanish)', t3: 'spa' },
  pt: { name: 'Português (Portuguese)', t3: 'por' },
  it: { name: 'Italiano (Italian)', t3: 'ita' },
  pl: { name: 'Polski (Polish)', t3: 'pol' },
  uk: { name: 'Українська (Ukrainian)', t3: 'ukr' },
  ru: { name: 'Русский (Russian)', t3: 'rus' },
  zh: { name: '中文 (Chinese)', t3: 'cmn' },
  hi: { name: 'हिन्दी (Hindi)', t3: 'hin' },
  id: { name: 'Bahasa Indonesia', t3: 'ind' },
};

export const RTL = new Set(['fa', 'ar']);

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

async function getJSON(url, ms = 7000) {
  const to = withTimeout(ms);
  try {
    const r = await fetch(url, { signal: to.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    to.done();
  }
}

/** Splits "de fiets" -> { article: 'de', word: 'fiets' } */
export function parseInput(raw) {
  let text = (raw || '').trim().replace(/\s+/g, ' ');
  let article = '';
  const m = text.match(/^(de|het|'t)\s+(.+)$/i);
  if (m && m[2].split(' ').length <= 3) {
    article = m[1].toLowerCase() === "'t" ? 'het' : m[1].toLowerCase();
    text = m[2];
  }
  return { article, word: text };
}

// ---------- Translation ----------
async function googleTranslate(q, tl, sl = 'nl') {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + encodeURIComponent(sl) + '&tl=' +
    encodeURIComponent(tl) + '&dt=t&dt=bd&dj=1&q=' + encodeURIComponent(q);
  const j = await getJSON(url);
  const main = (j.sentences || []).map((s) => s.trans || '').join('').trim();
  const alts = (j.dict || []).map((d) => ({
    pos: d.pos || '',
    terms: (d.terms || []).slice(0, 6),
  }));
  if (!main) throw new Error('empty');
  return { main, alts };
}

async function myMemory(q, tl, sl = 'nl') {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + sl + '|' + tl;
  const j = await getJSON(url);
  let main = ((j.responseData && j.responseData.translatedText) || '').replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim();
  if (!main || /MYMEMORY WARNING|QUERY LENGTH|INVALID/i.test(main)) throw new Error('mymemory');
  if (NON_LATIN.has(tl) && /^[\x00-\x7F]+$/.test(main)) throw new Error('untranslated');
  // Gather a few distinct alternative matches
  const seen = new Set([main.toLowerCase()]);
  const terms = [];
  for (const m of j.matches || []) {
    const t = (m.translation || '').trim();
    if (t && !seen.has(t.toLowerCase()) && t.length < 40 && m.quality > 50) { seen.add(t.toLowerCase()); terms.push(t); }
    if (terms.length >= 4) break;
  }
  return { main, alts: terms.length ? [{ pos: '', terms }] : [] };
}

const NON_LATIN = new Set(['fa', 'ar', 'ru', 'uk', 'zh', 'hi']);

export async function translate(q, tl = 'en', sl = 'nl') {
  let g = null;
  try { g = await googleTranslate(q, tl, sl); } catch {}
  // Google sometimes returns an untranslated English pivot (e.g. "GP") for non-Latin targets
  const suspicious = g && NON_LATIN.has(tl) && /^[\x00-\x7F]+$/.test(g.main);
  if (g && !suspicious) return g;
  try {
    const m = await myMemory(q, tl, sl);
    if (g) m.alts = [...m.alts, ...g.alts];
    return m;
  } catch (e) {
    if (g) return g;
    throw e;
  }
}

// ---------- Wiktionary ----------
const stripHtml = (h) => {
  const d = document.createElement('div');
  d.innerHTML = h;
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
};

function dutchSection(wikitext) {
  const i = wikitext.search(/^==\s*Dutch\s*==\s*$/m);
  if (i < 0) return '';
  const rest = wikitext.slice(i + 8);
  const j = rest.search(/^==[^=].*==\s*$/m);
  return j < 0 ? rest : rest.slice(0, j);
}

// Applies Dutch spelling rules to Wiktionary's plural shorthand ("-en", "-zen", "-s", ...)
function applySuffix(word, suf) {
  if (!/^[e zv]/.test(suf)) return word + suf; // -s, -'s, -n …
  let stem = word;
  if (suf[0] === 'z' || suf[0] === 'v') {
    if (!/[sf]$/.test(stem)) return word + suf;
    stem = stem.slice(0, -1) + 'X'; // placeholder consonant so the vowel rules below apply
  } else if (suf === 'en' && /[^e]e$/.test(stem)) return stem + 'n'; // gemeente -> gemeenten
  else if (suf === 'en' && /ee$/.test(stem)) return stem + 'ën'; // zee -> zeeën
  const m = stem.match(/^(.*?)([aeiouy]+)([^aeiouy])$/);
  if (m) {
    const [, pre, vow, cons] = m;
    const syllables = (stem.match(/[aeiouy]+/g) || []).length;
    if (vow.length === 2 && vow[0] === vow[1]) stem = pre + vow[0] + cons; // afspraak -> afspra(k)
    // kat -> katten, grondwet -> grondwetten; but unstressed endings don't double (monnik -> monniken)
    else if (vow.length === 1 && cons !== 'X' && !/[wxy]/.test(cons) && (syllables === 1 || !/(e[lrnm]|i[gkcs]|[ou][ms]|es)$/.test(stem))) stem = pre + vow + cons + cons;
  }
  if (stem.endsWith('X')) return stem.slice(0, -1) + suf;
  return stem + suf;
}

function buildPlural(word, p) {
  p = (p || '').split(',')[0].trim();
  if (!p || p === '+' || p === '-' || p === '?' || p === '!') return '';
  if (p.startsWith('-')) return word.includes(' ') ? '' : applySuffix(word, p.slice(1));
  if (/^[a-zA-Zàâäéèêëïîôöüûç' -]+$/.test(p)) return p;
  return '';
}

function parseWikitext(word, wikitext) {
  const sec = dutchSection(wikitext);
  if (!sec) return null;
  const out = { article: '', plural: '', pos: [] };
  const posRe = /^===+\s*(Noun|Verb|Adjective|Adverb|Preposition|Pronoun|Conjunction|Interjection|Numeral|Phrase|Proper noun|Particle|Determiner|Article)\s*===+/gm;
  let m;
  while ((m = posRe.exec(sec))) if (!out.pos.includes(m[1])) out.pos.push(m[1]);
  const noun = sec.match(/\{\{nl-noun\|([^}]*)\}\}/);
  if (noun) {
    const params = noun[1].split('|').filter((p) => !p.includes('='));
    const g = (params[0] || '').trim();
    if (/^n$/.test(g)) out.article = 'het';
    else if (/^(m|f|c|m\/f|f\/m|m,f|mf|c,n)/.test(g)) out.article = g.includes('n') && !g.startsWith('n') ? 'de/het' : 'de';
    else if (/^n[,/](m|f|c)/.test(g)) out.article = 'de/het';
    out.plural = buildPlural(word, (params[1] || '').trim());
  }
  return out;
}

async function wiktionary(word) {
  const variants = [...new Set([word, word.toLowerCase()])];
  for (const w of variants) {
    try {
      const [wt, defs] = await Promise.allSettled([
        getJSON('https://en.wiktionary.org/w/api.php?action=parse&page=' + encodeURIComponent(w) + '&prop=wikitext&format=json&formatversion=2&redirects=1&origin=*'),
        getJSON('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(w.replace(/ /g, '_'))),
      ]);
      let info = null;
      if (wt.status === 'fulfilled' && wt.value.parse) info = parseWikitext(w, wt.value.parse.wikitext || '');
      let definitions = [];
      if (defs.status === 'fulfilled' && defs.value.nl) {
        definitions = defs.value.nl.map((p) => ({
          pos: p.partOfSpeech,
          items: (p.definitions || []).map((d) => stripHtml(d.definition || '')).filter(Boolean).slice(0, 4),
          examples: (p.definitions || []).flatMap((d) => (d.examples || []).map(stripHtml)).slice(0, 2),
        })).filter((p) => p.items.length);
      }
      if (info || definitions.length) return { ...(info || { article: '', plural: '', pos: [] }), definitions };
    } catch {}
  }
  return null;
}

// ---------- Tatoeba example sentences ----------
export async function examples(word, tl = 'en') {
  const t3 = (LANGS[tl] || LANGS.en).t3;
  const url =
    'https://api.tatoeba.org/unstable/sentences?lang=nld&q=' + encodeURIComponent('=' + word) +
    '&trans:lang=' + t3 + '&sort=relevance&limit=20&word_count=3-12';
  try {
    const j = await getJSON(url, 7000);
    const list = (j.data || [])
      .map((s) => {
        const tr = (s.translations || []).find((t) => t.lang === t3) || null;
        return tr ? { nl: s.text, tr: tr.text } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.nl.length - b.nl.length);
    // prefer short-but-not-trivial sentences
    const good = list.filter((x) => x.nl.split(' ').length >= 3);
    return (good.length ? good : list).slice(0, 3);
  } catch {
    return [];
  }
}

/** Short translation of a word into an extra language (e.g. Persian next to English). */
export async function translateTerm(word, article, tl) {
  const r = await translate(article && article !== 'de/het' ? `${article} ${word}` : word, tl);
  let t = r.main;
  if (tl === 'en') t = t.replace(/^(the|a|an) (?=\w)/i, '');
  return t;
}

/**
 * Full lookup used when adding a word. Resolves even if some sources fail.
 * Throws only if no translation at all could be found.
 */
export async function lookup(raw, tl = 'en') {
  const { article: typedArticle, word } = parseInput(raw);
  if (!word) throw new Error('empty');
  const isPhrase = word.split(' ').length > 3;
  const [tr, wk, ex] = await Promise.allSettled([
    // with a typed article the user means the noun: "het eten" = food, not "to eat"
    translate(typedArticle ? `${typedArticle} ${word}` : word, tl),
    isPhrase ? Promise.resolve(null) : wiktionary(word),
    isPhrase ? Promise.resolve([]) : examples(word, tl),
  ]);
  if (tr.status !== 'fulfilled') throw new Error('translation-failed');
  const w = wk.status === 'fulfilled' ? wk.value : null;
  let article = typedArticle || (w && w.article) || '';
  let pos = (w && w.pos && w.pos[0]) || (tr.value.alts[0] && tr.value.alts[0].pos) || '';
  pos = pos ? pos.toLowerCase() : '';
  if (typedArticle) pos = 'noun';
  // de/het only makes sense when the word is primarily a noun (e.g. "lopen" is a verb, not "de lopen")
  if (pos && pos !== 'noun' && !typedArticle) article = '';
  let main = tr.value.main;
  if (tl === 'en') main = main.replace(/^(the|a|an|to) (?=\w)/i, (m) => (pos === 'verb' && /^to /i.test(m) ? m : ''));
  return {
    word,
    article,
    plural: (w && w.plural) || '',
    pos,
    translation: main,
    alts: tr.value.alts,
    definitions: (w && w.definitions) || [],
    examples: ex.status === 'fulfilled' ? ex.value : [],
  };
}

/** Free-text translation (sentences) in any direction, e.g. nl -> en or fa -> nl. */
export async function translateText(q, sl, tl, hint = 'en') {
  // sl may be 'auto': Google detects the language; MyMemory needs a real code, so use the hint
  const mm = () => myMemory(q, tl, sl === 'auto' ? hint : sl);
  let g = null;
  try { g = await googleTranslate(q, tl, sl); } catch {}
  if (g && !(NON_LATIN.has(tl) && /^[\x00-\x7F]+$/.test(g.main))) return g.main;
  try { return (await mm()).main; } catch (e) { if (g) return g.main; throw e; }
}
