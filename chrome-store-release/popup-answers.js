// popup-answers.js — popup UI of "Application answers" (ext 2.5.124, 2026-10-20). Data + rules: application-answers.js.
// Header chip "Profile incomplete" → popover: what is missing, "Complete now" (focuses the popup field — Your info /
// Preferences — or, when only questions a job form asked are left, opens the dashboard "Application answers" section),
// "Later" (hidden 24 h) and a link to every answer on the dashboard. Missing popup fields get an amber outline.
// Labels come from job forms (untrusted page text) → DOM APIs + textContent only, never innerHTML.
(function () {
  'use strict';
  const AA = window.AAMAnswers;
  if (!AA || typeof chrome === 'undefined' || !chrome.runtime) return;
  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise(res => { try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || null); }); } catch (_) { res(null); } });

  const MISS_WORD = { expectedSalary: 'expected salary', city: 'city', currentSalary: 'current CTC', phone: 'phone',
    yearsOfExperience: 'years of experience', resume: 'resume file', nationality: 'nationality', postalCode: 'postal code',
    noticePeriod: 'notice period', dateOfBirth: 'date of birth', gender: 'gender' };
  // Popup field (id + tab) for each gap.
  const FIELD = { phone: ['phone', 'personal'], city: ['city', 'personal'], yearsOfExperience: ['yearsOfExperience', 'personal'], resume: ['uploadResumeBtn', 'personal'],
    expectedSalary: ['expectedSalary', 'settings'], currentSalary: ['currentSalary', 'settings'], nationality: ['nationality', 'settings'], postalCode: ['postalCode', 'settings'],
    noticePeriod: ['noticePeriod', 'settings'], dateOfBirth: ['dateOfBirth', 'settings'], gender: ['gender', 'settings'] };

  let state = { items: {}, answers: {}, settings: {} };
  let countryHint = '';
  let extra = { yearsOfExperience: '', hasResume: false };
  let laterUntil = 0;
  let runSess = null; // chrome.storage.local.eam_skip_session (current / last run)

  async function loadProfileState() {
    try {
      const s = await chrome.storage.sync.get(['country', 'phoneCountryCode', 'yearsOfExperience']);
      const l = await chrome.storage.local.get(['accountProfile', 'resumeFileName', AA.LATER_KEY, 'eam_skip_session']);
      runSess = l.eam_skip_session || null;
      countryHint = AA.countryHintFrom(s, l);
      extra = { yearsOfExperience: s.yearsOfExperience, hasResume: !!l.resumeFileName };
      laterUntil = Number(l[AA.LATER_KEY]) || 0;
    } catch (_) { countryHint = ''; }
  }

  async function refresh() {
    const r = await send({ type: 'answersState' });
    if (r && r.ok) state = r;
    await loadProfileState();
    render();
  }

  // Settings as typed in the popup right now (autosave may not have landed yet).
  function liveSettings() {
    const s = Object.assign({}, state.settings || {});
    for (const k of AA.SETTING_KEYS) { const el = $(k); if (el && 'value' in el && document.activeElement === el) s[k] = el.value; }
    return s;
  }
  function gaps() { return AA.profileGaps(liveSettings(), countryHint, extra, state.items || {}); }
  function customs() { return AA.customGaps(state.items || {}, state.answers || {}); }

  // 2.5.125 end-of-run line: "N jobs skipped because your <field> is missing → Add". Only the answers that are STILL
  // missing (filled since → the line goes); never blocks Start, never asks mid-apply.
  function runLine(g, c) {
    const box = $('run-missing'); const txt = $('run-missing-text'); if (!box || !txt) return;
    const miss = (runSess && runSess.missing) || {};
    const still = g.map(x => x.key).filter(k => (miss[k] || 0) > 0).sort((a, b) => (miss[b] || 0) - (miss[a] || 0));
    const custom = c.length > 0 && (miss.custom || 0) > 0;
    if (!still.length && !custom) { box.hidden = true; return; }
    const counts = still.map(k => miss[k]).concat(custom ? [miss.custom] : []);
    const sum = counts.reduce((a, b) => a + b, 0);
    const n = counts.length === 1 ? counts[0] : Math.max(Math.max.apply(null, counts), Math.min(sum, Number(runSess.missingJobs) || sum));
    const words = still.slice(0, 3).map(k => (k === 'currentSalary' && countryHint !== 'IN') ? 'current salary' : MISS_WORD[k] || k);
    if (still.length > 3) words.push(still.length - 3 === 1 ? '1 other answer' : (still.length - 3) + ' other answers');
    let what;
    if (words.length) {
      const all = custom ? words.concat('a job-form answer') : words;
      what = 'your ' + (all.length > 1 ? all.slice(0, -1).join(', ') + ' and ' + all[all.length - 1] : all[0]) + (all.length > 1 ? ' are missing' : ' is missing');
    } else what = c.length === 1 ? 'a job-form question has no saved answer' : c.length + ' job-form questions have no saved answer';
    txt.textContent = (n === 1 ? '1 job' : n + ' jobs') + ' skipped because ' + what;
    const add = $('run-missing-add');
    if (add) { add.textContent = still.length ? 'Add' : 'Answer'; add.dataset.key = still[0] || ''; }
    box.hidden = false;
  }
  function focusKey(key) {
    const [id, tab] = FIELD[key] || [];
    if (!id) { openDashboard('ext_run_summary'); return; }
    const t = document.querySelector(`.tab[data-tab="${tab}"]`); if (t) t.click();
    setTimeout(() => { const f = $(id); if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); } }, 60);
  }

  function render() {
    const wrap = $('pf-chip-wrap'); if (!wrap) return;
    const g = gaps(); const c = customs();
    try { runLine(g, c); } catch (_) {}
    // Amber outline on the popup fields that are missing (whatever "Later" says: it only hides the chip / badge).
    document.querySelectorAll('.pf-need').forEach(e => e.classList.remove('pf-need'));
    for (const x of g) { const f = FIELD[x.key] && $(FIELD[x.key][0]); if (f) f.classList.add('pf-need'); }
    const show = (g.length > 0 || c.length > 0) && !(laterUntil > Date.now());
    wrap.hidden = !show;
    document.body.classList.toggle('has-pf-chip', show);
    if (!show) { closePop(); return; }
    const words = g.map(x => (x.key === 'currentSalary' && countryHint !== 'IN') ? 'current salary' : MISS_WORD[x.key] || x.key);
    if (c.length) words.push(c.length === 1 ? '1 question from a job form' : c.length + ' questions from job forms');
    const list = words.length > 1 ? words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1] : words[0];
    $('pf-pop-list').textContent = list + '.';
    $('pf-chip').setAttribute('aria-label', 'Profile incomplete: ' + list + ' missing');
    $('pf-chip').title = 'Missing: ' + list;
    const go = $('pf-pop-go'); if (go) go.textContent = g.length ? 'Complete now' : 'Answer on dashboard';
  }
  function closePop() { const p = $('pf-pop'); if (p) p.hidden = true; const c = $('pf-chip'); if (c) c.setAttribute('aria-expanded', 'false'); }
  function togglePop() {
    const p = $('pf-pop'); if (!p) return;
    p.hidden = !p.hidden;
    $('pf-chip').setAttribute('aria-expanded', p.hidden ? 'false' : 'true');
    if (!p.hidden) { const b = $('pf-pop-go'); if (b) b.focus(); }
  }
  function openDashboard(src) {
    try { chrome.tabs.create({ url: AA.DASHBOARD_ANSWERS_URL.replace('?focus=answers', '?focus=answers&src=' + encodeURIComponent(src || 'ext_popup')) }); } catch (_) {}
  }
  function completeNow() {
    closePop();
    const g = gaps();
    if (!g.length) { openDashboard('ext_complete_now'); return; }
    const [id, tab] = FIELD[g[0].key] || [];
    const t = document.querySelector(`.tab[data-tab="${tab}"]`); if (t) t.click();
    setTimeout(() => { const f = $(id); if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); } }, 60);
  }
  async function later() {
    laterUntil = Date.now() + AA.LATER_MS;
    try { await chrome.storage.local.set({ [AA.LATER_KEY]: laterUntil }); } catch (_) {}
    render();
  }

  function init() {
    $('pf-chip')?.addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });
    $('pf-pop-go')?.addEventListener('click', completeNow);
    $('pf-pop-later')?.addEventListener('click', later);
    $('pf-pop-dash')?.addEventListener('click', (e) => { e.preventDefault(); closePop(); openDashboard('ext_popover_link'); });
    $('run-missing-add')?.addEventListener('click', (e) => { const k = e.currentTarget.dataset.key; if (k) focusKey(k); else openDashboard('ext_run_summary'); });
    document.addEventListener('click', (e) => { const p = $('pf-pop'); if (p && !p.hidden && !e.target.closest('#pf-chip-wrap')) closePop(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
    // Typing in a missing field clears its outline / the chip as soon as it has a value.
    document.addEventListener('input', (e) => { if (e.target && e.target.id && FIELD[Object.keys(FIELD).find(k => FIELD[k][0] === e.target.id)]) render(); });
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if ((area === 'local' && (ch[AA.ASKED_KEY] || ch[AA.ANS_KEY] || ch.resumeFileName || ch.eam_skip_session)) || (area === 'sync' && (AA.SETTING_KEYS.some(k => ch[k]) || ch.yearsOfExperience || ch.country))) refresh();
      });
    } catch (_) {}
    refresh();
    // Pull answers / questions saved on the dashboard (account), then repaint.
    send({ type: 'answersSync' }).then((r) => { if (r && r.changed) refresh(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.AAMPopupAnswers = { refresh, render, gaps, customs, focusKey, _state: () => state };
})();
