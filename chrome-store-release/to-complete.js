// to-complete.js — "To complete" (2026-10-19, ext 2.5.121).
// Jobs the bot skipped because a REQUIRED question had no answer (expected salary, current city, nationality,
// a custom question…). The bot never asks mid-apply and never guesses: it saves the job + the exact questions
// here, the user answers once (popup tab or dashboard), the answers are reused by every later form, and
// "Apply to these jobs now" re-queues the saved jobs (one LinkedIn page per job, engine in re-apply mode).
//
// Self-contained like apply-prefs-sync.js:
//   - service worker: background.js importScripts('core/question-intents.js', 'to-complete.js'); messages below.
//   - popup: popup.html loads it (pure helpers only; the UI is popup-to-complete.js).
//   - Node: module.exports = pure functions (tests/ext-to-complete.test.js).
//
// Storage (chrome.storage.local):
//   eam_to_complete    { v:1, items:[{ jobId, url, title, company, location, site, questions:[{label,key,intent,kind?,options?}],
//                        reason, status:'open'|'queued'|'applied'|'not_found'|'dismissed', count, at, updatedAt, synced }] }
//   eam_custom_answers { [questionKey]: { q, a, at } }      ← answers to custom questions (profile-field answers live in
//                                                            chrome.storage.sync like the popup settings)
//   eam_reapply        { active, queue:[jobId], idx, results:{jobId:result}, tabId, startedIdx, currentAt, startedAt, finishedAt }
// Account copy (when signed in, tables from supabase/migrations/20261019160000_to_complete_answers.sql):
//   application_todos (RLS own rows) · application_answers (RLS own rows). Missing table (migration not applied
//   yet) → local only, retried after 6 h.
//
// Messages (chrome.runtime): toCompleteAdd {entry} · toCompleteList · toCompleteSaveAnswers {settings, custom} ·
//   toCompleteDismiss {jobId} · toCompleteSync · toCompleteReapply {jobs?|jobIds?} · toCompleteReapplyCancel ·
//   reapplyResult {jobId, result, reason} (from the engine) · toCompleteFromWeb {kind, ...} (content-marker bridge).
(function (root) {
  'use strict';

  const LIST_KEY = 'eam_to_complete';
  const ANS_KEY = 'eam_custom_answers';
  const REAPPLY_KEY = 'eam_reapply';
  const REMOTE_OFF_KEY = 'eam_tc_remote_off_until';
  const DAILY_LIMIT_BLOCK_MS = 12 * 3600e3; // LinkedIn's daily limit resets in < 12 h (measured 2026-09-25)
  const MAX_ITEMS = 200; // = the account limit (application_todos_guard)
  const QUESTIONS_MAX_BYTES = 5000; // < the account check pg_column_size(questions) <= 6000
  const JOB_URL_RE = /^https:\/\/(?:www\.)?linkedin\.com\/jobs\/view\/(\d{5,20})\/?(?:[?#].*)?$/i;
  // Settings the To-complete answers write (chrome.storage.sync keys = question-intents setting intents).
  const SETTING_KEYS = ['expectedSalary', 'currentSalary', 'city', 'postalCode', 'noticePeriod', 'dateOfBirth', 'gender',
    'nationality', 'phone', 'legallyAuthorized', 'visaSponsorship', 'willingToRelocate'];
  // Popup defaults: a Yes/No setting never blocks (the popup shows a default) — never listed as "missing".
  const HAS_DEFAULT = { legallyAuthorized: 'yes', visaSponsorship: 'no', willingToRelocate: 'yes' };

  const QI = () => root.AAMQuestionIntents || (typeof require === 'function' ? require('./core/question-intents.js') : null);

  // ─── pure ─────────────────────────────────────────────────────────────────────────────────────────────
  function canonicalJob(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const m = String(entry.url || '').match(JOB_URL_RE);
    const jobId = String(entry.jobId || (m && m[1]) || '').trim();
    if (!/^\d{5,20}$/.test(jobId)) return null;
    if (m && m[1] !== jobId) return null;
    return { jobId, url: `https://www.linkedin.com/jobs/view/${jobId}/` };
  }

  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

  function cleanQuestions(qs) {
    const out = []; const seen = new Set();
    for (const q of Array.isArray(qs) ? qs : []) {
      if (!q || typeof q !== 'object') continue;
      const key = str(q.key, 160); const label = str(q.label, 200); const intent = str(q.intent, 30);
      if (!key || !label || !intent || intent === 'unsupported' || seen.has(key)) continue;
      seen.add(key);
      const c = { label, key, intent };
      if (q.kind) c.kind = str(q.kind, 12);
      if (Array.isArray(q.options) && q.options.length) c.options = q.options.slice(0, 12).map(o => str(o, 80)).filter(Boolean);
      out.push(c);
      if (out.length >= 8) break;
    }
    // 2.5.122: the account row rejects questions over 6000 bytes (application_todos check) and one rejected row fails
    // the whole batched push → keep ≤ QUESTIONS_MAX_BYTES: drop the longest option lists first (that question then
    // gets a text input), then the last questions. (8 long labels with 12 long options each reached ~11 KB.)
    const size = () => { const j = JSON.stringify(out); return j.length + (j.match(/[^\x00-\x7f]/g) || []).length * 2; };
    while (size() > QUESTIONS_MAX_BYTES) {
      let k = -1, n = 0;
      out.forEach((q, i) => { const l = q.options ? JSON.stringify(q.options).length : 0; if (l > n) { n = l; k = i; } });
      if (k >= 0) delete out[k].options; else if (out.length > 1) out.pop(); else break;
    }
    return out;
  }

  // Add / refresh one skipped job. The latest skip's questions replace the old ones (they are what is still missing).
  function mergeEntry(items, entry, now) {
    const job = canonicalJob(entry);
    const questions = cleanQuestions(entry && entry.questions);
    if (!job || !questions.length) return { items: items || [], added: false };
    now = now || Date.now();
    const list = (items || []).slice();
    const i = list.findIndex(x => x.jobId === job.jobId);
    const base = i >= 0 ? list[i] : { at: now, count: 0 };
    const item = Object.assign({}, base, {
      jobId: job.jobId, url: job.url, site: 'linkedin',
      title: str(entry.title, 200) || base.title || '', company: str(entry.company, 200) || base.company || '', location: str(entry.location, 200) || base.location || '',
      questions, reason: str(entry.reason, 30) || base.reason || 'questions', status: 'open',
      count: Math.min(1000, (base.count || 0) + 1), updatedAt: now, synced: false,
    });
    if (i >= 0) list.splice(i, 1);
    list.unshift(item);
    // Cap: drop the oldest closed items first, then the oldest open ones.
    while (list.length > MAX_ITEMS) {
      let k = -1;
      for (let j = list.length - 1; j >= 0; j--) if (list[j].status !== 'open' && list[j].status !== 'queued') { k = j; break; }
      list.splice(k >= 0 ? k : list.length - 1, 1);
    }
    return { items: list, added: i < 0, item };
  }

  // Is this question answered by the current settings / saved custom answers?
  function isAnswered(q, ctx) {
    ctx = ctx || {};
    if (q.intent === 'custom') return !!(ctx.custom && ctx.custom[q.key] && String(ctx.custom[q.key].a || '').trim());
    const v = ctx.settings ? ctx.settings[q.intent] : '';
    return String(v == null ? '' : v).trim() !== '';
  }
  function openQuestions(item, ctx) { return (item.questions || []).filter(q => !isAnswered(q, ctx)); }
  function readyItems(items, ctx) {
    return (items || []).filter(it => (it.status === 'open' || it.status === 'not_found') && openQuestions(it, ctx).length === 0);
  }
  function openItems(items) { return (items || []).filter(it => it.status === 'open' || it.status === 'queued' || it.status === 'not_found'); }

  // Distinct questions still unanswered across open jobs: profile-field intents grouped by intent (one salary input
  // for three differently-worded salary questions), custom questions by key.
  function pendingQuestions(items, ctx) {
    const groups = new Map();
    for (const it of openItems(items)) {
      for (const q of it.questions || []) {
        if (isAnswered(q, ctx)) continue;
        const gk = q.intent === 'custom' ? 'custom:' + q.key : q.intent;
        const g = groups.get(gk) || { id: gk, intent: q.intent, key: q.key, labels: [], options: null, kind: q.kind || '', jobs: 0 };
        if (!g.labels.includes(q.label) && g.labels.length < 3) g.labels.push(q.label);
        if (!g.options && q.options && q.options.length) g.options = q.options.slice();
        g.jobs++;
        groups.set(gk, g);
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.jobs - a.jobs);
  }

  // Settings that block the most skips and are empty → pre-run banner. countryHint: 'IN' adds the current CTC.
  function missingKeySettings(settings, countryHint) {
    const s = settings || {};
    const out = [];
    if (!String(s.expectedSalary || '').trim()) out.push('expectedSalary');
    if (!String(s.city || '').trim()) out.push('city');
    if (/^IN$/i.test(String(countryHint || '')) && !String(s.currentSalary || '').trim()) out.push('currentSalary');
    return out;
  }

  // Account rows → local items (union by jobId, the most recent update wins; unsynced local edits win ties).
  function mergeRemote(localItems, rows) {
    const map = new Map((localItems || []).map(x => [x.jobId, x]));
    for (const r of Array.isArray(rows) ? rows : []) {
      const job = canonicalJob({ jobId: r.job_id, url: r.job_url });
      if (!job) continue;
      const remote = {
        jobId: job.jobId, url: job.url, site: 'linkedin', title: str(r.title, 200), company: str(r.company, 200), location: str(r.location, 200),
        questions: cleanQuestions(r.questions), reason: str(r.skip_reason, 30) || 'questions', status: str(r.status, 12) || 'open',
        count: Number(r.skipped_count) || 1, at: Date.parse(r.created_at) || Date.now(), updatedAt: Date.parse(r.updated_at) || 0, synced: true,
      };
      const l = map.get(job.jobId);
      if (!l || (l.synced !== false && remote.updatedAt >= (l.updatedAt || 0)) || (l.synced === false && remote.updatedAt > (l.updatedAt || 0) + 1000)) map.set(job.jobId, remote);
    }
    return Array.from(map.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, MAX_ITEMS);
  }

  function mergeAnswers(local, rows) {
    const out = Object.assign({}, local || {});
    for (const r of Array.isArray(rows) ? rows : []) {
      const key = str(r.question_key, 160); const a = str(r.answer, 500);
      if (!key || !a) continue;
      const at = Date.parse(r.updated_at) || 0;
      if (!out[key] || (out[key].at || 0) <= at) out[key] = { q: str(r.question, 300), a, at };
    }
    return out;
  }

  // Result of one re-applied job → item status.
  function applyResult(items, jobId, result, now) {
    const list = (items || []).slice();
    const i = list.findIndex(x => x.jobId === jobId);
    if (i < 0) return list;
    const r = String(result || '');
    const status = (r === 'applied' || r === 'already_applied') ? 'applied' : r === 'not_found' ? 'not_found' : 'open';
    list[i] = Object.assign({}, list[i], { status, lastResult: r.slice(0, 30), updatedAt: now || Date.now(), synced: false });
    return list;
  }

  function reapplyUrl(jobId) { return `https://www.linkedin.com/jobs/search/?currentJobId=${jobId}&f_AL=true`; }

  // Popup / dashboard answers → { settings:{key:normalized}, custom:[{key,question,answer}], errors:{id:true} }
  function normalizeAnswers(input) {
    const qi = QI();
    const settings = {}; const custom = []; const errors = {};
    for (const [k, v] of Object.entries((input && input.settings) || {})) {
      if (!SETTING_KEYS.includes(k)) continue;
      const raw = String(v == null ? '' : v).trim();
      if (!raw) continue;
      const n = qi ? qi.normalizeAnswer(k, raw) : raw;
      if (n) settings[k] = n; else errors[k] = true;
    }
    for (const c of (input && input.custom) || []) {
      const key = str(c && c.key, 160); const question = str(c && c.question, 300);
      const answer = qi ? qi.normalizeAnswer('custom', c && c.answer) : str(c && c.answer, 500);
      if (!key || !question) continue;
      if (answer) custom.push({ key, question, answer }); else if (String((c && c.answer) || '').trim()) errors[key] = true;
    }
    return { settings, custom, errors };
  }

  // ─── chrome glue ──────────────────────────────────────────────────────────────────────────────────────
  const hasChrome = typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.runtime;
  const api = { LIST_KEY, ANS_KEY, REAPPLY_KEY, SETTING_KEYS, HAS_DEFAULT, canonicalJob, cleanQuestions, mergeEntry, isAnswered, openQuestions,
    readyItems, openItems, pendingQuestions, missingKeySettings, mergeRemote, mergeAnswers, applyResult, reapplyUrl, normalizeAnswers };
  root.AAMToComplete = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (!hasChrome) return;
  const isServiceWorker = typeof importScripts === 'function' && typeof document === 'undefined';
  if (!isServiceWorker) return; // popup: pure helpers only (UI in popup-to-complete.js)

  /* global SUPABASE_URL, SUPABASE_ANON_KEY, refreshSupabaseToken, enqueueDiag */
  const SB_URL = 'https://tgknaopmwbelterrhrnz.supabase.co';
  const sbUrl = () => (typeof SUPABASE_URL === 'string' && SUPABASE_URL) || SB_URL;
  const sbAnon = () => (typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY) || '';
  const L = (keys) => chrome.storage.local.get(keys);
  const diag = (event_type, meta) => { try { if (typeof enqueueDiag === 'function') enqueueDiag({ site: 'linkedin', event_type, url_path: null, meta: meta || {} }); } catch (_) {} };

  async function getList() { const o = await L([LIST_KEY]); return (o[LIST_KEY] && Array.isArray(o[LIST_KEY].items)) ? o[LIST_KEY].items : []; }
  async function setList(items) { await chrome.storage.local.set({ [LIST_KEY]: { v: 1, items } }); }
  async function getAnswers() { const o = await L([ANS_KEY]); return o[ANS_KEY] && typeof o[ANS_KEY] === 'object' ? o[ANS_KEY] : {}; }
  async function getSettings() { return chrome.storage.sync.get(SETTING_KEYS); }

  // Serialize list writes (skips from the engine, results, dashboard edits can arrive together).
  let _chain = Promise.resolve();
  const locked = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };

  async function _session() { const { eam_session } = await L(['eam_session']); return eam_session && eam_session.access_token ? eam_session : null; }
  function _sub(tok) { try { const b = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b + '==='.slice((b.length + 3) % 4))).sub || ''; } catch (_) { return ''; } }
  async function _fetch(path, init) {
    const off = (await L([REMOTE_OFF_KEY]))[REMOTE_OFF_KEY] || 0;
    if (off > Date.now()) return { status: -1 };
    let s = await _session();
    if (!s) return { status: 0 };
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

  async function pushTodos() {
    const items = await getList();
    const dirty = items.filter(x => x.synced === false);
    if (!dirty.length) return { ok: true, pushed: 0 };
    const probe = await _session(); if (!probe) return { ok: false, reason: 'signed_out' };
    const uid = _sub(probe.access_token) || probe.user_id;
    const body = dirty.map(x => ({ user_id: uid, site: 'linkedin', job_id: x.jobId, job_url: x.url, title: x.title || null, company: x.company || null,
      location: x.location || null, questions: x.questions || [], status: x.status || 'open', skip_reason: x.reason || null, skipped_count: x.count || 1 }));
    const r = await _fetch('/rest/v1/application_todos?on_conflict=user_id,site,job_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) return { ok: false, reason: 'http_' + r.status };
    await locked(async () => {
      const cur = await getList();
      const sent = new Map(dirty.map(x => [x.jobId, x.updatedAt]));
      await setList(cur.map(x => (sent.has(x.jobId) && sent.get(x.jobId) === x.updatedAt) ? Object.assign({}, x, { synced: true }) : x));
    });
    return { ok: true, pushed: dirty.length };
  }

  async function pull() {
    const t = await _fetch('/rest/v1/application_todos?select=job_id,job_url,title,company,location,questions,status,skip_reason,skipped_count,created_at,updated_at&order=updated_at.desc&limit=200');
    const a = await _fetch('/rest/v1/application_answers?select=question_key,question,answer,updated_at&limit=300');
    let changed = false;
    if (t.ok) { const rows = await t.json(); await locked(async () => { const cur = await getList(); const m = mergeRemote(cur, rows); changed = JSON.stringify(m) !== JSON.stringify(cur); if (changed) await setList(m); }); }
    if (a.ok) { const rows = await a.json(); const cur = await getAnswers(); const m = mergeAnswers(cur, rows); if (JSON.stringify(m) !== JSON.stringify(cur)) { changed = true; await chrome.storage.local.set({ [ANS_KEY]: m }); } }
    return { ok: !!(t.ok || a.ok), changed, remote: t.status };
  }

  async function syncNow() {
    try { const p = await pull(); const s = await pushTodos(); return { ok: p.ok || s.ok, changed: p.changed, pushed: s.pushed || 0 }; }
    catch (e) { return { ok: false, reason: (e && e.message) || 'error' }; }
  }

  async function add(entry) {
    const res = await locked(async () => { const cur = await getList(); const r = mergeEntry(cur, entry); if (r.item) await setList(r.items); return r; });
    if (res.item) {
      diag('todo_saved', { n: res.item.questions.length, intents: Array.from(new Set(res.item.questions.map(q => q.intent))).slice(0, 6), reason: res.item.reason, again: !res.added });
      pushTodos().catch(() => {});
    }
    return { ok: !!res.item, added: res.added };
  }

  async function saveAnswers(input) {
    const n = normalizeAnswers(input);
    const keys = Object.keys(n.settings);
    if (keys.length) {
      await chrome.storage.sync.set(n.settings);
      // Account sync of the profile fields (apply-prefs-sync.js: per-field edit time → pushed to user_profiles).
      try { if (root.AAMApplyPrefs) { await root.AAMApplyPrefs.markEdited(keys); root.AAMApplyPrefs.syncNow().catch(() => {}); } } catch (_) {}
    }
    if (n.custom.length) {
      const cur = await getAnswers(); const at = Date.now();
      for (const c of n.custom) cur[c.key] = { q: c.question, a: c.answer, at };
      await chrome.storage.local.set({ [ANS_KEY]: cur });
      _fetch('/rest/v1/application_answers?on_conflict=user_id,question_key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(n.custom.map(c => ({ question_key: c.key, question: c.question, answer: c.answer }))) }).catch(() => {});
    }
    if (keys.length || n.custom.length) diag('todo_answered', { fields: keys.slice(0, 8), custom: n.custom.length });
    return { ok: !Object.keys(n.errors).length, saved: keys.length + n.custom.length, errors: n.errors };
  }

  async function setStatus(jobIds, status) {
    const ids = new Set(jobIds || []);
    await locked(async () => { const cur = await getList(); await setList(cur.map(x => ids.has(x.jobId) ? Object.assign({}, x, { status, updatedAt: Date.now(), synced: false }) : x)); });
    pushTodos().catch(() => {});
  }

  // ─── re-apply queue ───────────────────────────────────────────────────────────────────────────────────
  // Same files and order as popup.js injectModularScripts (+ question-intents before form-filler).
  const ENGINE_FILES = ['core/utils.js', 'core/job-board-strings.js', 'core/site-registry.js', 'adapters/base-adapter.js', 'core/question-intents.js',
    'core/ai-form.js', 'core/form-filler.js', 'core/engine.js', 'adapters/linkedin-adapter.js'];
  async function getRe() { return (await L([REAPPLY_KEY]))[REAPPLY_KEY] || null; }
  async function setRe(r) { await chrome.storage.local.set({ [REAPPLY_KEY]: r }); }

  async function reapply(msg) {
    // Jobs passed by the dashboard (account rows) are merged first; then the ready ones are queued.
    const given = Array.isArray(msg && msg.jobs) ? msg.jobs : [];
    if (given.length) {
      await locked(async () => {
        let cur = await getList();
        for (const j of given.slice(0, 50)) {
          const job = canonicalJob(j); if (!job) continue;
          const i = cur.findIndex(x => x.jobId === job.jobId);
          if (i < 0) cur.unshift({ jobId: job.jobId, url: job.url, site: 'linkedin', title: str(j.title, 200), company: str(j.company, 200), location: str(j.location, 200),
            questions: cleanQuestions(j.questions), reason: 'questions', status: 'open', count: 1, at: Date.now(), updatedAt: Date.now(), synced: true });
        }
        await setList(cur.slice(0, MAX_ITEMS));
      });
    }
    const items = await getList();
    const ctx = { settings: await getSettings(), custom: await getAnswers() };
    let ids = Array.isArray(msg && msg.jobIds) ? msg.jobIds.map(String) : given.map(j => canonicalJob(j)).filter(Boolean).map(j => j.jobId);
    const ready = readyItems(items, ctx).map(x => x.jobId);
    ids = (ids.length ? ids.filter(id => items.some(x => x.jobId === id && x.status !== 'applied' && x.status !== 'dismissed')) : ready).slice(0, 50);
    if (!ids.length) return { ok: false, reason: 'nothing_ready' };
    const cur = await getRe();
    if (cur && cur.active) return { ok: false, reason: 'already_running', idx: cur.idx, total: cur.queue.length };
    // 2.5.122: LinkedIn's daily Easy Apply limit hit < 12 h ago (engine stopBot → eam_daily_limit_at; a normal Start
    // clears it) → re-applying now would only hit it again. The jobs stay ready in the list.
    const dl = (await L(['eam_daily_limit_at'])).eam_daily_limit_at || 0;
    if (dl && Date.now() - dl < DAILY_LIMIT_BLOCK_MS) return { ok: false, reason: 'daily_limit', at: dl };
    // The tab exists (blank) before LinkedIn loads, and the queue state is stored before its first "complete" event.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    await setRe({ active: true, queue: ids, idx: 0, results: {}, tabId: tab.id, startedIdx: -1, currentAt: Date.now(), startedAt: Date.now() });
    await chrome.tabs.update(tab.id, { url: reapplyUrl(ids[0]) });
    await setStatus(ids, 'queued');
    diag('todo_reapply', { phase: 'start', jobs: ids.length });
    return { ok: true, total: ids.length };
  }

  async function startCurrent(tabId) {
    const re = await getRe();
    if (!re || !re.active || re.tabId !== tabId || re.startedIdx === re.idx) return;
    re.startedIdx = re.idx; re.currentAt = Date.now();
    await setRe(re);
    const jobId = re.queue[re.idx];
    try {
      await new Promise(r => setTimeout(r, 2500)); // LinkedIn hydrates the list after "complete"
      for (const file of ENGINE_FILES) { try { await chrome.scripting.executeScript({ target: { tabId }, files: [file] }); } catch (_) {} }
      await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (window.EAM && window.EAM.BotEngine && !window.EAM._engineInitialized) { window.EAM.BotEngine.init(); window.EAM._engineInitialized = true; } } });
      await new Promise(r => setTimeout(r, 800));
      const res = await chrome.tabs.sendMessage(tabId, { action: 'start', adapter: 'linkedin', reapply: { jobId } });
      if (res && res.success === false) await onResult({ jobId, result: 'stopped', reason: String(res.error || 'start refused').slice(0, 80) }, tabId);
    } catch (e) {
      await onResult({ jobId, result: 'stopped', reason: 'inject: ' + String((e && e.message) || e).slice(0, 60) }, tabId);
    }
  }

  async function onResult(msg, tabId) {
    const re = await getRe();
    if (!re || !re.active || (tabId && re.tabId !== tabId) || String(msg.jobId) !== String(re.queue[re.idx])) return { ok: false };
    const result = str(msg.result, 30) || 'stopped';
    re.results[msg.jobId] = result;
    await locked(async () => { await setList(applyResult(await getList(), String(msg.jobId), result)); });
    pushTodos().catch(() => {});
    diag('todo_reapply', { phase: 'job', result, reason: str(msg.reason, 60) });
    // A stop (user Stop, daily limit, throttle stop, tab problem) ends the queue; the rest stays queued → back to open.
    if (result === 'stopped') return finish(re, 'stopped');
    re.idx++;
    if (re.idx >= re.queue.length) return finish(re, 'done');
    re.currentAt = Date.now();
    await setRe(re);
    try { await chrome.tabs.update(re.tabId, { url: reapplyUrl(re.queue[re.idx]) }); } catch (_) { return finish(re, 'tab_closed'); }
    return { ok: true };
  }

  async function finish(re, why) {
    const left = re.queue.filter(id => !re.results[id]);
    if (left.length) await setStatus(left, 'open');
    re.active = false; re.finishedAt = Date.now(); re.end = why;
    await setRe(re);
    const vals = Object.values(re.results);
    diag('todo_reapply', { phase: 'end', end: why, applied: vals.filter(v => v === 'applied').length, total: re.queue.length });
    return { ok: true, finished: true };
  }

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete' || !/linkedin\.com\/jobs\//i.test((tab && tab.url) || '')) return;
    getRe().then(re => { if (re && re.active && re.tabId === tabId) startCurrent(tabId); }).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener((tabId) => { getRe().then(re => { if (re && re.active && re.tabId === tabId) finish(re, 'tab_closed'); }).catch(() => {}); });
  try { chrome.alarms.create('eam-reapply-watchdog', { periodInMinutes: 1 }); } catch (_) {}
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name !== 'eam-reapply-watchdog') return;
    getRe().then(re => {
      if (!re || !re.active) return;
      // 2.5.122: 10 min > a LinkedIn throttle pause (< 7 min measured), so a paused re-apply is not timed out.
      if (Date.now() - (re.currentAt || 0) > 10 * 60e3) onResult({ jobId: re.queue[re.idx], result: 'timeout' }, re.tabId);
    }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !/^(toComplete|reapplyResult$)/.test(msg.type)) return false;
    const done = (p) => { Promise.resolve(p).then(sendResponse, (e) => sendResponse({ ok: false, reason: (e && e.message) || 'error' })); return true; };
    switch (msg.type) {
      case 'toCompleteAdd': return done(add(msg.entry));
      case 'toCompleteList': return done((async () => ({ ok: true, items: await getList(), answers: await getAnswers(), settings: await getSettings(), reapply: await getRe(),
        dailyLimitAt: (await L(['eam_daily_limit_at'])).eam_daily_limit_at || 0, dailyLimitBlockMs: DAILY_LIMIT_BLOCK_MS }))());
      case 'toCompleteSaveAnswers': return done(saveAnswers(msg));
      case 'toCompleteDismiss': return done(setStatus([String(msg.jobId)], 'dismissed').then(() => ({ ok: true })));
      case 'toCompleteSync': return done(syncNow());
      case 'toCompleteReapply': return done(reapply(msg));
      case 'toCompleteReapplyCancel': return done(getRe().then(re => re && re.active ? finish(re, 'cancelled') : { ok: true }));
      case 'reapplyResult': return done(onResult(msg, sender && sender.tab && sender.tab.id));
      default: return false;
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
