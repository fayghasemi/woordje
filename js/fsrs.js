// FSRS-5 spaced-repetition scheduler (the algorithm modern Anki uses).
// States: 0 = new, 1 = learning, 2 = review, 3 = relearning
// Ratings: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy

const W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const MAX_IVL = 3650;

export const State = { New: 0, Learning: 1, Review: 2, Relearning: 3 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function newSrs() {
  return { state: 0, due: 0, s: 0, d: 0, reps: 0, lapses: 0, last: 0, ivl: 0 };
}

export function retrievability(elapsedDays, s) {
  if (s <= 0) return 0;
  return Math.pow(1 + (FACTOR * elapsedDays) / s, DECAY);
}

const initS = (g) => Math.max(W[g - 1], 0.1);
const initD = (g) => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);

function nextD(d, g) {
  const delta = -W[6] * (g - 3);
  const dp = d + (delta * (10 - d)) / 9; // linear damping
  return clamp(W[7] * initD(4) + (1 - W[7]) * dp, 1, 10); // mean reversion
}

function recallS(d, s, r, g) {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return (
    s *
    (1 +
      Math.exp(W[8]) *
        (11 - d) *
        Math.pow(s, -W[9]) *
        (Math.exp((1 - r) * W[10]) - 1) *
        hard *
        easy)
  );
}

function forgetS(d, s, r) {
  const sf = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  return Math.min(sf, s);
}

const shortTermS = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

function intervalDays(s, retention, fuzz = true) {
  let ivl = (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  ivl = Math.round(ivl);
  if (fuzz && ivl >= 3) {
    const f = Math.max(1, Math.round(ivl * 0.05));
    ivl += Math.round((Math.random() * 2 - 1) * f);
  }
  return clamp(ivl, 1, MAX_IVL);
}

/**
 * Returns the new SRS record after answering with rating g at time `now`.
 * Does not mutate the input.
 */
export function schedule(srs, g, now = Date.now(), retention = 0.9, fuzz = true) {
  const c = { ...srs };
  const elapsed = c.last ? Math.max(0, (now - c.last) / DAY) : 0;
  c.reps += 1;

  if (c.state === State.New) {
    c.d = initD(g);
    c.s = initS(g);
    if (g === 1) { c.state = State.Learning; c.due = now + 1 * MIN; }
    else if (g === 2) { c.state = State.Learning; c.due = now + 6 * MIN; }
    else if (g === 3) { c.state = State.Learning; c.due = now + 10 * MIN; }
    else { c.state = State.Review; c.ivl = intervalDays(c.s, retention, fuzz); c.due = now + c.ivl * DAY; }
  } else if (c.state === State.Learning || c.state === State.Relearning) {
    c.d = nextD(c.d, g);
    c.s = shortTermS(c.s, g);
    if (g === 1) { c.due = now + 5 * MIN; }
    else if (g === 2) { c.due = now + 10 * MIN; }
    else {
      let ivl = intervalDays(c.s, retention, fuzz);
      if (g === 4) ivl = Math.max(ivl, 2);
      c.state = State.Review; c.ivl = ivl; c.due = now + ivl * DAY;
    }
  } else {
    // Review
    const r = retrievability(elapsed, c.s);
    const d0 = c.d;
    c.d = nextD(d0, g);
    if (g === 1) {
      c.s = forgetS(d0, c.s, r);
      c.lapses += 1;
      c.state = State.Relearning;
      c.due = now + 10 * MIN;
    } else {
      // keep Hard < Good < Easy ordering of intervals
      const sH = recallS(d0, c.s, r, 2), sG = recallS(d0, c.s, r, 3), sE = recallS(d0, c.s, r, 4);
      let iH = intervalDays(sH, retention, false);
      let iG = intervalDays(sG, retention, false);
      let iE = intervalDays(sE, retention, false);
      iH = Math.min(iH, iG);
      iG = Math.max(iG, iH + 1);
      iE = Math.max(iE, iG + 1);
      const pick = { 2: [sH, iH], 3: [sG, iG], 4: [sE, iE] }[g];
      c.s = pick[0];
      let ivl = pick[1];
      if (fuzz && ivl >= 3) {
        const f = Math.max(1, Math.round(ivl * 0.05));
        ivl = clamp(ivl + Math.round((Math.random() * 2 - 1) * f), 1, MAX_IVL);
      }
      c.ivl = ivl;
      c.due = now + ivl * DAY;
    }
  }
  c.last = now;
  return c;
}

/** Preview next due for each rating (no fuzz) — used for button labels. */
export function preview(srs, now = Date.now(), retention = 0.9) {
  const out = {};
  for (const g of [1, 2, 3, 4]) out[g] = schedule(srs, g, now, retention, false).due - now;
  return out;
}

export function fmtInterval(ms) {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(ms / DAY);
  if (d < 31) return `${d}d`;
  const mo = d / 30.4;
  if (mo < 12) return `${mo < 10 ? mo.toFixed(1).replace('.0', '') : Math.round(mo)}mo`;
  return `${(d / 365).toFixed(1).replace('.0', '')}y`;
}

/** Rough "strength" 0..1 for progress bars. */
export function strength(srs, now = Date.now()) {
  if (!srs || srs.state === State.New) return 0;
  const s = srs.s || 0;
  // map stability (days) to 0..1 — 21+ days is "known"
  return clamp(Math.log(1 + s) / Math.log(1 + 60), 0.04, 1);
}

export { DAY, MIN };
