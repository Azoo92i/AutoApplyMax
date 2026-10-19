// apply-prefs-sync.js — "Application details" two-way sync between the extension
// (chrome.storage.sync, popup "Your info" / "Preferences") and the AutoApplyMax
// account (user_profiles.apply_prefs + years_of_experience + expected_salary).
// Added 2026-10-15 (dashboard Smart Profile "Application details" card).
//
// Self-contained on purpose (merges cleanly with other release work):
//   - service worker: background.js does `importScripts('apply-prefs-sync.js')`; this file then
//     answers the runtime messages {type:'syncApplyPrefs'} and {type:'applyPrefsEdited', keys}.
//   - popup: popup.html loads it before popup.js; it records which fields the user typed in
//     (per-field edit time) and asks the service worker to sync on open / after an edit.
//   - Node: module.exports = the pure functions (tests/ext-apply-prefs-sync.test.js).
//
// Rule (last write wins, per field):
//   server time  = user_profiles.apply_prefs_updated_at (server clock, moved by a DB trigger when
//                  any of these values change)
//   local time   = chrome.storage.local.applyPrefsEditedAt[key] (set when the user TYPES in the
//                  popup, or to the server time once a value came from / reached the server)
//   - same value on both sides            → nothing
//   - popup value typed after the server  → pushed to the account
//   - otherwise the account value fills the extension: empty / never-typed (popup default) values,
//     and values typed before the last account change
//   - a value in the extension with no edit time (typed before this feature) is never overwritten
//     by a different account value; it only fills an empty account field
//   - popup defaults (years 2, visa No, authorized/relocate/license Yes) never reach the account
(function (root) {
  'use strict';

  const SB_URL = 'https://tgknaopmwbelterrhrnz.supabase.co';
  // background.js may switch backend at runtime (its SUPABASE_URL / SUPABASE_ANON_KEY script globals win).
  /* global SUPABASE_URL, SUPABASE_ANON_KEY */
  const sbUrl = () => (typeof SUPABASE_URL === 'string' && SUPABASE_URL) || SB_URL;
  const sbAnon = () => (typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY) || SB_ANON;
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRna25hb3Btd2JlbHRlcnJocm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NzYzMTcsImV4cCI6MjA5NDI1MjMxN30.2-V5Z6-ZIKOkC6RJEjdEEAVKjGYbSOdX_FSd3yPdE6Q';

  // key = chrome.storage.sync key (= popup input id). col = user_profiles column, else apply_prefs key.
  // def = value the popup SHOWS when nothing is stored (never pushed as if the user chose it).
  const FIELDS = [
    { key: 'yearsOfExperience', col: 'years_of_experience', def: '2', kind: 'int' },
    { key: 'expectedSalary', col: 'expected_salary', kind: 'money' },
    { key: 'currentSalary', kind: 'money' },
    { key: 'noticePeriod', kind: 'text' },
    { key: 'dateOfBirth', kind: 'date' },
    { key: 'postalCode', kind: 'postal' },
    { key: 'visaSponsorship', def: 'no', kind: 'yesno' },
    { key: 'legallyAuthorized', def: 'yes', kind: 'yesno' },
    { key: 'willingToRelocate', def: 'yes', kind: 'yesno' },
    { key: 'driversLicense', def: 'yes', kind: 'yesno' },
    { key: 'gender', kind: 'gender' },
  ];
  const KEYS = FIELDS.map(f => f.key);
  const BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));
  const SELECT = 'id,apply_prefs,apply_prefs_updated_at,years_of_experience,expected_salary';

  // Canonical string for a value ('' = not set). Mirrors the DB trigger's sanitizer.
  function normalize(key, v) {
    const f = BY_KEY[key];
    if (!f || v === undefined || v === null) return '';
    let s = String(v).trim();
    if (!s) return '';
    switch (f.kind) {
      case 'int': { const m = s.match(/^\d{1,2}(?:[.,]\d+)?/); return m ? String(Math.round(parseFloat(m[0].replace(',', '.')))) : ''; }
      // Digits only — the popup field is numeric; "45000 EUR" / "45,000" → "45000". "8 LPA" style → '' (unknown unit).
      case 'money': return /^\d[\d\s,.]*$/.test(s) ? String(Math.round(parseFloat(s.replace(/[\s,]/g, '')))) : '';
      case 'yesno': s = s.toLowerCase(); return s === 'yes' || s === 'no' ? s : '';
      case 'gender': s = s.toLowerCase(); return ['male', 'female', 'non_binary', 'other'].includes(s) ? s : '';
      case 'date': return /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s) ? s : '';
      case 'postal': return /^[A-Za-z0-9][A-Za-z0-9 -]{0,11}$/.test(s) ? s : '';
      default: return s.slice(0, 40);
    }
  }

  // user_profiles row → { key: value } (normalized, '' when not set).
  function serverValues(row) {
    const out = {};
    const prefs = (row && row.apply_prefs && typeof row.apply_prefs === 'object') ? row.apply_prefs : {};
    for (const f of FIELDS) out[f.key] = normalize(f.key, f.col ? (row ? row[f.col] : '') : prefs[f.key]);
    return out;
  }

  // Pure reconciliation. local = chrome.storage.sync values, editedAt = { key: ms }, row = user_profiles row.
  // Returns what to write locally, the new edit times, and the patch for the account (keys → value, '' = clear).
  function reconcile(local, editedAt, row) {
    local = local || {}; editedAt = editedAt || {};
    const serverAt = row && row.apply_prefs_updated_at ? (Date.parse(row.apply_prefs_updated_at) || 0) : 0;
    const S = serverValues(row);
    const localUpdate = {}, editedAtUpdate = {}, serverPatch = {};
    for (const f of FIELDS) {
      const k = f.key;
      const L = normalize(k, local[k]);
      const s = S[k];
      const E = Number(editedAt[k]) || 0;
      const isDefault = !E && f.def !== undefined && L === f.def; // shown by the popup, never chosen
      if (L === s) continue;
      if (E && E > serverAt) { serverPatch[k] = L; continue; }            // typed after the last account change
      if (!s) { if (L && !isDefault) serverPatch[k] = L; continue; }      // account empty: legacy popup value fills it
      if (!L || isDefault || E) { localUpdate[k] = s; editedAtUpdate[k] = serverAt || Date.now(); continue; }
      // L set without edit time (typed before this feature) and different from the account: keep both as they are.
    }
    return { localUpdate, editedAtUpdate, serverPatch, serverAt };
  }

  // Account patch → PostgREST body (apply_prefs merged with the row's current object).
  function patchBody(row, serverPatch) {
    const body = {};
    const prefs = Object.assign({}, (row && row.apply_prefs && typeof row.apply_prefs === 'object') ? row.apply_prefs : {});
    let prefsChanged = false;
    for (const [k, v] of Object.entries(serverPatch || {})) {
      const f = BY_KEY[k]; if (!f) continue;
      if (f.col) body[f.col] = v === '' ? null : v;
      else { if (v === '') delete prefs[k]; else prefs[k] = v; prefsChanged = true; }
    }
    if (prefsChanged) body.apply_prefs = prefs;
    return body;
  }

  // ─── chrome glue ──────────────────────────────────────────────────────────
  const hasChrome = typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.runtime;

  async function _session() {
    const { eam_session } = await chrome.storage.local.get(['eam_session']);
    return eam_session && eam_session.access_token ? eam_session : null;
  }
  async function _refresh() {
    try { if (typeof root.refreshSupabaseToken === 'function') return await root.refreshSupabaseToken(); } catch (_) {}
    return null;
  }
  async function _fetchAuthed(url, init) {
    let s = await _session();
    if (!s) return { status: 0 };
    const go = (tok) => fetch(url, Object.assign({}, init, { headers: Object.assign({ apikey: sbAnon(), Authorization: 'Bearer ' + tok }, (init && init.headers) || {}) }));
    let r = await go(s.access_token);
    if (r.status === 401) { const f = await _refresh(); if (f && f.access_token) r = await go(f.access_token); }
    return r;
  }

  let _running = null;
  // Full two-way sync. Never throws; returns { ok, changed:[keys], pushed:[keys], reason }.
  function syncNow() {
    if (_running) return _running;
    _running = (async () => {
      try {
        if (!(await _session())) return { ok: false, reason: 'signed_out' };
        const r = await _fetchAuthed(`${sbUrl()}/rest/v1/user_profiles?select=${SELECT}&limit=1`);
        if (!r.ok) return { ok: false, reason: 'http_' + r.status };
        const row = (await r.json())?.[0];
        if (!row || !row.id) return { ok: false, reason: 'no_profile_row' };
        const local = await chrome.storage.sync.get(KEYS);
        const { applyPrefsEditedAt = {} } = await chrome.storage.local.get(['applyPrefsEditedAt']);
        const res = reconcile(local, applyPrefsEditedAt, row);
        const edited = Object.assign({}, applyPrefsEditedAt, res.editedAtUpdate);
        if (Object.keys(res.localUpdate).length) await chrome.storage.sync.set(res.localUpdate);
        const pushed = Object.keys(res.serverPatch);
        if (pushed.length) {
          const body = patchBody(row, res.serverPatch);
          const p = await _fetchAuthed(`${sbUrl()}/rest/v1/user_profiles?id=eq.${encodeURIComponent(row.id)}&select=apply_prefs_updated_at`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body),
          });
          if (p.ok) {
            // Re-base the pushed fields on the server clock (client clocks can be off).
            let at = 0; try { at = Date.parse((await p.json())?.[0]?.apply_prefs_updated_at) || 0; } catch (_) {}
            if (at) for (const k of pushed) edited[k] = at;
          } else {
            await chrome.storage.local.set({ applyPrefsEditedAt: edited });
            return { ok: false, reason: 'push_http_' + p.status, changed: Object.keys(res.localUpdate), pushed: [] };
          }
        }
        await chrome.storage.local.set({ applyPrefsEditedAt: edited, applyPrefsSyncedAt: Date.now() });
        return { ok: true, changed: Object.keys(res.localUpdate), values: res.localUpdate, pushed };
      } catch (e) {
        return { ok: false, reason: (e && e.message) || 'error' };
      } finally { _running = null; }
    })();
    return _running;
  }

  // The user typed in these popup fields (values already saved in chrome.storage.sync by popup.js).
  async function markEdited(keys, at) {
    const ks = (keys || []).filter(k => BY_KEY[k]);
    if (!ks.length) return;
    const { applyPrefsEditedAt = {} } = await chrome.storage.local.get(['applyPrefsEditedAt']);
    for (const k of ks) applyPrefsEditedAt[k] = at || Date.now();
    await chrome.storage.local.set({ applyPrefsEditedAt });
  }

  const api = { FIELDS, KEYS, normalize, serverValues, reconcile, patchBody, syncNow, markEdited };
  root.AAMApplyPrefs = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (!hasChrome) return;

  const isServiceWorker = typeof importScripts === 'function' && typeof document === 'undefined';
  if (isServiceWorker) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.type === 'syncApplyPrefs') { syncNow().then(sendResponse); return true; }
      if (msg.type === 'applyPrefsEdited') {
        markEdited(Array.isArray(msg.keys) ? msg.keys : [], Number(msg.at) || 0).then(() => syncNow()).then(sendResponse);
        return true;
      }
      return false;
    });
    return;
  }

  // Popup page: record typed fields, sync on open, refresh the inputs that changed.
  if (typeof document !== 'undefined' && typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
    const typed = {}; let t = null;
    const flush = () => {
      const keys = Object.keys(typed); if (!keys.length) return;
      const at = Math.max(...keys.map(k => typed[k])); for (const k of keys) delete typed[k];
      // Edit time stored right away (survives the popup closing); the SW pushes after popup.js's 500 ms auto-save.
      markEdited(keys, at).catch(() => {});
      setTimeout(() => { try { chrome.runtime.sendMessage({ type: 'applyPrefsEdited', keys, at }, () => void chrome.runtime.lastError); } catch (_) {} }, 900);
    };
    const onEdit = (e) => {
      const id = e && e.target && e.target.id;
      if (!id || !BY_KEY[id] || !e.isTrusted) return; // programmatic fills (prefill from account) are not "typed"
      typed[id] = Date.now();
      clearTimeout(t); t = setTimeout(flush, 300);
    };
    document.addEventListener('input', onEdit, true);
    document.addEventListener('change', onEdit, true);
    window.addEventListener('pagehide', flush);
    // Refresh the inputs from storage (fresh read — popup.js's loadConfig may have painted older values).
    const paint = () => {
      try {
        chrome.storage.sync.get(KEYS, (vals) => {
          void chrome.runtime.lastError;
          for (const k of KEYS) {
            const el = document.getElementById(k);
            const v = vals && vals[k];
            if (!el || v === undefined || v === null || typed[k] || document.activeElement === el) continue;
            if (String(el.value) !== String(v)) el.value = String(v);
          }
        });
      } catch (_) {}
    };
    let paintedOnce = false;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !paintedOnce) return; // only after our first pull (loadConfig owns the first paint)
        if (KEYS.some(k => changes[k])) paint();
      });
    } catch (_) {}
    const pull = () => {
      try {
        chrome.runtime.sendMessage({ type: 'syncApplyPrefs' }, (res) => {
          void chrome.runtime.lastError;
          paintedOnce = true;
          // Always repaint: a sync started elsewhere (Start, dashboard) may have landed after loadConfig painted.
          paint(); setTimeout(paint, 1000);
        });
      } catch (_) {}
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(pull, 400));
    else setTimeout(pull, 400);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
