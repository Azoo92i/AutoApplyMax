// application-answers.js — "Application answers" (ext 2.5.124, 2026-10-20; replaces the 2.5.121-123 "To complete" list).
// The bot never asks mid-apply and never guesses. When a REQUIRED form question has no answer the application is
// skipped (as before) and the exact question is RECORDED (labels only, never a value). What is missing is shown in ONE
// place per surface:
//   - popup: the "Profile incomplete" header chip + popover (Complete now → the popup field; questions only a form can
//     ask → the dashboard "Application answers" section) and the amber "!" toolbar badge;
//   - dashboard: the "Application answers" section (+ a "!" on its sidebar item).
// No saved-jobs list, no re-apply queue (Théo 2026-10-20: "saved jobs, we don't care much").
//
// Self-contained like apply-prefs-sync.js:
//   - service worker: background.js importScripts('core/question-intents.js', 'application-answers.js'); messages below.
//   - popup: popup.html loads it (pure helpers only; the UI is popup-answers.js).
//   - Node: module.exports = pure functions (tests/ext-application-answers.test.js).
//
// Storage (chrome.storage.local):
//   eam_asked_questions { v:1, items:{ [questionKey]: { label, key, intent, kind?, options?, count, at, lastAt, synced } } }
//   eam_custom_answers  { [questionKey]: { q, a, at } }   ← answers to custom questions (profile-field answers live in
//                                                          chrome.storage.sync like every popup setting)
// Account copy (signed in): application_answers (supabase/migrations/20261019160000_application_answers.sql, RLS own
// rows) — recorded questions pushed (answer column never sent by the extension), custom answers pulled. Missing table
// (migration not applied yet) → local only, retried after 6 h.
//
// Messages (chrome.runtime): answersRecord {questions, reason} (engine) · answersState (popup) · answersSync (popup /
//   engine Start) · answersSaveCustom {custom} (dashboard bridge, content-marker.js).
(function (root) {
  'use strict';

  const ASKED_KEY = 'eam_asked_questions';
  const ANS_KEY = 'eam_custom_answers';
  const REMOTE_OFF_KEY = 'eam_aa_remote_off_until';
  const MAX_ITEMS = 300; // = the account limit (application_answers_guard)
  // Settings an answer can fill (chrome.storage.sync keys = question-intents setting intents).
  const SETTING_KEYS = ['expectedSalary', 'currentSalary', 'city', 'postalCode', 'noticePeriod', 'dateOfBirth', 'gender',
    'nationality', 'phone', 'legallyAuthorized', 'visaSponsorship', 'willingToRelocate'];
  // Popup defaults: a Yes/No setting never blocks (the popup shows a default) — never listed as "missing".
  const HAS_DEFAULT = { legallyAuthorized: 'yes', visaSponsorship: 'no', willingToRelocate: 'yes' };

  const QI = () => root.AAMQuestionIntents || (typeof require === 'function' ? require('./core/question-intents.js') : null);
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

  // ─── pure ─────────────────────────────────────────────────────────────────────────────────────────────
  function cleanQuestions(qs) {
    const out = []; const seen = new Set();
    for (const q of Array.isArray(qs) ? qs : []) {
      if (!q || typeof q !== 'object') continue;
      const key = str(q.key, 160); const label = str(q.label, 200); const intent = str(q.intent, 30);
      if (key.length < 2 || !label || !/^[A-Za-z]{2,30}$/.test(intent) || intent === 'unsupported' || seen.has(key)) continue;
      seen.add(key);
      const c = { label, key, intent };
      if (q.kind) c.kind = str(q.kind, 12);
      if (Array.isArray(q.options) && q.options.length) {
        const opts = q.options.slice(0, 12).map(o => str(o, 80)).filter(Boolean);
        // ≤ 2,000 bytes (account check pg_column_size(options)) — otherwise the question gets a text input.
        if (opts.length && Buffer_byteLength(JSON.stringify(opts)) <= 1800) c.options = opts;
      }
      out.push(c);
      if (out.length >= 8) break;
    }
    return out;
  }
  function Buffer_byteLength(s) { return s.length + (s.match(/[^\x00-\x7f]/g) || []).length * 2; }

  // Record the questions of one skip. Returns { items, added:[keys] }. Cap: drop the least recently asked first.
  function recordQuestions(items, questions, now) {
    now = now || Date.now();
    const out = Object.assign({}, items || {});
    const added = [];
    for (const q of cleanQuestions(questions)) {
      const prev = out[q.key];
      if (!prev) added.push(q.key);
      out[q.key] = Object.assign({}, prev || { at: now, count: 0 }, q, { count: Math.min(100000, ((prev && prev.count) || 0) + 1), lastAt: now, synced: false });
    }
    const keys = Object.keys(out);
    if (keys.length > MAX_ITEMS) keys.sort((a, b) => (out[a].lastAt || 0) - (out[b].lastAt || 0)).slice(0, keys.length - MAX_ITEMS).forEach(k => { delete out[k]; });
    return { items: out, added };
  }

  function isAnswered(q, ctx) {
    ctx = ctx || {};
    if (q.intent === 'custom') return !!(ctx.custom && ctx.custom[q.key] && String(ctx.custom[q.key].a || '').trim());
    if (HAS_DEFAULT[q.intent]) return true;
    const v = ctx.settings ? ctx.settings[q.intent] : '';
    return String(v == null ? '' : v).trim() !== '';
  }

  // Recorded questions still unanswered: profile-field intents grouped (one salary for three wordings), custom by key.
  function missingQuestions(items, ctx) {
    const groups = new Map();
    for (const q of Object.values(items || {})) {
      if (!q || isAnswered(q, ctx)) continue;
      const gk = q.intent === 'custom' ? 'custom:' + q.key : q.intent;
      const g = groups.get(gk) || { id: gk, intent: q.intent, key: q.key, labels: [], options: null, asked: 0 };
      if (!g.labels.includes(q.label) && g.labels.length < 3) g.labels.push(q.label);
      if (!g.options && q.options && q.options.length) g.options = q.options.slice();
      g.asked += q.count || 1;
      groups.set(gk, g);
    }
    return Array.from(groups.values()).sort((a, b) => b.asked - a.asked);
  }

  // "Profile incomplete": empty fields that commonly block applications, in priority order, each with the popup tab
  // that edits it — key settings (expected salary, city, India current CTC) + phone + years + resume file + any other
  // profile field a form already asked (nationality, postal code…). extra = { yearsOfExperience, hasResume }.
  const GAP_ORDER = ['expectedSalary', 'currentSalary', 'city', 'phone', 'yearsOfExperience', 'resume', 'nationality',
    'postalCode', 'noticePeriod', 'dateOfBirth', 'gender'];
  function keyGaps(settings, countryHint) {
    const s = settings || {};
    const out = [];
    if (!String(s.expectedSalary || '').trim()) out.push('expectedSalary');
    if (/^IN$/i.test(String(countryHint || '')) && !String(s.currentSalary || '').trim()) out.push('currentSalary');
    if (!String(s.city || '').trim()) out.push('city');
    return out;
  }
  function profileGaps(settings, countryHint, extra, items) {
    const s = settings || {}; const x = extra || {};
    const set = new Set(keyGaps(s, countryHint));
    if (!String(s.phone || '').trim()) set.add('phone');
    if (!String(x.yearsOfExperience == null ? '' : x.yearsOfExperience).trim()) set.add('yearsOfExperience');
    if (!x.hasResume) set.add('resume');
    for (const g of missingQuestions(items || {}, { settings: s, custom: {} })) {
      if (g.intent !== 'custom' && GAP_ORDER.includes(g.intent)) set.add(g.intent);
    }
    return GAP_ORDER.filter(k => set.has(k)).map(k => ({ key: k }));
  }
  // Custom questions a form asked that have no saved answer (answered on the dashboard only).
  function customGaps(items, custom) { return missingQuestions(items || {}, { settings: {}, custom: custom || {} }).filter(g => g.intent === 'custom'); }

  // Country for the India CTC rule: settings → account profile → +91 phone code.
  function countryHintFrom(sync, local) {
    const s = sync || {}; const l = local || {};
    const c = String(s.country || (l.accountProfile && l.accountProfile.country) || '').trim().toUpperCase();
    return c.length === 2 ? c : (String(s.phoneCountryCode || '').replace(/[^\d]/g, '') === '91' ? 'IN' : '');
  }
  // Toolbar "!" badge (amber) while something is missing (unless "Later" < 24 h).
  const LATER_KEY = 'eam_profile_later_until';
  const LATER_MS = 24 * 3600e3;
  function attentionState(sync, local, now) {
    const s = sync || {}; const l = local || {};
    const items = (l[ASKED_KEY] && l[ASKED_KEY].items) || {};
    const gaps = profileGaps(s, countryHintFrom(s, l), { yearsOfExperience: s.yearsOfExperience, hasResume: !!(l.resumeFile || l.resumeFileName) }, items);
    const custom = customGaps(items, l[ANS_KEY]).length;
    const later = Number(l[LATER_KEY]) > (now || Date.now());
    return { gaps, custom, later, badge: (gaps.length > 0 || custom > 0) && !later };
  }
  const BADGE_SYNC_KEYS = SETTING_KEYS.concat(['yearsOfExperience', 'country', 'phoneCountryCode']);
  const BADGE_LOCAL_KEYS = [ASKED_KEY, ANS_KEY, LATER_KEY, 'resumeFile', 'resumeFileName', 'accountProfile'];

  // Account rows → local: custom answers (most recent wins) + questions recorded on another device.
  function mergeAnswers(local, rows) {
    const out = Object.assign({}, local || {});
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r && r.intent && r.intent !== 'custom') continue;
      const key = str(r && r.question_key, 160); const a = str(r && r.answer, 500);
      if (!key || !a) continue;
      const at = Date.parse(r.updated_at) || 0;
      if (!out[key] || (out[key].at || 0) <= at) out[key] = { q: str(r.question, 300), a, at };
    }
    return out;
  }
  function mergeRemoteQuestions(items, rows) {
    const out = Object.assign({}, items || {});
    for (const r of Array.isArray(rows) ? rows : []) {
      const [q] = cleanQuestions([{ key: r && r.question_key, label: r && r.question, intent: r && r.intent, options: r && r.options }]);
      if (!q || out[q.key]) continue;
      const at = Date.parse(r.last_asked_at || r.updated_at) || Date.now();
      out[q.key] = Object.assign(q, { count: Number(r.asked_count) || 1, at, lastAt: at, synced: true });
    }
    return out;
  }
  // Local item → account row (no answer column: the extension never writes an answer value here).
  function toRow(item, uid) {
    return { user_id: uid, question_key: item.key, question: item.label, intent: item.intent, options: item.options && item.options.length ? item.options : null,
      asked_count: item.count || 1, last_asked_at: new Date(item.lastAt || Date.now()).toISOString() };
  }

  // Dashboard answers → { custom:[{key,question,answer}], errors:{key:true} }
  function normalizeCustom(list) {
    const qi = QI();
    const custom = []; const errors = {};
    for (const c of Array.isArray(list) ? list : []) {
      const key = str(c && c.key, 160); const question = str(c && c.question, 300);
      const answer = qi ? qi.normalizeAnswer('custom', c && c.answer) : str(c && c.answer, 500);
      if (key.length < 2 || !question) continue;
      if (answer) custom.push({ key, question, answer }); else if (String((c && c.answer) || '').trim()) errors[key] = true;
    }
    return { custom, errors };
  }

  const DASHBOARD_ANSWERS_URL = 'https://www.autoapplymax.com/dashboard?focus=answers#application-answers';

  // ─── chrome glue ──────────────────────────────────────────────────────────────────────────────────────
  const hasChrome = typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.runtime;
  const api = { ASKED_KEY, ANS_KEY, SETTING_KEYS, HAS_DEFAULT, MAX_ITEMS, GAP_ORDER, cleanQuestions, recordQuestions, isAnswered, missingQuestions,
    keyGaps, profileGaps, customGaps, countryHintFrom, attentionState, LATER_KEY, LATER_MS, BADGE_SYNC_KEYS, BADGE_LOCAL_KEYS,
    mergeAnswers, mergeRemoteQuestions, toRow, normalizeCustom, DASHBOARD_ANSWERS_URL };
  root.AAMAnswers = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (!hasChrome) return;
  const isServiceWorker = typeof importScripts === 'function' && typeof document === 'undefined';
  if (!isServiceWorker) return; // popup: pure helpers only (UI in popup-answers.js)

  /* global SUPABASE_URL, SUPABASE_ANON_KEY, refreshSupabaseToken, enqueueDiag */
  const SB_URL = 'https://tgknaopmwbelterrhrnz.supabase.co';
  const sbUrl = () => (typeof SUPABASE_URL === 'string' && SUPABASE_URL) || SB_URL;
  const sbAnon = () => (typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY) || '';
  const L = (keys) => chrome.storage.local.get(keys);
  const diag = (event_type, meta) => { try { if (typeof enqueueDiag === 'function') enqueueDiag({ site: 'linkedin', event_type, url_path: null, meta: meta || {} }); } catch (_) {} };

  async function getItems() { const o = await L([ASKED_KEY]); return (o[ASKED_KEY] && o[ASKED_KEY].items && typeof o[ASKED_KEY].items === 'object') ? o[ASKED_KEY].items : {}; }
  async function setItems(items) { await chrome.storage.local.set({ [ASKED_KEY]: { v: 1, items } }); }
  async function getAnswers() { const o = await L([ANS_KEY]); return o[ANS_KEY] && typeof o[ANS_KEY] === 'object' ? o[ANS_KEY] : {}; }
  async function getSettings() { return chrome.storage.sync.get(SETTING_KEYS); }

  let _chain = Promise.resolve();
  const locked = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };

  async function _session() { const { eam_session } = await L(['eam_session']); return eam_session && eam_session.access_token ? eam_session : null; }
  function _sub(tok) { try { const b = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b + '==='.slice((b.length + 3) % 4))).sub || ''; } catch (_) { return ''; } }
  async function _fetch(path, init) {
    const off = (await L([REMOTE_OFF_KEY]))[REMOTE_OFF_KEY] || 0;
    if (off > Date.now()) return { status: -1, ok: false };
    let s = await _session();
    if (!s) return { status: 0, ok: false };
    const go = (tok) => fetch(sbUrl() + path, Object.assign({}, init, { headers: Object.assign({ apikey: sbAnon() || tok, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, (init && init.headers) || {}) }));
    let r = await go(s.access_token);
    if (r.status === 401) { try { const f = typeof refreshSupabaseToken === 'function' ? await refreshSupabaseToken() : null; if (f && f.access_token) { s = f; r = await go(f.access_token); } } catch (_) {} }
    if (r.status === 404) { // PGRST205 / relation missing: migration not applied yet → local only for 6 h
      let body = ''; try { body = await r.text(); } catch (_) {}
      if (/PGRST205|42P01|does not exist|Could not find the table/i.test(body)) await chrome.storage.local.set({ [REMOTE_OFF_KEY]: Date.now() + 6 * 3600e3 });
    }
    r._uid = _sub(s.access_token) || s.user_id || '';
    return r;
  }

  async function push() {
    const items = await getItems();
    const dirty = Object.values(items).filter(x => x && x.synced === false);
    if (!dirty.length) return { ok: true, pushed: 0 };
    const probe = await _session(); if (!probe) return { ok: false, reason: 'signed_out' };
    const uid = _sub(probe.access_token) || probe.user_id;
    const r = await _fetch('/rest/v1/application_answers?on_conflict=user_id,question_key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(dirty.map(x => toRow(x, uid))) });
    if (!r.ok) return { ok: false, reason: 'http_' + r.status };
    await locked(async () => {
      const cur = await getItems();
      for (const x of dirty) if (cur[x.key] && cur[x.key].lastAt === x.lastAt) cur[x.key] = Object.assign({}, cur[x.key], { synced: true });
      await setItems(cur);
    });
    return { ok: true, pushed: dirty.length };
  }

  async function pull() {
    const r = await _fetch('/rest/v1/application_answers?select=question_key,question,intent,options,answer,asked_count,last_asked_at,updated_at&limit=300');
    if (!r.ok) return { ok: false, changed: false, remote: r.status };
    const rows = await r.json();
    let changed = false;
    const cur = await getAnswers(); const m = mergeAnswers(cur, rows);
    if (JSON.stringify(m) !== JSON.stringify(cur)) { changed = true; await chrome.storage.local.set({ [ANS_KEY]: m }); }
    await locked(async () => { const it = await getItems(); const mi = mergeRemoteQuestions(it, rows); if (Object.keys(mi).length !== Object.keys(it).length) { changed = true; await setItems(mi); } });
    return { ok: true, changed };
  }

  async function syncNow() {
    try { const p = await pull(); const s = await push(); return { ok: p.ok || s.ok, changed: p.changed, pushed: s.pushed || 0 }; }
    catch (e) { return { ok: false, reason: (e && e.message) || 'error' }; }
  }

  async function record(msg) {
    const res = await locked(async () => { const cur = await getItems(); const r = recordQuestions(cur, msg && msg.questions); await setItems(r.items); return r; });
    const qs = cleanQuestions(msg && msg.questions);
    if (qs.length) {
      diag('answers_missing', { n: qs.length, intents: Array.from(new Set(qs.map(q => q.intent))).slice(0, 6), reason: str(msg && msg.reason, 30) || 'questions', new: res.added.length });
      push().catch(() => {});
    }
    return { ok: qs.length > 0, added: res.added.length };
  }

  async function saveCustom(msg) {
    const n = normalizeCustom(msg && msg.custom);
    if (n.custom.length) {
      const cur = await getAnswers(); const at = Date.now();
      for (const c of n.custom) cur[c.key] = { q: c.question, a: c.answer, at };
      await chrome.storage.local.set({ [ANS_KEY]: cur });
      diag('answers_saved', { fields: [], custom: n.custom.length });
    }
    return { ok: !Object.keys(n.errors).length, saved: n.custom.length, errors: n.errors };
  }

  // A profile field a form already asked (recorded question) gets its first value (popup, dashboard bridge, account
  // sync) → answers_saved (field names only). Fields no form asked yet (first setup, account pull) are not counted.
  const WATCH = SETTING_KEYS.filter(k => !HAS_DEFAULT[k]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const filled = WATCH.filter(k => changes[k] && !String(changes[k].oldValue == null ? '' : changes[k].oldValue).trim() && String(changes[k].newValue == null ? '' : changes[k].newValue).trim());
    if (!filled.length) return;
    getItems().then((items) => {
      const asked = new Set(Object.values(items).map(q => q && q.intent));
      const f = filled.filter(k => asked.has(k));
      if (f.length) diag('answers_saved', { fields: f.slice(0, 8), custom: 0 });
    }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !/^answers[A-Z]/.test(msg.type)) return false;
    const done = (p) => { Promise.resolve(p).then(sendResponse, (e) => sendResponse({ ok: false, reason: (e && e.message) || 'error' })); return true; };
    switch (msg.type) {
      case 'answersRecord': return done(record(msg));
      case 'answersState': return done((async () => ({ ok: true, items: await getItems(), answers: await getAnswers(), settings: await getSettings() }))());
      case 'answersSync': return done(syncNow());
      case 'answersSaveCustom': return done(saveCustom(msg));
      default: return false;
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
