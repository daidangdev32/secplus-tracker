// SecPlus Tracker — app.js (ES module)
//
// Single source of truth once signed in is a single Firestore document at
// users/{uid} = { progress: {videoId: {...}}, settings: {...}, activity: {dateISO:true} }.
// We keep one realtime listener on it and mirror it into `state`, then re-render.
// Firestore's offline cache (persistentLocalCache) makes reads/writes instant and
// keeps the app working offline; we never use localStorage as the source of truth.

import { firebaseConfig, isConfigured } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, onSnapshot, setDoc,
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DOMAIN_NAMES = {
  0: "Course Intro",
  1: "General Security Concepts",
  2: "Threats, Vulnerabilities & Mitigations",
  3: "Security Architecture",
  4: "Security Operations",
  5: "Security Program Management & Oversight",
};

// Confidence rating → days until the next review. (Spaced-repetition table.)
const RATING_INTERVALS = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };
const RATING_WORD = { 1: "totally lost", 2: "shaky", 3: "okay-ish", 4: "solid", 5: "could teach it" };

// ---------------------------------------------------------------------------
// App state (a plain mirror of Firestore + the loaded playlist)
// ---------------------------------------------------------------------------
const state = {
  videos: [],          // from data/videos.json, sorted by position
  progress: {},        // videoId -> progress object (from Firestore)
  settings: {},        // { examDate, todayMode }
  activity: {},        // dateISO -> true (for the streak)
  user: null,
  uid: null,
  docRef: null,
  ready: false,        // first Firestore snapshot received
  tab: "today",
  openDomains: new Set(),
  watchRevealed: new Set(), // ids whose inline rating was revealed by tapping Watch
};

let auth = null, db = null;

// ---------------------------------------------------------------------------
// Date helpers — everything is a local YYYY-MM-DD string so string compares work
// ---------------------------------------------------------------------------
function localISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayISO() { return localISO(new Date()); }
function fromISO(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
function addDaysISO(iso, n) { const d = fromISO(iso); d.setDate(d.getDate() + n); return localISO(d); }
// Whole days from today until `iso` (negative if in the past).
function daysUntil(iso) { return Math.round((fromISO(iso) - fromISO(todayISO())) / 86400000); }

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
function defaultSettings() {
  return { examDate: `${new Date().getFullYear()}-08-31`, todayMode: "review-then-new" };
}
function defaultProgress() {
  return {
    watched: false, watchedDate: null, rating: null, prevRating: null,
    nextReviewDate: null, mastered: false, note: "",
  };
}
function prog(id) { return state.progress[id] || defaultProgress(); }

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------
const unwatched = () => state.videos.filter((v) => !prog(v.id).watched);

// Due for review = watched, not mastered, and nextReviewDate has arrived.
function dueForReview() {
  const t = todayISO();
  return state.videos
    .filter((v) => { const p = prog(v.id); return p.watched && !p.mastered && p.nextReviewDate && p.nextReviewDate <= t; })
    .sort((a, b) => (prog(a.id).nextReviewDate.localeCompare(prog(b.id).nextReviewDate)) || (a.position - b.position));
}

// Weakspot = rating 1–3 and not mastered.
function weakspots() {
  return state.videos.filter((v) => { const p = prog(v.id); return !p.mastered && p.rating >= 1 && p.rating <= 3; });
}

// Seconds of unwatched video remaining in the whole course.
function secsLeft() {
  return unwatched().reduce((s, v) => s + (v.durationSec || 0), 0);
}

// Minutes/day of study needed to finish all unwatched video by `examDateISO`.
// (Clamp days to ≥1 so a today/past deadline doesn't divide by zero.)
function dailyMinutesToFinish(examDateISO) {
  const days = Math.max(1, daysUntil(examDateISO || defaultSettings().examDate));
  return Math.ceil(secsLeft() / 60 / days);
}

// Pace = the daily-study target for the saved exam date. Drives Today's batch.
function paceMinutes() { return dailyMinutesToFinish(state.settings.examDate); }

// Average length of one concept (video) across the whole course.
function avgConceptMinutes() {
  if (!state.videos.length) return 0;
  const total = state.videos.reduce((s, v) => s + (v.durationSec || 0), 0);
  return Math.max(1, Math.round(total / state.videos.length / 60));
}

function fmtDatePretty(iso) {
  try { return fromISO(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return iso; }
}

// One-sentence study plan: how much to study per day to finish by the deadline.
function studyPlanText(examDateISO) {
  const n = unwatched().length;
  if (!n) return "All videos watched — you've finished the playlist. 🎉";
  const days = daysUntil(examDateISO);
  if (days < 0) return "That deadline has passed — pick a future date to get a daily target.";
  const d = Math.max(1, days);
  return `Study ~${dailyMinutesToFinish(examDateISO)} min/day to finish by ${fmtDatePretty(examDateISO)} — ` +
    `${n} video${n === 1 ? "" : "s"} (${fmtHoursLeft(secsLeft())}) over ${d} day${d === 1 ? "" : "s"}.`;
}

// Today's new batch: next unwatched videos in order until summed minutes ≥ pace (≥1 video).
function newToday() {
  const target = paceMinutes();
  const out = [];
  let mins = 0;
  for (const v of unwatched()) {
    out.push(v);
    mins += (v.durationSec || 0) / 60;
    if (mins >= target) break;
  }
  return out;
}

// Honest readiness: watching at avg confidence 3 reads ~60%, not 100%.
function readinessPct() {
  if (!state.videos.length) return 0;
  const sum = state.videos.reduce((s, v) => {
    const p = prog(v.id);
    return s + (p.watched && p.rating ? p.rating / 5 : 0);
  }, 0);
  return Math.round((sum / state.videos.length) * 100);
}

// Consecutive days (ending today, or yesterday if today not done yet) with activity.
function streak() {
  const days = state.activity || {};
  let n = 0;
  let cursor = todayISO();
  if (!days[cursor]) cursor = addDaysISO(cursor, -1); // today not done yet is OK
  while (days[cursor]) { n++; cursor = addDaysISO(cursor, -1); }
  return n;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmtDur(sec) {
  if (!sec) return "";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtHoursLeft(sec) {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---------------------------------------------------------------------------
// Writes (optimistic local update, then Firestore — its cache echoes it back)
// ---------------------------------------------------------------------------
function markActivity(t) { state.activity[t] = true; }

async function persist(partial) {
  if (!state.docRef) return;
  try {
    // merge:true deep-merges maps, so we only touch the fields we pass.
    await setDoc(state.docRef, partial, { merge: true });
  } catch (e) {
    console.error("Firestore write failed", e);
    showToast("Couldn't sync — will retry when online");
  }
}

// Core spaced-repetition update. On every rate:
//  - shift current rating into prevRating, set the new rating
//  - 5 twice in a row → mastered, leaves the rotation (nextReviewDate null)
//  - any rating ≤ 4 → not mastered, recompute nextReviewDate from the table
//  - if it wasn't watched yet, mark it watched today
async function rate(id, newRating) {
  const p = { ...prog(id) };
  const prev = p.rating;            // old current rating
  p.prevRating = prev;
  p.rating = newRating;
  const t = todayISO();
  if (!p.watched) { p.watched = true; p.watchedDate = t; }
  if (newRating === 5 && prev === 5) {
    p.mastered = true;
    p.nextReviewDate = null;
  } else {
    p.mastered = false;
    p.nextReviewDate = addDaysISO(t, RATING_INTERVALS[newRating]);
  }
  state.progress[id] = p;           // optimistic
  markActivity(t);
  await persist({ progress: { [id]: p }, activity: { [t]: true } });

  if (p.mastered) showToast("Mastered — out of rotation 🏆", true);
  else if (newRating >= 4 && prev >= 1 && prev <= 3) showToast("Graduated 🎉", true);
}

async function saveNote(id, text) {
  const p = { ...prog(id), note: text };
  state.progress[id] = p;
  await persist({ progress: { [id]: { note: text } } });
}

async function saveExamDate(iso) {
  if (!iso) return;
  state.settings.examDate = iso;
  await persist({ settings: { examDate: iso } });
  render();
}

// ---------------------------------------------------------------------------
// Rendering — build HTML strings, wire interaction via event delegation
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const view = () => $("#view");

function ratingRow(id, current, { revealed = true } = {}) {
  const btns = [1, 2, 3, 4, 5].map((n) =>
    `<button class="rate-btn ${current === n ? "sel" : ""}" data-action="rate" data-id="${id}" data-rating="${n}" aria-label="Rate ${n}: ${RATING_WORD[n]}">${n}</button>`
  ).join("");
  return `<div class="rate-wrap" data-rate-wrap ${revealed ? "" : "hidden"}>
      <div class="rate">${btns}</div>
      <div class="rate-legend"><span>1 · totally lost</span><span>5 · could teach it</span></div>
    </div>`;
}

function watchLink(v, label, primary) {
  const cls = primary ? "btn-primary watch-btn" : "vid-yt";
  const icon = primary
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>`
    : "";
  // Plain https watch URL — iOS routes it to the YouTube app if installed.
  return `<a class="${cls}" data-action="watch" data-id="${v.id}" href="${v.url}" target="_blank" rel="noopener">${icon}${label}</a>`;
}

// ---- Tab: Today ----
function renderToday() {
  const due = dueForReview();
  const fresh = newToday();
  const hero = due[0] || fresh[0] || null;
  const pace = paceMinutes();
  const watchedCount = state.videos.filter((v) => prog(v.id).watched).length;
  const dExam = daysUntil(state.settings.examDate || defaultSettings().examDate);

  let html = "";

  if (hero) {
    const isReview = !!due[0];
    const revealed = prog(hero.id).watched || state.watchRevealed.has(hero.id);
    html += `<div class="hero">
      <div class="hero-kicker">${isReview ? "Review first" : "Next up"}</div>
      <div class="hero-title">${esc(hero.title)}</div>
      <div class="hero-meta">
        <span>${esc(DOMAIN_NAMES[hero.domain])}</span><span class="dot"></span>
        <span>${fmtDur(hero.durationSec)}</span>
      </div>
      ${watchLink(hero, "Watch now", true)}
      ${ratingRow(hero.id, prog(hero.id).rating, { revealed })}
    </div>`;
  } else {
    html += `<div class="card empty"><div class="empty-mark">✓</div>
      <strong>All caught up.</strong><br/>Nothing due and every video watched. Go take a practice test.</div>`;
  }

  // Stat strip
  html += `<div class="stats">
    <div class="stat"><div class="stat-num accent">${pace}</div><div class="stat-label">min/day to finish</div></div>
    <div class="stat"><div class="stat-num">${watchedCount}<span style="color:var(--faint);font-size:.8rem">/${state.videos.length}</span></div><div class="stat-label">videos watched</div></div>
    <div class="stat"><div class="stat-num">${streak()}🔥</div><div class="stat-label">day streak</div></div>
    <div class="stat"><div class="stat-num">${dExam >= 0 ? dExam + "d" : "—"}</div><div class="stat-label">to exam</div></div>
  </div>`;

  if (due.length) {
    html += `<div class="section-title">Due for review (${due.length})</div>`;
    html += due.map((v) => videoRow(v, { showRating: true })).join("");
  }

  // If there were due reviews the hero is the first review, so the whole new
  // batch is listed; otherwise the hero was the first new video, so skip it here.
  const newList = due.length ? fresh : fresh.slice(1);
  if (newList.length) {
    html += `<div class="section-title">New today</div>`;
    html += newList.map((v) => videoRow(v, { showRating: true, hideUntilWatch: true })).join("");
  }

  view().innerHTML = html;
}

// A compact video row used in Today / Roadmap / Weakspots.
function videoRow(v, { showRating = false, hideUntilWatch = false, showNote = false } = {}) {
  const p = prog(v.id);
  const revealed = !hideUntilWatch || p.watched || state.watchRevealed.has(v.id);
  return `<div class="card vid-card" data-card="${v.id}">
    <div class="vid">
      <div class="vid-check ${p.watched ? "on" : ""}">${p.watched ? '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>' : ""}</div>
      <div class="vid-main">
        <div class="vid-title">${esc(v.title)}</div>
        <div class="vid-sub">
          <span>${esc(DOMAIN_NAMES[v.domain])}</span><span class="dot"></span>
          <span>${fmtDur(v.durationSec)}</span><span class="dot"></span>
          ${watchLink(v, p.watched ? "Rewatch" : "Watch", false)}
          ${p.mastered ? '<span class="badge-mastered">Mastered</span>' : ""}
        </div>
      </div>
    </div>
    ${showRating ? ratingRow(v.id, p.rating, { revealed }) : ""}
    ${showNote ? noteField(v.id, p.note) : ""}
  </div>`;
}

function noteField(id, note) {
  return `<textarea class="note" data-action="note-input" data-id="${id}" rows="2"
    placeholder="Why is this weak? (note to self)">${esc(note)}</textarea>`;
}

// ---- Tab: Roadmap ----
function renderRoadmap() {
  const totalLeftSec = unwatched().reduce((s, v) => s + (v.durationSec || 0), 0);
  let html = `<div class="card readiness">
      <div class="readiness-num">${readinessPct()}%</div>
      <div class="readiness-cap">Readiness — watching ≠ ready. Keep this honest with practice tests.</div>
      <div class="readiness-left">${totalLeftSec ? fmtHoursLeft(totalLeftSec) + " of video left" : "All videos watched"}</div>
    </div>`;

  // Study-planning card: time per concept + daily study needed to hit the deadline.
  const left = unwatched().length;
  const exam = state.settings.examDate || defaultSettings().examDate;
  const dleft = daysUntil(exam);
  let dailyVal, dailyNote;
  if (!left) {
    dailyVal = "Done"; dailyNote = "every video watched — go take a practice test";
  } else if (dleft < 0) {
    dailyVal = `~${dailyMinutesToFinish(exam)} min`;
    dailyNote = `deadline (${fmtDatePretty(exam)}) has passed — set a new date in settings`;
  } else {
    dailyVal = `~${dailyMinutesToFinish(exam)} min`;
    dailyNote = `to finish ${left} video${left === 1 ? "" : "s"} (${fmtHoursLeft(secsLeft())}) by ${fmtDatePretty(exam)}`;
  }
  html += `<div class="card plan">
      <div class="plan-row">
        <span class="plan-label">Time per concept</span>
        <span class="plan-val">≈ ${avgConceptMinutes()} min</span>
        <span class="plan-note">average across ${state.videos.length} concepts</span>
      </div>
      <div class="plan-row">
        <span class="plan-label">Daily study to finish</span>
        <span class="plan-val">${dailyVal}${left ? "/day" : ""}</span>
        <span class="plan-note">${dailyNote}</span>
      </div>
    </div>`;

  const domains = [...new Set(state.videos.map((v) => v.domain))].sort((a, b) => a - b);
  for (const d of domains) {
    const vids = state.videos.filter((v) => v.domain === d);
    if (!vids.length) continue; // skip empty domains (e.g. domain 0 if it had none)
    const watched = vids.filter((v) => prog(v.id).watched).length;
    const pct = Math.round((watched / vids.length) * 100);
    const leftSec = vids.filter((v) => !prog(v.id).watched).reduce((s, v) => s + (v.durationSec || 0), 0);
    const open = state.openDomains.has(d);

    html += `<div class="domain ${open ? "open" : ""}">
      <button class="domain-head" data-action="toggle-domain" data-domain="${d}">
        <div class="domain-row">
          <span class="domain-name">${esc(DOMAIN_NAMES[d])}
            <svg class="chev" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
          </span>
          <span class="domain-left ${pct === 100 ? "done" : ""}">${pct === 100 ? "done" : fmtHoursLeft(leftSec) + " left"}</span>
        </div>
        <div class="bar ${pct === 100 ? "full" : ""}"><span style="width:${pct}%"></span></div>
      </button>
      ${open ? `<div class="domain-body">${vids.map((v) => videoRow(v, { showRating: true, showNote: true })).join("")}</div>` : ""}
    </div>`;
  }
  view().innerHTML = html;
}

// ---- Tab: Weakspots ----
function renderWeakspots() {
  const t = todayISO();
  const all = weakspots();
  const dueNow = all.filter((v) => { const d = prog(v.id).nextReviewDate; return !d || d <= t; })
    .sort((a, b) => (prog(a.id).nextReviewDate || "").localeCompare(prog(b.id).nextReviewDate || "") || a.position - b.position);
  const scheduled = all.filter((v) => { const d = prog(v.id).nextReviewDate; return d && d > t; })
    .sort((a, b) => prog(a.id).nextReviewDate.localeCompare(prog(b.id).nextReviewDate));

  if (!all.length) {
    view().innerHTML = `<div class="card empty"><div class="empty-mark">🛡️</div>
      <strong>No weak spots.</strong><br/>Anything you rate 1–3 shows up here on a spaced schedule.</div>`;
    return;
  }

  let html = "";
  if (dueNow.length) {
    html += `<div class="section-title">Due now (${dueNow.length})</div>`;
    html += dueNow.map((v) => weakCard(v, false)).join("");
  }
  if (scheduled.length) {
    html += `<div class="section-title">Scheduled</div>`;
    html += scheduled.map((v) => weakCard(v, true)).join("");
  }
  view().innerHTML = html;
}

function weakCard(v, scheduled) {
  const p = prog(v.id);
  const when = p.nextReviewDate ? daysUntil(p.nextReviewDate) : 0;
  const whenTxt = scheduled
    ? `in ${when}d · ${p.nextReviewDate}`
    : "due now";
  return `<div class="card vid-card" data-card="${v.id}">
    <div class="vid">
      <div class="vid-main">
        <div class="vid-title">${esc(v.title)}</div>
        <div class="vid-sub">
          <span class="pill r${p.rating}">rated ${p.rating}</span>
          <span>${esc(DOMAIN_NAMES[v.domain])}</span><span class="dot"></span>
          <span class="scheduled-date">${whenTxt}</span>
        </div>
      </div>
    </div>
    ${noteField(v.id, p.note)}
    <div style="margin-top:10px">${watchLink(v, "Review on YouTube", false)}</div>
    ${ratingRow(v.id, p.rating, { revealed: true })}
  </div>`;
}

function render() {
  if (!state.ready) {
    view().innerHTML = `<div class="empty"><p>Syncing your data…</p></div>`;
    return;
  }
  document.querySelectorAll(".tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  if (state.tab === "today") renderToday();
  else if (state.tab === "roadmap") renderRoadmap();
  else renderWeakspots();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg, good = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (good ? " good" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------
function onClick(e) {
  const tab = e.target.closest("[data-tab]");
  if (tab) { state.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }

  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (action === "watch") {
    // Let the link navigate; reveal the inline rating so it can be rated on return.
    state.watchRevealed.add(el.dataset.id);
    const wrap = el.closest(".hero, .vid-card")?.querySelector("[data-rate-wrap]");
    if (wrap) wrap.hidden = false;
    return; // do not preventDefault — the deep link must open
  }

  if (action === "rate") {
    e.preventDefault();
    const id = el.dataset.id, n = Number(el.dataset.rating);
    const wasWeak = (() => { const p = prog(id); return !p.mastered && p.rating >= 1 && p.rating <= 3; })();
    // On Weakspots, if a re-rate graduates the card, animate it out before re-render.
    const graduates = state.tab === "weakspots" && wasWeak && (n >= 4);
    rate(id, n).then(() => {
      if (graduates) {
        const card = document.querySelector(`.vid-card[data-card="${CSS.escape(id)}"]`);
        if (card && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
          card.classList.add("graduating");
          setTimeout(render, 480);
          return;
        }
      }
      render();
    });
    return;
  }

  if (action === "toggle-domain") {
    const d = Number(el.dataset.domain);
    if (state.openDomains.has(d)) state.openDomains.delete(d); else state.openDomains.add(d);
    render();
    return;
  }
}

function onChange(e) {
  // Exam date has no data-action, so handle it before the delegation lookup.
  if (e.target.id === "exam-date") { saveExamDate(e.target.value); return; }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "note-input") saveNote(el.dataset.id, el.value);
}

// Live: update the study-plan readout as the exam date is being picked.
function onInput(e) {
  if (e.target.id === "exam-date") {
    const p = $("#study-plan");
    if (p) p.textContent = studyPlanText(e.target.value || state.settings.examDate);
  }
}

// ---------------------------------------------------------------------------
// Settings sheet
// ---------------------------------------------------------------------------
function openSheet() {
  $("#exam-date").value = state.settings.examDate || defaultSettings().examDate;
  const row = $("#account-row");
  const u = state.user;
  row.innerHTML = u
    ? `${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer"/>` : ""}<span>${esc(u.displayName || u.email || "Signed in")}</span>`
    : "";
  $("#study-plan").textContent = studyPlanText(state.settings.examDate || defaultSettings().examDate);
  $("#settings-sheet").hidden = false;
}
function closeSheet() { $("#settings-sheet").hidden = true; }

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const provider = new GoogleAuthProvider();

function signinError(e) {
  const map = {
    "auth/unauthorized-domain": "This site isn't authorized in Firebase yet. Add your GitHub Pages domain under Authentication → Settings → Authorized domains (README Stage 2, step 6).",
    "auth/operation-not-allowed": "Google sign-in isn't enabled in Firebase (README Stage 2, step 2).",
    "auth/popup-blocked": "Your browser blocked the sign-in popup. Retrying with a redirect…",
  };
  const el = $("#signin-error");
  el.textContent = map[e?.code] || (e?.message || "Sign-in failed.");
  el.hidden = false;
  // warn (not error): the common cases here are setup guidance (config not
  // filled in, domain not yet authorized), not unexpected runtime failures.
  console.warn("Sign-in:", e?.code || e?.message || e);
}

async function doSignIn() {
  $("#signin-error").hidden = true;
  // Popup-first on EVERY platform, including iOS Safari. signInWithRedirect
  // bounces through {project}.firebaseapp.com; Safari's storage partitioning
  // (ITP) drops the pending-auth state on the way back, so the user returns
  // still signed out. signInWithPopup completes via postMessage from the popup
  // and sidesteps that. It must be called directly in the click gesture (it is)
  // so Safari's pop-up blocker allows it.
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") {
      return; // user dismissed it — not an error
    }
    // Popup genuinely unavailable (e.g. blocked): fall back to redirect.
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) {
      try { await signInWithRedirect(auth, provider); } catch (e2) { signinError(e2); }
    } else {
      signinError(e);
    }
  }
}

function startListening(uid) {
  state.docRef = doc(db, "users", uid);
  // One realtime listener drives the whole app.
  onSnapshot(state.docRef, async (snap) => {
    if (!snap.exists()) {
      // First sign-in on this account: seed an empty document.
      await persist({ progress: {}, settings: defaultSettings(), activity: {} });
      return; // the write echoes back as the next snapshot
    }
    const data = snap.data();
    state.progress = data.progress || {};
    state.settings = { ...defaultSettings(), ...(data.settings || {}) };
    state.activity = data.activity || {};
    state.ready = true;
    render();
  }, (err) => {
    console.error("snapshot error", err);
    showToast("Sync error — check Firestore rules");
  });
}

function showScreen(which) {
  $("#boot").hidden = which !== "boot";
  $("#signin").hidden = which !== "signin";
  $("#app").hidden = which !== "app";
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function loadVideos() {
  const res = await fetch("data/videos.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("videos.json missing");
  const list = await res.json();
  state.videos = list.slice().sort((a, b) => a.position - b.position);
}

async function boot() {
  // Wire UI that exists regardless of auth state.
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  $("#signin-btn").addEventListener("click", doSignIn);
  $("#settings-btn").addEventListener("click", openSheet);
  $("#signout-btn").addEventListener("click", () => { closeSheet(); signOut(auth); });
  document.querySelectorAll("[data-close-sheet]").forEach((b) => b.addEventListener("click", closeSheet));
  // Re-render Today when returning from YouTube so a freshly-revealed rating is ready.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.ready && state.tab === "today") render(); });

  if (!isConfigured) {
    showScreen("signin");
    signinError({ message: "firebase-config.js isn't filled in yet — see README Stage 2." });
    $("#signin-btn").disabled = true;
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    // Firestore with offline persistence (IndexedDB), multi-tab safe.
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) {
    showScreen("signin");
    signinError({ message: "Firebase failed to initialize — check firebase-config.js values." });
    return;
  }

  try { await loadVideos(); }
  catch (e) { console.error(e); showToast("Couldn't load the playlist (data/videos.json)"); }

  // Complete any pending redirect sign-in before we read auth state.
  try { await getRedirectResult(auth); } catch (e) { signinError(e); }

  onAuthStateChanged(auth, (user) => {
    if (user) {
      state.user = user; state.uid = user.uid; state.ready = false;
      showScreen("app");
      render();
      startListening(user.uid);
    } else {
      state.user = null; state.uid = null; state.ready = false;
      showScreen("signin");
    }
  });
}

// Register the service worker (PWA / offline). Non-blocking.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed", e));
  });
}

boot();
