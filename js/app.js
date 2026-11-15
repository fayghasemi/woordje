import { db, requestPersistence } from './db.js';
import { schedule, preview, fmtInterval, strength, newSrs, State, DAY, MIN } from './fsrs.js';
import { lookup, parseInput, translateTerm, translateText, LANGS, RTL } from './lookup.js';
import { PACKS, BUILTIN_NOUNS } from './starter.js';
import { icon } from './icons.js';

const VERSION = '1.4.2';

// ───────────────────────── helpers ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, '0');
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,!?;:"'()]/g, '').replace(/\s+/g, ' ').trim();
const DAY_OFFSET = 4 * 3600e3; // a "study day" starts at 04:00
const dayKey = (ts = Date.now()) => { const d = new Date(ts - DAY_OFFSET); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayEnd = () => { const d = new Date(Date.now() - DAY_OFFSET); d.setHours(0, 0, 0, 0); return d.getTime() + DAY + DAY_OFFSET; };
const vibrate = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ───────────────────────── state ─────────────────────────
const DEFAULT_SETTINGS = {
  lang: 'en',
  lang2: '', // optional second translation language shown next to the first (e.g. 'fa')
  voiceEngine: 'free', // 'free' | 'elevenlabs'
  elVoice: '',
  elVoiceName: '',
  elModel: 'eleven_flash_v2_5',
  newPerDay: 15,
  dailyGoal: 30,
  retention: 0.9,
  dirReverse: false, // English -> Dutch
  dirListen: false, // hear Dutch -> meaning
  typeAnswers: true, // type the Dutch when producing it
  autoplay: true,
  rate: 0.9,
  theme: 'auto',
  lastBackup: 0,
  installedPacks: [],
};

const S = {
  cards: new Map(),
  settings: { ...DEFAULT_SETTINGS },
  stats: { days: {} },
  tab: 'home',
  words: { q: '', filter: 'all', sort: 'recent' },
  session: null,
  add: null,
  deferredInstall: null,
  elKey: '', // kept out of settings so it never ends up in backup files
  elVoices: null,
  tr: { src: 'nl', text: '', out: '', out2: '', outLang: '', loading: false, err: '', seq: 0 },
  trHistory: [],
};

let saveStatsT = 0;
function saveStats() { clearTimeout(saveStatsT); saveStatsT = setTimeout(() => db.setMeta('stats', S.stats), 300); }
function saveSettings() { db.setMeta('settings', S.settings); }
async function saveCard(c) { c.updatedAt = Date.now(); S.cards.set(c.id, c); await db.putCard(c); }

function today() {
  const k = dayKey();
  if (!S.stats.days[k]) S.stats.days[k] = { r: 0, n: 0, a: 0, ok: 0, t: 0 };
  return S.stats.days[k];
}

// ───────────────────────── card helpers ─────────────────────────
const DIRS = () => ['nl', ...(S.settings.dirReverse ? ['tr'] : []), ...(S.settings.dirListen ? ['listen'] : [])];
const srsOf = (c, dir) => (c.srs && c.srs[dir]) || null;
const isReady = (c) => !!(c.translation && c.translation.trim());

function cardStatus(c) {
  const s = srsOf(c, 'nl');
  if (!s || s.state === State.New) return 'new';
  if (s.state === State.Learning || s.state === State.Relearning) return 'learning';
  if (s.s >= 21) return 'known';
  return 'review';
}

const STATUS_LABEL = { new: 'New', learning: 'Learning', review: 'Reviewing', known: 'Known' };

function articleHtml(a, cls = '') {
  if (!a) return '';
  const k = a === 'het' ? 'het' : a === 'de' ? 'de' : 'both';
  return `<span class="art art-${k} ${cls}">${esc(a)}</span>`;
}

function dirAttr(lang) { return RTL.has(lang) ? 'dir="rtl"' : ''; }

function findDuplicate(word) {
  const n = norm(word);
  for (const c of S.cards.values()) if (norm(c.word) === n) return c;
  return null;
}

function makeCard({ word, article = '', translation = '', note = '', tags = [] }) {
  return {
    id: uid(), word, article, translation, note, tags,
    plural: '', pos: '', alts: [], definitions: [], examples: [], translations: {},
    starred: false, status: translation ? 'ok' : 'pending', tries: 0,
    lang: S.settings.lang, userEdited: !!translation,
    createdAt: Date.now(), updatedAt: Date.now(), srs: {},
  };
}

function applyLookup(c, r) {
  if (!c.userEdited || !c.translation) c.translation = r.translation;
  if (!c.article && r.article) c.article = r.article;
  c.plural = c.plural || r.plural;
  c.pos = c.pos || r.pos;
  c.alts = r.alts || [];
  c.definitions = r.definitions || [];
  c.examples = r.examples && r.examples.length ? r.examples : c.examples || [];
  c.status = 'ok';
  c.lang = S.settings.lang;
}

// second translation language helpers
const needsExtra = (c) => { const l = S.settings.lang2; return !!l && l !== c.lang && c.status === 'ok' && !(c.translations && l in c.translations); };
function extraTr(c) {
  const l = S.settings.lang2;
  if (!l || l === c.lang) return null;
  const t = c.translations && c.translations[l];
  return t ? { lang: l, text: t } : null;
}
function extraHtml(c, cls) {
  const x = extraTr(c);
  return x ? `<div class="${cls}" ${dirAttr(x.lang)} lang="${x.lang}">${esc(x.text)}</div>` : '';
}

// ───────────────────────── background lookups ─────────────────────────
let processing = false;
async function processPending() {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      if (!navigator.onLine) break;
      const c = [...S.cards.values()].find((x) => x.status === 'pending');
      if (!c) {
        // second language (e.g. Persian) for words that don't have it yet
        const x = [...S.cards.values()].find(needsExtra);
        if (!x) break;
        const l = S.settings.lang2;
        try {
          const t = await translateTerm(x.word, x.article, l);
          x.translations = { ...(x.translations || {}), [l]: t };
        } catch {
          if (!navigator.onLine) break;
          x.xTries = (x.xTries || 0) + 1;
          if (x.xTries >= 2) x.translations = { ...(x.translations || {}), [l]: '' };
        }
        await saveCard(x);
        softRefresh();
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      try {
        const r = await lookup((c.article ? c.article + ' ' : '') + c.word, S.settings.lang);
        const fresh = S.cards.get(c.id);
        if (!fresh) continue;
        applyLookup(fresh, r);
        await saveCard(fresh);
      } catch (e) {
        const fresh = S.cards.get(c.id);
        if (!fresh) continue;
        if (!navigator.onLine) break;
        fresh.tries = (fresh.tries || 0) + 1;
        if (fresh.tries >= 2) fresh.status = fresh.translation ? 'ok' : 'failed';
        await saveCard(fresh);
      }
      softRefresh();
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    processing = false;
  }
}

// ───────────────────────── speech ─────────────────────────
let nlVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  nlVoice = vs.find((v) => v.lang === 'nl-NL' && /google|xander|claire|ellen|natural|premium|enhanced/i.test(v.name))
    || vs.find((v) => v.lang === 'nl-NL') || vs.find((v) => /^nl/i.test(v.lang)) || null;
}
// One shared <audio> element, "unlocked" by the first tap so iPhone allows later playback.
const player = new Audio();
player.preload = 'auto';
let playerUrl = '';
let unlocked = false;
const SILENT = (() => { // 50 ms of silence as a WAV file
  const n = 400, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  try { player.src = SILENT; const p = player.play(); if (p && p.catch) p.catch(() => {}); } catch {}
}
addEventListener('pointerdown', unlockAudio, { once: true, capture: true });

function playUrl(url, rate) {
  try {
    player.pause();
    if (playerUrl.startsWith('blob:') && playerUrl !== url) URL.revokeObjectURL(playerUrl);
    playerUrl = url;
    player.src = url;
    player.playbackRate = Math.max(0.5, Math.min(1.5, rate || S.settings.rate));
    return player.play();
  } catch (e) { return Promise.reject(e); }
}

// ---- ElevenLabs (premium voice). Audio is cached on the device, so each word costs credits only once.
const EL_DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // ElevenLabs standard voice "George", available on every account
const elVoiceId = () => S.settings.elVoice || EL_DEFAULT_VOICE;
const elCacheKey = (text) => `${elVoiceId()}|${S.settings.elModel}|${text}`;
const elReady = () => S.settings.voiceEngine === 'elevenlabs' && S.elKey;
const elInflight = new Map();

async function elFetch(text) {
  const key = elCacheKey(text);
  try { const hit = await db.getAudio(key); if (hit) return hit; } catch {}
  if (elInflight.has(key)) return elInflight.get(key);
  const p = (async () => {
    const model = S.settings.elModel;
    const body = { text, model_id: model };
    if (/flash|turbo/.test(model)) body.language_code = 'nl'; // forces Dutch pronunciation
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elVoiceId())}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': S.elKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); msg = (j.detail && (j.detail.message || j.detail.status)) || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await r.blob();
    db.setAudio(key, blob).catch(() => {});
    return blob;
  })();
  elInflight.set(key, p);
  try { return await p; } finally { elInflight.delete(key); }
}

let elErrorShown = 0;
async function speakEleven(text, rate) {
  try {
    const blob = await elFetch(text);
    await playUrl(URL.createObjectURL(blob), rate);
    return true;
  } catch (e) {
    if (e && e.name === 'NotAllowedError') return true; // autoplay blocked — tap the speaker
    if (Date.now() - elErrorShown > 15000) { elErrorShown = Date.now(); toast(`ElevenLabs: ${esc(e.message || 'failed')} — using the free voice`); }
    return false;
  }
}

/** Prefetch premium audio for a word so it also plays offline later. */
function prefetchAudio(c) {
  if (elReady() && navigator.onLine) elFetch(cardSpeech(c)).catch(() => {});
}

// ---- Free voices
function speakGoogle(text, rate) {
  // needs <meta name="referrer" content="no-referrer"> — Google rejects requests from other sites
  return playUrl('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=nl&q=' + encodeURIComponent(text.slice(0, 190)), rate);
}
const goodLocalVoice = () => nlVoice && /google|xander|claire|ellen|fleur|natural|premium|enhanced|siri/i.test(nlVoice.name);

async function speak(text, rate) {
  if (!text) return;
  if (elReady() && (await speakEleven(text, rate))) return;
  if (goodLocalVoice() || (!navigator.onLine && nlVoice)) { speakLocal(text, rate); return; }
  if (navigator.onLine) {
    try { await speakGoogle(text, rate); return; } catch (e) { if (e && e.name === 'NotAllowedError') return; }
  }
  if (nlVoice) { speakLocal(text, rate); return; }
  // Never read Dutch with an English voice — that teaches the wrong pronunciation.
  toast('No Dutch voice available offline on this device');
}
function speakLocal(text, rate) {
  if (!('speechSynthesis' in window) || !nlVoice) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'nl-NL';
    if (nlVoice) u.voice = nlVoice;
    u.rate = rate || S.settings.rate;
    speechSynthesis.speak(u);
  } catch {}
}
const cardSpeech = (c) => (c.article && c.article !== 'de/het' ? c.article + ' ' : '') + c.word;
const speakCard = (c) => speak(cardSpeech(c));

// ───────────────────────── toast ─────────────────────────
let toastT = 0;
function toast(msg, opts = {}) {
  const el = $('#toast');
  clearTimeout(toastT);
  el.innerHTML = `<span>${msg}</span>${opts.action ? `<button class="toast-btn">${esc(opts.action)}</button>` : ''}`;
  el.classList.add('show');
  if (opts.action) $('.toast-btn', el).onclick = () => { el.classList.remove('show'); opts.onAction && opts.onAction(); };
  toastT = setTimeout(() => el.classList.remove('show'), opts.ms || (opts.action ? 4500 : 2200));
}

// ───────────────────────── queue building ─────────────────────────
function buildQueue() {
  const now = Date.now();
  const end = dayEnd();
  const dirs = DIRS();
  const learning = [], reviews = [], fresh = [];
  const cards = [...S.cards.values()].filter(isReady);
  for (const c of cards) {
    for (const dir of dirs) {
      const s = srsOf(c, dir);
      if (!s || s.state === State.New) {
        // production / listening cards only unlock once recognition is solid
        if (dir !== 'nl') { const b = srsOf(c, 'nl'); if (!b || b.state !== State.Review) continue; }
        fresh.push({ id: c.id, dir, created: c.createdAt + (dir === 'nl' ? 0 : 1) });
      } else if (s.state === State.Review) {
        if (s.due <= end) reviews.push({ id: c.id, dir, due: s.due });
      } else if (s.due <= now + 20 * MIN) {
        learning.push({ id: c.id, dir, due: s.due });
      }
    }
  }
  const t = today();
  const newLeft = Math.max(0, S.settings.newPerDay - t.n);
  fresh.sort((a, b) => a.created - b.created);
  const newItems = fresh.slice(0, newLeft);
  reviews.sort((a, b) => a.due - b.due);
  return { learning, reviews, newItems, newWaiting: fresh.length };
}

function dueCounts() {
  const q = buildQueue();
  return { learn: q.learning.length, review: q.reviews.length, new: q.newItems.length, total: q.learning.length + q.reviews.length + q.newItems.length, newWaiting: q.newWaiting };
}

function nextDueTime() {
  let min = Infinity;
  for (const c of S.cards.values()) for (const d of DIRS()) { const s = srsOf(c, d); if (s && s.state !== State.New && s.due < min) min = s.due; }
  return min;
}

// ───────────────────────── stats ─────────────────────────
function streak() {
  let n = 0;
  const d = new Date(Date.now() - DAY_OFFSET);
  const key = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const has = (k) => { const v = S.stats.days[k]; return v && (v.r > 0 || v.a > 0); };
  if (!has(key(d))) d.setDate(d.getDate() - 1);
  while (has(key(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function counts() {
  let total = 0, known = 0, learning = 0, fresh = 0;
  for (const c of S.cards.values()) {
    total++;
    const st = cardStatus(c);
    if (st === 'known') known++;
    else if (st === 'new') fresh++;
    else learning++;
  }
  return { total, known, learning, fresh };
}

// ───────────────────────── rendering ─────────────────────────
function greeting() {
  const h = new Date().getHours();
  if (h < 6) return 'Goedenacht';
  if (h < 12) return 'Goedemorgen';
  if (h < 18) return 'Goedemiddag';
  return 'Goedenavond';
}

function render(quiet = false) {
  const v = $('#view');
  v.classList.toggle('no-anim', quiet);
  const views = { home: viewHome, words: viewWords, practice: viewPractice, translate: viewTranslate, settings: viewSettings };
  v.innerHTML = views[S.tab]();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.tab));
  afterRender();
}

// Re-render without losing scroll/focus where possible (used by background updates)
let softT = 0, softLast = 0;
function softRefresh() {
  if (S.session || $('#session.open')) return;
  const wait = 1200 - (Date.now() - softLast);
  if (wait > 0) { clearTimeout(softT); softT = setTimeout(softRefresh, wait); return; }
  softLast = Date.now();
  const active = document.activeElement;
  if (S.tab === 'words' && active && active.id === 'word-search') { renderWordList(); return; }
  if (S.tab === 'translate') { if (!$('#sheet.open')) renderTrOut(); return; } // never re-render while typing a sentence
  if ($('#sheet.open')) { if (S.detailId) refreshDetail(); }
  const y = $('#view').scrollTop;
  render(true);
  $('#view').scrollTop = y;
}

function afterRender() {
  if (S.tab === 'words') renderWordList();
  if (S.tab === 'settings' && S.elKey && S.settings.voiceEngine === 'elevenlabs') {
    if (!S.elVoices) { S.elVoices = []; loadVoices(); }
    loadUsage();
  }
}

// ── Home
function viewHome() {
  const dc = dueCounts();
  const c = counts();
  const t = today();
  const st = streak();
  const goal = S.settings.dailyGoal;
  const pct = Math.min(1, t.r / goal);
  const empty = S.cards.size === 0;
  const recent = [...S.cards.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  const d = new Date();
  const dateStr = d.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });

  let hero;
  if (empty) {
    hero = `
      <div class="hero hero-empty">
        <div class="hero-kicker">Welkom! 👋</div>
        <h2>Start your Dutch word bank</h2>
        <p>Every time you meet a new word, add it here. Translations, de/het, plurals, pronunciation and example sentences are filled in for you.</p>
        <div class="hero-actions">
          <button class="btn btn-light" data-action="open-add">${icon('plus', 20)} Add your first word</button>
          <button class="btn btn-ghost-light" data-action="goto" data-tab="settings" data-scroll="packs">${icon('layers', 18)} Starter packs</button>
        </div>
      </div>`;
  } else if (dc.total > 0) {
    hero = `
      <div class="hero" data-action="start-review" role="button" tabindex="0">
        <div class="hero-top">
          <div>
            <div class="hero-kicker">Ready to review</div>
            <div class="hero-count">${dc.total}<span> card${dc.total === 1 ? '' : 's'}</span></div>
          </div>
          <div class="hero-ring" style="--p:${pct}">
            <svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" class="ring-bg"/><circle cx="22" cy="22" r="19" class="ring-fg" style="stroke-dasharray:${(pct * 119.4).toFixed(1)} 200"/></svg>
            <div class="ring-label"><b>${t.r}</b><small>/${goal}</small></div>
          </div>
        </div>
        <div class="hero-pills">
          ${dc.new ? `<span class="pill-new">${dc.new} new</span>` : ''}
          ${dc.learn ? `<span class="pill-learn">${dc.learn} learning</span>` : ''}
          ${dc.review ? `<span class="pill-rev">${dc.review} review</span>` : ''}
        </div>
        <button class="btn btn-light btn-block hero-btn">${icon('play', 18)} Start review</button>
      </div>`;
  } else {
    const nd = nextDueTime();
    const when = nd === Infinity ? '' : nd - Date.now() < DAY ? `Next review at ${new Date(nd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : `Next review ${new Date(nd).toLocaleDateString([], { weekday: 'long' })}`;
    hero = `
      <div class="hero hero-done">
        <div class="hero-top">
          <div>
            <div class="hero-kicker">All caught up</div>
            <h2>Goed gedaan! 🎉</h2>
            <p>${when || 'Add new words to keep learning.'}${dc.newWaiting && !dc.new ? ` · ${dc.newWaiting} new words waiting for tomorrow` : ''}</p>
          </div>
          <div class="hero-ring" style="--p:${pct}">
            <svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" class="ring-bg"/><circle cx="22" cy="22" r="19" class="ring-fg" style="stroke-dasharray:${(pct * 119.4).toFixed(1)} 200"/></svg>
            <div class="ring-label"><b>${t.r}</b><small>/${goal}</small></div>
          </div>
        </div>
        <div class="hero-actions">
          <button class="btn btn-ghost-light" data-action="goto" data-tab="practice">${icon('sparkles', 18)} Extra practice</button>
          ${dc.newWaiting ? `<button class="btn btn-ghost-light" data-action="learn-more">${icon('plus', 18)} Learn 5 more</button>` : ''}
        </div>
      </div>`;
  }

  const backupNag = S.cards.size >= 25 && Date.now() - (S.settings.lastBackup || 0) > 14 * DAY;

  return `
    <header class="page-head">
      <div>
        <div class="eyebrow cap">${esc(dateStr)}</div>
        <h1>${greeting()}</h1>
      </div>
      <div class="head-actions">
        <div class="streak ${st ? 'on' : ''}" title="Day streak">${icon('flame', 18)}<b>${st}</b></div>
        <button class="icon-btn gear" data-action="goto" data-tab="settings" aria-label="Settings">${icon('settings', 22)}</button>
      </div>
    </header>

    <button class="quick-add" data-action="open-add">
      ${icon('plus', 20)}<span>Add a Dutch word…</span><kbd>N</kbd>
    </button>

    ${hero}

    ${empty ? '' : `
    <div class="tiles">
      <div class="tile"><b>${c.total}</b><span>Words</span></div>
      <div class="tile"><b>${c.learning}</b><span>Learning</span></div>
      <div class="tile"><b>${c.known}</b><span>Known</span></div>
    </div>`}

    ${backupNag ? `
    <div class="notice" data-action="export">
      ${icon('download', 20)}<div><b>Back up your words</b><span>Keep a copy safe — it takes one tap.</span></div>${icon('chevron', 18)}
    </div>` : ''}

    ${!isStandalone() ? `
    <div class="notice notice-accent" data-action="install">
      ${icon('share', 20)}<div><b>Install on your phone</b><span>Get the full-screen app, offline support and a home-screen icon.</span></div>${icon('chevron', 18)}
    </div>` : ''}

    ${empty ? '' : `
    <section class="card-section">
      <div class="section-head"><h3>Activity</h3><span class="muted">${Object.values(S.stats.days).reduce((a, b) => a + (b.r || 0), 0)} reviews total</span></div>
      ${heatmap()}
    </section>

    <section class="card-section">
      <div class="section-head"><h3>Recently added</h3><button class="link" data-action="goto" data-tab="words">See all</button></div>
      <div class="rows">${recent.map(rowHtml).join('')}</div>
    </section>`}
  `;
}

function heatmap() {
  const weeks = 17;
  const end = new Date(Date.now() - DAY_OFFSET);
  end.setHours(12, 0, 0, 0);
  const dow = (end.getDay() + 6) % 7; // Monday = 0
  const start = new Date(end);
  start.setDate(end.getDate() - dow - (weeks - 1) * 7);
  let cells = '';
  const max = Math.max(10, ...Object.values(S.stats.days).map((d) => d.r || 0));
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const v = S.stats.days[k];
    const n = v ? (v.r || 0) + (v.a || 0) : 0;
    const lvl = d > end ? -1 : n === 0 ? 0 : n < max * 0.25 ? 1 : n < max * 0.5 ? 2 : n < max * 0.8 ? 3 : 4;
    cells += `<i class="hm l${lvl}" title="${k}: ${v ? v.r : 0} reviews, ${v ? v.a : 0} added"></i>`;
  }
  return `<div class="heatmap" style="--weeks:${weeks}">${cells}</div>
  <div class="hm-legend"><span>Less</span><i class="hm l0"></i><i class="hm l1"></i><i class="hm l2"></i><i class="hm l3"></i><i class="hm l4"></i><span>More</span></div>`;
}

function rowHtml(c) {
  const st = cardStatus(c);
  const s = srsOf(c, 'nl');
  const str = strength(s);
  let sub;
  if (c.status === 'pending' && !c.translation) sub = `<span class="pending"><i class="spinner"></i> Translating…</span>`;
  else if (c.status === 'failed' && !c.translation) sub = `<span class="failed">Tap to add a translation</span>`;
  else {
    const x = extraTr(c);
    sub = `<span ${dirAttr(c.lang)}>${esc(c.translation)}</span>${x ? `<span class="sub2"> · </span><span class="sub2" ${dirAttr(x.lang)}>${esc(x.text)}</span>` : ''}`;
  }
  return `
    <button class="row" data-action="open-detail" data-id="${c.id}">
      <div class="row-main">
        <div class="row-word">${articleHtml(c.article)}<span>${esc(c.word)}</span>${c.starred ? icon('star', 14, 'star-on') : ''}</div>
        <div class="row-sub">${sub}</div>
      </div>
      <div class="row-meta">
        <span class="status st-${st}">${STATUS_LABEL[st]}</span>
        <span class="meter"><i style="width:${Math.round(str * 100)}%"></i></span>
      </div>
    </button>`;
}

// ── Words
function viewWords() {
  const f = S.words.filter;
  const chip = (k, label) => `<button class="chip ${f === k ? 'on' : ''}" data-action="filter" data-f="${k}">${label}</button>`;
  return `
    <header class="page-head sticky">
      <div><h1>Words</h1><div class="eyebrow" id="word-count"></div></div>
      <button class="icon-btn primary" data-action="open-add" aria-label="Add word">${icon('plus', 22)}</button>
    </header>
    <div class="search">
      ${icon('search', 18)}
      <input id="word-search" type="search" placeholder="Search Dutch or translation" value="${esc(S.words.q)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    </div>
    <div class="chips">
      ${chip('all', 'All')}${chip('new', 'New')}${chip('learning', 'Learning')}${chip('known', 'Known')}${chip('starred', '★ Starred')}${chip('hard', 'Tricky')}${chip('de', 'de')}${chip('het', 'het')}
    </div>
    <div class="sortbar">
      <select id="word-sort" aria-label="Sort">
        <option value="recent" ${S.words.sort === 'recent' ? 'selected' : ''}>Newest first</option>
        <option value="az" ${S.words.sort === 'az' ? 'selected' : ''}>A → Z</option>
        <option value="weak" ${S.words.sort === 'weak' ? 'selected' : ''}>Weakest first</option>
        <option value="due" ${S.words.sort === 'due' ? 'selected' : ''}>Due soonest</option>
      </select>
    </div>
    <div class="rows" id="word-list"></div>`;
}

function renderWordList() {
  const list = $('#word-list');
  if (!list) return;
  const q = norm(S.words.q);
  const f = S.words.filter;
  let arr = [...S.cards.values()].filter((c) => {
    if (q && !norm(c.word).includes(q) && !norm(c.translation).includes(q) && !norm(c.note).includes(q) && !norm(Object.values(c.translations || {}).join(' ')).includes(q)) return false;
    const st = cardStatus(c);
    if (f === 'new') return st === 'new';
    if (f === 'learning') return st === 'learning' || st === 'review';
    if (f === 'known') return st === 'known';
    if (f === 'starred') return c.starred;
    if (f === 'hard') { const s = srsOf(c, 'nl'); return s && (s.lapses >= 2 || s.d >= 7.5); }
    if (f === 'de' || f === 'het') return c.article === f;
    return true;
  });
  const sorters = {
    recent: (a, b) => b.createdAt - a.createdAt,
    az: (a, b) => a.word.localeCompare(b.word, 'nl'),
    weak: (a, b) => strength(srsOf(a, 'nl')) - strength(srsOf(b, 'nl')),
    due: (a, b) => ((srsOf(a, 'nl') || {}).due || 0) - ((srsOf(b, 'nl') || {}).due || 0),
  };
  arr.sort(sorters[S.words.sort]);
  const wc = $('#word-count');
  if (wc) wc.textContent = `${arr.length} of ${S.cards.size} word${S.cards.size === 1 ? '' : 's'}`;
  if (!arr.length) {
    list.innerHTML = S.cards.size
      ? `<div class="empty">${icon('search', 28)}<p>No words match.</p>${q ? `<button class="btn btn-primary" data-action="open-add" data-prefill="${esc(S.words.q)}">${icon('plus', 18)} Add “${esc(S.words.q)}”</button>` : ''}</div>`
      : `<div class="empty">${icon('book', 32)}<p>Your word list is empty.</p><button class="btn btn-primary" data-action="open-add">${icon('plus', 18)} Add a word</button></div>`;
    return;
  }
  // render in chunks for big lists
  const LIMIT = 300;
  list.innerHTML = arr.slice(0, LIMIT).map(rowHtml).join('') + (arr.length > LIMIT ? `<div class="muted center pad">Showing ${LIMIT} of ${arr.length}. Use search to narrow down.</div>` : '');
}

// ── Practice
function viewPractice() {
  const dc = dueCounts();
  const nouns = [...S.cards.values()].filter((c) => c.article === 'de' || c.article === 'het').length;
  const ready = [...S.cards.values()].filter(isReady).length;
  const mode = (action, ic, title, sub, cls = '', disabled = false) => `
    <button class="mode ${cls}" data-action="${action}" ${disabled ? 'disabled' : ''}>
      <div class="mode-ic">${icon(ic, 24)}</div>
      <div class="mode-text"><b>${title}</b><span>${sub}</span></div>
      ${icon('chevron', 18)}
    </button>`;
  return `
    <header class="page-head"><div><h1>Practice</h1><div class="eyebrow">Spaced repetition + focused drills</div></div></header>

    <div class="hero hero-compact" data-action="start-review" role="button" tabindex="0">
      <div class="hero-top">
        <div><div class="hero-kicker">Daily review</div><div class="hero-count">${dc.total}<span> due</span></div></div>
        <div class="hero-play">${icon('play', 26)}</div>
      </div>
      <p class="hero-note">Smart scheduling (FSRS) shows each word right before you'd forget it.</p>
    </div>

    <div class="section-label">Drills — don't affect your schedule</div>
    <div class="modes">
      ${mode('drill-dehet', 'target', 'de of het?', `Train noun articles · ${nouns >= 8 ? nouns + ' of your nouns' : 'uses common nouns too'}`, 'm-orange')}
      ${mode('drill-weak', 'refresh', 'Tricky words', 'Your weakest and most-forgotten words', 'm-red', ready < 1)}
      ${mode('drill-spell', 'keyboard', 'Spelling', 'See the meaning, type the Dutch word', 'm-blue', ready < 1)}
      ${mode('drill-listen', 'headphones', 'Listening', 'Hear the Dutch word, recall the meaning', 'm-green', ready < 1)}
      ${mode('drill-random', 'shuffle', 'Shuffle all', '20 random words from your list', 'm-purple', ready < 1)}
    </div>
    ${ready < 1 ? `<p class="muted center pad">Add a few words to unlock the drills.</p>` : ''}

    <div class="section-label">Exam tip</div>
    <div class="tip">
      ${icon('info', 20)}
      <p>The inburgering exams (A2) test <b>Lezen, Luisteren, Schrijven, Spreken</b> and <b>KNM</b>. Turn on <b>English → Dutch</b> and <b>Listening</b> cards in Settings once your list grows — they train exactly the skills writing and listening need.</p>
    </div>`;
}

// ── Settings
function viewSettings() {
  const s = S.settings;
  const langOpts = Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${s.lang === k ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
  const toggle = (key, title, sub) => `
    <label class="set-row">
      <div><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>
      <input type="checkbox" class="switch" data-setting="${key}" ${s[key] ? 'checked' : ''}>
    </label>`;
  const stepper = (key, title, sub, step, min, max) => `
    <div class="set-row">
      <div><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>
      <div class="stepper"><button data-action="step" data-key="${key}" data-d="${-step}" data-min="${min}" data-max="${max}">−</button><output>${s[key]}</output><button data-action="step" data-key="${key}" data-d="${step}" data-min="${min}" data-max="${max}">+</button></div>
    </div>`;
  const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(s[key]) === String(v) ? 'on' : ''}" data-action="seg" data-key="${key}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const packs = Object.entries(PACKS).map(([k, p]) => {
    const done = s.installedPacks.includes(k);
    return `<div class="set-row">
      <div><b>${p.title}</b><span>${p.subtitle} · ${p.items.length} words</span></div>
      <button class="btn btn-sm ${done ? 'btn-soft' : 'btn-primary'}" data-action="add-pack" data-pack="${k}" ${done ? 'disabled' : ''}>${done ? icon('check', 16) + ' Added' : 'Add'}</button>
    </div>`;
  }).join('');
  const failed = [...S.cards.values()].filter((c) => c.status === 'failed').length;

  return `
    <header class="page-head"><div><h1>Settings</h1><div class="eyebrow">Woordje v${VERSION}</div></div></header>

    <div class="group-label">Translation</div>
    <div class="group">
      <div class="set-row">
        <div><b>Translate into</b><span>Used for new words you add</span></div>
        <select data-setting="lang">${langOpts}</select>
      </div>
      <div class="set-row">
        <div><b>Also show</b><span>A second translation on every card${s.lang2 ? ' — added to existing words automatically' : ''}</span></div>
        <select data-setting="lang2"><option value="" ${!s.lang2 ? 'selected' : ''}>None</option>${Object.entries(LANGS).filter(([k]) => k !== s.lang).map(([k, v]) => `<option value="${k}" ${s.lang2 === k ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
      </div>
      ${failed ? `<div class="set-row"><div><b>${failed} word${failed > 1 ? 's' : ''} without translation</b><span>Try fetching them again</span></div><button class="btn btn-sm btn-soft" data-action="retry-failed">Retry</button></div>` : ''}
    </div>

    <div class="group-label">Daily study</div>
    <div class="group">
      ${stepper('newPerDay', 'New words per day', 'How many unseen words to introduce daily', 5, 0, 100)}
      ${stepper('dailyGoal', 'Daily review goal', 'Fills the ring on the home screen', 10, 10, 300)}
      <div class="set-row col">
        <div><b>Memory target</b><span>Higher = more reviews, better recall</span></div>
        ${seg('retention', [[0.85, '85%'], [0.9, '90%'], [0.95, '95%']])}
      </div>
    </div>

    <div class="group-label">Card types</div>
    <div class="group">
      <div class="set-row"><div><b>Dutch → ${esc((LANGS[s.lang] || LANGS.en).name.split(' (')[0])}</b><span>Recognise the word (always on)</span></div><input type="checkbox" class="switch" checked disabled></div>
      ${toggle('dirReverse', `${esc((LANGS[s.lang] || LANGS.en).name.split(' (')[0])} → Dutch`, 'Produce the Dutch word — great for Schrijven & Spreken')}
      ${toggle('dirListen', 'Listening', 'Hear the word and recall its meaning — great for Luisteren')}
      ${toggle('typeAnswers', 'Type answers', 'Type the Dutch word on production cards')}
    </div>

    <div class="group-label">Pronunciation</div>
    <div class="group">
      ${toggle('autoplay', 'Auto-play pronunciation', 'Speak Dutch words when cards appear')}
      <div class="set-row col">
        <div class="row-between"><b>Speaking speed</b><button class="btn btn-sm btn-soft" data-action="test-voice">${icon('volume', 16)} Test</button></div>
        <input type="range" min="0.5" max="1.2" step="0.05" value="${s.rate}" data-setting="rate">
      </div>
      <div class="set-row col">
        <div><b>Voice</b><span>ElevenLabs sounds like a real Dutch speaker. Each word is generated once and saved on your phone.</span></div>
        ${seg('voiceEngine', [['free', 'Free'], ['elevenlabs', 'ElevenLabs']])}
      </div>
      ${s.voiceEngine === 'elevenlabs' ? elevenSettingsHtml(seg) : `
      <div class="set-row"><div><span>${goodLocalVoice() ? `Using your device's Dutch voice: ${esc(nlVoice.name)} (works offline)` : 'Using Google’s free online Dutch voice.'}</span></div></div>`}
    </div>

    <div class="group-label">Appearance</div>
    <div class="group">
      <div class="set-row col"><div><b>Theme</b></div>${seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>
    </div>

    <div class="group-label" id="packs">Starter packs</div>
    <div class="group">${packs}</div>

    <div class="group-label">Your data</div>
    <div class="group">
      <button class="set-row link-row" data-action="export"><div><b>${icon('download', 18)} Export backup</b><span>${s.lastBackup ? 'Last backup ' + new Date(s.lastBackup).toLocaleDateString() : 'Never backed up'}</span></div>${icon('chevron', 18)}</button>
      <label class="set-row link-row"><div><b>${icon('upload', 18)} Import backup</b><span>Restore or merge a Woordje backup file</span></div>${icon('chevron', 18)}<input type="file" accept="application/json,.json" id="import-file" hidden></label>
      <button class="set-row link-row" data-action="install"><div><b>${icon('share', 18)} Install app</b><span>${isStandalone() ? 'Installed ✓' : 'Add Woordje to your home screen'}</span></div>${icon('chevron', 18)}</button>
      <div class="set-row"><div><span id="storage-info">Your words are stored privately on this device.</span></div></div>
    </div>

    <div class="group">
      <button class="set-row link-row danger" data-action="reset-all"><div><b>${icon('trash', 18)} Delete all data</b><span>Removes every word and all progress</span></div></button>
    </div>

    <p class="credits">Translations by Google Translate &amp; MyMemory · Dictionary data from Wiktionary (CC BY-SA) · Example sentences from Tatoeba (CC BY 2.0 FR) · Scheduling by FSRS.<br>Succes met je inburgering! 🇳🇱</p>
  `;
}

function elevenSettingsHtml(seg) {
  const s = S.settings;
  const voices = S.elVoices;
  let voiceRow = '';
  if (S.elKey && voices && voices.length) {
    voiceRow = `<div class="set-row">
      <div><b>Speaker</b><span>Your own (cloned) voices are listed first</span></div>
      <select data-setting="elVoice">${voices.map((v) => `<option value="${esc(v.voice_id)}" ${v.voice_id === s.elVoice ? 'selected' : ''}>${esc(v.name)}${/cloned|professional/.test(v.category) ? ' ★ yours' : ''}</option>`).join('')}</select>
    </div>`;
  } else if (S.elKey) {
    voiceRow = `<div class="set-row col">
      <div><b>Speaker</b><span>${s.elVoiceName ? 'Current: ' + esc(s.elVoiceName) : 'Using the standard voice “George”. Load your voices or paste a voice ID to change it.'}</span></div>
      <div class="key-row"><input id="el-voice-id" placeholder="Voice ID" value="${esc(s.elVoice)}" autocomplete="off" autocapitalize="none" spellcheck="false"><button class="btn btn-sm btn-soft" data-action="el-save-voice">Use</button><button class="btn btn-sm btn-soft" data-action="el-load-voices">Load list</button></div>
    </div>`;
  }
  return `
    <div class="set-row col">
      <div><b>ElevenLabs API key</b><span>Stored only on this phone and never included in backups.</span></div>
      <div class="key-row"><input id="el-key" type="password" placeholder="${S.elKey ? '•••••••• saved' : 'Paste your API key'}" autocomplete="off" autocapitalize="none" spellcheck="false"><button class="btn btn-sm btn-primary" data-action="el-save-key">${S.elKey ? 'Replace' : 'Save'}</button></div>
    </div>
    ${voiceRow}
    ${S.elKey ? `
    <div class="set-row col">
      <div><b>Model</b><span>Flash v2.5 forces Dutch pronunciation and uses half the credits. Multilingual v2 sounds most natural.</span></div>
      ${seg('elModel', [['eleven_flash_v2_5', 'Flash v2.5'], ['eleven_multilingual_v2', 'Multilingual v2']])}
    </div>
    <div class="set-row"><div><span id="el-usage">Checking credits…</span></div><button class="btn btn-sm btn-soft" data-action="el-clear-cache">Clear saved audio</button></div>` : ''}`;
}

async function loadVoices() {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': S.elKey } });
    if (!r.ok) throw new Error(r.status === 401 ? 'the key was rejected or lacks the “Voices: read” permission' : 'HTTP ' + r.status);
    const j = await r.json();
    const order = { cloned: 0, professional: 0, generated: 1, premade: 2 };
    S.elVoices = (j.voices || []).sort((a, b) => (order[a.category] ?? 3) - (order[b.category] ?? 3) || a.name.localeCompare(b.name));
    if (!S.elVoices.some((v) => v.voice_id === S.settings.elVoice) && S.elVoices[0]) {
      S.settings.elVoice = S.elVoices[0].voice_id; S.settings.elVoiceName = S.elVoices[0].name; saveSettings();
    }
  } catch (e) {
    S.elVoices = [];
    toast('Could not load voices: ' + esc(e.message));
  }
  if (S.tab === 'settings' && !S.session) render(true);
}

async function loadUsage() {
  if (!$('#el-usage')) return;
  let text;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': S.elKey } });
    if (!r.ok) throw 0;
    const j = await r.json();
    const left = Math.max(0, (j.character_limit || 0) - (j.character_count || 0));
    text = `${left.toLocaleString()} credits left this month (a word uses ~5–10)`;
  } catch { text = 'Audio is saved on this phone after the first play.'; }
  const el = $('#el-usage'); // look it up again: the page may have re-rendered meanwhile
  if (el) el.textContent = text;
}

// ───────────────────────── translate (sentences) ─────────────────────────
const SPEECH_LANG = { nl: 'nl-NL', en: 'en-US', fa: 'fa-IR', ar: 'ar-SA', tr: 'tr-TR', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-PT', it: 'it-IT', pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', zh: 'zh-CN', hi: 'hi-IN', id: 'id-ID' };
const langName = (k) => (k === 'nl' ? 'Nederlands' : k === 'auto' ? 'Auto-detect' : ((LANGS[k] || LANGS.en).name.split(' (')[0]));
const trTarget = () => (S.tr.src === 'nl' ? S.settings.lang : 'nl');
const trSecond = () => (S.tr.src === 'nl' && S.settings.lang2 && S.settings.lang2 !== S.settings.lang ? S.settings.lang2 : '');
// languages you can speak into the mic when translating *into* Dutch
const micLangs = () => [...new Set([S.settings.lang, S.settings.lang2].filter(Boolean))];

function viewTranslate() {
  const t = S.tr;
  const tl = trTarget();
  const l2 = trSecond();
  const canPaste = !!(navigator.clipboard && navigator.clipboard.readText);
  const ml = micLangs();
  if (!ml.includes(t.micLang)) t.micLang = ml[0];
  const micLang = t.src === 'nl' ? 'nl' : t.micLang;
  const hintNames = ml.map(langName).join(', ');
  return `
    <header class="page-head"><div><h1>Translate</h1><div class="eyebrow">Letters, signs, conversations — any sentence</div></div></header>

    <div class="tr-langs">
      <div class="tr-lang">${t.src === 'auto' ? `${esc(hintNames)}<small class="tr-auto">auto-detect</small>` : esc(langName(t.src))}</div>
      <button class="tr-swap" data-action="tr-swap" aria-label="Swap languages">${icon('swap', 20)}</button>
      <div class="tr-lang">${esc(langName(tl))}${l2 ? `<small> + ${esc(langName(l2))}</small>` : ''}</div>
    </div>

    <div class="tr-card">
      <textarea id="tr-input" ${t.src === 'nl' ? 'lang="nl"' : ''} dir="auto" rows="4" placeholder="${t.src === 'nl' ? 'Typ of zeg een Nederlandse zin…' : `Type or say a sentence in ${esc(hintNames)}…`}" autocomplete="off" spellcheck="false">${esc(t.text)}</textarea>
      <div class="tr-actions">
        <button class="icon-btn mic" data-action="dictate" data-target="tr-input" data-lang="${micLang}" data-mode="replace" aria-label="Speak">${icon('mic', 21)}</button>
        ${t.src !== 'nl' && ml.length > 1 ? `<button class="mic-lang" data-action="tr-mic-lang" aria-label="Microphone language">${esc(micLang.toUpperCase())}</button>` : ''}
        ${t.src === 'nl' ? `<button class="icon-btn" data-action="tr-speak-in" aria-label="Listen">${icon('volume', 20)}</button>` : ''}
        ${canPaste ? `<button class="icon-btn" data-action="tr-paste" aria-label="Paste">${icon('clipboard', 20)}</button>` : ''}
        <span class="tr-spacer"></span>
        <button class="icon-btn" data-action="tr-clear" aria-label="Clear" ${t.text ? '' : 'hidden'} id="tr-clear">${icon('x', 20)}</button>
      </div>
    </div>

    <div id="tr-out">${trOutHtml()}</div>

    ${S.trHistory.length ? `
    <div class="section-head tr-hist-head"><h3>${icon('clock', 16)} Recent</h3><button class="link" data-action="tr-clear-history">Clear</button></div>
    <div class="tr-history">
      ${S.trHistory.map((h, i) => `<button class="tr-hist" data-action="tr-load" data-i="${i}">
        <span class="tr-hist-in" dir="auto">${esc(h.text)}</span>
        <span class="tr-hist-out" dir="auto">${esc(h.out)}</span>
      </button>`).join('')}
    </div>` : ''}`;
}

function trOutHtml() {
  const t = S.tr;
  if (!t.text.trim()) {
    return `<div class="tr-tip">${icon('info', 18)}<p>Type, paste or say a sentence. Tap any Dutch word to add it to your words instantly — its translation is filled in automatically and the sentence is saved as its example.</p></div>`;
  }
  if (t.loading && !t.out) return `<div class="tr-card tr-result"><div class="sk sk2"></div><div class="sk sk3"></div></div>`;
  if (t.err && !t.out) return `<div class="tr-card tr-result"><p class="hint warn">${esc(t.err)}</p></div>`;
  const tl = t.outLang;
  const dutch = t.src === 'nl' ? t.text : t.out;
  const words = [...new Set((dutch.match(/[\p{L}][\p{L}'’-]*/gu) || []).map((w) => w.toLowerCase()))].slice(0, 40);
  return `
    <div class="tr-card tr-result ${t.loading ? 'is-loading' : ''}">
      <div class="tr-out-text" lang="${tl}" ${dirAttr(tl)}>${esc(t.out)}</div>
      ${t.out2 ? `<div class="tr-out2" lang="${t.out2Lang}" ${dirAttr(t.out2Lang)}>${esc(t.out2)}</div>` : ''}
      <div class="tr-actions">
        ${tl === 'nl' ? `<button class="icon-btn" data-action="tr-speak-out" aria-label="Listen">${icon('volume', 20)}</button>` : ''}
        <button class="icon-btn" data-action="tr-copy" aria-label="Copy">${icon('copy', 19)}</button>
      </div>
    </div>
    ${words.length ? `
    <div class="tr-words-label">Tap a Dutch word to add it to your words</div>
    <div class="alt-chips tr-words">${words.map((w) => { const have = findDuplicate(w); return `<button class="chip ${have ? 'on' : ''}" data-action="tr-add-word" data-w="${esc(w)}">${have ? '✓ ' : '+ '}${esc(w)}</button>`; }).join('')}</div>` : ''}`;
}

function renderTrOut() {
  const box = $('#tr-out');
  if (box) box.innerHTML = trOutHtml();
  const c = $('#tr-clear');
  if (c) c.hidden = !S.tr.text;
}

let trT = 0;
function onTrInput() {
  S.tr.text = $('#tr-input').value;
  clearTimeout(trT);
  if (!S.tr.text.trim()) { S.tr.out = ''; S.tr.out2 = ''; S.tr.err = ''; S.tr.loading = false; renderTrOut(); return; }
  S.tr.loading = true;
  renderTrOut();
  trT = setTimeout(runTranslate, 650);
}

async function runTranslate() {
  const t = S.tr;
  const q = t.text.trim();
  const seq = ++t.seq;
  if (!q) return;
  const tl = trTarget(), l2 = trSecond();
  t.loading = true;
  try {
    const [main, second] = await Promise.all([
      translateText(q, t.src, tl, S.tr.micLang || S.settings.lang),
      l2 ? translateText(q, t.src, l2).catch(() => '') : Promise.resolve(''),
    ]);
    if (seq !== t.seq) return;
    Object.assign(t, { out: main, out2: second, outLang: tl, out2Lang: l2, err: '' });
    addTrHistory({ src: t.src, tl, text: q, out: main, out2: second });
  } catch {
    if (seq !== t.seq) return;
    t.out = '';
    t.err = navigator.onLine ? 'Could not translate right now — try again in a moment.' : 'You’re offline — translating needs an internet connection.';
  }
  t.loading = false;
  if (S.tab === 'translate') renderTrOut();
}

let trHistT = 0;
function addTrHistory(h) {
  const list = S.trHistory;
  // while typing, the newest entry keeps growing — replace it instead of adding every step
  if (list[0] && list[0].src === h.src && (h.text.startsWith(list[0].text) || list[0].text.startsWith(h.text))) list.shift();
  const dup = list.findIndex((x) => x.src === h.src && x.text === h.text);
  if (dup >= 0) list.splice(dup, 1);
  list.unshift({ ...h, ts: Date.now() });
  S.trHistory = list.slice(0, 30);
  clearTimeout(trHistT);
  trHistT = setTimeout(() => db.setMeta('trHistory', S.trHistory).catch(() => {}), 800);
}

// ───────────────────────── sheet (bottom drawer) ─────────────────────────
// ───────────────────────── back button (Android) ─────────────────────────
// Every screen that opens on top (sheet, review, another tab) adds a browser-history entry,
// so the phone's Back button closes that screen instead of leaving the app.
let ignorePop = 0;
function pushLayer(layer) { try { history.pushState({ layer }, ''); } catch {} }
function popLayer() {
  if (history.state && history.state.layer) { ignorePop++; history.back(); }
}
addEventListener('popstate', () => {
  if (ignorePop > 0) { ignorePop--; return; }
  if ($('#sheet.open')) { closeSheet(true); return; }
  if ($('#session.open')) { closeOverlay(true); return; } // review progress is saved card by card
  if (S.tab !== 'home') { S.tab = 'home'; render(); $('#view').scrollTop = 0; }
});
function setTab(tab) {
  closeSheet();
  if (tab === S.tab) return;
  if (S.tab === 'home') pushLayer('tab');
  else if (tab === 'home') popLayer();
  S.tab = tab; render(); $('#view').scrollTop = 0;
}

function openSheet(html, opts = {}) {
  const sheet = $('#sheet');
  if (!sheet.classList.contains('open')) pushLayer('sheet');
  const body = $('#sheet-body');
  body.innerHTML = html;
  sheet.className = 'sheet open' + (opts.tall ? ' tall' : '');
  $('#scrim').classList.add('open');
  document.body.classList.add('sheet-open');
  body.scrollTop = 0;
  S.onSheetClose = opts.onClose || null;
}
function closeSheet(fromBack = false) {
  if (recog) recog.abort();
  const sheet = $('#sheet');
  if (!sheet.classList.contains('open')) return;
  if (!fromBack) popLayer();
  sheet.classList.remove('open');
  $('#scrim').classList.remove('open');
  document.body.classList.remove('sheet-open');
  S.detailId = null;
  const cb = S.onSheetClose; S.onSheetClose = null;
  if (cb) cb();
  if (document.activeElement) document.activeElement.blur();
}

// ── Add word
function openAdd(prefill = '', note = '') {
  S.add = { input: prefill, result: null, loading: false, error: '', translation: '', translationTouched: false, article: null, note, bulk: false, seq: 0 };
  openSheet(addHtml(), { onClose: () => { if (recog) recog.abort(); S.add = null; softRefresh(); } });
  const inp = $('#add-input');
  inp.value = prefill;
  inp.focus();
  if (prefill) onAddInput();
}

function addHtml() {
  const canPaste = !!(navigator.clipboard && navigator.clipboard.readText);
  return `
    <div class="sheet-head">
      <h2>Add a word</h2>
      <div class="sheet-head-actions">
        <button class="btn btn-sm btn-soft" data-action="toggle-bulk">${icon('list', 16)} Many</button>
        <button class="icon-btn" data-action="close-sheet" aria-label="Close">${icon('x', 22)}</button>
      </div>
    </div>
    <div id="add-single">
      <div class="add-field">
        <input id="add-input" type="text" lang="nl" placeholder="bijv. de gemeente" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="done">
        <button class="icon-btn mic" id="mic-btn" data-action="dictate" aria-label="Say a Dutch word">${icon('mic', 21)}</button>
        ${canPaste ? `<button class="icon-btn" data-action="paste" aria-label="Paste">${icon('clipboard', 20)}</button>` : ''}
      </div>
      <div id="add-preview"><p class="hint">Type or paste a Dutch word or phrase. The translation appears automatically — just press <b>Enter</b> to save.</p></div>
    </div>
    <div id="add-bulk" hidden>
      <textarea id="bulk-input" lang="nl" rows="8" placeholder="One word per line…&#10;de fiets&#10;gezellig&#10;afspraak maken" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"></textarea>
      <button class="btn btn-primary btn-block" data-action="bulk-add">${icon('plus', 18)} Add all</button>
      <p class="hint">Translations are fetched in the background — you can close this right away.</p>
    </div>`;
}

// ── Voice input (Dutch). A mic button's data-target names the field to fill:
//    the Add field gets a single word; note fields get whole sentences appended.
let recog = null;
function dictate(btn) {
  if (recog) { recog.stop(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const targetId = btn.dataset.target || 'add-input';
  const inp = document.getElementById(targetId);
  if (!inp) return;
  const wordMode = targetId === 'add-input';
  if (!SR) {
    inp.focus();
    toast(isIOS() ? 'Tap the 🎤 on your keyboard to dictate (switch the keyboard to Dutch first)' : 'Voice input isn’t supported in this browser — use the 🎤 on your keyboard', { ms: 5000 });
    return;
  }
  const r = new SR();
  r.lang = SPEECH_LANG[btn.dataset.lang || 'nl'] || 'nl-NL';
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  recog = r;
  btn.classList.add('listening');
  const oldPlaceholder = inp.placeholder;
  inp.placeholder = wordMode ? 'Luisteren… zeg een woord' : 'Luisteren… zeg de zin';
  const base = wordMode || btn.dataset.mode === 'replace' ? '' : inp.value.trim();
  let finalText = '';
  r.onresult = (e) => {
    let t = '';
    for (const res of e.results) t += res[0].transcript;
    t = t.trim();
    if (wordMode) {
      t = t.replace(/[.!?。]+$/, '');
      if (t && t === t[0].toUpperCase() + t.slice(1) && !/^[A-Z]{2,}/.test(t)) t = t[0].toLowerCase() + t.slice(1); // "Fiets" -> "fiets"
      inp.value = t;
    } else {
      if (t) t = t[0].toUpperCase() + t.slice(1);
      inp.value = base ? `${base} ${t}` : t;
    }
    if (e.results[e.results.length - 1].isFinal) finalText = t;
  };
  r.onerror = (e) => {
    const msg = { 'not-allowed': 'Microphone access is blocked — allow it in your browser settings', 'service-not-allowed': 'Voice input isn’t available here — use the 🎤 on your keyboard', 'no-speech': 'I didn’t hear anything — tap the mic and try again', network: 'Voice input needs an internet connection' }[e.error];
    if (e.error !== 'aborted') toast(msg || 'Voice input failed: ' + esc(e.error), { ms: 4000 });
  };
  r.onend = () => {
    recog = null;
    btn.classList.remove('listening');
    inp.placeholder = oldPlaceholder;
    if (wordMode) { if (finalText || inp.value) { onAddInput(); vibrate(10); } }
    else if (finalText) { inp.dispatchEvent(new Event('input', { bubbles: true })); vibrate(10); }
  };
  try { r.start(); vibrate(8); } catch { recog = null; btn.classList.remove('listening'); inp.placeholder = oldPlaceholder; }
}

let addT = 0;
function onAddInput() {
  const a = S.add; if (!a) return;
  a.input = $('#add-input').value;
  a.translationTouched = false; a.article = null;
  clearTimeout(addT);
  const { word } = parseInput(a.input);
  if (!word) { a.result = null; a.loading = false; renderAddPreview(); return; }
  a.loading = true;
  renderAddPreview();
  addT = setTimeout(async () => {
    const seq = ++a.seq;
    const input = a.input;
    try {
      const r = await lookup(input, S.settings.lang);
      if (!S.add || seq !== S.add.seq) return;
      a.result = r; a.error = ''; a.translation = r.translation; a.extra = '';
      const l2 = S.settings.lang2;
      if (l2 && l2 !== S.settings.lang) {
        translateTerm(r.word, r.article, l2).then((t) => {
          if (!S.add || seq !== S.add.seq) return;
          a.extra = t;
          const el = $('#add-extra');
          if (el) { el.textContent = t; el.classList.remove('sk'); }
        }).catch(() => { const el = $('#add-extra'); if (el) el.remove(); });
      }
    } catch (e) {
      if (!S.add || seq !== S.add.seq) return;
      a.result = null;
      a.error = navigator.onLine ? 'notfound' : 'offline';
    }
    a.loading = false;
    renderAddPreview();
  }, 380);
}

function renderAddPreview() {
  const a = S.add; const box = $('#add-preview'); if (!a || !box) return;
  const { word, article: typedArt } = parseInput(a.input);
  if (!word) { box.innerHTML = `<p class="hint">Type or paste a Dutch word or phrase. The translation appears automatically — just press <b>Enter</b> to save.</p>`; return; }
  const dup = findDuplicate(word);
  const dupHtml = dup ? `<button class="dup" data-action="open-detail" data-id="${dup.id}">${icon('info', 16)} Already in your list: <b>${esc(dup.word)}</b> — ${esc(dup.translation || '…')}</button>` : '';
  const r = a.result;
  const art = a.article !== null ? a.article : (r ? r.article : typedArt);
  const artSeg = `<div class="art-seg">${['', 'de', 'het'].map((x) => `<button class="${art === x ? 'on' : ''} ${x ? 'a-' + x : ''}" data-action="set-art" data-v="${x}">${x || '–'}</button>`).join('')}</div>`;

  if (a.loading && !r) {
    box.innerHTML = `${dupHtml}<div class="preview skeleton"><div class="sk sk1"></div><div class="sk sk2"></div><div class="sk sk3"></div></div>
      <button class="btn btn-primary btn-block" data-action="save-word">${icon('plus', 18)} Add “${esc(word)}”</button>`;
    return;
  }
  if (!r) {
    const msg = a.error === 'offline' ? `${icon('wifiOff', 16)} You're offline — the translation will be fetched automatically later.` : `Couldn't find a translation automatically. You can type one, or save it and we'll retry later.`;
    box.innerHTML = `${dupHtml}<div class="preview">
        <div class="pv-top">${artSeg}</div>
        <p class="hint warn">${msg}</p>
        <input id="add-translation" class="pv-input" placeholder="Translation (optional)" value="${esc(a.translation || '')}" ${dirAttr(S.settings.lang)}>
      </div>
      <button class="btn btn-primary btn-block" data-action="save-word">${icon('plus', 18)} Add “${esc(word)}”</button>`;
    return;
  }
  const chosen = meaningParts(a.translation).map(norm);
  const altTerms = [...new Set(r.alts.flatMap((x) => x.terms))].filter((t) => norm(t) !== norm(r.translation)).slice(0, 8);
  const meta = [r.pos, r.plural ? `mv. ${r.plural}` : ''].filter(Boolean).join(' · ');
  const ex = r.examples[0];
  const def = r.definitions[0];
  box.innerHTML = `${dupHtml}
    <div class="preview ${a.loading ? 'is-loading' : ''}">
      <div class="pv-top">
        ${artSeg}
        <button class="icon-btn" data-action="speak" data-text="${esc((art ? art + ' ' : '') + r.word)}" aria-label="Pronounce">${icon('volume', 20)}</button>
      </div>
      <div class="pv-word">${art ? `<span class="pv-art a-${art}">${art}</span>` : ''}${esc(r.word)}</div>
      ${meta ? `<div class="pv-meta">${esc(meta)}</div>` : ''}
      <input id="add-translation" class="pv-input big" value="${esc(a.translation)}" ${dirAttr(S.settings.lang)} aria-label="Translation">
      ${S.settings.lang2 && S.settings.lang2 !== S.settings.lang ? `<div id="add-extra" class="pv-tr2 ${a.extra ? '' : 'sk'}" ${dirAttr(S.settings.lang2)}>${esc(a.extra || '')}</div>` : ''}
      ${altTerms.length ? `<div class="alt-label">Tap to add more meanings</div><div class="alt-chips">${altTerms.map((t) => `<button class="chip ${chosen.includes(norm(t)) ? 'on' : ''}" data-action="use-alt" data-t="${esc(t)}" ${dirAttr(S.settings.lang)}>${chosen.includes(norm(t)) ? '✓ ' : '+ '}${esc(t)}</button>`).join('')}</div>` : ''}
      ${def && S.settings.lang !== 'en' ? `<div class="pv-def"><small>${esc(def.pos)}</small> ${esc(def.items[0])}</div>` : ''}
      ${def && S.settings.lang === 'en' && def.items[0] && norm(def.items[0]) !== norm(a.translation) ? `<div class="pv-def"><small>${esc(def.pos)}</small> ${esc(def.items.slice(0, 2).join('; '))}</div>` : ''}
      ${ex ? `<div class="pv-ex"><p lang="nl">${highlight(ex.nl, r.word)}</p><p class="muted" ${dirAttr(S.settings.lang)}>${esc(ex.tr)}</p></div>` : ''}
      <details class="pv-note" ${a.note ? 'open' : ''}><summary>Add a note or the sentence where you saw it</summary><div class="note-field"><textarea id="add-note" rows="2" lang="nl" placeholder="e.g. Ik heb een afspraak bij de gemeente.">${esc(a.note)}</textarea><button type="button" class="icon-btn mic" data-action="dictate" data-target="add-note" aria-label="Say the sentence">${icon('mic', 20)}</button></div></details>
    </div>
    <button class="btn btn-primary btn-block" data-action="save-word">${icon('plus', 18)} Add to my words</button>`;
}

// A translation can hold several meanings separated by commas: "municipality, town"
const meaningParts = (s) => (s || '').split(/\s*[,;،]\s*/).map((x) => x.trim()).filter(Boolean);
function toggleMeaning(current, term) {
  const parts = meaningParts(current);
  const i = parts.findIndex((p) => norm(p) === norm(term));
  if (i >= 0) parts.splice(i, 1); else parts.push(term);
  return { text: parts.join(', '), added: i < 0 };
}

function highlight(sentence, word) {
  const s = esc(sentence);
  const w = esc(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return s.replace(new RegExp(`(${w}\\w*)`, 'i'), '<mark>$1</mark>'); } catch { return s; }
}

async function saveWord() {
  const a = S.add; if (!a) return;
  a.input = $('#add-input').value;
  const { word, article: typedArt } = parseInput(a.input);
  if (!word) { $('#add-input').focus(); return; }
  const tInput = $('#add-translation');
  const noteEl = $('#add-note');
  const translation = tInput ? tInput.value.trim() : '';
  const note = noteEl ? noteEl.value.trim() : a.note;
  const r = a.result && norm(a.result.word) === norm(word) ? a.result : null;
  const art = a.article !== null ? a.article : (r ? r.article : typedArt);
  const c = makeCard({ word, article: art, translation: '', note });
  if (r) {
    applyLookup(c, r);
    c.article = art;
    if (translation) { c.userEdited = norm(translation) !== norm(r.translation); c.translation = translation; }
    if (a.extra && S.settings.lang2) c.translations = { [S.settings.lang2]: a.extra };
  } else if (translation) {
    c.translation = translation; c.userEdited = true; c.status = 'pending'; // still fetch extras
  }
  // reset for the next word right away (before any await) — keep sheet open for rapid entry
  clearTimeout(addT);
  S.add = { ...S.add, input: '', result: null, loading: false, error: '', translation: '', extra: '', note: '', article: null, seq: a.seq + 1 };
  const inp = $('#add-input'); inp.value = ''; inp.focus();
  renderAddPreview();
  S.cards.set(c.id, c);
  today().a++; saveStats();
  vibrate(12);
  toast(`Added <b>${esc(word)}</b>`, { action: 'Undo', onAction: async () => { S.cards.delete(c.id); await db.deleteCard(c.id); today().a = Math.max(0, today().a - 1); saveStats(); softRefresh(); } });
  await saveCard(c);
  prefetchAudio(c);
  if (c.status === 'pending' || needsExtra(c)) processPending();
}

async function bulkAdd() {
  const lines = $('#bulk-input').value.split(/\n|;|,(?=\s*\S)/).map((l) => l.trim()).filter(Boolean);
  let added = 0, skipped = 0;
  const toSave = [];
  for (const line of lines) {
    const { word, article } = parseInput(line);
    if (!word || findDuplicate(word) || toSave.some((x) => norm(x.word) === norm(word))) { skipped++; continue; }
    toSave.push(makeCard({ word, article }));
    added++;
  }
  for (const c of toSave) S.cards.set(c.id, c);
  await db.putCards(toSave);
  today().a += added; saveStats();
  closeSheet();
  toast(`Added ${added} word${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (duplicates)` : ''}`);
  processPending();
}

// ── Word detail
function openDetail(id) {
  const c = S.cards.get(id); if (!c) return;
  S.detailId = id;
  openSheet(detailHtml(c), { tall: true });
}
function refreshDetail() {
  const c = S.cards.get(S.detailId);
  if (c && !$('#edit-form')) $('#sheet-body').innerHTML = detailHtml(c);
}

function detailHtml(c) {
  const s = srsOf(c, 'nl');
  const st = cardStatus(c);
  const due = s && s.state !== State.New ? (s.due <= Date.now() ? 'Due now' : 'Next review ' + relTime(s.due)) : 'Not studied yet';
  const alts = (c.alts || []).filter((a) => a.terms && a.terms.length);
  return `
    <div class="sheet-head">
      <span class="status st-${st}">${STATUS_LABEL[st]}</span>
      <div class="sheet-head-actions">
        <button class="icon-btn ${c.starred ? 'starred' : ''}" data-action="star" data-id="${c.id}" aria-label="Star">${icon('star', 20)}</button>
        <button class="icon-btn" data-action="edit" data-id="${c.id}" aria-label="Edit">${icon('edit', 20)}</button>
        <button class="icon-btn" data-action="close-sheet" aria-label="Close">${icon('x', 22)}</button>
      </div>
    </div>
    <div class="detail-hero">
      <div class="d-word">${c.article ? `<span class="pv-art a-${c.article === 'het' ? 'het' : c.article === 'de' ? 'de' : 'both'}">${esc(c.article)}</span>` : ''}${esc(c.word)}</div>
      <button class="speak-big" data-action="speak-card" data-id="${c.id}" aria-label="Pronounce">${icon('volume', 24)}</button>
    </div>
    <div class="d-meta">${[c.pos, c.plural ? `mv. ${c.plural}` : ''].filter(Boolean).map((x) => `<span class="chip static">${esc(x)}</span>`).join('')}</div>
    <div class="d-translation" ${dirAttr(c.lang)}>${c.status === 'pending' && !c.translation ? '<span class="pending"><i class="spinner"></i> Translating…</span>' : esc(c.translation) || '<span class="muted">No translation yet</span>'}</div>
    ${extraHtml(c, 'd-translation2')}
    ${c.note ? `<div class="d-note">${esc(c.note)}</div>` : ''}

    ${alts.length ? (() => {
      const chosen = meaningParts(c.translation).map(norm);
      return `<div class="d-section"><h4>Other meanings <span class="h4-hint">· tap to add to the card</span></h4>${alts.map((a) => `<div class="d-alts">${a.pos ? `<small>${esc(a.pos)}</small>` : ''}<div class="alt-chips">${a.terms.map((t) => `<button class="chip ${chosen.includes(norm(t)) ? 'on' : ''}" data-action="toggle-meaning" data-id="${c.id}" data-t="${esc(t)}" ${dirAttr(c.lang)}>${chosen.includes(norm(t)) ? '✓ ' : '+ '}${esc(t)}</button>`).join('')}</div></div>`).join('')}</div>`;
    })() : ''}
    ${c.definitions && c.definitions.length ? `<div class="d-section"><h4>Dictionary</h4>${c.definitions.slice(0, 3).map((d) => `<p><small>${esc(d.pos)}</small></p><ol>${d.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>`).join('')}</div>` : ''}
    ${c.examples && c.examples.length ? `<div class="d-section"><h4>Examples</h4>${c.examples.map((e) => `<div class="ex"><button class="icon-btn sm" data-action="speak" data-text="${esc(e.nl)}" aria-label="Play">${icon('volume', 16)}</button><div><p lang="nl">${highlight(e.nl, c.word)}</p><p class="muted" ${dirAttr(c.lang)}>${esc(e.tr)}</p></div></div>`).join('')}</div>` : ''}

    <div class="d-section">
      <h4>Progress</h4>
      <div class="d-stats">
        <div><b>${s ? s.reps : 0}</b><span>reviews</span></div>
        <div><b>${s ? s.lapses : 0}</b><span>forgotten</span></div>
        <div><b>${s && s.state === State.Review ? fmtInterval(s.ivl * DAY) : '–'}</b><span>interval</span></div>
      </div>
      <p class="muted small">${due} · added ${new Date(c.createdAt).toLocaleDateString()}</p>
    </div>
    <div class="d-actions">
      <button class="btn btn-soft" data-action="refetch" data-id="${c.id}">${icon('refresh', 16)} Re-translate</button>
      <button class="btn btn-soft" data-action="reset-card" data-id="${c.id}">${icon('undo', 16)} Reset progress</button>
      <button class="btn btn-danger-soft" data-action="delete" data-id="${c.id}">${icon('trash', 16)} Delete</button>
    </div>`;
}

function relTime(ts) {
  const d = ts - Date.now();
  if (d < 3600e3) return `in ${Math.max(1, Math.round(d / 60e3))} min`;
  if (d < DAY) return `in ${Math.round(d / 3600e3)} h`;
  const days = Math.round(d / DAY);
  if (days === 1) return 'tomorrow';
  if (days < 60) return `in ${days} days`;
  return 'on ' + new Date(ts).toLocaleDateString();
}

function editHtml(c) {
  const art = c.article || '';
  return `
    <div class="sheet-head"><h2>Edit word</h2><div class="sheet-head-actions"><button class="icon-btn" data-action="open-detail" data-id="${c.id}" aria-label="Back">${icon('x', 22)}</button></div></div>
    <form id="edit-form" data-id="${c.id}" class="form">
      <label>Dutch<input name="word" value="${esc(c.word)}" lang="nl" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
      <label>Article<div class="art-seg wide">${['', 'de', 'het', 'de/het'].map((x) => `<button type="button" class="${art === x ? 'on' : ''} ${x === 'de' || x === 'het' ? 'a-' + x : ''}" data-action="form-art" data-v="${x}">${x || 'none'}</button>`).join('')}</div><input type="hidden" name="article" value="${esc(art)}"></label>
      <label>Translation<input name="translation" value="${esc(c.translation)}" ${dirAttr(c.lang)} autocomplete="off"></label>
      ${S.settings.lang2 && S.settings.lang2 !== c.lang ? `<label>${esc((LANGS[S.settings.lang2] || {}).name || S.settings.lang2)}<input name="translation2" value="${esc((c.translations || {})[S.settings.lang2] || '')}" ${dirAttr(S.settings.lang2)} autocomplete="off"></label>` : ''}
      <div class="form-2">
        <label>Plural<input name="plural" value="${esc(c.plural)}" lang="nl" autocomplete="off" autocapitalize="none"></label>
        <label>Type<input name="pos" value="${esc(c.pos)}" placeholder="noun, verb…" autocomplete="off"></label>
      </div>
      <label>Note or example sentence<div class="note-field"><textarea name="note" id="edit-note" rows="3" lang="nl">${esc(c.note)}</textarea><button type="button" class="icon-btn mic" data-action="dictate" data-target="edit-note" aria-label="Say the sentence">${icon('mic', 20)}</button></div></label>
      <button class="btn btn-primary btn-block" type="submit">${icon('check', 18)} Save</button>
    </form>`;
}

// ───────────────────────── review session ─────────────────────────
function startReview() {
  const q = buildQueue();
  // interleave new cards among reviews
  const main = [];
  const rev = [...q.reviews], nw = [...q.newItems];
  const gap = nw.length ? Math.max(1, Math.floor(rev.length / (nw.length + 1))) : 0;
  while (rev.length || nw.length) {
    for (let i = 0; i < gap && rev.length; i++) main.push(rev.shift());
    if (nw.length) main.push(nw.shift());
    if (!gap) while (rev.length) main.push(rev.shift());
  }
  const learning = q.learning.sort((a, b) => a.due - b.due);
  if (!main.length && !learning.length) { toast('Nothing due right now 🎉'); return; }
  beginSession({ mode: 'srs', queue: main, learning });
}

function beginSession({ mode, queue, learning = [], title = '' }) {
  S.session = {
    mode, title, queue, learning,
    total: queue.length + learning.length,
    done: 0, correct: 0, again: 0, startedAt: Date.now(),
    current: null, revealed: false, typed: null, undo: [],
    seen: new Set(),
  };
  if (!$('#session').classList.contains('open')) pushLayer('session');
  $('#session').classList.add('open');
  document.body.classList.add('in-session');
  nextCard();
}

function endSession(show = true) {
  const se = S.session; if (!se) return;
  S.session = null;
  if (show && se.done > 0) {
    renderSummary(se);
  } else {
    popLayer();
    $('#session').classList.remove('open');
    document.body.classList.remove('in-session');
    render();
  }
}

function pickNext() {
  const se = S.session;
  const now = Date.now();
  se.learning.sort((a, b) => a.due - b.due);
  if (se.learning.length && se.learning[0].due <= now) return se.learning.shift();
  if (se.queue.length) return se.queue.shift();
  if (se.learning.length) return se.learning.shift(); // learn ahead
  return null;
}

function nextCard() {
  const se = S.session; if (!se) return;
  let item = pickNext();
  while (item && !S.cards.get(item.id)) item = pickNext();
  if (!item) { endSession(true); return; }
  se.current = item; se.revealed = false; se.typed = null;
  renderSessionCard();
  const c = S.cards.get(item.id);
  const shouldSpeak = item.dir === 'listen' || (S.settings.autoplay && item.dir === 'nl');
  if (shouldSpeak) setTimeout(() => speakCard(c), 250);
  // warm the premium-voice cache for the next card so it plays instantly
  const nxt = se.queue[0] && S.cards.get(se.queue[0].id);
  if (nxt) prefetchAudio(nxt);
}

function sessionProgress() {
  const se = S.session;
  const left = se.queue.length + se.learning.length + (se.current ? 1 : 0);
  const pct = se.total ? Math.min(1, se.done / (se.done + left)) : 0;
  return { left, pct };
}

function renderSessionCard(opts = {}) {
  const se = S.session; const item = se.current; const c = S.cards.get(item.id);
  const { left, pct } = sessionProgress();
  const dir = item.dir;
  const lang = c.lang;
  const isCram = se.mode !== 'srs';
  const typing = (dir === 'tr' && S.settings.typeAnswers && !isCram) || se.mode === 'spell';
  const s = srsOf(c, dir) || newSrs();
  const isNew = s.state === State.New && !isCram;
  const artCls = c.article === 'het' ? 'het' : c.article === 'de' ? 'de' : 'both';

  let front;
  if (dir === 'nl') {
    front = `${c.article ? `<span class="pv-art a-${artCls}">${esc(c.article)}</span>` : ''}<div class="c-word" lang="nl">${esc(c.word)}</div>
      <button class="speak-big ghost" data-action="speak-card" data-id="${c.id}" aria-label="Pronounce">${icon('volume', 22)}</button>`;
  } else if (dir === 'listen') {
    front = `<button class="listen-btn" data-action="speak-card" data-id="${c.id}" aria-label="Play again">${icon('headphones', 44)}</button><div class="c-hint">What does it mean?</div>`;
  } else {
    front = `<div class="c-prompt">How do you say…</div><div class="c-word c-tr" ${dirAttr(lang)}>${esc(c.translation)}</div>${extraHtml(c, 'b-tr2')}
      ${c.pos ? `<div class="c-hint">${esc(c.pos)}${c.pos === 'noun' && c.article ? ' · include de/het' : ''}</div>` : ''}`;
  }

  const ex = (c.examples || [])[0];
  const back = `
    <div class="b-word" lang="nl">${c.article ? `<span class="pv-art a-${artCls}">${esc(c.article)}</span>` : ''}${esc(c.word)}
      <button class="icon-btn" data-action="speak-card" data-id="${c.id}" aria-label="Pronounce">${icon('volume', 20)}</button></div>
    ${[c.pos, c.plural ? `mv. ${c.plural}` : ''].filter(Boolean).length ? `<div class="b-meta">${esc([c.pos, c.plural ? `mv. ${c.plural}` : ''].filter(Boolean).join(' · '))}</div>` : ''}
    <div class="b-tr" ${dirAttr(lang)}>${esc(c.translation)}</div>
    ${extraHtml(c, 'b-tr2')}
    ${se.typed ? typedFeedback(se.typed) : ''}
    ${ex ? `<div class="b-ex"><p lang="nl">${highlight(ex.nl, c.word)}</p><p ${dirAttr(lang)}>${esc(ex.tr)}</p></div>` : ''}
    ${c.note ? `<div class="b-note">${esc(c.note)}</div>` : ''}`;

  const pv = isCram ? null : preview(s, Date.now(), S.settings.retention);
  const btn = (g, label, cls) => `<button class="rate ${cls} ${se.typed && se.typed.suggest === g ? 'suggest' : ''}" data-action="rate" data-g="${g}"><b>${label}</b>${pv ? `<small>${fmtInterval(pv[g])}</small>` : ''}<kbd>${g}</kbd></button>`;

  const controls = se.revealed
    ? (isCram
      ? `<div class="rates two">${btn(1, 'Again', 'r-again')}${btn(3, 'Got it', 'r-good')}</div>`
      : `<div class="rates">${btn(1, 'Again', 'r-again')}${btn(2, 'Hard', 'r-hard')}${btn(3, 'Good', 'r-good')}${btn(4, 'Easy', 'r-easy')}</div>`)
    : typing
      ? `<form class="type-form" id="type-form"><input id="type-input" lang="nl" placeholder="Type the Dutch word…" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="go"><button class="btn btn-primary" type="submit">Check</button></form><button class="link center-link" data-action="reveal">Show answer</button>`
      : `<button class="btn btn-primary btn-block btn-lg" data-action="reveal">Show answer <kbd>space</kbd></button>`;

  $('#session').innerHTML = `
    <div class="s-top">
      <button class="icon-btn" data-action="end-session" aria-label="Close">${icon('x', 24)}</button>
      <div class="s-progress"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
      <span class="s-left">${left}</span>
      <button class="icon-btn" data-action="session-edit" aria-label="Edit this word">${icon('edit', 19)}</button>
      <button class="icon-btn" data-action="session-delete" aria-label="Delete this word">${icon('trash', 19)}</button>
      <button class="icon-btn" data-action="undo-rate" aria-label="Undo" ${se.undo.length ? '' : 'disabled'}>${icon('undo', 20)}</button>
    </div>
    ${se.title ? `<div class="s-title">${esc(se.title)}</div>` : ''}
    <div class="s-stage">
      <div class="fcard ${se.revealed && !opts.flip ? 'flipped' : ''} ${se.revealed ? '' : 'enter'}" id="fcard" data-action="${se.revealed ? '' : typing ? '' : 'reveal'}">
        <div class="face front">
          ${isNew ? '<span class="badge-new">New</span>' : ''}
          ${dir === 'tr' ? '<span class="badge-dir">→ NL</span>' : dir === 'listen' ? '<span class="badge-dir">🎧</span>' : ''}
          <div class="face-body">${front}</div>
          ${!typing ? '<div class="tap-hint">Tap to reveal</div>' : ''}
        </div>
        <div class="face back"><div class="face-body">${back}</div>${se.revealed && !isCram ? '<div class="swipe-hint">← Again · Good →</div>' : ''}</div>
        <div class="swipe-tint"></div>
      </div>
    </div>
    <div class="s-controls">${controls}</div>`;

  if (typing && !se.revealed) setTimeout(() => { const i = $('#type-input'); i && i.focus(); }, 60);
  if (opts.flip) { const f = $('#fcard'); f.getBoundingClientRect(); requestAnimationFrame(() => f.classList.add('flipped')); }
  bindSwipe();
}

function typedFeedback(t) {
  const cls = t.result === 'right' ? 'ok' : t.result === 'close' ? 'close' : 'wrong';
  const label = t.result === 'right' ? 'Correct!' : t.result === 'close' ? 'Almost — check the spelling' : 'Not quite';
  return `<div class="typed ${cls}"><small>${label}${t.articleWrong ? ' · watch the article' : ''}</small><div>You wrote: <b>${esc(t.text || '—')}</b></div></div>`;
}

function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function checkTyped(c, text) {
  const { article: ta, word: tw } = parseInput(text);
  const target = norm(c.word), got = norm(tw);
  const d = lev(got, target);
  let result = got === target ? 'right' : d <= (target.length > 6 ? 2 : 1) && got.length > 1 ? 'close' : 'wrong';
  const articleWrong = !!(c.article && (c.article === 'de' || c.article === 'het') && ta && ta !== c.article);
  if (result === 'right' && articleWrong) result = 'close';
  return { text, result, articleWrong, suggest: result === 'right' ? 3 : result === 'close' ? 2 : 1 };
}

function reveal() {
  const se = S.session; if (!se || se.revealed) return;
  se.revealed = true;
  const c = S.cards.get(se.current.id);
  renderSessionCard({ flip: true });
  if (se.current.dir !== 'nl' && S.settings.autoplay) speakCard(c);
}

async function rate(g) {
  const se = S.session; if (!se || !se.revealed) return;
  const item = se.current; const c = S.cards.get(item.id);
  const t = today();
  vibrate(g === 1 ? 20 : 8);
  if (se.mode !== 'srs') {
    se.done++;
    if (g === 1) { se.again++; se.queue.splice(Math.min(se.queue.length, 3), 0, item); }
    else se.correct++;
    t.r++; saveStats();
    nextCard();
    return;
  }
  const prev = srsOf(c, item.dir);
  const before = prev ? { ...prev } : null;
  const wasNew = !prev || prev.state === State.New;
  const next = schedule(prev || newSrs(), g, Date.now(), S.settings.retention);
  c.srs = { ...(c.srs || {}), [item.dir]: next };
  se.undo.push({ item, before, wasNew, g, statsBefore: { ...t }, queueLen: se.queue.length, learningSnapshot: [...se.learning] });
  if (se.undo.length > 20) se.undo.shift();
  t.r++; if (wasNew) t.n++; if (g > 1) t.ok++;
  saveStats();
  se.done++;
  if (g === 1) se.again++; else se.correct++;
  if (next.state !== State.Review && next.due - Date.now() < 30 * MIN) se.learning.push({ id: c.id, dir: item.dir, due: next.due });
  nextCard();
  saveCard(c).catch(() => toast('Could not save — storage problem'));
}

async function undoRate() {
  const se = S.session; if (!se || !se.undo.length) return;
  const u = se.undo.pop();
  const c = S.cards.get(u.item.id); if (!c) return;
  if (se.current && !u.learningSnapshot.some((x) => x.id === se.current.id && x.dir === se.current.dir)) se.queue.unshift(se.current);
  c.srs = { ...(c.srs || {}) };
  if (u.before) c.srs[u.item.dir] = u.before; else delete c.srs[u.item.dir];
  saveCard(c);
  const t = today(); Object.assign(t, u.statsBefore); saveStats();
  se.learning = u.learningSnapshot;
  se.done = Math.max(0, se.done - 1);
  if (u.g === 1) se.again = Math.max(0, se.again - 1); else se.correct = Math.max(0, se.correct - 1);
  se.current = u.item; se.revealed = false; se.typed = null;
  renderSessionCard();
}

function renderSummary(se) {
  const mins = Math.max(1, Math.round((Date.now() - se.startedAt) / 60000));
  const acc = se.done ? Math.round((se.correct / se.done) * 100) : 0;
  const st = streak();
  const msgs = acc >= 90 ? ['Uitstekend!', 'Fantastisch!', 'Top gedaan!'] : acc >= 70 ? ['Goed bezig!', 'Lekker gewerkt!', 'Mooi zo!'] : ['Doorzetten!', 'Elke dag een beetje beter!', 'Je komt er wel!'];
  $('#session').innerHTML = `
    <div class="summary">
      <canvas id="confetti"></canvas>
      <div class="sum-emoji">${acc >= 90 ? '🏆' : acc >= 70 ? '🎉' : '💪'}</div>
      <h2>${msgs[Math.floor(Math.random() * msgs.length)]}</h2>
      <p class="muted">${se.mode === 'srs' ? 'Session complete' : esc(se.title || 'Drill complete')}</p>
      <div class="sum-stats">
        <div><b>${se.done}</b><span>cards</span></div>
        <div><b>${acc}%</b><span>correct</span></div>
        <div><b>${mins}</b><span>min</span></div>
        <div><b>${st}🔥</b><span>day streak</span></div>
      </div>
      <button class="btn btn-primary btn-block btn-lg" data-action="close-summary">Done</button>
      ${se.mode === 'srs' && dueCounts().total ? `<button class="btn btn-soft btn-block" data-action="start-review">Keep going (${dueCounts().total} more)</button>` : ''}
    </div>`;
  if (acc >= 70) confetti($('#confetti'));
}

function confetti(canvas) {
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  const W = (canvas.width = canvas.offsetWidth * devicePixelRatio), H = (canvas.height = canvas.offsetHeight * devicePixelRatio);
  const colors = ['#FF6B1A', '#21468B', '#AE1C28', '#FFB703', '#30A46C', '#ffffff'];
  const parts = Array.from({ length: 140 }, () => ({ x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.35, vx: (Math.random() - 0.5) * 18 * devicePixelRatio, vy: (-Math.random() * 16 - 6) * devicePixelRatio, r: (4 + Math.random() * 5) * devicePixelRatio, c: colors[(Math.random() * colors.length) | 0], a: Math.random() * 6, va: (Math.random() - 0.5) * 0.3 }));
  let f = 0;
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.5 * devicePixelRatio; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    }
    if (++f < 150 && canvas.isConnected) requestAnimationFrame(tick);
  })();
}

// swipe gestures on revealed card
function bindSwipe() {
  const el = $('#fcard');
  if (!el || !S.session || !S.session.revealed) return;
  let x0 = null, y0 = 0, dx = 0, active = false;
  el.onpointerdown = (e) => { if (e.target.closest('button')) return; x0 = e.clientX; y0 = e.clientY; dx = 0; active = true; el.style.transition = 'none'; };
  el.onpointermove = (e) => {
    if (!active || x0 === null) return;
    dx = e.clientX - x0;
    if (Math.abs(e.clientY - y0) > Math.abs(dx) * 1.5) return;
    el.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg) rotateY(180deg)`;
    el.dataset.swipe = dx > 40 ? 'good' : dx < -40 ? 'again' : '';
    el.style.setProperty('--tint', Math.min(1, Math.abs(dx) / 140));
  };
  const up = () => {
    if (!active) return; active = false;
    el.style.transition = '';
    if (Math.abs(dx) > 110) {
      el.style.transform = `translateX(${dx > 0 ? 600 : -600}px) rotate(${dx > 0 ? 20 : -20}deg) rotateY(180deg)`;
      const g = dx > 0 ? 3 : 1;
      setTimeout(() => rate(g), 160);
    } else { el.style.transform = ''; el.dataset.swipe = ''; }
    x0 = null;
  };
  el.onpointerup = up; el.onpointercancel = up; el.onpointerleave = up;
}

// ── drills (cram — no scheduling impact)
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startDrill(kind) {
  const ready = [...S.cards.values()].filter(isReady);
  if (kind === 'dehet') return startDeHet();
  let pick, dir = 'nl', mode = 'cram', title = '';
  if (kind === 'weak') {
    pick = ready.sort((a, b) => {
      const sa = srsOf(a, 'nl'), sb = srsOf(b, 'nl');
      const wa = sa ? sa.lapses * 3 + sa.d - Math.log1p(sa.s) : 5, wb = sb ? sb.lapses * 3 + sb.d - Math.log1p(sb.s) : 5;
      return wb - wa;
    }).slice(0, 20);
    title = 'Tricky words';
  } else if (kind === 'spell') { pick = shuffle(ready).slice(0, 15); dir = 'tr'; mode = 'spell'; title = 'Spelling'; }
  else if (kind === 'listen') { pick = shuffle(ready).slice(0, 20); dir = 'listen'; title = 'Listening'; }
  else { pick = shuffle(ready).slice(0, 20); title = 'Shuffle'; }
  if (!pick.length) { toast('Add some words first'); return; }
  beginSession({ mode, queue: pick.map((c) => ({ id: c.id, dir })), title });
}

// de/het game
function startDeHet() {
  const mine = [...S.cards.values()].filter((c) => (c.article === 'de' || c.article === 'het') && !/\s/.test(c.word)).map((c) => ({ word: c.word, article: c.article, en: c.translation, lang: c.lang }));
  let pool = mine.length >= 12 ? mine : [...mine, ...BUILTIN_NOUNS.filter((b) => !mine.some((m) => norm(m.word) === norm(b.word))).map((b) => ({ word: b.word, article: b.article, en: b.en, lang: 'en' }))];
  pool = shuffle(pool).slice(0, 20);
  S.dehet = { pool, i: 0, right: 0, streak: 0, best: 0, answered: null, startedAt: Date.now(), wrong: [] };
  if (!$('#session').classList.contains('open')) pushLayer('session');
  $('#session').classList.add('open');
  document.body.classList.add('in-session');
  renderDeHet();
}

function renderDeHet() {
  const g = S.dehet;
  if (g.i >= g.pool.length) {
    const acc = Math.round((g.right / g.pool.length) * 100);
    $('#session').innerHTML = `<div class="summary"><canvas id="confetti"></canvas>
      <div class="sum-emoji">${acc >= 90 ? '🏆' : acc >= 70 ? '🎉' : '💪'}</div>
      <h2>${g.right} / ${g.pool.length} goed</h2>
      <p class="muted">Best streak: ${g.best}</p>
      ${g.wrong.length ? `<div class="dh-wrong"><h4>Review these</h4>${g.wrong.map((w) => `<div>${articleHtml(w.article)} ${esc(w.word)} <span class="muted" ${dirAttr(w.lang)}>${esc(w.en)}</span></div>`).join('')}</div>` : ''}
      <div class="tip small">${icon('info', 18)}<p><b>Rules of thumb:</b> diminutives (-je) are always <b>het</b>; words ending in -heid, -ing, -tie, -teit, -schap (abstract) are <b>de</b>; infinitives used as nouns (het eten) are <b>het</b>; about 2/3 of nouns are <b>de</b>.</p></div>
      <button class="btn btn-primary btn-block btn-lg" data-action="dehet-again">Play again</button>
      <button class="btn btn-soft btn-block" data-action="close-summary">Done</button></div>`;
    today().r += g.pool.length; saveStats();
    if (acc >= 70) confetti($('#confetti'));
    return;
  }
  const w = g.pool[g.i];
  const ans = g.answered;
  $('#session').innerHTML = `
    <div class="s-top">
      <button class="icon-btn" data-action="end-dehet" aria-label="Close">${icon('x', 24)}</button>
      <div class="s-progress"><i style="width:${(g.i / g.pool.length) * 100}%"></i></div>
      <span class="s-left">${g.streak ? `🔥${g.streak}` : g.i + 1 + '/' + g.pool.length}</span>
    </div>
    <div class="s-title">de of het?</div>
    <div class="s-stage">
      <div class="dh-card ${ans ? (ans.ok ? 'ok' : 'bad') : ''}">
        <div class="dh-art">${ans ? `<span class="pv-art a-${w.article} big">${w.article}</span>` : '<span class="dh-blank">___</span>'}</div>
        <div class="c-word" lang="nl">${esc(w.word)}</div>
        <div class="muted" ${dirAttr(w.lang)}>${esc(w.en || '')}</div>
      </div>
    </div>
    <div class="s-controls">
      <div class="dh-btns">
        <button class="dh-btn a-de ${ans && w.article === 'de' ? 'correct' : ''} ${ans && ans.pick === 'de' && !ans.ok ? 'wrong' : ''}" data-action="dehet" data-v="de">de<kbd>←</kbd></button>
        <button class="dh-btn a-het ${ans && w.article === 'het' ? 'correct' : ''} ${ans && ans.pick === 'het' && !ans.ok ? 'wrong' : ''}" data-action="dehet" data-v="het">het<kbd>→</kbd></button>
      </div>
    </div>`;
}

function answerDeHet(v) {
  const g = S.dehet; if (!g || g.answered || g.i >= g.pool.length) return;
  const w = g.pool[g.i];
  const ok = v === w.article;
  g.answered = { ok, pick: v };
  if (ok) { g.right++; g.streak++; g.best = Math.max(g.best, g.streak); vibrate(8); }
  else { g.streak = 0; g.wrong.push(w); vibrate([30, 40, 30]); }
  renderDeHet();
  speak(`${w.article} ${w.word}`);
  setTimeout(() => { if (S.dehet === g) { g.answered = null; g.i++; renderDeHet(); } }, ok ? 650 : 1400);
}

function closeOverlay(fromBack = false) {
  if (!fromBack && $('#session').classList.contains('open')) popLayer();
  S.session = null; S.dehet = null;
  $('#session').classList.remove('open');
  document.body.classList.remove('in-session');
  render();
}

// ───────────────────────── data import/export ─────────────────────────
async function exportData() {
  const data = { app: 'woordje', version: 1, exportedAt: new Date().toISOString(), settings: S.settings, stats: S.stats, cards: [...S.cards.values()] };
  const json = JSON.stringify(data);
  const name = `woordje-backup-${dayKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /android|iphone|ipad/i.test(navigator.userAgent)) {
      await navigator.share({ files: [file], title: 'Woordje backup' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    S.settings.lastBackup = Date.now(); saveSettings();
    toast(`Backup saved · ${S.cards.size} words`);
    if (S.tab !== 'session') softRefresh();
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('Export failed');
  }
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.cards)) throw new Error('bad');
    let added = 0, updated = 0;
    const toSave = [];
    for (const c of data.cards) {
      if (!c || !c.id || !c.word) continue;
      const existing = S.cards.get(c.id) || findDuplicate(c.word);
      if (existing) {
        if ((c.updatedAt || 0) > (existing.updatedAt || 0)) { const merged = { ...c, id: existing.id }; S.cards.set(existing.id, merged); toSave.push(merged); updated++; }
      } else { S.cards.set(c.id, c); toSave.push(c); added++; }
    }
    await db.putCards(toSave);
    if (data.stats && data.stats.days) {
      for (const [k, v] of Object.entries(data.stats.days)) {
        const cur = S.stats.days[k];
        if (!cur || (v.r || 0) > (cur.r || 0)) S.stats.days[k] = v;
      }
      saveStats();
    }
    toast(`Imported: ${added} new, ${updated} updated`);
    render();
  } catch {
    toast('That file is not a valid Woordje backup');
  }
}

async function addPack(key) {
  const p = PACKS[key]; if (!p) return;
  const toSave = [];
  const base = Date.now();
  p.items.forEach((it, i) => {
    if (findDuplicate(it.word) || toSave.some((x) => norm(x.word) === norm(it.word))) return;
    const c = makeCard({ word: it.word, article: it.article, translation: S.settings.lang === 'en' ? it.en : '', tags: [it.tag] });
    c.pos = it.pos; c.createdAt = base - (p.items.length - i); c.userEdited = S.settings.lang === 'en';
    // fetch examples/plurals (and translation for non-English) in the background
    c.status = 'pending';
    toSave.push(c);
  });
  for (const c of toSave) S.cards.set(c.id, c);
  await db.putCards(toSave);
  S.settings.installedPacks = [...new Set([...S.settings.installedPacks, key])];
  saveSettings();
  toast(`Added ${toSave.length} words from “${p.title}”`);
  render();
  processPending();
}

// ───────────────────────── install ─────────────────────────
function showInstall() {
  if (isStandalone()) { toast('Woordje is already installed ✓'); return; }
  if (S.deferredInstall) {
    S.deferredInstall.prompt();
    S.deferredInstall.userChoice.finally(() => { S.deferredInstall = null; });
    return;
  }
  const ios = isIOS();
  openSheet(`
    <div class="sheet-head"><h2>Install Woordje</h2><div class="sheet-head-actions"><button class="icon-btn" data-action="close-sheet" aria-label="Close">${icon('x', 22)}</button></div></div>
    <div class="install-steps">
      ${ios ? `
        <div class="step"><span>1</span><p>Open this page in <b>Safari</b>.</p></div>
        <div class="step"><span>2</span><p>Tap the <b>Share</b> button ${icon('share', 18)} at the bottom of the screen.</p></div>
        <div class="step"><span>3</span><p>Scroll down and tap <b>Add to Home Screen</b>.</p></div>
        <div class="step"><span>4</span><p>Open Woordje from your home screen — it runs full-screen and works offline.</p></div>` : `
        <div class="step"><span>1</span><p>Open this page in <b>Chrome</b>.</p></div>
        <div class="step"><span>2</span><p>Tap the <b>⋮</b> menu in the top-right corner.</p></div>
        <div class="step"><span>3</span><p>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</p></div>
        <div class="step"><span>4</span><p>Bonus on Android: select a word in any app → <b>Share</b> → <b>Woordje</b> to add it instantly.</p></div>`}
    </div>`);
}

// ───────────────────────── events ─────────────────────────
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (!a) return;
  const id = el.dataset.id;
  switch (a) {
    case 'goto':
      setTab(el.dataset.tab);
      if (el.dataset.scroll) setTimeout(() => { const t = document.getElementById(el.dataset.scroll); t && t.scrollIntoView({ behavior: 'smooth' }); }, 50);
      break;
    case 'open-add': openAdd(el.dataset.prefill || ''); break;
    case 'close-sheet': closeSheet(); break;
    case 'dictate': dictate(el); break;
    case 'tr-swap': {
      const t = S.tr;
      const newSrc = t.src === 'nl' ? 'auto' : 'nl';
      if (t.out) t.text = t.out; // continue with the result, like Google Translate
      Object.assign(t, { src: newSrc, out: '', out2: '', err: '' });
      render(true);
      if (t.text.trim()) { t.loading = true; renderTrOut(); runTranslate(); }
      break;
    }
    case 'tr-clear': {
      Object.assign(S.tr, { text: '', out: '', out2: '', err: '', loading: false });
      const i = $('#tr-input'); if (i) { i.value = ''; i.focus(); }
      renderTrOut(); break;
    }
    case 'tr-paste':
      try { const t = (await navigator.clipboard.readText()).trim(); if (t) { $('#tr-input').value = t; onTrInput(); } } catch { toast('Paste was blocked — long-press the box to paste'); }
      break;
    case 'tr-speak-in': speak(S.tr.text.trim()); break;
    case 'tr-speak-out': speak(S.tr.out); break;
    case 'tr-copy': {
      const txt = [S.tr.out, S.tr.out2].filter(Boolean).join('\n');
      try { await navigator.clipboard.writeText(txt); toast('Copied'); } catch { toast('Copy was blocked'); }
      break;
    }
    case 'tr-add-word': {
      const w = el.dataset.w;
      const have = findDuplicate(w);
      if (have) { openDetail(have.id); break; }
      // Add straight away: translation, de/het, Persian etc. are filled in the background
      const sentence = (S.tr.src === 'nl' ? S.tr.text : S.tr.out).trim();
      // if the sentence says "de bank" / "het huis", take that article
      const m = sentence.match(new RegExp(`(?:^|[^\\p{L}])(de|het)\\s+${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu'));
      const c = makeCard({ word: w, article: m ? m[1].toLowerCase() : '', note: sentence.length <= 300 ? sentence : '' });
      c.userEdited = false;
      S.cards.set(c.id, c);
      today().a++; saveStats();
      el.classList.add('on'); el.textContent = '✓ ' + w;
      vibrate(12);
      toast(`Added <b>${esc(w)}</b> — translating…`, { action: 'Undo', onAction: async () => { S.cards.delete(c.id); await db.deleteCard(c.id); today().a = Math.max(0, today().a - 1); saveStats(); renderTrOut(); } });
      await saveCard(c);
      processPending();
      break;
    }
    case 'tr-load': {
      const h = S.trHistory[+el.dataset.i]; if (!h) break;
      Object.assign(S.tr, { src: h.src, text: h.text, out: h.out, out2: h.out2 || '', outLang: h.tl, out2Lang: h.src === 'nl' ? S.settings.lang2 : '', err: '', loading: false });
      render(true); $('#view').scrollTop = 0; break;
    }
    case 'tr-mic-lang': { const ml = micLangs(); S.tr.micLang = ml[(ml.indexOf(S.tr.micLang) + 1) % ml.length]; render(true); break; }
    case 'tr-clear-history': S.trHistory = []; db.setMeta('trHistory', []).catch(() => {}); render(true); break;
    case 'paste':
      try { const t = (await navigator.clipboard.readText()).trim().split('\n')[0].slice(0, 80); if (t) { $('#add-input').value = t; onAddInput(); } } catch { toast('Paste was blocked — long-press the field to paste'); }
      break;
    case 'toggle-bulk': {
      S.add.bulk = !S.add.bulk;
      $('#add-single').hidden = S.add.bulk; $('#add-bulk').hidden = !S.add.bulk;
      el.innerHTML = S.add.bulk ? `${icon('plus', 16)} One` : `${icon('list', 16)} Many`;
      (S.add.bulk ? $('#bulk-input') : $('#add-input')).focus();
      break;
    }
    case 'bulk-add': bulkAdd(); break;
    case 'set-art': if (S.add) { S.add.article = el.dataset.v; const t = $('#add-translation'); if (t) S.add.translation = t.value; const n = $('#add-note'); if (n) S.add.note = n.value; renderAddPreview(); } break;
    case 'use-alt': {
      const t = $('#add-translation'); if (!t) break;
      const { text, added } = toggleMeaning(t.value, el.dataset.t);
      t.value = text; S.add.translation = text; S.add.translationTouched = true;
      el.classList.toggle('on', added); el.textContent = (added ? '✓ ' : '+ ') + el.dataset.t;
      vibrate(5); break;
    }
    case 'toggle-meaning': {
      const c = S.cards.get(id); if (!c) break;
      const { text, added } = toggleMeaning(c.translation, el.dataset.t);
      if (!text) { toast('Keep at least one meaning'); break; }
      c.translation = text; c.userEdited = true;
      await saveCard(c); refreshDetail(); vibrate(5);
      toast(added ? `Added “${esc(el.dataset.t)}”` : `Removed “${esc(el.dataset.t)}”`);
      break;
    }
    case 'save-word': saveWord(); break;
    case 'speak': speak(el.dataset.text); break;
    case 'speak-card': e.stopPropagation(); { const c = S.cards.get(id); if (c) speakCard(c); } break;
    case 'open-detail': openDetail(id); break;
    case 'star': { const c = S.cards.get(id); c.starred = !c.starred; await saveCard(c); refreshDetail(); vibrate(5); break; }
    case 'edit': { const c = S.cards.get(id); $('#sheet-body').innerHTML = editHtml(c); break; }
    case 'form-art': { const f = $('#edit-form'); f.article.value = el.dataset.v; $$('.art-seg button', f).forEach((b) => b.classList.toggle('on', b === el)); break; }
    case 'delete': {
      const c = S.cards.get(id); if (!c) break;
      S.cards.delete(id); await db.deleteCard(id); closeSheet(); render();
      toast(`Deleted <b>${esc(c.word)}</b>`, { action: 'Undo', onAction: async () => { await saveCard(c); render(); } });
      break;
    }
    case 'reset-card': {
      const c = S.cards.get(id); const prevSrs = c.srs; c.srs = {}; await saveCard(c); refreshDetail();
      toast('Progress reset', { action: 'Undo', onAction: async () => { c.srs = prevSrs; await saveCard(c); refreshDetail(); } });
      break;
    }
    case 'refetch': {
      const c = S.cards.get(id); el.disabled = true; el.innerHTML = `<i class="spinner"></i> Fetching…`;
      try { const r = await lookup((c.article ? c.article + ' ' : '') + c.word, S.settings.lang); c.userEdited = false; c.translation = ''; applyLookup(c, r); c.translations = {}; c.xTries = 0; await saveCard(c); toast('Updated'); processPending(); }
      catch { toast(navigator.onLine ? 'No translation found' : 'You are offline'); }
      refreshDetail(); break;
    }
    case 'filter': S.words.filter = el.dataset.f; $$('.chips .chip').forEach((c) => c.classList.toggle('on', c === el)); renderWordList(); break;
    case 'start-review': if (S.dehet) S.dehet = null; startReview(); break;
    case 'learn-more': S.settings.newPerDay += 5; saveSettings(); startReview(); toast('Daily new-word limit raised by 5'); break;
    case 'reveal': reveal(); break;
    case 'rate': rate(+el.dataset.g); break;
    case 'undo-rate': undoRate(); break;
    case 'session-delete': {
      const se = S.session; if (!se || !se.current) break;
      const c = S.cards.get(se.current.id); if (!c) break;
      if (!confirm(`Delete “${c.word}” from your words?`)) break;
      const drop = (x) => x.id !== c.id;
      se.queue = se.queue.filter(drop); se.learning = se.learning.filter(drop); se.undo = se.undo.filter((u) => u.item.id !== c.id);
      S.cards.delete(c.id); await db.deleteCard(c.id);
      toast(`Deleted <b>${esc(c.word)}</b>`, { action: 'Undo', onAction: async () => { await saveCard(c); } });
      nextCard();
      break;
    }
    case 'session-edit': {
      const se = S.session; if (!se || !se.current) break;
      const c = S.cards.get(se.current.id); if (!c) break;
      openSheet(editHtml(c), {
        onClose: () => {
          const s2 = S.session; if (!s2 || !s2.current) return;
          if (S.cards.get(s2.current.id)) renderSessionCard({}); else nextCard(); // deleted from the sheet
        },
      });
      break;
    }
    case 'end-session': endSession(S.session && S.session.done > 0); break;
    case 'close-summary': closeOverlay(); break;
    case 'drill-dehet': startDrill('dehet'); break;
    case 'drill-weak': startDrill('weak'); break;
    case 'drill-spell': startDrill('spell'); break;
    case 'drill-listen': startDrill('listen'); break;
    case 'drill-random': startDrill('random'); break;
    case 'dehet': answerDeHet(el.dataset.v); break;
    case 'dehet-again': startDeHet(); break;
    case 'end-dehet': closeOverlay(); break;
    case 'step': {
      const k = el.dataset.key; const v = Math.min(+el.dataset.max, Math.max(+el.dataset.min, S.settings[k] + +el.dataset.d));
      S.settings[k] = v; saveSettings(); el.parentElement.querySelector('output').textContent = v; break;
    }
    case 'seg': {
      const k = el.dataset.key; let v = el.dataset.v; if (k === 'retention') v = +v;
      S.settings[k] = v; saveSettings(); $$('button', el.parentElement).forEach((b) => b.classList.toggle('on', b === el));
      if (k === 'theme') applyTheme();
      if (k === 'voiceEngine') render(true);
      if (k === 'elModel') speak('Goedemorgen! Hoe gaat het met je?');
      break;
    }
    case 'test-voice': speak('Goedemorgen! Hoe gaat het met je?'); break;
    case 'el-save-key': {
      const v = ($('#el-key').value || '').trim();
      if (!v) { toast('Paste your ElevenLabs API key first'); break; }
      S.elKey = v; await db.setMeta('elKey', v);
      S.elVoices = null; toast('API key saved on this phone'); render(true);
      break;
    }
    case 'el-load-voices': S.elVoices = null; render(true); break;
    case 'el-save-voice': {
      const v = ($('#el-voice-id').value || '').trim(); if (!v) break;
      S.settings.elVoice = v; S.settings.elVoiceName = v; saveSettings(); speak('Goedemorgen! Hoe gaat het met je?'); render(true);
      break;
    }
    case 'el-clear-cache': await db.clearAudio().catch(() => {}); toast('Saved audio cleared'); break;
    case 'add-pack': el.disabled = true; addPack(el.dataset.pack); break;
    case 'retry-failed': {
      for (const c of S.cards.values()) if (c.status === 'failed') { c.status = 'pending'; c.tries = 0; await saveCard(c); }
      toast('Retrying…'); render(); processPending(); break;
    }
    case 'export': exportData(); break;
    case 'install': showInstall(); break;
    case 'reset-all': {
      if (!confirm('Delete ALL words and progress? This cannot be undone.\n\nTip: export a backup first.')) break;
      if (!confirm('Are you absolutely sure?')) break;
      await db.clearCards(); S.cards.clear(); S.stats = { days: {} }; await db.setMeta('stats', S.stats);
      S.settings.installedPacks = []; saveSettings(); render(); toast('All data deleted'); break;
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'add-input') onAddInput();
  else if (t.id === 'add-translation' && S.add) { S.add.translation = t.value; S.add.translationTouched = true; }
  else if (t.id === 'add-note' && S.add) S.add.note = t.value;
  else if (t.id === 'tr-input') onTrInput();
  else if (t.id === 'word-search') { S.words.q = t.value; renderWordList(); }
  else if (t.dataset.setting === 'rate') { S.settings.rate = +t.value; saveSettings(); }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'word-sort') { S.words.sort = t.value; renderWordList(); }
  else if (t.id === 'import-file' && t.files[0]) { importData(t.files[0]); t.value = ''; }
  else if (t.dataset.setting) {
    const k = t.dataset.setting;
    if (t.type === 'checkbox') S.settings[k] = t.checked;
    else if (k === 'rate') S.settings[k] = +t.value;
    else S.settings[k] = t.value;
    if (k === 'elVoice') { S.settings.elVoiceName = (t.selectedOptions[0] || {}).textContent || ''; speak('Goedemorgen! Hoe gaat het met je?'); }
    if (k === 'lang' && S.settings.lang2 === S.settings.lang) S.settings.lang2 = '';
    saveSettings();
    if (k === 'lang') render(true);
    if (k === 'lang2') {
      render(true);
      const n = [...S.cards.values()].filter(needsExtra).length;
      if (n) toast(`Adding ${esc((LANGS[S.settings.lang2] || {}).name || '')} to ${n} word${n > 1 ? 's' : ''}…`);
      processPending();
    }
    if (k === 'rate') speak('Goed zo', S.settings.rate);
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'type-form') {
    const se = S.session; if (!se) return;
    const c = S.cards.get(se.current.id);
    se.typed = checkTyped(c, $('#type-input').value);
    reveal();
    if (se.typed.result === 'right') vibrate(10); else vibrate([20, 30, 20]);
  } else if (f.id === 'edit-form') {
    const c = S.cards.get(f.dataset.id); if (!c) return;
    const fd = new FormData(f);
    const tr = fd.get('translation').trim();
    if (tr !== c.translation) c.userEdited = true;
    Object.assign(c, { word: fd.get('word').trim() || c.word, article: fd.get('article'), translation: tr, plural: fd.get('plural').trim(), pos: fd.get('pos').trim(), note: fd.get('note').trim() });
    if (c.translation) c.status = 'ok';
    if (fd.has('translation2')) c.translations = { ...(c.translations || {}), [S.settings.lang2]: fd.get('translation2').trim() };
    await saveCard(c);
    toast('Saved');
    if (S.session) { closeSheet(); return; } // edited during a review: back to the card
    $('#sheet-body').innerHTML = detailHtml(c);
    render();
  }
});

document.addEventListener('keydown', (e) => {
  const inField = /INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || '');
  if (e.key === 'Enter' && e.target.id === 'add-input') { e.preventDefault(); saveWord(); return; }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.id === 'bulk-input') { e.preventDefault(); bulkAdd(); return; }
  if (S.dehet && !inField) {
    if (e.key === 'ArrowLeft' || e.key === 'd') answerDeHet('de');
    else if (e.key === 'ArrowRight' || e.key === 'h') answerDeHet('het');
    else if (e.key === 'Escape') closeOverlay();
    return;
  }
  if (S.session) {
    if ($('#sheet.open')) { if (e.key === 'Escape') closeSheet(); return; }
    if (inField) return;
    if ((e.key === ' ' || e.key === 'Enter') && !S.session.revealed) { e.preventDefault(); reveal(); }
    else if (/^[1-4]$/.test(e.key) && S.session.revealed) { if (S.session.mode !== 'srs' && (e.key === '2' || e.key === '4')) return; rate(+e.key); }
    else if (e.key === ' ' && S.session.revealed) { e.preventDefault(); rate(3); }
    else if (e.key === 'z' || (e.key === 'z' && e.ctrlKey)) undoRate();
    else if (e.key === 'Escape') endSession(S.session.done > 0);
    else if (e.key === 'r' || e.key === 'p') { const c = S.cards.get(S.session.current.id); speakCard(c); }
    return;
  }
  if ($('#session.open')) { if (e.key === 'Escape' || e.key === 'Enter') closeOverlay(); return; }
  if (e.key === 'Escape') { closeSheet(); return; }
  if (!inField && !$('#sheet.open') && (e.key === 'n' || e.key === 'a' || e.key === '+')) { e.preventDefault(); openAdd(); }
});

// sheet drag-to-dismiss
(function sheetDrag() {
  const sheet = $('#sheet'); const grab = $('#sheet-grab');
  let y0 = null, dy = 0;
  const start = (e) => { y0 = e.touches ? e.touches[0].clientY : e.clientY; dy = 0; sheet.style.transition = 'none'; };
  const move = (e) => { if (y0 === null) return; dy = Math.max(0, (e.touches ? e.touches[0].clientY : e.clientY) - y0); sheet.style.transform = `translate(-50%, ${dy}px)`; };
  const end = () => { if (y0 === null) return; y0 = null; sheet.style.transition = ''; sheet.style.transform = ''; if (dy > 90) closeSheet(); };
  grab.addEventListener('touchstart', start, { passive: true });
  grab.addEventListener('touchmove', move, { passive: true });
  grab.addEventListener('touchend', end);
  grab.addEventListener('mousedown', (e) => { start(e); const mm = (ev) => move(ev); const mu = () => { end(); removeEventListener('mousemove', mm); removeEventListener('mouseup', mu); }; addEventListener('mousemove', mm); addEventListener('mouseup', mu); });
  $('#scrim').addEventListener('click', closeSheet);
})();

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  if (t.dataset.tab === 'add') { openAdd(); return; }
  if (S.tab === t.dataset.tab) { $('#view').scrollTo({ top: 0, behavior: 'smooth' }); return; }
  setTab(t.dataset.tab);
}));

// ───────────────────────── theme ─────────────────────────
function applyTheme() {
  const t = S.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#0B0D12' : '#F5F4F0');
}

// ───────────────────────── boot ─────────────────────────
async function boot() {
  try {
    const [cards, settings, stats, elKey] = await Promise.all([db.allCards(), db.getMeta('settings'), db.getMeta('stats'), db.getMeta('elKey')]);
    S.elKey = elKey || '';
    try { S.trHistory = (await db.getMeta('trHistory')) || []; } catch {}
    for (const c of cards || []) S.cards.set(c.id, c);
    S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    S.stats = stats && stats.days ? stats : { days: {} };
  } catch (e) {
    console.error(e);
    toast('Storage unavailable — words may not be saved (private browsing?)', { ms: 6000 });
  }
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  pickVoice();
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { pickVoice(); if (S.tab === 'settings') softRefresh(); });

  // Handle shared text (Android share target) or ?add= links
  const params = new URLSearchParams(location.search);
  const shared = params.get('text') || params.get('title') || params.get('add') || '';
  const tab = params.get('tab');
  if (tab && ['home', 'words', 'practice', 'translate', 'settings'].includes(tab)) S.tab = tab;
  render();
  if (params.get('review') !== null) startReview();
  if (shared || params.has('add')) {
    history.replaceState(null, '', location.pathname);
    openAdd(shared.replace(/https?:\/\/\S+/g, '').trim().split('\n')[0].slice(0, 80));
  } else if (params.toString()) history.replaceState(null, '', location.pathname);

  document.body.classList.add('ready');
  requestPersistence().then((ok) => { const el = $('#storage-info'); if (el && ok) el.textContent = 'Your words are stored privately on this device (persistent storage on).'; });
  processPending();
  addEventListener('online', processPending);
  addEventListener('offline', () => toast(`${icon('wifiOff', 16)} Offline — you can still review and add words`));

  // refresh due counts when coming back to the app
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !S.session && !$('#session.open') && !$('#sheet.open')) render(true); });
}

addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.deferredInstall = e; });
addEventListener('appinstalled', () => { S.deferredInstall = null; toast('Woordje installed 🎉'); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    // check for updates whenever the app comes back to the foreground
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (S.session || $('#session.open')) return; // don't interrupt a review
    toast('Woordje was updated ✨', { action: 'Reload', ms: 10000, onAction: () => location.reload() });
  });
}

boot();
