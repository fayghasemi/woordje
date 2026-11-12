# Woordje — Dutch flashcards for the inburgering exam

A fast, offline-capable flashcard app (PWA) for collecting Dutch words as you meet them.
You type a word, and the app fills in the rest by itself.

## What it does
- **One-step adding**: type a word and press Enter. The translation, **de/het**, plural, part of speech, dictionary
  meanings and real example sentences are fetched automatically. You can keep typing the next word right away.
  You can also paste a whole list ("Many"), or on Android share a word from any app straight into Woordje.
- **Smart reviews (FSRS-5)**: the same scheduling algorithm modern Anki uses. It shows each word just before you would forget it.
- **Card types**: Dutch → your language (always on), your language → Dutch (with typed answers), and Listening.
- **Drills that don't affect your schedule**: *de of het?* game, Tricky words, Spelling, Listening and Shuffle.
- **Pronunciation**: uses the phone's Dutch voice, or Google's online Dutch voice as a fallback.
- **Starter packs**: KNM essentials (government, health, work, housing) and A2 everyday nouns.
- **Translate into** English, Persian, Arabic, Turkish, Ukrainian and 10 more languages.
- Streaks, daily goal ring, activity heatmap, dark mode, and works offline.
- Your data stays **on your phone** (IndexedDB). Use **Settings → Export backup** now and then.

## Free services used (no keys, no accounts)
Google Translate (public endpoint) with MyMemory as the fallback, Wiktionary (CC BY-SA) and Tatoeba (CC BY 2.0 FR).

## Put it on your phone
The app is a static website. It has to be served over **HTTPS** before a phone can install it.
Any free static host works:

**GitHub Pages**
1. Create a free GitHub account, then a new public repository (for example `woordje`).
2. Upload every file in this folder except `.claude/` (for example with *Add file → Upload files*).
3. Go to *Settings → Pages → Deploy from branch → main / root*.
4. After about a minute, the app is live at `https://<username>.github.io/woordje/`.

**Netlify Drop** (alternative): go to app.netlify.com/drop and drag this folder onto the page.

Then open the URL on your phone:
- **iPhone**: open it in Safari, tap Share, then **Add to Home Screen**.
- **Android**: open it in Chrome, tap the ⋮ menu, then **Install app**.

## Updating
After you change any file, bump `CACHE` in `sw.js` (for example `woordje-v1.0.1`) and upload again.
The app then offers a "Reload" button to pick up the new version.

## Run locally
```
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```
Then open http://localhost:5173.
