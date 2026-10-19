/**
 * AutoApplyMax - Bot Engine
 * Main loop extracted from content-simple.js.
 * Delegates all DOM interactions to the active adapter.
 * Namespace: window.EAM.BotEngine
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};
  const u = () => window.EAM.utils;
  // v2.5.115: consecutive result pages without one Easy Apply job before the run stops.
  const PAGES_WITHOUT_EASY_APPLY_STOP = 3;

  // v2.5.87: session start/stop telemetry → ext_diag_events (types already
  // allow-listed by ext-diag-ingest). LinkedIn only, fire-and-forget.
  function _diag(eventType, meta) {
    try {
      if (!/linkedin\.com$/i.test(location.hostname)) return;
      chrome.runtime.sendMessage({ type: 'eam-diag', event: { site: 'linkedin', event_type: eventType, url_path: location.pathname, meta: meta || {} } });
    } catch (_) {}
  }

  // v2.5.117: every run ends with exactly ONE session_end carrying a reason (telemetry 2026-10-16, 7 days: 196 of
  // 683 runs had none — a second Start superseded the loop, the adapter's daily-limit break, the tab closed /
  // reloaded). `run` ties session_start and session_end together.
  let _run = null; // { id, ended }
  function _runMeta(reason, extra) {
    const state = u() || {};
    let sess = null; try { sess = state.getSkipSession ? state.getSkipSession() : null; } catch (_) {}
    return Object.assign({ reason: String(reason || '').slice(0, 120), run: _run ? _run.id : null, applied: state.appliedCount || 0, skipped: state.skippedCount || 0 },
      sess ? { sess_applied: sess.applied, sess_skipped: sess.skipped, skip_reasons: sess.reasons } : {}, extra || {});
  }
  function _endSession(reason, extra) {
    if (!_run || _run.ended) return false;
    const meta = _runMeta(reason, extra);
    _run.ended = true;
    _diag('session_end', meta);
    return true;
  }
  // Search identity (same search = same list of jobs) — used to resume after a Stop without re-opening jobs.
  const _SEARCH_KEYS = ['keywords', 'location', 'geoId', 'f_AL', 'f_WT', 'f_E', 'f_JT', 'f_TPR', 'f_C', 'f_I', 'f_F', 'f_SB2', 'f_PP', 'sortBy', 'distance'];
  function _searchKey() {
    try { const q = new URLSearchParams(location.search); return location.pathname + '?' + _SEARCH_KEYS.filter(k => q.has(k)).map(k => k + '=' + q.get(k)).join('&'); } catch (_) { return location.pathname; }
  }
  const RESUME_MAX_MS = 2 * 3600 * 1000;

  // v2.5.92: an application dropped because a screening question needed AI
  // on the free plan — the popup explains it once after the run and offers
  // Premium (Théo 2026-09-27). Counts only while AI is premium-blocked.
  function _notePremiumSkip() {
    try {
      const ai = window.EAM && window.EAM.aiForm;
      if (!ai || !ai.isPremiumBlocked || !ai.isPremiumBlocked()) return;
      chrome.storage.local.get(['eam_ai_premium_notice'], (r) => {
        const n = (r && r.eam_ai_premium_notice) || { at: Date.now(), seen: false };
        chrome.storage.local.set({ eam_ai_premium_notice: { ...n, skipped: (n.skipped || 0) + 1 } });
      });
    } catch (_) {}
  }

  // v2.5.105: one repair pass per application on LinkedIn validation errors (see
  // FormFiller.repairValidationErrors). true = something was fixed → retry the step.
  async function _tryRepair(modal) {
    const st = u(); const FF = window.EAM && window.EAM.FormFiller;
    if (!FF || !FF.repairValidationErrors || (st._repairTried || 0) >= 1) return false;
    st._repairTried = (st._repairTried || 0) + 1;
    try {
      const r = await FF.repairValidationErrors(modal, st.config);
      st.log(`Validation errors — repair pass fixed ${r.fixed} field(s)`);
      if (r.fixed > 0) { await st.wait(800); return true; }
    } catch (e) { st.log('repair failed: ' + (e && e.message)); }
    return false;
  }
  // Which question / message made us discard — labels + LinkedIn messages only (no answers).
  function _skipDetail(reason, modal) {
    try {
      const FF = window.EAM && window.EAM.FormFiller;
      const errs = FF && FF.validationErrorDetails && modal ? FF.validationErrorDetails(modal) : [];
      const fails = (u()._unknownFieldLabels || []).slice(-3).map(s => String(s).slice(0, 100));
      // v2.5.106: 10 steps without Submit (MERITIS, live 2026-10-10) showed no LinkedIn error — list the
      // REQUIRED fields still empty on the stuck step (labels only, never values).
      const empty = [];
      const emptyMeta = {};
      try {
        const lab = (el) => {
          const id = el.id && modal.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          const fs = el.closest('fieldset'); const lg = fs && fs.querySelector('legend');
          // v2.5.109: native-dialog fields have an empty <label for> → the visible question (getFieldQuestion).
          let q = ''; try { q = FF && FF.getFieldQuestion ? FF.getFieldQuestion(el, modal) : ''; } catch (_) {}
          return String((id && id.textContent.trim()) || (lg && lg.textContent) || q || el.getAttribute('aria-label') || el.name || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 100);
        };
        for (const el of modal ? modal.querySelectorAll('input, select, textarea') : []) {
          if (empty.length >= 4) break;
          if (!(el.required || el.getAttribute('aria-required') === 'true') || el.type === 'hidden' || el.disabled) continue;
          if (el.type === 'radio' || el.type === 'checkbox') {
            const grp = el.name ? modal.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`) : [el];
            if ([...grp].some(r => r.checked)) continue;
          } else if (String(el.value || '').trim() && !/^select an option$|^s[ée]lectionnez/i.test(String(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : el.value).trim())) continue;
          const l = lab(el); if (l && !empty.includes(l)) { empty.push(l); try { emptyMeta[l.trim().toLowerCase().slice(0, 120)] = FF && FF.fieldMeta ? FF.fieldMeta(el, modal) : null; } catch (_) {} }
        }
      } catch (_) {}
      // 2026-10-19 "To complete": the job is kept with the exact questions that blocked it (never asked mid-apply).
      if (/^(questions|form_invalid|step_limit)$/.test(reason)) {
        try { _saveToComplete(reason, (u()._unknownFieldLabels || []).concat(empty), u()._missingSettings || [], Object.assign({}, emptyMeta, u()._unknownFieldMeta || {})); } catch (_) {}
      }
      // v2.5.109: where the form was stuck (native-dialog step_limit skips showed no error and no empty
      // field — ops alert 2026-10-12): progress ("3/4 pages" / "75 percent"), footer button labels,
      // aria-invalid count. Labels only, never answers.
      let where = {};
      try {
        const t = String(modal && modal.textContent || '');
        const pg = t.match(/(\d+)\s*\/\s*(\d+)\s*pages?/i) || t.match(/(\d{1,3})\s*(%|percent)/i);
        const btns = modal ? Array.from(modal.querySelectorAll('button')).filter(b => b.offsetParent !== null).map(b => String(b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 24)).filter(Boolean).slice(-4) : [];
        where = { prog: pg ? pg[0].slice(0, 20) : '', btns, inv: modal ? modal.querySelectorAll('[aria-invalid="true"]').length : 0, files: modal ? modal.querySelectorAll('input[type="file"]').length : 0 };
      } catch (_) {}
      // ext-diag-ingest replaces any meta > 800 bytes with {_truncated:true}: shorten the lists, and
      // the "where" fields only ride along when they still fit.
      const base = { reason, errs: errs.slice(0, 3), unknown: fails, empty, repaired: u()._repairTried || 0 };
      // v2.5.112: settings whose absence caused the skip (expectedSalary / currentSalary / postalCode) → popup hint.
      const miss = (u()._missingSettings || []).slice(0, 3);
      if (miss.length) { base.miss = miss; try { u().noteMissingSettings && u().noteMissingSettings(miss); } catch (_) {} try { _missingSettingNotice(miss); } catch (_) {} }
      const fit = (o) => JSON.stringify(o).length <= 780;
      if (!fit(base)) { base.unknown = base.unknown.map(s => s.slice(0, 50)); base.empty = base.empty.map(s => s.slice(0, 60)); base.errs = base.errs.map(e => ({ msg: String(e.msg || '').slice(0, 60), label: String(e.label || '').slice(0, 60) })); }
      _diag('form_skip_detail', fit({ ...base, ...where }) ? { ...base, ...where } : base);
    } catch (_) {}
  }

  // ─── 2026-10-19 "To complete" ───────────────────────────────────────────────────────────────────────
  // A job skipped on unanswerable REQUIRED questions is saved (service worker, to-complete.js) with those questions
  // (labels only) so the user answers once and re-applies. Unsupported questions (uploads, cover letter, experience
  // sub-forms) never make a job "to complete" on their own.
  function _saveToComplete(reason, labels, missing, meta) {
    const st = u();
    const QI = (window.EAM && window.EAM.QuestionIntents) || window.AAMQuestionIntents;
    if (!QI) return;
    const questions = QI.questionsForSkip(labels, missing, meta);
    if (!questions.length) return;
    const ji = st.currentJobInfo || {};
    const id = String(ji.jobId || (String(ji.link || '').match(/\/jobs\/view\/(\d{5,20})/) || [])[1] || st._currentJobId || '');
    if (!/^\d{5,20}$/.test(id)) return;
    const entry = { jobId: id, url: `https://www.linkedin.com/jobs/view/${id}/`, title: ji.title || '', company: ji.company || '', location: ji.location || '', questions, reason };
    try { chrome.runtime.sendMessage({ type: 'toCompleteAdd', entry }, () => void chrome.runtime.lastError); } catch (_) {}
    st._tcSavedRun = (st._tcSavedRun || 0) + 1;
    st.log(`Saved to "To complete": ${questions.length} question(s) to answer once (${questions.map(q => q.label.slice(0, 40)).join(' · ')})`);
    // One in-page hint per run (settings hints keep their own notice).
    if (!st._tcNoticeShown && st._showBotNotice && !(missing || []).length) {
      st._tcNoticeShown = true;
      try { st._showBotNotice('Saved to "To complete" — not lost', 'This job asked a question we have no answer for. Open the extension → To complete, answer it once, then click "Apply to these jobs now". The run goes on.', 'info'); } catch (_) {}
    }
  }

  // Re-apply mode: report this job's result to the service worker, then stop this page's run.
  async function _finishReapply() {
    const st = u(); const r = st._reapply;
    if (!r || r.reported) return;
    let result = 'not_found', why = '';
    if (r.done) {
      let applied = 0; try { applied = st.getSkipSession ? st.getSkipSession().applied : 0; } catch (_) {}
      if (applied > (r.appliedBefore || 0)) result = 'applied';
      else { why = String(st._lastSkipReason || ''); result = /^(already_applied|applied_pane|applied_nomodal)$/.test(why) ? 'already_applied' : 'skipped'; }
    }
    r.reported = true;
    st.log(`Re-apply result for job ${r.jobId}: ${result}${why ? ' (' + why + ')' : ''}`);
    try { chrome.runtime.sendMessage({ type: 'reapplyResult', jobId: r.jobId, result, reason: why }, () => void chrome.runtime.lastError); } catch (_) {}
    await stopBot('Re-apply: ' + result, result === 'not_found' ? { title: 'This job is not in the list LinkedIn showed', body: 'It may be closed. It stays in "To complete" — open it from there to check.', tone: 'info' } : null);
  }

  // v2.5.119: a job skipped because a setting is empty (current CTC, expected salary, postal code, birth date, gender) —
  // until now only the popup said so. The page now shows it too, next to Easy Apply, so the user fills it in.
  const _MISS_COPY = { expectedSalary: 'your expected salary', currentSalary: 'your current salary / CTC', postalCode: 'your postal code', dateOfBirth: 'your date of birth', gender: 'your gender' };
  function _missingSettingNotice(keys) {
    const st = u();
    st._missNoticeKeys = st._missNoticeKeys || {};
    let fresh = false;
    for (const k of keys || []) { if (_MISS_COPY[k]) { if (!st._missNoticeKeys[k]) fresh = true; st._missNoticeKeys[k] = (st._missNoticeKeys[k] || 0) + 1; } }
    if (!fresh && st._missNotice) return;
    const ks = Object.keys(st._missNoticeKeys);
    if (!ks.length || !st._showBotNotice) return;
    const what = ks.map(k => _MISS_COPY[k]);
    const list = what.length > 1 ? what.slice(0, -1).join(', ') + ' and ' + what[what.length - 1] : what[0];
    const n = ks.reduce((a, k) => a + st._missNoticeKeys[k], 0);
    st._missNotice = {
      title: 'Add ' + list + ' to apply to more jobs',
      body: (n === 1 ? 'A job asked for ' : n + ' jobs asked for ') + list + ' and it is empty in your settings, so they were skipped (never guessed). Open the AutoApplyMax extension → Preferences and fill it in; auto-apply keeps going meanwhile.',
    };
    st._showBotNotice(st._missNotice.title, st._missNotice.body, 'warn');
  }

  let activeAdapter = null;

  // v2.5.96: skip reasons of the current run → telemetry (scan_result once per
  // processed page). Only when something happened since the last snapshot.
  let _lastSnapKey = '';
  function _diagSkipSnapshot(eventType) {
    try {
      const s = u().getSkipSession && u().getSkipSession();
      if (!s || (!s.skipped && !s.applied)) return;
      const key = s.applied + '/' + s.skipped;
      if (key === _lastSnapKey) return;
      _lastSnapKey = key;
      _diag(eventType, { src: 'engine', sess_applied: s.applied, sess_skipped: s.skipped, skip_reasons: s.reasons });
    } catch (_) {}
  }

  // ─── Main loop ────────────────────────────────────────────────────────
  // Rate-limit tracking. Bail only after 4 consecutive rate-limit hits so
  // the bot gets a real chance to survive a LinkedIn cool-down window that
  // outlasts our first pause. Pause length grows with strike count so
  // LinkedIn's own timer has room to expire before we retry — a fixed 2-3
  // min pause was too short (LinkedIn re-fired the popup back-to-back and
  // the bot burned all 3 strikes in ~6 min, bailing instead of resuming).
  const RATE_LIMIT_STRIKE_LIMIT = 4;
  // Minutes to wait per strike (1-indexed). Last entry repeats if strikes
  // exceed the list length before hitting the bail-out.
  // v2.5.103 (Théo 2026-10-07): LinkedIn's throttle usually clears after a
  // couple of minutes, and a DIFFERENT offer whose Easy Apply opens is the
  // signal it's over. Telemetry (14 d): after the old 5-min pause the bot
  // re-hit the throttle at once by retrying the SAME job, then sat 8 + 12 min;
  // a user who stopped and restarted after ~1 min applied 4 jobs straight
  // away. Short pauses + resume on the next offer (the throttled one is
  // retried at the end of the list) + strikes reset after each real submit.
  const RATE_LIMIT_PAUSE_MINUTES = [2, 4, 8];

  async function handleRateLimit(adapter, state, source) {
    state.rateLimitStrikes = (state.rateLimitStrikes || 0) + 1;
    const strikes = state.rateLimitStrikes;

    if (strikes >= RATE_LIMIT_STRIKE_LIMIT) {
      const msg = 'LinkedIn keeps asking us to slow down, so auto-apply stopped to protect your account. Wait about 15 minutes, then click Start auto-apply again.';
      state.log('⏸ ' + msg);
      try { await chrome.storage.local.remove('eam_pause_state'); } catch (_) {}
      try { await adapter.discardApplication(); } catch (e) {}
      try {
        chrome.runtime.sendMessage({
          type: 'rateLimitStop',
          message: msg,
          strikes,
        });
      } catch (e) {}
      try {
        if (chrome.notifications && chrome.notifications.create) {
          chrome.notifications.create('eam-rate-limit', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: 'AutoApplyMax — short break',
            message: 'LinkedIn keeps asking us to slow down. Wait about 15 minutes, then click Start auto-apply again.',
            priority: 2,
          });
        }
      } catch (e) {}
      _diag('rate_limit_throttle', { phase: 'stop', strike: strikes, source });
      await stopBot('Rate limit (' + strikes + ' strikes)');
      return false; // signal: caller should break/return
    }

    const baseMin = RATE_LIMIT_PAUSE_MINUTES[strikes - 1] || RATE_LIMIT_PAUSE_MINUTES[RATE_LIMIT_PAUSE_MINUTES.length - 1];
    const pauseMinutes = baseMin + Math.random() * 0.5;
    const pauseMs = Math.round(pauseMinutes * 60 * 1000);
    _diag('rate_limit_throttle', { phase: 'pause', strike: strikes, pause_min: Math.round(pauseMinutes * 10) / 10, source });
    state.log('⏳ Waiting ~' + Math.round(pauseMinutes) + ' min to avoid LinkedIn rate limit — this keeps your account safe. Will resume automatically.');
    try { await adapter.discardApplication(); } catch (e) {}
    // v2.5.92: the popup + toolbar badge read this to show "Paused — resumes
    // in N min" (the popup never knew about a pause before, it said Running).
    try { await chrome.storage.local.set({ eam_pause_state: { until: Date.now() + pauseMs, strike: strikes, minutes: Math.round(pauseMinutes) } }); } catch (_) {}
    // v2.5.87: a silent throttle has no LinkedIn dialog for checkRateLimit to
    // replace — show our own pause notice so the user sees why nothing moves.
    try {
      if (!document.querySelector('[data-eam-rl-chip], [data-eam-rate-limit-replacement], #eam-rate-limit-banner') && state._showBotNotice) {
        state._showBotNotice('Paused ~' + Math.round(pauseMinutes) + ' min', 'LinkedIn asked us to slow down — auto-apply resumes automatically. Keep this tab open.', 'info');
      }
    } catch (_) {}
    await state.wait(pauseMs);
    try { await chrome.storage.local.remove('eam_pause_state'); } catch (_) {}
    try { state._clearBotNotice && state._clearBotNotice(); } catch (_) {}
    // v2.5.87: LinkedIn re-shows the same "temporarily paused" dialog DURING
    // our pause (live 2026-09-25 13:14:08, 48 s into the pause). The 2.5 s
    // poller hid it and set pendingRateLimitPause → right after resuming the
    // bot paused AGAIN as strike 2 (8 min) for the same throttle. A detection
    // made while we were already paused belongs to this pause.
    state.pendingRateLimitPause = false;
    if (!state.isRunning) return false; // user stopped while we slept
    // Restore anything we hid when the popup fired so the top of the
    // job page comes back after the pause (bug 2026-09-06: hidden
    // elements stayed hidden forever).
    try { state._restoreHiddenRateLimit && state._restoreHiddenRateLimit(); } catch (_) {}
    // v2.5.85: also remove the inline chip we placed next to Easy Apply.
    // _restoreHiddenRateLimit already calls _removeInlineChip, but engine
    // holds a direct ref via state so double-call is defense-in-depth
    // (if utils failed to export, chip still gets swept from here).
    try { state._removeInlineChip && state._removeInlineChip(); } catch (_) {}
    try {
      const banner = document.getElementById('eam-rate-limit-banner');
      if (banner) banner.remove();
    } catch (_) {}
    // 2026-09-18: actively dismiss any LinkedIn dialog that stuck around
    // during the pause — the rate-limit / "Something went wrong" popup may
    // still be visible after our restore, and if we don't close it the
    // very next Easy Apply click hits the same modal + bails. Look for
    // Got it / Dismiss / Close / OK in both light DOM and the interop
    // shadow root.
    try {
      const findDismissBtn = (root) => {
        if (!root || !root.querySelector) return null;
        const bySel = root.querySelector(
          'button[aria-label*="Got it" i], button[aria-label*="Dismiss" i], button[aria-label*="Close" i], .artdeco-modal__dismiss'
        );
        if (bySel) return bySel;
        const btns = root.querySelectorAll ? root.querySelectorAll('button') : [];
        return [...btns].find(b => /^got it$|^j.ai compris$|^fermer$|^ok$|^close$|^try\s+again$|^réessayer$/i.test((b.textContent || '').trim())) || null;
      };
      let sr = null;
      try { sr = document.getElementById('interop-outlet')?.shadowRoot || null; } catch (_) {}
      for (let i = 0; i < 3; i++) {
        const btn = findDismissBtn(document) || findDismissBtn(sr);
        if (!btn) break;
        try { btn.click(); } catch (_) {}
        await state.wait(300);
      }
    } catch (_) {}
    // Give LinkedIn a beat to settle before we start clicking again.
    await state.wait(1200);
    state.log('▶ Resuming auto-apply.');
    _diag('rate_limit_throttle', { phase: 'resume', strike: strikes, source });
    try { if (adapter) adapter._rateLimitHit = false; } catch (_) {}
    state.updateActivity();
    return true; // signal: keep looping
  }

  // v2.5.119 (live telemetry 2.5.117, 2026-10-16/17): LinkedIn's "Nous n’avons pas pu envoyer votre candidature.
  // Veuillez réessayer." / "We couldn't submit your application" = LinkedIn refusing submits for a while (66
  // form_invalid skips in a row for one user, 55 submit_failed for another — the bot burnt through the list). Treated
  // like the throttle: in-place pause notice, auto-resume, strike count (4th → stop), rate_limit_throttle telemetry
  // with source "submit error". null = no such message on screen.
  async function _submitErrorPause(adapter, state, modal, where) {
    let t = '';
    try { t = state.findSubmitErrorToast ? state.findSubmitErrorToast(modal) : ''; } catch (_) { t = ''; }
    if (!t) return null;
    state.log(`⏸ LinkedIn did not accept the application ("${t.slice(0, 90)}") — LinkedIn is slowing applications down, pausing like a rate limit`);
    const keep = await handleRateLimit(adapter, state, 'submit error (' + where + ')');
    return keep ? 'paused' : 'stop';
  }

  // v2.5.93: one main loop at a time (see the 'start' handler).
  let loopGen = 0;
  let loopPromise = null;

  async function mainLoop(adapter, gen = loopGen) {
    activeAdapter = adapter;
    const state = u();
    const stale = () => gen !== loopGen;

    // Reset rate-limit strikes for this session — cumulative across the
    // whole bot run, but cleared on every fresh Start click.
    state.rateLimitStrikes = 0;

    // Triple-layer security
    if (!state.isRunning) { state.log('SECURITY BLOCK 1/3: isRunning=false'); if (!stale()) _endSession('Not running at loop start'); return; }
    if (!state.userExplicitlyClickedStart) {
      state.log('SECURITY BLOCK 2/3: user did NOT click Start');
      state.isRunning = false;
      await chrome.storage.local.set({ isRunning: false });
      if (!stale()) _endSession('Start not confirmed by the user');
      return;
    }
    if (!state.config || !state.config.email) {
      state.log('SECURITY BLOCK 3/3: No config loaded');
      state.isRunning = false;
      state.userExplicitlyClickedStart = false;
      await chrome.storage.local.set({ isRunning: false });
      if (!stale()) _endSession('No settings loaded (email missing)');
      return;
    }

    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: green; font-weight: bold;');
    console.log(`%c BOT STARTED on ${adapter.siteName}`, 'color: green; font-weight: bold; font-size: 14px;');
    console.log('%c ALL SECURITY CHECKS PASSED', 'color: green; font-weight: bold;');
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: green; font-weight: bold;');

    // ── FOCUS WARNING (Skas bug 2026-08-12) ─────────────────────────────
    // On LinkedIn, Chrome throttles synthetic MouseEvents + React's
    // delegated onClick handlers on tabs that don't have focus. Result:
    // card clicks fire but React ignores them → currentJobId never updates
    // → every card marked stale. Detected via `document.hasFocus() === false`
    // in the DIAG block. Warn the user proactively so they know to keep
    // the LinkedIn tab focused (not just visible in a background window).
    if (!document.hasFocus()) {
      state.log('⚠ LinkedIn tab is not focused. Chrome throttles event dispatch on background tabs — auto-apply may skip jobs silently.');
      state.log('   Click on this tab (bring it to the foreground) for the bot to work reliably.');
      console.warn('[EAM] docHasFocus=false at bot start — user should focus the LinkedIn tab');
    }

    // Nudge: on LinkedIn search-results without the Easy Apply filter, most
    // jobs are external Apply (non-EA) and get skipped — user thinks the bot
    // isn't working when it's actually behaving correctly. Ege 2026-09-07
    // cancelled Premium 2 min after this exact scenario. Show a friendly
    // banner directing them to check `Easy Apply` filter.
    try {
      // Only nudge on LinkedIn search-list URLs when the filter is missing.
      // Skip when the URL path is ALREADY an Easy-Apply-only context, e.g.
      // /jobs/collections/easy-apply/ (LinkedIn's own EA-only page).
      // Skip on /jobs/view/{id} (single job detail, not a list).
      const href = location.href;
      const isSearchList = /\/jobs\/(search|search-results|collections)\//i.test(href);
      const isJobView = /\/jobs\/view\//i.test(href);
      const hasFilter = /[?&]f_AL=true/i.test(href);
      const isImplicitEasyApply = /\/collections\/easy-apply\//i.test(href) || /\/easy-apply\//i.test(href);
      if (adapter.siteName === 'LinkedIn' && isSearchList && !isJobView && !hasFilter && !isImplicitEasyApply) {
        state._showEasyApplyFilterHint && state._showEasyApplyFilterHint();
        state.log('ℹ Easy Apply filter is OFF — most external Apply jobs will be skipped. Enable the "Easy Apply" chip in the LinkedIn toolbar for best results.');
      }
    } catch (_) {}

    await adapter.onStart();

    // If we're on a form-only page (e.g. smartapply.indeed.com), skip job browsing
    if (adapter.isFormOnlyPage && adapter.isFormOnlyPage()) {
      state.log('Form-only page detected — running form filler directly');
      await formOnlyLoop(adapter);
      return;
    }

    while (state.isRunning && !stale()) {
      try {
        // Detect if LinkedIn stripped our search filter mid-run (e.g.
        // rate-limit response redirects to /jobs/search-results/ without
        // f_AL=true). Try to auto-recover by navigating back to the
        // original URL — LinkedIn's SPA re-hydrates with the filter
        // restored, and the loop resumes on the next iteration. Only
        // give up after 3 consecutive drops (real LinkedIn block signal).
        //
        // Skas bug report 2026-08-14: "It would apply for 5-6 minutes,
        // but every few minutes it refreshes the page automatically and
        // removes the easy apply filter, and then skips rest of the jobs."
        // Previous behavior stopped hard on first drop → user had to
        // manually re-select filter + click Start. New behavior recovers
        // silently (up to 3×) so the run continues.
        if (state._startHadFilter && /\/jobs\/search-results\//i.test(window.location.pathname)) {
          const stillHasFilter = adapter.isEasyApplyFilterOn ? adapter.isEasyApplyFilterOn() : /[?&]f_AL=true/i.test(window.location.href);
          if (!stillHasFilter) {
            state._filterDropRecoveries = (state._filterDropRecoveries || 0) + 1;
            // v2.5.87: NO navigation. The old fix assigned window.location.href
            // = full page load = injected engine destroyed (isRunning lost,
            // the "keeps refreshing, applies to nothing" reports). Re-enable
            // the filter in place by clicking LinkedIn's own Easy Apply chip;
            // if that fails, stop cleanly with a visible message.
            const restored = state._filterDropRecoveries <= 3 && adapter.restoreEasyApplyFilter
              ? await adapter.restoreEasyApplyFilter()
              : false;
            if (!restored) {
              state.log('⏸ LinkedIn removed the Easy Apply filter and it could not be restored in place.');
              await stopBot('LinkedIn dropped the Easy Apply filter', {
                title: 'Easy Apply filter was removed',
                body: 'LinkedIn reset your search filters. Turn the "Easy Apply" filter back on, then click Start again.',
              });
              break;
            }
            state.log(`✓ Easy Apply filter re-enabled in place (attempt ${state._filterDropRecoveries}/3)`);
            state.updateActivity();
            continue;
          }
          // Filter is intact — reset the recovery counter so we don't carry
          // strikes across separate LinkedIn hiccups spread hours apart.
          if (state._filterDropRecoveries) state._filterDropRecoveries = 0;
        }

        // Daily limit
        if (adapter.checkDailyLimit()) {
          state.log('Stopping bot: Daily limit reached');
          await stopBot('Daily limit reached');
          break;
        }

        // Rate limit (LinkedIn "fast pace" warning) — pause + retry, but
        // give up after RATE_LIMIT_STRIKE_LIMIT consecutive hits so we
        // don't accumulate a deeper LinkedIn-side block.
        // Two signals:
        //   1. Fresh detection via adapter.checkRateLimit() (main-loop poll).
        //   2. state.pendingRateLimitPause flag set by utils's 2.5s background
        //      poller — catches the toast when it appeared BETWEEN main-loop
        //      iterations (e.g. while we were sleeping in isLoading or filling
        //      a form). Without this, the engine was still trying to click
        //      Easy Apply while the LinkedIn "applying at a fast pace" toast
        //      was showing (2026-09-07 Théo live report).
        if (adapter.checkRateLimit() || state.pendingRateLimitPause) {
          state.pendingRateLimitPause = false;
          const keepGoing = await handleRateLimit(adapter, state, 'main loop');
          if (!keepGoing) break;
          continue;
        }

        // Stuck detection — in-place recovery only (v2.5.87: never reload,
        // on any layout). 2 attempts, then a clean stop with a message.
        if (state.isStuck()) {
          state._stuckRecoveries = (state._stuckRecoveries || 0) + 1;
          if (state._stuckRecoveries > 2) {
            await stopBot('Stuck — no progress after in-place recovery', {
              title: 'Paused — the page stopped responding',
              body: 'Scroll the job list or change page, then click Start again.',
            });
            break;
          }
          state.log(`STUCK: no activity for 2 min — in-place recovery ${state._stuckRecoveries}/2 (no page reload)`);
          await adapter.recoverInPlace();
          state.updateActivity();
          continue;
        }

        // Get job cards
        const jobCards = adapter.getJobCards();
        // Adapter can flag the current page as unsupported — stop cleanly
        // instead of looping/refreshing (which disconnects the user from
        // LinkedIn). Used for the new flat-list `<a href>` layout where
        // there's no in-place Easy Apply modal flow.
        if (adapter._unsupportedLayout) {
          state.log('Stopping: unsupported page layout (see warnings above)');
          await stopBot('Unsupported page layout');
          break;
        }
        if (jobCards.length === 0) {
          // v2.5.87: no reload. Scroll to wake lazy lists (3 tries, ~15s),
          // then stop cleanly with a visible message.
          state._emptyScans = (state._emptyScans || 0) + 1;
          if (state._emptyScans > 3) {
            await stopBot('No jobs found on this page', {
              title: 'No Easy Apply jobs found on this page',
              body: 'Change your search (keywords, location, Easy Apply filter) and click Start again.',
            });
            break;
          }
          state.log(`No jobs found — in-place retry ${state._emptyScans}/3 (scroll, no reload)`);
          await adapter.recoverInPlace();
          await state.wait(2500);
          continue;
        }
        state._emptyScans = 0;
        state._stuckRecoveries = 0;

        state.log(`${jobCards.length} jobs found`);
        state.updateActivity();

        // 2026-09-15 fix (#874): track consecutive stale-ref skips. LinkedIn
        // re-renders card list after some applies + on auto-pagination — our
        // jobCards[i] then points to detached DOM nodes. After N in a row,
        // scroll to bottom + re-query to force fresh refs so we don't lose
        // jobs 21-25 of every batch.
        let _staleStreak = 0;
        let _jobCards = jobCards;
        // v2.5.115: per page — cards evaluated for the first time / of those, cards with nothing to apply to
        // (not Easy Apply, no Apply button, already applied).
        let _pageNew = 0, _pageNoApply = 0, _pageResumed = 0;
        if (!state._evaluatedJobIds) state._evaluatedJobIds = new Set();
        let _lastStaleRefreshAt = 0;
        const _STALE_REFRESH_COOLDOWN_MS = 30000;
        // Process each job
        for (let i = 0; i < _jobCards.length; i++) {
          if (!state.isRunning) break;
          // Adapter-driven hard stop. Currently only the LinkedIn adapter
          // sets this — fires when LinkedIn's daily Easy Apply popup is
          // detected. Without this, every remaining card would burn its
          // 20s isLoading timeout for no reason, and the user would see
          // "skip" on the next ~24 cards before the loop ran out.
          if (adapter.shouldStopIteration && adapter.shouldStopIteration()) {
            state.log('⚠ Adapter requested a hard stop (e.g. daily limit reached). Stopping iteration.');
            // v2.5.117: was `isRunning = false; break` — no session_end, no daily notice, no daily_limit_reached
            // event on this path (only set by the adapter's daily-limit detection).
            await stopBot('Daily limit reached');
            break;
          }
          // v2.5.87: LinkedIn can drop f_AL mid-list (seen live 2026-09-25 right
          // after an apply on /jobs/search-results/). The filter check only ran
          // in the outer loop, which this 25-card loop never returned to → 12 min
          // of skipping non-Easy-Apply / stale cards. Hand back to the outer loop.
          if (state._startHadFilter && /\/jobs\/search-results\//i.test(window.location.pathname) &&
              !(adapter.isEasyApplyFilterOn ? adapter.isEasyApplyFilterOn() : /[?&]f_AL=true/i.test(window.location.href))) {
            state.log('⚠ Easy Apply filter dropped mid-list — handing back to the main loop to restore it');
            break;
          }
          // v2.5.87: a throttle flagged between cards (background poller or the
          // adapter's pre-modal check) pauses HERE, before touching the next card.
          if (state.pendingRateLimitPause) {
            state.pendingRateLimitPause = false;
            const keepGoing = await handleRateLimit(adapter, state, 'between cards');
            if (!keepGoing) break;
          }
          // v2.5.87: read from _jobCards (the list re-queried after stale refs).
          // Reading the original `jobCards` kept re-using the detached nodes after
          // a re-query → the same stale cards forever ("0 applied, 188 skipped").
          const jobCard = _jobCards[i];
          state.log(`\n--- Job ${i + 1}/${_jobCards.length} ---`);
          console.log(`[EAM][mainLoop] Processing job ${i + 1}/${_jobCards.length}, URL:`, window.location.href);

          // Reset per-job counters that the form-filler / step loop use
          // to detect "stuck on unanswerable field" scenarios.
          state._unknownFieldFails = 0;
          state._unknownFieldLabels = [];
          state._unknownFieldMeta = {};
          state._missingSettings = [];
          state._repairTried = 0;
          // v2.5.119: keep the "add your <setting>" hint visible in the page while the run goes on (LinkedIn re-renders
          // the job pane on every job, which removes it).
          try { if (state._missNotice && state._showBotNotice && !document.querySelector('[data-eam-bot-notice]')) state._showBotNotice(state._missNotice.title, state._missNotice.body, 'warn'); } catch (_) {}

          // Cleanup leftover modal — but only if it actually contains form
          // fields. After a successful submit, LinkedIn briefly leaves a
          // "Application sent" / "Done" success dialog in the DOM (or in
          // the shadow root on /jobs/search-results/). That dialog has no
          // inputs, so trying to discardApplication() on it just spins.
          //
          // SAFETY NET: if the same un-clearable dialog is still detected
          // after 2 cleanup attempts, stop trying and proceed to the next
          // card without skipping. This prevents the bot from looping
          // forever on a dialog that getFormModal mis-identified as EA
          // (e.g., LinkedIn renamed an internal class and a non-EA dialog
          // now matches the fingerprint) — better to ignore the dialog
          // and try processing jobs than to skip 25 cards in a row.
          state._staleDialogFails = state._staleDialogFails || 0;
          let leftoverModal = adapter.getFormModal();
          const hasFormFields = leftoverModal &&
            leftoverModal.querySelectorAll &&
            leftoverModal.querySelectorAll('input, textarea, select').length > 0;
          const shouldTryCleanup = leftoverModal && state.isShown(leftoverModal)
            && hasFormFields && state._staleDialogFails < 2;
          if (shouldTryCleanup) {
            state.log('Modal from previous job still open! Cleaning up...');
            await adapter.discardApplication();
            await state.wait(1000);
            leftoverModal = adapter.getFormModal();
            const stillHasFields = leftoverModal &&
              leftoverModal.querySelectorAll &&
              leftoverModal.querySelectorAll('input, textarea, select').length > 0;
            if (leftoverModal && state.isShown(leftoverModal) && stillHasFields) {
              state._staleDialogFails++;
              state.log('Cleanup failed (' + state._staleDialogFails + '/2). ' +
                       (state._staleDialogFails < 2 ? 'Will retry on next card.' : 'Giving up — proceeding past stale dialog.'));
              state.noteSkip('stale_dialog');
              continue;
            }
            // Cleanup succeeded — reset counter
            state._staleDialogFails = 0;
          } else if (leftoverModal && state._staleDialogFails >= 2) {
            // Already tried & failed twice; the dialog is benign noise.
            // Don't skip the card — let the normal apply flow proceed.
            state.log('Stale dialog persists but cleanup gave up — processing card anyway');
          }

          // v2.5.115: a job already evaluated in this run is never re-evaluated (live 2026-10-16: the same
          // 11 cards were re-opened every ~30 s for an hour after a wrong "next page", skips 615 → 1,562).
          const _cardJobId = adapter.getCardJobId ? adapter.getCardJobId(jobCard) : null;
          // 2026-10-19 re-apply mode ("To complete" → Apply to these jobs now): only the queued job, once.
          if (state._reapply) {
            if (state._reapply.done) break;
            if (!_cardJobId || String(_cardJobId) !== state._reapply.jobId) continue;
            state._reapply.done = true;
            try { state._reapply.appliedBefore = state.getSkipSession ? state.getSkipSession().applied : 0; } catch (_) { state._reapply.appliedBefore = 0; }
            state._lastSkipReason = '';
            state._evaluatedJobIds && state._evaluatedJobIds.delete(_cardJobId);
          }
          if (_cardJobId) {
            if (state._evaluatedJobIds.has(_cardJobId)) {
              if (state._resumedJobIds && state._resumedJobIds.has(_cardJobId)) { _pageResumed++; console.log('[EAM][mainLoop] job ' + _cardJobId + ' already checked before Stop — skipped without re-opening'); }
              else console.log('[EAM][mainLoop] job ' + _cardJobId + ' already checked in this run — skipped without re-opening');
              continue;
            }
            state._evaluatedJobIds.add(_cardJobId);
            state._currentJobId = _cardJobId;
          }
          _pageNew++;

          // Extract job info
          const jobInfo = adapter.getJobInfo(jobCard);
          // v2.5.97: the AI layer answers "what position are you looking for?" with the job
          // being applied to (live 2026-10-03: the AI invented "Directeur Financier").
          try { state.currentJobInfo = { title: jobInfo && jobInfo.title || '', company: jobInfo && jobInfo.company || '', link: jobInfo && jobInfo.link || '', location: jobInfo && jobInfo.location || '', jobId: _cardJobId || '' }; } catch (_) {}

          // Blacklist check
          if (state.shouldSkipByBlacklist(jobInfo.title, jobInfo.company, jobInfo.description, state.config.blacklistKeywords)) {
            state.noteSkip('blacklist');
            continue;
          }

          // Experience check (adapter-specific)
          // v2.5.96: the user's own years of experience are the floor (see utils.effectiveMaxYears).
          const _maxYears = state.effectiveMaxYears ? state.effectiveMaxYears(state.config.maxYearsRequired, state.config.yearsOfExperience) : parseInt(state.config.maxYearsRequired, 10);
          if (adapter.shouldSkipByExperience && adapter.shouldSkipByExperience(jobCard, _maxYears)) {
            state.noteSkip('years_card');
            continue;
          }

          // Fast pre-check: skip non-Easy Apply jobs instantly (LinkedIn only).
          // BUT: LinkedIn lazy-renders cards outside the viewport via an
          // internal virtualization container (Ember `occludable-update`
          // mixin). The <li data-occludable-job-id> exists but its inner
          // HTML is just `<!---->` until the internal observer hydrates
          // it — which doesn't fire from a window scrollIntoView. If we
          // pre-skip an empty card via isEasyApply, we lose 17/24 cards on
          // /jobs/collections/recommended/, producing the
          // "0 applied 172 skipped" pattern (fixed 2026-08-02).
          //
          // Fix: on empty card, DON'T skip — let clickJobCard() run
          // (it does scrollIntoView + click which forces hydration).
          // The subsequent getApplyButton() check on the detail pane
          // will still correctly filter non-Easy-Apply jobs.
          const cardHydrated = jobCard && (jobCard.textContent || '').trim().length >= 20;
          if (cardHydrated && adapter.isEasyApply && !adapter.isEasyApply(jobCard)) {
            const _applied = adapter.isAlreadyAppliedCard && adapter.isAlreadyAppliedCard(jobCard);
            state.log(_applied ? 'Already applied (card badge) — skip' : 'Not Easy Apply (card badge) — skip');
            state.noteSkip(_applied ? 'already_applied' : 'not_easy_apply');
            _pageNoApply++;
            continue;
          }

          // Click job card. clickJobCard returns false when URL didn't
          // change within ~3s (stale card reference — LinkedIn re-rendered
          // the list after a previous successful submit, and our cached
          // jobCards[i] now points to a detached node). Skip cleanly so
          // the engine doesn't query getApplyButton against the previous
          // job's pane and waste 5s in modal poll.
          const clickOk = await adapter.clickJobCard(jobCard);
          if (clickOk === false) {
            state.log('Card click did not navigate (stale ref) — skip');
            state.noteSkip('stale_card');
            if (_cardJobId) state._evaluatedJobIds.delete(_cardJobId); // not really evaluated — may be retried after a re-query
            _pageNew--;
            _staleStreak++;
            // #874 fix: after 3 consecutive stale refs, force LinkedIn to
            // hydrate fresh cards (scroll bottom + re-query). Reset i to
            // current index so we continue with the new list. 30s cooldown
            // between refreshes to avoid infinite loop when rate-limit
            // banner blocks all clicks.
            const _now = Date.now();
            if (_staleStreak >= 3 && (_now - _lastStaleRefreshAt) > _STALE_REFRESH_COOLDOWN_MS && /^linkedin$/i.test(adapter.siteKey)) {
              _lastStaleRefreshAt = _now;
              state.log(`⚠ ${_staleStreak} consecutive stale refs — re-querying jobCards`);
              try {
                window.scrollTo(0, document.body.scrollHeight);
                await state.wait(1500);
                window.scrollTo(0, 0);
                await state.wait(800);
                const fresh = adapter.getJobCards();
                if (fresh && fresh.length > _jobCards.length - i) {
                  state.log(`   Refreshed: ${fresh.length} cards (was ${_jobCards.length - i - 1} remaining)`);
                  _jobCards = fresh;
                  i = -1; // reset — for-loop will ++ to 0
                  _staleStreak = 0;
                }
              } catch (e) { state.log('  re-query failed: ' + e.message); }
            }
            continue;
          }
          _staleStreak = 0;

          // FAST silently-applied pre-check (LinkedIn only). Some already-
          // applied jobs don't show the "Applied ·" badge on the card text
          // (the badge is added when applying via THIS bot/extension and
          // sometimes missing for old applications). After clickJobCard
          // succeeded (currentJobId switched), the right pane shows
          // "Application status / Application submitted / X ago" instead
          // of the Easy Apply form. Detect this in <1s by scanning the
          // shadow root + body for the indicator. Skip immediately —
          // saves the 5s modal-poll wait per silently-applied job.
          if (/^linkedin$/i.test(adapter.siteKey)) {
            await state.wait(400); // give pane content a beat to render
            try {
              // v2.5.96: focused job only (job-list card texts cut out) — see
              // linkedin-adapter.isFocusedJobApplied.
              if (adapter.isFocusedJobApplied && adapter.isFocusedJobApplied()) {
                state.log('Silently-applied (right-pane indicator) — skip');
                state.noteSkip('applied_pane');
                _pageNoApply++;
                continue;
              }
            } catch (e) {}
          }

          // v2.5.98: the user's blacklist also applies to the focused job's type pills
          // ("Internship" / "Stage" / "Alternance"): live 2026-10-03, a VINCI internship ad whose
          // title had no internship word was applied to with "stage, internship" blacklisted.
          // v2.5.104: the blacklist also runs on the FOCUSED job's title — the card title can be
          // empty when the first check runs (live 2026-10-08: "Stage - Assistant Chef de Projet"
          // reached the form, the bot answered "Oui" to "stage de fin d'études ?").
          try {
            if (adapter.getFocusedJobTitle && state.config.blacklistKeywords) {
              const ft = adapter.getFocusedJobTitle();
              if (ft && state.shouldSkipByBlacklist(ft, '', '', state.config.blacklistKeywords)) {
                state.noteSkip('blacklist');
                continue;
              }
            }
          } catch (_) {}
          try {
            if (adapter.getFocusedJobTags && state.config.blacklistKeywords) {
              const tags = adapter.getFocusedJobTags();
              if (tags.length && state.shouldSkipByBlacklist(tags.join(' · '), '', '', state.config.blacklistKeywords)) {
                state.log(`Skip: job type tag "${tags.join(', ')}" is in your blacklist`);
                state.noteSkip('blacklist');
                continue;
              }
            }
          } catch (_) {}

          // v2.5.89: "Max years required" setting, read from the job DESCRIPTION.
          // shouldSkipByExperience() above only sees card titles, where LinkedIn
          // never states the requirement → the setting was effectively ignored.
          try {
            const maxY = _maxYears;
            if (maxY > 0 && adapter.getJobDescriptionText && state.extractRequiredYears) {
              const req = state.extractRequiredYears(adapter.getJobDescriptionText());
              if (req > maxY) {
                state.log(`Skip: job asks for ${req}+ years of experience (your max: ${maxY}, setting ${state.config.maxYearsRequired}, your experience ${state.config.yearsOfExperience || '?'})`);
                state.noteSkip('years_req');
                continue;
              }
            }
          } catch (_) {}

          // Wait for apply button to load (Indeed renders it asynchronously via React)
          let applyBtn = null;
          for (let attempt = 1; attempt <= 6; attempt++) {
            applyBtn = adapter.getApplyButton();
            if (applyBtn) break;
            if (attempt < 6) {
              state.log(`Waiting for Apply button... (${attempt}/6)`);
              await state.wait(800);
            }
          }
          if (!applyBtn) {
            state.log('No Apply button after waiting, skip');
            state.noteSkip('no_apply_btn');
            _pageNoApply++;
            continue;
          }

          // Save job info before clicking Apply (in case of redirect, e.g. Indeed)
          try {
            await chrome.storage.local.set({ currentIndeedJob: jobInfo });
          } catch (e) {}

          // Snapshot URL pre-click so we can detect navigation. If LinkedIn
          // navigates to /jobs/view/JOBID/apply/ instead of opening the
          // in-place modal (some page layouts), the search list is gone
          // and our cards array is invalid — abort cleanly rather than
          // iterating against stale references.
          const urlBeforeApply = window.location.href;
          await state.click(applyBtn);
          await state.wait(800);
          const urlAfterApply = window.location.href;
          let navigatedAway =
            urlAfterApply !== urlBeforeApply &&
            (/\/jobs\/view\//i.test(urlAfterApply) ||
             !/\/jobs\/(search|search-results|collections)/i.test(urlAfterApply));
          // v2.5.88: LinkedIn (2026-09-26) opens the Easy Apply form as a native
          // <dialog> OVER the search list and swaps the URL to /jobs/view/<id>/
          // (SPA overlay, list still mounted). That is in-place — only a real page
          // change (no dialog, /apply/ route, non-jobs page) is "navigated away".
          if (navigatedAway && /\/jobs\/view\/\d+\/?(\?|$)/i.test(urlAfterApply)) {
            for (let i = 0; i < 8 && navigatedAway; i++) {
              try { if (adapter.getFormModal && adapter.getFormModal()) navigatedAway = false; } catch (_) {}
              if (navigatedAway) await state.wait(400);
            }
            if (!navigatedAway) state.log('Easy Apply dialog opened as an overlay (URL /jobs/view/…) — continuing in place');
          }
          if (navigatedAway) {
            state.log('⚠ Page navigated away after clicking Apply — search context lost');
            state.log('   Was: ' + urlBeforeApply.slice(0, 100));
            state.log('   Now: ' + urlAfterApply.slice(0, 100));
            state.log('   This page layout doesn\'t support in-place Easy Apply.');
            state.log('   Try /jobs/collections/easy-apply/ or /jobs/search/?f_AL=true');
            await stopBot('Page navigated away — unsupported layout');
            break;
          }

          // v2.5.90: layout fingerprint once the Easy Apply form is up — emitted
          // once per distinct combination per session (low volume).
          try {
            if (adapter.layoutFingerprint) {
              await state.wait(600);
              const fp = adapter.layoutFingerprint();
              state._fpSeen = state._fpSeen || new Set();
              if (fp && fp.modal !== 'none' && !state._fpSeen.has(fp.key)) { state._fpSeen.add(fp.key); _diag('modal_open', { fp }); }
            }
          } catch (_) {}

          // ── Safety reminder modal ("Continue applying") ─────────────
          // LinkedIn sometimes shows a "Job search safety reminder" dialog
          // with "Review job post" and "Continue applying" buttons.
          // We must click "Continue applying" to proceed.
          const safetyModal = document.querySelector('[role="dialog"], .artdeco-modal');
          if (safetyModal && state.isShown(safetyModal)) {
            const safetyText = safetyModal.textContent.toLowerCase();
            if (safetyText.includes('safety reminder') || safetyText.includes('rappel de sécurité') ||
                safetyText.includes('continue applying') || safetyText.includes('continuer à postuler')) {
              state.log('Safety reminder detected — clicking Continue applying...');
              const continueBtn = Array.from(safetyModal.querySelectorAll('button')).find(btn => {
                const t = btn.textContent.trim().toLowerCase();
                return t.includes('continue applying') || t.includes('continuer à postuler') ||
                       t.includes('continue') || t.includes('continuer');
              });
              if (continueBtn) {
                await state.click(continueBtn);
                state.log('Safety reminder dismissed');
                await state.wait(1000);
              }
            }
          }

          // ── Indeed: new-tab apply flow ──────────────────────────────
          // Indeed opens a new tab for SmartApply — wait for it to complete
          if (adapter.opensNewTab && adapter.opensNewTab()) {
            console.log('[EAM][mainLoop] Indeed new-tab flow started for:', jobInfo.title, '|', jobInfo.company);
            console.log('[EAM][mainLoop] Current URL:', window.location.href);
            state.log('Apply opened new tab — waiting for SmartApply to complete...');

            // Save our tab ID so background.js knows where to switch back
            try { chrome.runtime.sendMessage({ type: 'saveSearchTabId' }); } catch (e) {}

            // Clear any previous completion flag
            await chrome.storage.local.set({ indeedApplyComplete: false });

            // Wait for completion using EVENT LISTENERS (not throttled in background tabs)
            // Chrome throttles setInterval in background tabs to ~1/min, so we use:
            // 1. chrome.runtime.onMessage (primary — direct message from background.js)
            // 2. chrome.storage.onChanged (secondary — storage flag change)
            // 3. Slow polling (last resort safety net)
            const completed = await new Promise((resolve) => {
              let resolved = false;
              const cleanup = () => {
                resolved = true;
                chrome.runtime.onMessage.removeListener(msgListener);
                chrome.storage.onChanged.removeListener(storageListener);
                clearInterval(pollCheck);
              };

              // Primary: direct message from background.js (instant, not throttled)
              const msgListener = (request) => {
                if (resolved) return;
                if (request.action === 'indeedApplyComplete') {
                  state.log('Received completion signal via message');
                  cleanup();
                  chrome.storage.local.set({ indeedApplyComplete: false });
                  resolve(true);
                }
              };
              chrome.runtime.onMessage.addListener(msgListener);

              // Secondary: storage change event (not throttled)
              const storageListener = (changes, area) => {
                if (resolved) return;
                if (area === 'local' && changes.indeedApplyComplete && changes.indeedApplyComplete.newValue === true) {
                  state.log('Received completion signal via storage change');
                  cleanup();
                  chrome.storage.local.set({ indeedApplyComplete: false });
                  resolve(true);
                }
              };
              chrome.storage.onChanged.addListener(storageListener);

              // Tertiary: slow polling as safety net (every 5s)
              const pollCheck = setInterval(async () => {
                if (resolved) return;
                if (!state.isRunning) { cleanup(); resolve(false); return; }
                try {
                  const s = await chrome.storage.local.get(['indeedApplyComplete']);
                  if (s.indeedApplyComplete) {
                    state.log('Received completion signal via polling');
                    cleanup();
                    await chrome.storage.local.set({ indeedApplyComplete: false });
                    resolve(true);
                  }
                } catch (e) {}
              }, 5000);

              // Timeout after 3 minutes
              setTimeout(() => { if (!resolved) { cleanup(); resolve(false); } }, 180000);
            });

            if (completed) {
              state.log('SmartApply completed! Moving to next job');
              console.log('[EAM][mainLoop] SmartApply DONE — resuming search');
              console.log('[EAM][mainLoop] Current URL after return:', window.location.href);
              // Refresh local state from storage (formOnlyLoop saved the job there)
              try {
                const s = await chrome.storage.local.get(['appliedCount', 'appliedJobs']);
                state.appliedCount = s.appliedCount || state.appliedCount;
                state.appliedJobs = s.appliedJobs || state.appliedJobs;
              } catch (e) {}
              state.updateActivity();

              // Verify we're still on the search page — if not, go back
              if (!/indeed\.(com|fr)\/jobs/i.test(window.location.href) &&
                  !/indeed\.(com|fr)\/recherche/i.test(window.location.href)) {
                console.warn('[EAM][mainLoop] NOT on search page! URL:', window.location.href, '— navigating back');
                window.history.back();
                await state.wait(3000);
                console.log('[EAM][mainLoop] After history.back, URL:', window.location.href);
              }
            } else {
              state.log('SmartApply did not complete in time — skipping');
              console.warn('[EAM][mainLoop] SmartApply TIMEOUT — skipping');
              state.noteSkip('smartapply_to');
            }
            // Wait for page to settle before processing next job
            await state.wait(2000);
            console.log('[EAM][mainLoop] Continuing to next job. URL:', window.location.href);
            continue;
          }

          // Check daily limit after clicking apply
          if (adapter.checkDailyLimit()) {
            state.log('DAILY LIMIT REACHED after clicking Apply');
            await stopBot('Daily limit reached');
            break;
          }

          // Check rate limit after clicking apply (fresh scan + pending flag
          // set by background poller between iterations)
          if (adapter.checkRateLimit() || state.pendingRateLimitPause) {
            state.pendingRateLimitPause = false;
            const keepGoing = await handleRateLimit(adapter, state, 'after Apply click');
            if (!keepGoing) break;
            // v2.5.89: retry THIS job once after the pause — it was never applied to
            // (every throttle used to silently lose the job that hit it).
            // v2.5.103: resume on the NEXT offer (the one that hit the throttle tends to
            // re-trigger it); this job is retried once at the end of the list.
            if (!jobCard.__eamThrottleRetried && _jobCards && _jobCards.length != null) { if (state._reapply) state._reapply.done = false; jobCard.__eamThrottleRetried = true; if (_cardJobId) state._evaluatedJobIds.delete(_cardJobId); _jobCards = Array.from(_jobCards).concat([jobCard]); state.log('↷ Moving on to the next job — this one will be retried at the end'); }
            continue;
          }

          // Verify modal appeared. Poll up to 8s, with one re-click of the
          // Easy Apply button at the 4s mark as a fallback — the LinkedIn
          // /jobs/search-results/ rollout renders the Apply form inside an
          // iframe that hydrates from network fetches, so 5s was not enough
          // for slow connections. The re-click covers the case where the
          // first click was silently swallowed by React because the card
          // was mid-hydration (2026-08-12 Skas bug pattern).
          let modal = adapter.getFormModal();
          let pollMs = 0;
          const POLL_INTERVAL = 500;
          const POLL_BUDGET = 8000;
          const RETRY_CLICK_AT_MS = 4000;
          let retryClickFired = false;
          while ((!modal || !state.isShown(modal)) && pollMs < POLL_BUDGET) {
            if (!state.isRunning) break;
            await state.wait(POLL_INTERVAL);
            pollMs += POLL_INTERVAL;
            modal = adapter.getFormModal();
            if (!retryClickFired && pollMs >= RETRY_CLICK_AT_MS && (!modal || !state.isShown(modal))) {
              retryClickFired = true;
              try {
                const freshBtn = adapter.getApplyButton && adapter.getApplyButton();
                if (freshBtn && freshBtn.offsetParent !== null) {
                  state.log('Modal still absent at 4s — retrying Easy Apply click');
                  await state.click(freshBtn);
                }
              } catch (_) {}
            }
          }
          if (!modal || !state.isShown(modal)) {
            state.log('Modal did not appear (' + Math.round(pollMs/1000) + 's poll) — checking for limit...');
            if (adapter.checkDailyLimit()) {
              await stopBot('Daily limit reached');
              break;
            }
            if (adapter.checkRateLimit()) {
              const keepGoing = await handleRateLimit(adapter, state, 'modal failed');
              if (!keepGoing) break;
              // v2.5.103: resume on the NEXT offer (the one that hit the throttle tends to
            // re-trigger it); this job is retried once at the end of the list.
            if (!jobCard.__eamThrottleRetried && _jobCards && _jobCards.length != null) { if (state._reapply) state._reapply.done = false; jobCard.__eamThrottleRetried = true; if (_cardJobId) state._evaluatedJobIds.delete(_cardJobId); _jobCards = Array.from(_jobCards).concat([jobCard]); state.log('↷ Moving on to the next job — this one will be retried at the end'); }
              continue;
            }
            // Modal didn't appear after applyBtn click — most common cause is
            // that the focused job is silently already-applied (e.g., user
            // applied earlier so LinkedIn keeps the EA <a> in the DOM but
            // its onClick handler short-circuits because the user is already
            // applied to this job). Detect this by scanning the page for
            // an "Applied"/"Application sent" status indicator and skip.
            try {
              // v2.5.96: focused job only — an applied card in the job list used
              // to match here too, which also hid LinkedIn's silent throttle
              // (each no-modal click was counted "already applied", the
              // no-modal streak below never grew).
              let appliedHere;
              if (adapter.isFocusedJobApplied) appliedHere = adapter.isFocusedJobApplied();
              else {
                const sr = document.getElementById('interop-outlet') && document.getElementById('interop-outlet').shadowRoot;
                appliedHere = state.isAppliedIndicatorText((document.body.innerText || '') + ' ' + (sr ? (sr.textContent || '') : ''));
              }
              if (appliedHere) {
                state.log('Job is silently already-applied (detected via page indicator) — skip');
                state.noteSkip('applied_nomodal');
                continue;
              }
            } catch (e) {}
            state.log('Modal did not appear (unknown reason), skipping');
            state.noteSkip('modal_none');
            // v2.5.87 — SILENT throttle. Live 2026-09-25 13:05→: after LinkedIn's
            // "Easy Apply is temporarily paused" dialog and our 5-min pause, every
            // Easy Apply click opened NOTHING (no dialog, button enabled) — the bot
            // skipped card after card. Several no-modal clicks in a row = LinkedIn
            // is still throttling → pause again (next strike, longer) instead of
            // burning the whole list.
            state._noModalStreak = (state._noModalStreak || 0) + 1;
            if (state._noModalStreak >= ((state.rateLimitStrikes || 0) > 0 ? 3 : 5)) {
              state.log(`⚠ ${state._noModalStreak} Easy Apply clicks in a row opened nothing — LinkedIn is still throttling. Pausing again.`);
              state._noModalStreak = 0;
              const keepGoing = await handleRateLimit(adapter, state, 'silent throttle');
              if (!keepGoing) break;
            }
            continue;
          }
          state._noModalStreak = 0;
          if (pollMs > 0) state.log('Modal appeared after ' + pollMs + 'ms poll');

          // ── Multi-step form loop ──────────────────────────────────────
          let step = 0;
          let _submitErr = null; // v2.5.119: 'paused' | 'stop' after LinkedIn's "couldn't submit" message
          const appStart = Date.now();
          const appTimeout = 180000; // 3 min
          const loadingTimeout = 20000; // 20s

          while (step < 10) {
            step++;

            // Honor Stop mid-application. Without this guard the inner step
            // loop runs 10 more iterations after the user clicks Stop —
            // each blocked by utils.click's SECURITY VIOLATION, so no real
            // click fires, but 10 phantom "Step N" logs scroll across the
            // console and feel like a hang.
            if (!state.isRunning) {
              state.log('Stop detected — exiting step loop');
              break;
            }

            // Timeout
            if (Date.now() - appStart > appTimeout) {
              state.log('TIMEOUT 3min - Discarding');
              await adapter.discardApplication();
              state.noteSkip('app_timeout');
              break;
            }

            // Stuck loading — but skip reload if a legitimate LinkedIn
            // popup (rate-limit / daily-limit) is up. Those popups are
            // NOT stuck — they have working "Got it"/"Continue" buttons
            // and should be handled by the rate-limit / daily-limit
            // branches above, not by page refresh. Reloading in that
            // state would just re-serve the same popup and users report
            // it as "the page keeps refreshing and my filter is lost".
            if (adapter.checkForStuckLoading()) {
              const rateLimit = state.checkRateLimit && state.checkRateLimit();
              const dailyLimit = state.checkDailyLimit && state.checkDailyLimit();
              if (rateLimit || dailyLimit) {
                state.log('Stuck-loading heuristic fired, but ' +
                          (dailyLimit ? 'daily-limit' : 'rate-limit') +
                          ' popup is up — skipping reload, letting normal handler run.');
                break;
              }
              // v2.5.87: NEVER reload (any layout — Skas 2026-08-12 refresh
              // loop + reload kills the injected engine). Close the stuck
              // modal in place and skip this job; stop only if it won't close.
              state.log('Stuck loading popup — closing it in place and skipping this job (no reload)');
              await adapter.discardApplication();
              if (adapter.getFormModal() && adapter.clearAllModals) await adapter.clearAllModals(3);
              const stillOpen = adapter.getFormModal();
              if (stillOpen && state.isShown(stillOpen)) {
                await stopBot('Stuck application window could not be closed', {
                  title: 'Paused — an application window is stuck',
                  body: 'Close the LinkedIn application window, then click Start again.',
                });
                return;
              }
              state.noteSkip('stuck_loading');
              break;
            }

            // Validation errors
            modal = adapter.getFormModal();
            // v2.5.119: LinkedIn's "couldn't submit your application" message → pause (throttle), never a form skip.
            if (modal) {
              const se = await _submitErrorPause(adapter, state, modal, 'form');
              if (se) { _submitErr = se; step = 999; break; }
            }
            if (modal && adapter.hasValidationErrors(modal)) {
              // v2.5.105: fix what LinkedIn's message asks for (number range, missing
              // selection, required text via AI, length) once per application, then retry.
              if (await _tryRepair(modal)) continue;
              state.log('Validation error detected - discarding');
              _skipDetail('form_invalid', modal);
              await adapter.discardApplication();
              _notePremiumSkip();
              state.noteSkip('form_invalid');
              step = 999;
              break;
            }

            // Loading screen check
            if (await adapter.isLoading()) {
              state.log('Loading screen detected...');
              const loadStart = Date.now();
              while (await adapter.isLoading()) {
                if (Date.now() - loadStart > loadingTimeout) {
                  state.log('Loading TIMEOUT 20s - Discarding');
                  await adapter.discardApplication();
                  state.noteSkip('load_timeout');
                  break;
                }
                await state.wait(1000);
              }
              if (Date.now() - loadStart > loadingTimeout) break;
            }

            state.log(`Step ${step}`);

            modal = adapter.getFormModal();
            if (!modal) { state.log('Modal closed'); break; }

            // Fill form step
            await adapter.fillFormStep(modal, state.config);
            await state.wait(1500);

            // STUCK DETECTION — if 3+ unanswerable fields piled up on this
            // job (AI returned nothing OR not signed in OR premium-blocked
            // and field has no built-in pattern), we'll never satisfy
            // the required fields. Discard + skip immediately rather
            // than spinning through 10 step iterations clicking a Next
            // button that LinkedIn keeps rejecting.
            if ((state._unknownFieldFails || 0) >= 3) {
              state.log('Stuck on unanswerable fields (' + state._unknownFieldFails +
                        ' fails) — discarding and moving on');
              _skipDetail('questions', modal);
              await adapter.discardApplication();
              _notePremiumSkip();
              state.noteSkip('questions');
              break;
            }

            // Pre-scroll to reveal hidden buttons (Indeed SmartApply needs this)
            if (adapter.scrollToRevealButtons) {
              await adapter.scrollToRevealButtons();
            }

            // Find next/submit button — retry once after 1.2s if not found,
            // LinkedIn sometimes re-mounts the footer buttons between form
            // steps and a probe within the transition window returns null.
            // Losing a whole application to a transient null was the 2nd
            // most-common failure mode in the 2026-08 telemetry.
            let nextBtn = adapter.getNextStepButton(modal);
            if (!nextBtn) {
              await state.wait(1200);
              nextBtn = adapter.getNextStepButton(modal);
            }
            if (!nextBtn) {
              // v2.5.89: close the window before moving on. A spinner-only / broken
              // Easy Apply window used to stay open over the list, and the NEXT job
              // was processed "inside" it and skipped too (fixture repro 2026-09-26).
              state.log('No button found after retry — closing this application window and skipping');
              await adapter.discardApplication();
              if (adapter.getFormModal() && adapter.clearAllModals) await adapter.clearAllModals(3);
              state.noteSkip('no_next_btn');
              break;
            }

            const isSubmit = adapter.isSubmitButton(nextBtn);

            // Pre-submit actions
            if (isSubmit) {
              await adapter.handlePreSubmit(modal, nextBtn);
            }

            // Scroll button into view before clicking
            nextBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
            await state.wait(400);

            // Check disabled
            if (nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') {
              if (step > 2) {
                state.log('Button disabled after multiple attempts - discarding');
                await adapter.discardApplication();
                state.noteSkip('btn_disabled');
                break;
              }
              await state.wait(1000);
              continue;
            }

            // v2.5.93: last check right before Submit — LinkedIn can re-render the
            // review step (and re-check "Follow <company>") after handlePreSubmit.
            if (isSubmit && adapter.ensureUnfollowed) await adapter.ensureUnfollowed(modal);

            await state.click(nextBtn);
            await state.wait(1000);

            // Check for validation errors after clicking next
            const stillModal = adapter.getFormModal();
            if (stillModal || isSubmit) {
              const se = await _submitErrorPause(adapter, state, stillModal, isSubmit ? 'submit' : 'next');
              if (se) { _submitErr = se; step = 999; break; }
            }
            if (stillModal && !isSubmit && adapter.hasValidationErrors(stillModal)) {
              if (await _tryRepair(stillModal)) continue;
              state.log('Validation error after Next click - discarding');
              _skipDetail('form_invalid', stillModal);
              await adapter.discardApplication();
              state.noteSkip('form_invalid');
              step = 999;
              break;
            }
            if (step === 999) break;

            // Submit flow
            if (isSubmit) {
              state.log('Submit clicked!');
              // v2.5.89: only count + record the job once LinkedIn accepted it.
              // A rejected submit ("Something went wrong", offline, last-step
              // validation) used to be saved to job_applications as applied.
              let outcome = 'unknown';
              try { if (adapter.verifySubmitted) outcome = await adapter.verifySubmitted(); } catch (_) {}
              if (outcome === 'failed') {
                const se = await _submitErrorPause(adapter, state, adapter.getFormModal(), 'after submit');
                if (se) { _submitErr = se; step = 999; break; }
                _skipDetail('submit_failed', adapter.getFormModal());
                state.log('⚠ LinkedIn did not accept the application (error or form still open) — not counted, discarding');
                await adapter.discardApplication();
                state.noteSkip('submit_failed');
                break;
              }
              state.log(outcome === 'confirmed' ? 'Application confirmed by LinkedIn' : 'Submit sent (no confirmation signal seen)');
              state.appliedCount++;
              // v2.5.103: strikes count CONSECUTIVE throttles — a real submit means
              // LinkedIn let us through, so the next throttle starts again at 2 min.
              state.rateLimitStrikes = 0;
              state._noModalStreak = 0;
              try { state.noteSessionApplied && state.noteSessionApplied(); } catch (_) {}
              state.appliedJobs.push({
                title: jobInfo.title,
                company: jobInfo.company,
                link: jobInfo.link,
                location: jobInfo.location || '',
                date: new Date().toISOString(),
                source: adapter.siteKey
              });
              state.updateAppliedCount();
              state.saveAppliedJobsToStorage();

              // Notify background.js for Supabase auto-sync
              try {
                chrome.runtime.sendMessage({
                  type: 'jobApplied',
                  title: jobInfo.title,
                  company: jobInfo.company,
                  link: jobInfo.link,
                  location: jobInfo.location || '',
                  date: new Date().toISOString(),
                  source: adapter.siteKey
                });
              } catch (e) {}

              // Wait for post-submit popup to appear
              await state.wait(1500);
              state.updateActivity();

              // Robust modal cleanup — handles all variants:
              // "Application sent", "Your application was sent to X!", "Done", etc.
              await adapter.clearAllModals(5);

              state.log('Application completed, next job');
              await state.wait(500);
              break;
            }
          }
          // v2.5.98: 10 steps without reaching Submit (a step that never advances, e.g. an
          // unanswered required radio on /jobs/search-results/) left the form OPEN: the next
          // cards were "processed" inside it ("Modal from previous job still open", cleanup
          // failed 2/2, live 2026-10-04 MERITIS). Close it and count the skip.
          // v2.5.112: step 999 = already discarded + counted (form_invalid) — telemetry showed every form_invalid
          // followed by a second "step_limit" for the same job (the window was still closing).
          // v2.5.119: paused on LinkedIn's "couldn't submit" message → this job is retried at the end of the list
          // (never counted as a skip), the next offer is tried after the pause.
          if (_submitErr) {
            if (_submitErr === 'stop' || !state.isRunning) break;
            if (!jobCard.__eamThrottleRetried && _jobCards && _jobCards.length != null) { if (state._reapply) state._reapply.done = false; jobCard.__eamThrottleRetried = true; if (_cardJobId) state._evaluatedJobIds.delete(_cardJobId); _jobCards = Array.from(_jobCards).concat([jobCard]); state.log('↷ Moving on to the next job — this one will be retried at the end'); }
            continue;
          }
          if (step === 999 && state.isRunning) {
            const left = adapter.getFormModal && adapter.getFormModal();
            if (left && state.isShown(left) && adapter.clearAllModals) { await state.wait(800); if (adapter.getFormModal()) await adapter.clearAllModals(3); }
          } else if (step >= 10 && state.isRunning) {
            const left = adapter.getFormModal && adapter.getFormModal();
            if (left && state.isShown(left)) {
              state.log('10 form steps without reaching Submit — discarding this application');
              _skipDetail('step_limit', left);
              await adapter.discardApplication();
              if (adapter.getFormModal() && adapter.clearAllModals) await adapter.clearAllModals(3);
              state.noteSkip('step_limit');
            }
          }
        }

        // v2.5.96: per-page skip-reason snapshot (one event per ~25 cards).
        _diagSkipSnapshot('scan_result');

        // Bot stopped during processing?
        if (!state.isRunning) break;

        // 2026-10-19 re-apply mode: one job per page load — report the result, stop (the service worker opens the next).
        if (state._reapply) { await _finishReapply(); break; }

        // v2.5.115: pages in a row without a single Easy Apply job → stop with a clear message instead of
        // paging through an unfiltered search for hours.
        const _isLinkedIn = /^linkedin$/i.test(adapter.siteKey || adapter.siteName || '');
        let _filterOn = false;
        try { _filterOn = adapter.isEasyApplyFilterOn ? !!adapter.isEasyApplyFilterOn() : /[?&]f_AL=true/i.test(window.location.href); } catch (_) {}
        const _searchTip = _filterOn
          ? 'Broaden the search (other keywords, a wider location), then click Start again.'
          : 'Turn on the "Easy Apply" filter in LinkedIn, or broaden the search (keywords, location), then click Start again.';
        // v2.5.117: a page whose jobs were all checked before a Stop (resume) says nothing about Easy Apply.
        state._pagesNoEligible = _pageNoApply < _pageNew ? 0 : (_pageNew === 0 && _pageResumed > 0) ? (state._pagesNoEligible || 0) : (state._pagesNoEligible || 0) + 1;
        state.log(`Page done: ${_pageNew} new job(s) checked, ${_pageNew - _pageNoApply} Easy Apply`);
        if (_isLinkedIn && state._pagesNoEligible >= PAGES_WITHOUT_EASY_APPLY_STOP) {
          state.log(`No Easy Apply job on the last ${state._pagesNoEligible} pages — stopping`);
          await stopBot('No Easy Apply jobs found', {
            title: 'No Easy Apply jobs found',
            body: `The last ${state._pagesNoEligible} pages had no Easy Apply job to apply to. ${_searchTip}`,
            tone: 'info',
          });
          break;
        }

        // Next page — only when the popup's "Auto next page" toggle is on (default on).
        if (state.config && state.config.autoNextPage === false) {
          state.log('Auto next page is off — stopping at the end of this page');
          await stopBot('Auto next page disabled', {
            title: 'Finished this page',
            body: '"Auto next page" is turned off in the extension settings, so the bot stopped at the end of this page.',
            tone: 'info',
          });
          break;
        }
        state.log('Looking for next page...');
        const nextPageOk = await adapter.goToNextPage();
        if (nextPageOk) {
          state.log('Next page loaded');
          continue;
        } else {
          state.log('No more pages');
          // v2.5.87: stop explicitly (was a silent break that left
          // isRunning=true in storage and no feedback on the page).
          await stopBot('No more pages in this search', {
            title: 'Finished this search',
            body: 'No more Easy Apply jobs on the remaining pages. ' + _searchTip,
            tone: 'info',
          });
          break;
        }

      } catch (error) {
        state.log(`Error: ${error.message}`);
        await state.wait(1500);
      }
    }

    state.log('Bot stopped');
    // v2.5.117: the loop ended without a stopBot() reason (not superseded by a newer Start — that one closed
    // the run itself). Never leave a run without its session_end.
    if (!stale()) _endSession(state.isRunning ? 'Loop ended (unknown cause)' : 'Stopped (no reason recorded)');
    await adapter.onStop();
  }

  // ─── Form-only loop (e.g. smartapply.indeed.com) ──────────────────────
  async function formOnlyLoop(adapter) {
    const state = u();
    let step = 0;
    const appStart = Date.now();
    const appTimeout = 180000; // 3 min
    console.log('[EAM][formOnlyLoop] Started on:', window.location.href);

    while (state.isRunning && step < 20) {
      step++;

      if (Date.now() - appStart > appTimeout) {
        state.log('TIMEOUT 3min on form-only page');
        break;
      }

      // Wait for page to settle
      if (await adapter.isLoading()) {
        state.log('Page loading...');
        const loadStart = Date.now();
        while (await adapter.isLoading()) {
          if (Date.now() - loadStart > 20000) {
            state.log('Loading TIMEOUT 20s');
            break;
          }
          await state.wait(1000);
        }
      }

      // Bail out on captcha/challenge — we can't solve those and looping
      // wastes user's applied-count budget for the day. Surface it instead.
      if (adapter.hasSmartApplyChallenge && adapter.hasSmartApplyChallenge()) {
        state.log('⚠ SmartApply challenge/captcha detected — pausing so you can solve it');
        try {
          chrome.runtime.sendMessage({ type: 'indeedSmartApplyChallenge', url: location.href });
        } catch (e) {}
        break;
      }

      const form = adapter.getFormModal();
      if (!form) {
        state.log('No form found, waiting...');
        await state.wait(2000);
        continue;
      }

      state.log(`Form step ${step}`);

      // Fill form
      await adapter.fillFormStep(form, state.config);
      await state.wait(1500);

      // Pre-scroll to reveal hidden buttons (Indeed SmartApply needs this)
      if (adapter.scrollToRevealButtons) {
        await adapter.scrollToRevealButtons();
      }

      // Find next/submit button
      const nextBtn = adapter.getNextStepButton(form);
      if (!nextBtn) {
        state.log('No button found — might be done or page changed');
        await state.wait(2000);
        // Check if we're still on the form page
        if (!adapter.isFormOnlyPage()) {
          state.log('Left form page — application may be complete');
          break;
        }
        continue;
      }

      // Scroll button into view
      nextBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await state.wait(500);

      const isSubmit = adapter.isSubmitButton(nextBtn);

      // Check disabled
      if (nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') {
        state.log('Button disabled, waiting...');
        await state.wait(1500);
        continue;
      }

      // Pre-submit actions
      if (isSubmit) {
        await adapter.handlePreSubmit(form, nextBtn);
        if (adapter.ensureUnfollowed) await adapter.ensureUnfollowed(form); // v2.5.93: re-verify right before Submit
      }

      await state.click(nextBtn);
      state.log(isSubmit ? 'Submit clicked!' : 'Continue clicked');
      await state.wait(2000);

      // Check for validation errors after clicking
      if (adapter.hasValidationErrors(form)) {
        state.log('Validation error — retrying fill');
        await adapter.fillFormStep(form, state.config);
        await state.wait(1000);
        continue;
      }

      if (isSubmit) {
        // Application submitted
        state.appliedCount++;
        // Try to get job info from storage (saved before redirect)
        let appliedJobInfo;
        try {
          const stored = await chrome.storage.local.get(['currentIndeedJob']);
          const jobInfo = stored.currentIndeedJob || {};
          appliedJobInfo = {
            title: jobInfo.title || 'Indeed Application',
            company: jobInfo.company || '',
            link: jobInfo.link || window.location.href,
            date: new Date().toISOString(),
            source: adapter.siteKey
          };
          state.appliedJobs.push(appliedJobInfo);
        } catch (e) {
          appliedJobInfo = {
            title: 'Indeed Application',
            company: '',
            link: window.location.href,
            date: new Date().toISOString(),
            source: adapter.siteKey
          };
          state.appliedJobs.push(appliedJobInfo);
        }
        state.updateAppliedCount();
        state.saveAppliedJobsToStorage();

        // Notify background.js for Supabase auto-sync
        try {
          chrome.runtime.sendMessage({
            type: 'jobApplied',
            title: appliedJobInfo.title,
            company: appliedJobInfo.company,
            link: appliedJobInfo.link,
            date: appliedJobInfo.date,
            source: appliedJobInfo.source
          });
        } catch (e) {}

        // Wait for storage to sync before signaling completion
        await state.wait(1500);

        // Dismiss demographic modal if present (Indeed post-apply)
        try {
          const dismissBtn = document.querySelector('[data-cy="dismiss"], button[data-cy="dismiss"]');
          if (dismissBtn) {
            dismissBtn.click();
            state.log('Dismissed demographic modal');
            await state.wait(500);
          }
        } catch (e) {}

        // Signal completion to background.js for cross-tab orchestration
        // background.js will close this tab and switch to the search tab
        console.log('[EAM][formOnlyLoop] Application submitted! Signaling completion');
        console.log('[EAM][formOnlyLoop] Applied:', appliedJobInfo.title, '|', appliedJobInfo.company);
        try {
          chrome.runtime.sendMessage({ type: 'indeedSmartApplyDone' });
          state.log('Application completed — signaled background for tab switch');
        } catch (e) {
          state.log('Application completed (signal failed, background fallback will handle)');
        }
        break;
      }

      // Wait for next step to load
      await state.wait(1000);
    }

    state.log('Form-only loop ended');
    await adapter.onStop();
  }

  // ─── Stop bot helper ──────────────────────────────────────────────────
  // notice (optional, v2.5.87): { title, body, tone } shown on the page next
  // to Easy Apply so the user sees WHY the bot stopped (replaces reloads).
  // v2.5.96: what the in-page stop notice says about this run — the skip
  // breakdown, and (daily limit, free plan only) one Premium line with true
  // claims. Premium does NOT raise LinkedIn's daily limit and the copy says so.
  const RUN_COPY = {
    en: {
      skipped: (n, b) => 'Skipped ' + n + ': ' + b + '.',
      applied: (n) => n + ' applied this run.',
      stopTitle: 'Stopped',
      dailyTitle: 'LinkedIn daily Easy Apply limit reached',
      dailyBody: 'Try again tomorrow — click Start again then.',
      premium: 'Premium: AI answers screening questions during auto-apply, 30 AI credits/month for tailored resumes & cover letters, AI autofill on 100+ ATS portals (you submit). LinkedIn\'s daily limit is the same on every plan.',
      premiumLink: 'Get Premium — 20% off your first payment',
    },
    fr: {
      skipped: (n, b) => n + ' ignorées : ' + b + '.',
      applied: (n) => n + ' candidature' + (n > 1 ? 's' : '') + ' envoyée' + (n > 1 ? 's' : '') + ' pendant cette session.',
      stopTitle: 'Arrêté',
      dailyTitle: 'Limite quotidienne LinkedIn atteinte',
      dailyBody: 'Réessayez demain en cliquant à nouveau sur Démarrer.',
      premium: 'Premium : l\'IA répond aux questions de présélection pendant l\'auto-candidature, 30 crédits IA/mois pour adapter CV et lettres, remplissage IA sur 100+ portails ATS (vous validez l\'envoi). La limite quotidienne de LinkedIn est la même pour tous les forfaits.',
      premiumLink: 'Passer Premium — -20 % sur le 1er paiement',
    },
  };
  const PREMIUM_URL = 'https://www.autoapplymax.com/dashboard?promo=WELCOMEBACK20&src=ext_daily_limit#upgrade';
  async function _runSummary(reason) {
    const state = u();
    const lang = state.uiLang ? state.uiLang() : 'en';
    const T = RUN_COPY[lang] || RUN_COPY.en;
    const sess = state.getSkipSession ? state.getSkipSession() : { applied: 0, skipped: 0, reasons: {} };
    const lines = [];
    if (sess.skipped > 0 && state.groupSkipReasons) {
      const b = state.formatSkipBreakdown(state.groupSkipReasons(sess.reasons), lang);
      if (b) lines.push({ kind: 'skips', text: T.skipped(sess.skipped, b) });
    }
    // v2.5.119: settings that caused skips stay visible in the end-of-run notice.
    try { if (state._missNotice) lines.push({ kind: 'skips', text: state._missNotice.title + ' — Preferences in the extension.' }); } catch (_) {}
    let link = null;
    const daily = /daily limit/i.test(String(reason));
    if (daily) {
      // Only an explicit free plan (cached by the popup from the user's
      // profile) — signed-out / unknown plan / paid users never see it.
      let plan = '';
      try { plan = String((await chrome.storage.local.get(['plan'])).plan || '').toLowerCase(); } catch (_) {}
      if (plan === 'free') { lines.push({ kind: 'premium', text: T.premium }); link = { text: T.premiumLink, url: PREMIUM_URL }; }
    }
    return { T, sess, daily, opts: { lines, link } };
  }

  async function stopBot(reason, notice) {
    const state = u();
    // 2026-10-19: a re-apply run stopped before its job was evaluated (user Stop, daily limit, throttle stop…) ends
    // the whole re-apply queue — the remaining jobs go back to "To complete".
    try {
      if (state._reapply && !state._reapply.reported) {
        state._reapply.reported = true;
        chrome.runtime.sendMessage({ type: 'reapplyResult', jobId: state._reapply.jobId, result: 'stopped', reason: String(reason || '').slice(0, 80) }, () => void chrome.runtime.lastError);
      }
    } catch (_) {}
    let _sum = null;
    try { _sum = await _runSummary(reason); } catch (_) {}
    try {
      if (notice) {
        state._showBotNotice && state._showBotNotice(notice.title, notice.body, notice.tone, _sum && _sum.opts);
      } else if (_sum && state._showBotNotice) {
        if (_sum.daily) {
          // One strip: replaces the short "limit reached" chip when it can be placed.
          const n = state._showBotNotice(_sum.T.dailyTitle, _sum.T.dailyBody, 'info', _sum.opts);
          if (n) { try { document.querySelectorAll('[data-eam-rl-chip="daily"]').forEach(x => x.remove()); } catch (_) {} }
        } else if (/user clicked stop/i.test(String(reason)) && (_sum.sess.skipped > 0 || _sum.sess.applied > 0)) {
          state._showBotNotice(_sum.T.stopTitle, _sum.T.applied(_sum.sess.applied), 'info', _sum.opts);
        }
      }
    } catch (_) {}
    // Visible trace so we can identify WHO triggered each stop. Critical
    // for diagnosing the "Bot stopped" mid-iteration bug: rate-limit and
    // daily-limit false positives both call stopBot, and without this log
    // the user sees "Bot stopped" with no explanation.
    console.log('%c[EAM] stopBot called — reason: ' + reason, 'color:#c00;font-weight:bold');
    console.trace('[EAM] stopBot stack');
    state.log('Bot stopping — ' + reason);
    // applied/skipped = LIFETIME counters (kept for continuity of older rows);
    // sess_* + skip_reasons = this run only (v2.5.96).
    _endSession(reason);
    // v2.5.117: Stop → Start on the same search resumes where the run was (live 2026-10-16: after a popup Stop the
    // new run restarted at Job 1/25 and re-opened the forms it had already discarded). The job in progress at the
    // Stop is not remembered (it is tried again). Any other stop (end of search, daily limit…) forgets the search.
    try {
      if (/user clicked stop/i.test(String(reason)) && state._evaluatedJobIds && state._evaluatedJobIds.size) {
        const ids = [...state._evaluatedJobIds].filter(x => x && x !== state._currentJobId).slice(-500);
        window.__eamResume = ids.length ? { key: _searchKey(), ids, at: Date.now() } : null;
      } else window.__eamResume = null;
    } catch (_) {}
    // The adapter's own daily_limit_reached only fires on one detection path; the real
    // limit on 2026-09-25 00:52 went through the engine path and left no event.
    if (/daily limit/i.test(String(reason))) _diag('daily_limit_reached', { source: 'engine', applied: state.appliedCount || 0 });
    state.isRunning = false;
    state.userExplicitlyClickedStart = false;
    await chrome.storage.local.set({ isRunning: false });
    try { await chrome.storage.local.remove('eam_pause_state'); } catch (_) {}
    if (/daily limit/i.test(String(reason))) { try { await chrome.storage.local.set({ eam_daily_limit_at: Date.now() }); } catch (_) {} }
    // Release cross-tab engine claim so other tabs can start after this one.
    try { await chrome.storage.local.remove(['engineOwnerTabId', 'engineOwnerClaimedAt']); } catch (_) {}
    try {
      chrome.runtime.sendMessage({ type: 'updateStatus', status: 'stopped', message: reason });
    } catch (e) {}
    // User-visible actionable feedback: some stops are self-inflicted
    // ("unsupported layout" = wrong URL; "daily limit" = tomorrow retry) —
    // pipe those to a persistent popup banner so user knows what to do next.
    // Otherwise stopBot fires silently and looks like a bug.
    const actionable = /unsupported page layout/i.test(reason)
      ? { message: 'This LinkedIn view isn\'t supported. Switch to /jobs/search/?f_AL=true (Easy Apply filter) for the reliable in-place modal flow.', tone: 'warning' }
      : /daily limit/i.test(reason)
      ? { message: 'LinkedIn daily Easy Apply limit reached — try again tomorrow.', tone: 'info' }
      : /rate limit/i.test(reason)
      ? { message: 'LinkedIn keeps asking us to slow down, so auto-apply stopped to protect your account. Wait about 15 minutes, then click Start auto-apply again.', tone: 'warning' }
      : null;
    if (actionable) {
      try { chrome.runtime.sendMessage({ type: 'botActionableStop', message: actionable.message, tone: actionable.tone, reason }); } catch (e) {}
      // Persist to storage so opening the popup shows the banner even
      // after the message dispatch is lost (popup may be closed at stop time).
      try {
        chrome.storage.local.set({
          eam_actionable_stop_banner: { message: actionable.message, tone: actionable.tone, reason, ts: Date.now() }
        });
      } catch (e) {}
    }
  }

  // ─── Message listener ─────────────────────────────────────────────────
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      (async () => {
        try {
          const state = u();
          if (request.action === 'start') {
            // Cross-tab engine mutex — prevents two tabs from starting the
            // bot simultaneously (would race on chrome.storage.local
            // .appliedCount + .appliedJobs, double-count or lose entries).
            // Extension edge-case audit 2026-08-14 flagged this as P1.
            // If another tab already holds the engine claim within the last
            // 90s, refuse the start and tell the user to close the other tab.
            try {
              const claim = await chrome.storage.local.get(['engineOwnerTabId', 'engineOwnerClaimedAt']);
              const now = Date.now();
              const isFresh = claim.engineOwnerClaimedAt && (now - claim.engineOwnerClaimedAt) < 90000;
              const myTabId = sender?.tab?.id;
              if (isFresh && claim.engineOwnerTabId && claim.engineOwnerTabId !== myTabId) {
                // Verify the other tab actually still exists (extension might
                // have stashed a stale claim from a closed tab)
                let stillExists = false;
                try {
                  const otherTab = await chrome.tabs.get(claim.engineOwnerTabId);
                  stillExists = !!otherTab;
                } catch (_) { stillExists = false; }
                if (stillExists) {
                  const msg = 'AutoApplyMax is already running on another tab (id=' + claim.engineOwnerTabId + '). Close that tab or click Stop there first, then try again.';
                  state.log('⚠ Cross-tab mutex: ' + msg);
                  sendResponse({ success: false, error: msg });
                  return;
                }
              }
              // Claim the engine for this tab. Heartbeat refresh happens in
              // mainLoop via updateActivity every ~2s.
              await chrome.storage.local.set({
                engineOwnerTabId: myTabId || 0,
                engineOwnerClaimedAt: now,
              });
            } catch (mutexErr) {
              // Non-fatal — proceed but log. Better to start the bot than
              // block on a mutex read failure.
              console.warn('[EAM] cross-tab mutex read failed, proceeding:', mutexErr?.message);
            }

            // 2026-10-15: application details edited on the dashboard (Smart Profile) → pulled into
            // chrome.storage.sync before the settings are read (apply-prefs-sync.js, max 3 s, never blocks Start).
            try {
              const ap = await Promise.race([
                new Promise(res => chrome.runtime.sendMessage({ type: 'syncApplyPrefs' }, r => { void chrome.runtime.lastError; res(r || null); })),
                new Promise(res => setTimeout(() => res(null), 3000)),
              ]);
              if (ap && ap.ok && ap.changed && ap.changed.length) state.log(`Application details updated from your dashboard (${ap.changed.join(', ')})`);
            } catch (_) {}
            // v2.5.88: + gender (form-filler / AI prompt read it but it was never
            // loaded → always empty during auto-apply) + autoNextPage (popup toggle
            // was saved but never honored — the bot always paginated).
            state._missNotice = null; state._missNoticeKeys = {}; // v2.5.119: per run
            state.config = await chrome.storage.sync.get([
              'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode', 'gender',
              'yearsOfExperience', 'maxYearsRequired', 'blacklistKeywords', 'city', 'country', 'expectedSalary', 'currentSalary', 'dateOfBirth', 'postalCode',
              'noticePeriod', 'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense',
              'autoNextPage', 'skillYearsAsTotal', 'nationality'
            ]);
            // 2026-10-19 "To complete": answers saved on the dashboard are pulled first (max 3 s, never blocks Start),
            // then the user's saved answers to custom questions (exact question only — FormFiller.applySavedAnswers).
            try {
              await Promise.race([
                new Promise(res => chrome.runtime.sendMessage({ type: 'toCompleteSync' }, r => { void chrome.runtime.lastError; res(r || null); })),
                new Promise(res => setTimeout(res, 3000)),
              ]);
              const { eam_custom_answers } = await chrome.storage.local.get(['eam_custom_answers']);
              state.config.customAnswers = (eam_custom_answers && typeof eam_custom_answers === 'object') ? eam_custom_answers : {};
              const nSaved = Object.keys(state.config.customAnswers).length;
              if (nSaved) state.log(`${nSaved} saved answer(s) from your To complete list loaded`);
            } catch (_) { state.config.customAnswers = {}; }
            // Re-apply mode (popup / dashboard "Apply to these jobs now"): only this LinkedIn job id, no pagination;
            // the result goes back to the service worker (to-complete.js), which opens the next job.
            state._reapply = (request.reapply && /^\d{5,20}$/.test(String(request.reapply.jobId || '')))
              ? { jobId: String(request.reapply.jobId), done: false, reported: false } : null;
            state._tcNoticeShown = false;
            if (state._reapply) state.log(`Re-apply mode: job ${state._reapply.jobId} only`);
            // v2.5.113 (Théo 2026-10-15): "How many years of experience with X?" → the TOTAL years. Popup toggle, default ON.
            state.config.skillYearsAsTotal = state.config.skillYearsAsTotal !== false;
            // v2.5.87: ground AI screening answers in the real CV (education,
            // experience, skills). Auto-apply never loaded cvProfile, so the AI
            // answered degree questions blind — "No" to "Bachelor's Degree?" for a
            // Master's holder was submitted on a real application (2026-09-25).
            // Same shape as popup.js universal-autofill enrichment.
            try {
              // v2.5.110: refresh the CV copy if the server one changed (max 4 s, never blocks Start).
              try {
                const sync = await Promise.race([
                  new Promise(res => chrome.runtime.sendMessage({ type: 'syncCvProfile' }, r => res(r || null))),
                  new Promise(res => setTimeout(() => res({ ok: false, reason: 'timeout' }), 4000)),
                ]);
                if (sync && sync.changed) state.log('CV profile re-synced from your dashboard (it had changed)');
              } catch (_) {}
              const { cvProfile, accountProfile } = await chrome.storage.local.get(['cvProfile', 'accountProfile']);
              // v2.5.112: dashboard values for settings left empty in the extension (expected salary, country).
              if (accountProfile) {
                const es = String(accountProfile.expectedSalary || '').trim();
                if (!String(state.config.expectedSalary || '').trim() && /^\d[\d\s,.]*$/.test(es)) { state.config.expectedSalary = String(Math.round(parseFloat(es.replace(/[\s,]/g, '')))); state.log('Expected salary taken from your dashboard profile'); }
                if (!state.config.country && accountProfile.country) state.config.country = String(accountProfile.country);
                // v2.5.113: dashboard years_of_experience — fallback when the extension setting is empty / 0.
                if (accountProfile.yearsOfExperience) state.config.accountYears = String(accountProfile.yearsOfExperience);
                // v2.5.119 (telemetry 2026-10-17: "Mobile phone number*", "Phone country code*", "Country*", "City" left
                // empty for users whose extension settings were blank): the dashboard phone when the extension has none.
                const ph = String(accountProfile.phone || '').replace(/[^\d+]/g, '');
                if (!String(state.config.phone || '').trim() && ph.replace(/\D/g, '').length >= 7) { state.config.phone = ph; state.log('Phone taken from your dashboard profile'); }
              }
              // v2.5.119: the user's other REAL cities (dashboard, CV) — used when the extension city is empty or matches no
              // LinkedIn location suggestion ("Hanumant Colony Tilpat" → "Faridabad, India"). Never a guessed city.
              {
                const alts = [];
                const add = (v) => { v = String(v || '').replace(/\s+/g, ' ').trim(); if (v && v.length <= 80 && !/\d{5,}/.test(v) && !alts.some(a => a.toLowerCase() === v.toLowerCase()) && v.toLowerCase() !== String(state.config.city || '').trim().toLowerCase()) alts.push(v); };
                if (accountProfile) add(accountProfile.city);
                if (cvProfile) { add(cvProfile.city); add(cvProfile.location); }
                if (!String(state.config.city || '').trim() && alts.length) { state.config.city = alts.shift(); state.log(`City taken from your dashboard / CV: ${state.config.city}`); }
                state.config.cityAlternates = alts;
                if (cvProfile && !String(state.config.phone || '').trim() && String(cvProfile.phone || '').replace(/\D/g, '').length >= 7) { state.config.phone = String(cvProfile.phone).replace(/[^\d+]/g, ''); state.log('Phone taken from your CV'); }
              }
              if (cvProfile) {
                if (cvProfile.linkedin) state.config.linkedinUrl = cvProfile.linkedin;
                if (cvProfile.website) state.config.portfolioUrl = cvProfile.website;
                if (cvProfile.github) state.config.githubUrl = cvProfile.github;
                // v2.5.115: the most recent role, not the first CV entry.
                const _FF = window.EAM && window.EAM.FormFiller;
                const latest = (_FF && _FF.latestCvRole) ? _FF.latestCvRole(cvProfile) : (cvProfile.experience || [])[0];
                if (latest?.company) state.config.currentCompany = latest.company;
                if (latest?.title) state.config.currentTitle = latest.title;
                if (cvProfile.summary) state.config.summary = (window.EAM.utils && window.EAM.utils.cleanProfileSummary) ? window.EAM.utils.cleanProfileSummary(cvProfile.summary) : cvProfile.summary;
                state.config.cvProfile = {
                  summary: cvProfile.summary, skills: cvProfile.skills, experience: cvProfile.experience,
                  education: cvProfile.education, languages: cvProfile.languages,
                  linkedin: cvProfile.linkedin, website: cvProfile.website, yearsOfExperience: cvProfile.yearsOfExperience,
                };
                // v2.5.89: language-level questions read config.languages, which was
                // never loaded → every language answered with the default level.
                if (!state.config.languages && Array.isArray(cvProfile.languages)) state.config.languages = cvProfile.languages;
                state.log(`AI grounding: CV profile loaded (${(cvProfile.education || []).length} education, ${(cvProfile.experience || []).length} experience entries)`);
              } else {
                state.log('⚠ No CV profile synced — AI will skip education/degree questions instead of guessing');
              }
            } catch (_) {}
            // v2.5.113 (user report: "it puts 0 years of experience for everything"): the "Years of experience" setting
            // left empty / 0 → dashboard profile, else the CV, else the span of the dated CV roles.
            try {
              if (!(parseInt(String(state.config.yearsOfExperience || '').match(/\d+/)?.[0] || '0', 10) > 0)) {
                const ty = window.EAM && window.EAM.FormFiller && window.EAM.FormFiller.totalYears ? window.EAM.FormFiller.totalYears(state.config) : 0;
                if (ty > 0) { state.config.yearsOfExperience = String(ty); state.log(`Years of experience: ${ty} (setting empty — taken from your dashboard profile / CV)`); }
              }
            } catch (_) {}
            const local = await chrome.storage.local.get(['appliedCount', 'skippedCount', 'appliedJobs', 'resumeFile', 'resumeFileName', 'resumeFileType']);
            state.appliedCount = local.appliedCount || 0;
            state.skippedCount = local.skippedCount || 0;
            state.appliedJobs = local.appliedJobs || [];
            state.resumeFile = local.resumeFile || null;
            state.resumeFileName = local.resumeFileName || null;
            state.resumeFileType = local.resumeFileType || null;

            if (state.resumeFile) state.log(`Resume loaded: ${state.resumeFileName}`);

            // v2.5.93: a quick Stop → Start used to spawn a SECOND main loop while the
            // first was still mid-job (it saw isRunning=true again and kept going):
            // two loops fought over the same form ("Cleanup failed 3/2", jobs
            // discarded — fixture STOPSTART 2026-09-27). Let the previous loop exit
            // first (bounded wait), and stamp each loop with a generation id so a
            // stale loop can never continue.
            // v2.5.117: a Start while a run is still on (double click, popup Start again) supersedes it — close
            // that run's telemetry here (its loop exits as "stale" without a reason).
            if (_run && !_run.ended && (loopPromise || state.isRunning)) _endSession('Restarted (Start clicked again)');
            const myGen = ++loopGen;
            if (loopPromise) {
              state.isRunning = false;
              state.log('Waiting for the previous run to stop before restarting…');
              await Promise.race([loopPromise.catch(() => {}), new Promise(r => setTimeout(r, 20000))]);
            }
            if (myGen !== loopGen) { sendResponse({ success: false, error: 'Superseded by a newer Start' }); return; }

            state.isRunning = true;
            state.userExplicitlyClickedStart = true;
            state.updateActivity();  // Refresh activity clock so isStuck can't fire before first iteration
            // Remember the URL at start so we can detect if LinkedIn strips
            // f_AL / keywords mid-run and stop cleanly instead of running
            // against a corrupted search context.
            state._startUrl = window.location.href;
            state._startHadFilter = /[?&]f_AL=true/i.test(window.location.href);
            state._filterDropRecoveries = 0;
            state._stuckRecoveries = 0;
            state._emptyScans = 0;
            // v2.5.115: job ids already evaluated in this run + consecutive pages without any Easy Apply job.
            state._evaluatedJobIds = new Set();
            state._resumedJobIds = new Set();
            state._currentJobId = null;
            state._pagesNoEligible = 0;
            try {
              const r = window.__eamResume; window.__eamResume = null;
              if (r && r.key === _searchKey() && Date.now() - r.at < RESUME_MAX_MS && Array.isArray(r.ids) && r.ids.length) {
                state._evaluatedJobIds = new Set(r.ids); state._resumedJobIds = new Set(r.ids);
                state.log(`Resuming this search: ${r.ids.length} job(s) already checked before Stop are not opened again`);
              }
            } catch (_) {}
            try { state.resetSkipSession && state.resetSkipSession(); } catch (_) {}
            try { state._clearBotNotice && state._clearBotNotice(); } catch (_) {}
            await chrome.storage.local.set({ isRunning: true });
            // v2.5.92: a fresh run clears the previous pause / daily-limit state
            // (popup alert + toolbar badge).
            try { await chrome.storage.local.remove(['eam_pause_state', 'eam_daily_limit_at']); } catch (_) {}

            sendResponse({ success: true, message: 'Bot started' });
            try { chrome.runtime.sendMessage({ type: 'botStarted' }); } catch (e) {}

            // Detect adapter
            const adapter = request.adapter
              ? window.EAM.registry.get(request.adapter)
              : window.EAM.registry.detectFromURL(window.location.href);

            if (!adapter) {
              state.log('No adapter found for this site!');
              sendResponse({ success: false, error: 'No adapter for this site' });
              return;
            }
            state.log(`Using adapter: ${adapter.siteName}`);
            let _fp = null; try { _fp = adapter.layoutFingerprint ? adapter.layoutFingerprint() : null; } catch (_) {}
            _run = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ended: false };
            _diag('session_start', { layout: /search-results/.test(location.pathname) ? 'search-results' : 'search', filter: state._startHadFilter, fp: _fp, run: _run.id, resumed: state._resumedJobIds ? state._resumedJobIds.size : 0 });
            const p = mainLoop(adapter, myGen);
            loopPromise = p;
            p.finally(() => { if (loopPromise === p) loopPromise = null; });

          } else if (request.action === 'stop') {
            await stopBot('User clicked Stop');
            sendResponse({ success: true, message: 'Bot stopped' });
            try { chrome.runtime.sendMessage({ type: 'botStopped' }); } catch (e) {}

          } else if (request.action === 'exportJobs') {
            sendResponse({ jobs: u().appliedJobs });

          } else if (request.action === 'resetCounters') {
            const state = u();
            state.appliedCount = 0; state._fpSeen = null;
            state.skippedCount = 0;
            state.appliedJobs = [];
            await chrome.storage.local.set({ appliedCount: 0, skippedCount: 0, appliedJobs: [] });
            state.updateAppliedCount();
            state.updateSkippedCount();
            sendResponse({ success: true, message: 'Counters reset' });

          } else if (request.action === 'clearAppliedJobs') {
            u().appliedJobs = [];
            await chrome.storage.local.set({ appliedJobs: [] });
            sendResponse({ success: true, message: 'Applied jobs cleared' });
          }
        } catch (error) {
          u().log(`Message handler error: ${error.message}`);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true; // async response
    });
  }

  // ─── Initialization ───────────────────────────────────────────────────
  function init() {
    const state = u();

    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0a66c2; font-weight: bold;');
    console.log('%c EASYAPPLYMAX v2.0.0 - MULTI-SITE ENGINE', 'color: #0a66c2; font-weight: bold; font-size: 16px;');
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0a66c2; font-weight: bold;');

    const adapter = window.EAM.registry.detectFromURL(window.location.href);
    if (adapter) {
      console.log(`%c Detected site: ${adapter.siteName}`, 'color: green; font-weight: bold;');
    } else {
      console.log('%c No adapter matched current URL', 'color: orange; font-weight: bold;');
    }

    // Security: clear running state on load
    // Exception: on form-only pages (smartapply.indeed.com), preserve isRunning in storage
    // so background.js can detect the bot should auto-start
    const isFormOnlyPage = /smartapply\.indeed\.com/i.test(window.location.href);
    state.isRunning = false;
    state.userExplicitlyClickedStart = false;

    (async () => {
      try {
        if (!isFormOnlyPage) {
          await chrome.storage.local.set({ isRunning: false });
        }
        const s = await chrome.storage.local.get(['appliedCount', 'skippedCount', 'appliedJobs']);
        state.appliedCount = s.appliedCount || 0;
        state.skippedCount = s.skippedCount || 0;
        state.appliedJobs = s.appliedJobs || [];
        state.log(`Stats: Applied ${state.appliedCount}, Skipped ${state.skippedCount}`);
        state.log('Waiting for user to click START...');
      } catch (error) {
        state.log(`Init error: ${error.message}`);
      }
    })();

    setupMessageListener();

    // v2.5.117: the page is going away (tab closed, reload, full navigation) while a run is on — the engine dies
    // with it. The service worker turns this into the run's session_end ("Tab closed" / "Page reloaded or
    // navigated away"), resets isRunning and releases the tab claim.
    if (!window.__eamUnloadHook) {
      window.__eamUnloadHook = true;
      window.addEventListener('pagehide', () => {
        try {
          const st = u();
          if (!st || !st.isRunning || !_run || _run.ended || !/linkedin\.com$/i.test(location.hostname)) return;
          const meta = _runMeta('Page unloaded');
          _run.ended = true;
          chrome.runtime.sendMessage({ type: 'eam-run-unload', event: { site: 'linkedin', event_type: 'session_end', url_path: location.pathname, meta } });
        } catch (_) {}
      });
    }
  }

  window.EAM.BotEngine = {
    mainLoop,
    stopBot,
    init,
    setupMessageListener,
    _endSession, // exposed for unit tests
    get _run() { return _run; },
    handleRateLimit, // exposed for unit tests
    RATE_LIMIT_STRIKE_LIMIT, // exposed for unit tests
    get activeAdapter() { return activeAdapter; }
  };

  // Auto-initialize when loaded via content_scripts (e.g. smartapply.indeed.com)
  // When loaded via popup.js executeScript, popup.js calls init() separately
  if (!window.EAM._engineInitialized) {
    window.EAM.BotEngine.init();
    window.EAM._engineInitialized = true;
  }
})();
