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

  // v2.5.87: session start/stop telemetry → ext_diag_events (types already
  // allow-listed by ext-diag-ingest). LinkedIn only, fire-and-forget.
  function _diag(eventType, meta) {
    try {
      if (!/linkedin\.com$/i.test(location.hostname)) return;
      chrome.runtime.sendMessage({ type: 'eam-diag', event: { site: 'linkedin', event_type: eventType, url_path: location.pathname, meta: meta || {} } });
    } catch (_) {}
  }

  let activeAdapter = null;

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
  const RATE_LIMIT_PAUSE_MINUTES = [5, 8, 12];

  async function handleRateLimit(adapter, state, source) {
    state.rateLimitStrikes = (state.rateLimitStrikes || 0) + 1;
    const strikes = state.rateLimitStrikes;

    if (strikes >= RATE_LIMIT_STRIKE_LIMIT) {
      const msg = 'Auto-apply paused to protect your LinkedIn account. Take a 15-min break, then click AutoApply on a fresh job card to resume.';
      state.log('⏸ ' + msg);
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
            message: 'Paused to protect your LinkedIn account. Take a 15-min break, then click AutoApply on a new job.',
            priority: 2,
          });
        }
      } catch (e) {}
      _diag('rate_limit_throttle', { phase: 'stop', strike: strikes, source });
      await stopBot('Rate limit (' + strikes + ' strikes)');
      return false; // signal: caller should break/return
    }

    const baseMin = RATE_LIMIT_PAUSE_MINUTES[strikes - 1] || RATE_LIMIT_PAUSE_MINUTES[RATE_LIMIT_PAUSE_MINUTES.length - 1];
    const pauseMinutes = baseMin + Math.random();
    const pauseMs = Math.round(pauseMinutes * 60 * 1000);
    _diag('rate_limit_throttle', { phase: 'pause', strike: strikes, pause_min: Math.round(pauseMinutes * 10) / 10, source });
    state.log('⏳ Waiting ~' + Math.round(pauseMinutes) + ' min to avoid LinkedIn rate limit — this keeps your account safe. Will resume automatically.');
    try { await adapter.discardApplication(); } catch (e) {}
    // v2.5.87: a silent throttle has no LinkedIn dialog for checkRateLimit to
    // replace — show our own pause notice so the user sees why nothing moves.
    try {
      if (!document.querySelector('[data-eam-rl-chip], [data-eam-rate-limit-replacement], #eam-rate-limit-banner') && state._showBotNotice) {
        state._showBotNotice('Paused ~' + Math.round(pauseMinutes) + ' min', 'LinkedIn is slowing Easy Apply down. Auto-apply resumes automatically — keep this tab open.', 'info');
      }
    } catch (_) {}
    await state.wait(pauseMs);
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

  async function mainLoop(adapter) {
    activeAdapter = adapter;
    const state = u();

    // Reset rate-limit strikes for this session — cumulative across the
    // whole bot run, but cleared on every fresh Start click.
    state.rateLimitStrikes = 0;

    // Triple-layer security
    if (!state.isRunning) { state.log('SECURITY BLOCK 1/3: isRunning=false'); return; }
    if (!state.userExplicitlyClickedStart) {
      state.log('SECURITY BLOCK 2/3: user did NOT click Start');
      state.isRunning = false;
      await chrome.storage.local.set({ isRunning: false });
      return;
    }
    if (!state.config || !state.config.email) {
      state.log('SECURITY BLOCK 3/3: No config loaded');
      state.isRunning = false;
      state.userExplicitlyClickedStart = false;
      await chrome.storage.local.set({ isRunning: false });
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

    while (state.isRunning) {
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
            state.isRunning = false;
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
              state.skippedCount++;
              state.updateSkippedCount();
              continue;
            }
            // Cleanup succeeded — reset counter
            state._staleDialogFails = 0;
          } else if (leftoverModal && state._staleDialogFails >= 2) {
            // Already tried & failed twice; the dialog is benign noise.
            // Don't skip the card — let the normal apply flow proceed.
            state.log('Stale dialog persists but cleanup gave up — processing card anyway');
          }

          // Extract job info
          const jobInfo = adapter.getJobInfo(jobCard);

          // Blacklist check
          if (state.shouldSkipByBlacklist(jobInfo.title, jobInfo.company, jobInfo.description, state.config.blacklistKeywords)) {
            state.skippedCount++;
            state.updateSkippedCount();
            continue;
          }

          // Experience check (adapter-specific)
          if (adapter.shouldSkipByExperience && adapter.shouldSkipByExperience(jobCard, parseInt(state.config.maxYearsRequired))) {
            state.skippedCount++;
            state.updateSkippedCount();
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
            state.log('Not Easy Apply (card badge) — skip');
            state.skippedCount++;
            state.updateSkippedCount();
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
            state.skippedCount++;
            state.updateSkippedCount();
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
              const sr = document.getElementById('interop-outlet') &&
                         document.getElementById('interop-outlet').shadowRoot;
              const shadowTxt = sr ? (sr.textContent || '') : '';
              const bodyTxt = (document.body.innerText || '');
              const combined = bodyTxt + ' ' + shadowTxt;
              if (/Application status[\s\S]{0,40}Application submitted/i.test(combined) ||
                  /You applied[\s\S]{0,30}ago/i.test(combined) ||
                  /Vous avez postulé/i.test(combined) ||
                  /Postulé[\s\S]{0,30}il y a/i.test(combined) ||
                  /Application sent[\s\S]{0,30}ago/i.test(combined)) {
                state.log('Silently-applied (right-pane indicator) — skip');
                state.skippedCount++;
                state.updateSkippedCount();
                continue;
              }
            } catch (e) {}
          }

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
            state.skippedCount++;
            state.updateSkippedCount();
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
              state.skippedCount++;
              state.updateSkippedCount();
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
            continue; // retry from next job
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
              continue;
            }
            // Modal didn't appear after applyBtn click — most common cause is
            // that the focused job is silently already-applied (e.g., user
            // applied earlier so LinkedIn keeps the EA <a> in the DOM but
            // its onClick handler short-circuits because the user is already
            // applied to this job). Detect this by scanning the page for
            // an "Applied"/"Application sent" status indicator and skip.
            try {
              const bodyTxt = (document.body.innerText || '');
              const sr = document.getElementById('interop-outlet') &&
                         document.getElementById('interop-outlet').shadowRoot;
              const shadowTxt = sr ? (sr.textContent || '') : '';
              const combined = (bodyTxt + ' ' + shadowTxt);
              if (/Application status[\s\S]{0,30}Application submitted/i.test(combined) ||
                  /You applied[\s\S]{0,20}ago/i.test(combined) ||
                  /Vous avez postul[ée]/i.test(combined) ||
                  /Postulé[\s\S]{0,30}il y a/i.test(combined)) {
                state.log('Job is silently already-applied (detected via page indicator) — skip');
                state.skippedCount++;
                state.updateSkippedCount();
                continue;
              }
            } catch (e) {}
            state.log('Modal did not appear (unknown reason), skipping');
            state.skippedCount++;
            state.updateSkippedCount();
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
              state.skippedCount++;
              state.updateSkippedCount();
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
              state.skippedCount++;
              state.updateSkippedCount();
              break;
            }

            // Validation errors
            modal = adapter.getFormModal();
            if (modal && adapter.hasValidationErrors(modal)) {
              state.log('Validation error detected - discarding');
              await adapter.discardApplication();
              state.skippedCount++;
              state.updateSkippedCount();
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
                  state.skippedCount++;
                  state.updateSkippedCount();
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
              await adapter.discardApplication();
              state.skippedCount++;
              state.updateSkippedCount();
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
            if (!nextBtn) { state.log('No button found after retry — skipping'); break; }

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
                state.skippedCount++;
                state.updateSkippedCount();
                break;
              }
              await state.wait(1000);
              continue;
            }

            await state.click(nextBtn);
            await state.wait(1000);

            // Check for validation errors after clicking next
            const stillModal = adapter.getFormModal();
            if (stillModal && !isSubmit && adapter.hasValidationErrors(stillModal)) {
              state.log('Validation error after Next click - discarding');
              await adapter.discardApplication();
              state.skippedCount++;
              state.updateSkippedCount();
              step = 999;
              break;
            }
            if (step === 999) break;

            // Submit flow
            if (isSubmit) {
              state.log('Submit clicked!');
              state.appliedCount++;
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
        }

        // Bot stopped during processing?
        if (!state.isRunning) break;

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
            body: 'No more Easy Apply jobs on the remaining pages. Try other keywords or a wider location.',
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
  async function stopBot(reason, notice) {
    const state = u();
    if (notice) { try { state._showBotNotice && state._showBotNotice(notice.title, notice.body, notice.tone); } catch (_) {} }
    // Visible trace so we can identify WHO triggered each stop. Critical
    // for diagnosing the "Bot stopped" mid-iteration bug: rate-limit and
    // daily-limit false positives both call stopBot, and without this log
    // the user sees "Bot stopped" with no explanation.
    console.log('%c[EAM] stopBot called — reason: ' + reason, 'color:#c00;font-weight:bold');
    console.trace('[EAM] stopBot stack');
    state.log('Bot stopping — ' + reason);
    _diag('session_end', { reason: String(reason || '').slice(0, 120), applied: state.appliedCount || 0, skipped: state.skippedCount || 0 });
    // The adapter's own daily_limit_reached only fires on one detection path; the real
    // limit on 2026-09-25 00:52 went through the engine path and left no event.
    if (/daily limit/i.test(String(reason))) _diag('daily_limit_reached', { source: 'engine', applied: state.appliedCount || 0 });
    state.isRunning = false;
    state.userExplicitlyClickedStart = false;
    await chrome.storage.local.set({ isRunning: false });
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
      ? { message: 'LinkedIn daily Easy Apply limit hit. The bot stopped cleanly — try again in ~24h.', tone: 'info' }
      : /rate limit/i.test(reason)
      ? { message: reason + '. Wait 15-30 min then relaunch, or scroll manually for a bit before retrying.', tone: 'warning' }
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

            // v2.5.88: + gender (form-filler / AI prompt read it but it was never
            // loaded → always empty during auto-apply) + autoNextPage (popup toggle
            // was saved but never honored — the bot always paginated).
            state.config = await chrome.storage.sync.get([
              'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode', 'gender',
              'yearsOfExperience', 'maxYearsRequired', 'blacklistKeywords', 'city', 'country', 'expectedSalary',
              'noticePeriod', 'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense',
              'autoNextPage'
            ]);
            // v2.5.87: ground AI screening answers in the real CV (education,
            // experience, skills). Auto-apply never loaded cvProfile, so the AI
            // answered degree questions blind — "No" to "Bachelor's Degree?" for a
            // Master's holder was submitted on a real application (2026-09-25).
            // Same shape as popup.js universal-autofill enrichment.
            try {
              const { cvProfile } = await chrome.storage.local.get(['cvProfile']);
              if (cvProfile) {
                if (cvProfile.linkedin) state.config.linkedinUrl = cvProfile.linkedin;
                if (cvProfile.website) state.config.portfolioUrl = cvProfile.website;
                const latest = (cvProfile.experience || [])[0];
                if (latest?.company) state.config.currentCompany = latest.company;
                if (latest?.title) state.config.currentTitle = latest.title;
                if (cvProfile.summary) state.config.summary = cvProfile.summary;
                state.config.cvProfile = {
                  summary: cvProfile.summary, skills: cvProfile.skills, experience: cvProfile.experience,
                  education: cvProfile.education, languages: cvProfile.languages,
                  linkedin: cvProfile.linkedin, website: cvProfile.website,
                };
                state.log(`AI grounding: CV profile loaded (${(cvProfile.education || []).length} education, ${(cvProfile.experience || []).length} experience entries)`);
              } else {
                state.log('⚠ No CV profile synced — AI will skip education/degree questions instead of guessing');
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
            try { state._clearBotNotice && state._clearBotNotice(); } catch (_) {}
            await chrome.storage.local.set({ isRunning: true });

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
            _diag('session_start', { layout: /search-results/.test(location.pathname) ? 'search-results' : 'search', filter: state._startHadFilter });
            mainLoop(adapter);

          } else if (request.action === 'stop') {
            await stopBot('User clicked Stop');
            sendResponse({ success: true, message: 'Bot stopped' });
            try { chrome.runtime.sendMessage({ type: 'botStopped' }); } catch (e) {}

          } else if (request.action === 'exportJobs') {
            sendResponse({ jobs: u().appliedJobs });

          } else if (request.action === 'resetCounters') {
            const state = u();
            state.appliedCount = 0;
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
  }

  window.EAM.BotEngine = {
    mainLoop,
    stopBot,
    init,
    setupMessageListener,
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
