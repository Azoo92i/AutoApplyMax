/**
 * AutoApplyMax - LinkedIn Adapter
 * Extracted directly from content-simple.js selectors.
 * Zero behaviour change from original monolith.
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};
  const u = () => window.EAM.utils;

  // Fire-and-forget diagnostic emit to the service worker. LinkedIn only.
  // Never throws — if extension context is invalidated (reload during
  // long-running scan) the message just fails silently.
  function _emitDiag(eventType, meta) {
    try {
      if (!/linkedin\.com$/i.test(location.hostname)) return;
      chrome.runtime.sendMessage({
        type: 'eam-diag',
        event: {
          site: 'linkedin',
          event_type: eventType,
          url_path: location.pathname,
          meta: meta || {},
        },
      }).catch(() => {});
    } catch (e) { /* context invalidated — swallow */ }
  }

  // Return the deduped string if the input is a doubled prefix (with optional
  // whitespace/dash separator). Otherwise null. Handles the LinkedIn a11y +
  // visible-title concat: "Data Analyst Data Analyst" or "Foo\n\nFoo".
  function _dedupeDoubled(s) {
    if (!s || s.length < 8) return null;
    const half = s.length >> 1;
    // Exact doubling: "FooFoo" or "Foo Foo"
    for (let mid = half; mid <= half + 1; mid++) {
      const a = s.slice(0, mid).trim();
      const b = s.slice(mid).trim();
      if (a && a === b) return a;
    }
    // Sep-based doubling: "Foo — Foo", "Foo | Foo"
    const sepMatch = s.match(/^(.{4,}?)\s*[|·—–\-\/]\s*(.+)$/);
    if (sepMatch && sepMatch[1].trim() === sepMatch[2].trim()) return sepMatch[1].trim();
    return null;
  }

  // Extract the LinkedIn job id from any of the URL shapes LinkedIn uses and
  // return the canonical /jobs/view/{jobId}/ URL. Returns null if no id found.
  function _canonicalJobUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let m = url.match(/\/jobs\/view\/(\d{6,})/);
    if (!m) m = url.match(/[?&]currentJobId=(\d{6,})/);
    if (!m) return null;
    return `https://www.linkedin.com/jobs/view/${m[1]}/`;
  }

  class LinkedInAdapter extends window.EAM.BaseAdapter {

    get siteKey() { return 'linkedin'; }
    get siteName() { return 'LinkedIn'; }
    get badgeColor() { return '#0a66c2'; }

    matchURL(url) {
      return /linkedin\.com/i.test(url);
    }

    // LinkedIn rolled out a redesigned jobs page on /jobs/search-results/
    // (Apr 2026). The legacy /jobs/search/ template is unchanged. The new
    // template uses obfuscated CSS class hashes (`_80fc225b _126f5ffb`...)
    // and replaces the artdeco component lockups + `li[data-occludable-
    // job-id]` cards with `<div componentkey role="button">` cards holding
    // a <figure><img> company logo. Cards have positional <p> children:
    //   p[0] = title (a11y span + visible span)
    //   p[1] = company
    //   p[2] = location
    //   p[6] = "Easy Apply" badge text
    // The right-pane Apply control is now <a aria-label="Easy Apply to
    // this job"> (React-intercepted, opens in-place modal — does not
    // navigate). Each method below branches on _isNewSearchResults() so
    // the legacy /jobs/search/ flow is byte-for-byte unchanged.
    _isNewSearchResults() {
      return /\/jobs\/search-results\//i.test(window.location.pathname);
    }

    // The Apr 2026 LinkedIn redesign mounts the Easy Apply modal inside an
    // open Shadow DOM at <div id="interop-outlet" data-testid="interop-
    // shadowdom"> in the parent document. `document.querySelector(...)`
    // doesn't pierce shadow boundaries, which is why every selector we
    // tried returned 0 even though the modal was visible. We retrieve the
    // shadowRoot via `host.shadowRoot` (the root is open, not closed).
    _getInteropShadowRoot() {
      const host = document.getElementById('interop-outlet') ||
                   document.querySelector('[data-testid="interop-shadowdom"]');
      if (!host) return null;
      try { return host.shadowRoot || null; } catch (e) { return null; }
    }

    // Detect new LinkedIn pre-modal states on /jobs/search-results/. Two
    // observed since the Apr 2026 redesign rolled out wider in mid-2026:
    //   1. "Missing required qualifications" panel — when the user's
    //      profile doesn't match the JD, the FIRST Easy Apply click
    //      shows an inline panel in the right pane instead of opening
    //      the modal. The user has to acknowledge it before the modal
    //      actually opens (we click EA again to acknowledge).
    //   2. "You reached today's Easy Apply limit" — a centered popup
    //      LinkedIn injects after the daily EA cap is hit. Further EA
    //      clicks all hit this popup and never open the modal — every
    //      remaining card in the iteration would be wasted as a 20s
    //      timeout each. We MUST detect and stop iteration here.
    _detectNewSRPreModalState() {
      if (!this._isNewSearchResults()) return 'not-applicable';
      const bodyText = document.body.innerText || '';
      // Also scan the interop-outlet shadow root: LinkedIn injects the daily-
      // limit popup and other modals INTO that shadow tree, and document.body.
      // innerText does NOT pierce shadow boundaries. Without this extra scan
      // the daily-limit popup goes undetected → each remaining card eats a
      // 20s timeout → the bot appears to have "skipped everything".
      const shadowText = this._getInteropShadowRoot()?.textContent || '';
      const scanText = bodyText + '\n' + shadowText;
      // Daily limit popup — language-aware match. Has highest precedence
      // because once it fires, no further EA on any card will succeed.
      if (/reached\s+today.{0,8}s?\s+easy\s+apply\s+limit/i.test(scanText)
          || /limite\s+(quotidienne|du\s+jour).{0,40}easy\s+apply/i.test(scanText)
          || /Easy\s+Apply\s+(quota|limit)/i.test(scanText) && /today/i.test(scanText)) {
        return 'daily-limit';
      }
      // Soft rate-limit / throttle popup — LinkedIn shows a temporary
      // slowdown warning after ~5-10 rapid applications, distinct from the
      // hard daily cap. Message wording varies: "You're applying quickly",
      // "You seem to be applying to many jobs", "Please wait a moment",
      // "Try again in a few minutes", etc. Engine.js pauses iteration when
      // this state fires (like daily-limit) but shows a friendlier toast
      // suggesting the user retry in a few minutes rather than come back
      // tomorrow. Théo asked 2026-08-28 to replace LinkedIn's raw message
      // with our own "LinkedIn rate limit, extension paused — retry in
      // a few minutes" toast.
      if (/appl(y|ying).{0,20}(too\s+quickly|too\s+fast|very\s+fast|so\s+quickly|so\s+fast)/i.test(scanText)
          || /you'?re\s+applying\s+quickly/i.test(scanText)
          || /you\s+seem\s+to\s+be\s+applying/i.test(scanText)
          || /please\s+(wait|slow\s+down)\s+(a\s+moment|a\s+bit|before)/i.test(scanText)
          || /try\s+again\s+in\s+a?\s*(few\s+)?(minutes?|moment)/i.test(scanText)
          || /trop\s+rapidement/i.test(scanText)
          || /veuillez\s+attendre/i.test(scanText)) {
        return 'rate-limit-throttle';
      }
      // Qualifications-preview panel — appears in the right pane the FIRST
      // time we click Easy Apply, before the modal mounts. LinkedIn ships
      // two variants of the wording:
      //
      //   ❌ "Your profile and resume ARE MISSING some required qualifications"
      //   ✅ "Your profile and resume MATCH some required qualifications"
      //
      // The first version (2026-06-25 fix) only caught the "missing" case,
      // so well-matched applications still hit the 20s timeout because the
      // adapter saw no modal AND no panel signal — bot skipped jobs the
      // user was qualified for. The 2026-06-26 update widens the pattern
      // to cover both branches plus the universal "Show match details"
      // chip that LinkedIn renders on this surface whenever the preview
      // is rendered.
      //
      // We can be aggressive about including "Show match details" here
      // (which appears on every search-results card and used to false-
      // positive in isolation) because _detectNewSRPreModalState() is only
      // called from inside isLoading(), and isLoading() is itself only
      // polled by the engine AFTER it has already clicked Easy Apply. So
      // when this regex fires, "click EA again to ack" is the correct
      // recovery action regardless of which variant we hit.
      if (/missing\s+some\s+required\s+qualifications/i.test(scanText)
          || /Your\s+profile\s+and\s+resume\s+are\s+missing/i.test(scanText)
          || /Your\s+profile\s+and\s+resume\s+match\s+some\s+required/i.test(scanText)
          || /Show\s+match\s+details/i.test(scanText)
          || /qualifications\s+requises\s+manquantes/i.test(scanText)) {
        // Only treat as "panel" if no shadow modal is mounted — otherwise
        // the modal is the source of truth.
        const sr = this._getInteropShadowRoot();
        const modalUp = sr && sr.querySelector('[role="dialog"], [aria-modal="true"], form');
        if (!modalUp) return 'qualifications-panel';
      }
      return 'none';
    }

    // Override the base isLoading() so it knows to look inside the shadow
    // DOM on /jobs/search-results/. The base implementation only checks
    // `document.querySelector('.jobs-easy-apply-modal')` — that selector
    // never matches on the new design (modal lives in a shadow root), so
    // isLoading() returned true forever, the engine waited 20s, then
    // discarded the application without ever attempting to fill the form.
    async isLoading() {
      if (this._isNewSearchResults()) {
        const sr = this._getInteropShadowRoot();
        // ANY content in the shadow root means the modal has mounted.
        // Buttons may briefly be disabled during entry animations or
        // network fetches, but the engine's other guards (modal-still-
        // open check, validation-error check) will catch transient
        // states. If we wait for a perfectly-interactable button, we
        // hit the 20s timeout and discard the application.
        if (sr && (
          sr.querySelector('[role="dialog"], [aria-modal="true"]') ||
          sr.querySelector('form') ||
          sr.querySelector('input, textarea, select')
        )) {
          console.debug('[EAM Diag] isLoading=false — shadow modal mounted');
          return false;
        }

        // No modal yet — check the two known pre-modal states before
        // falling through to the generic loading timeout.
        const state = this._detectNewSRPreModalState();

        if (state === 'rate-limit-throttle') {
          // Soft rate-limit popup (LinkedIn slowed us down, not the daily
          // cap). Pause iteration and show our own toast — LinkedIn's raw
          // "You seem to be applying to many jobs" is technical + doesn't
          // tell the user what to do. Théo 2026-08-28 asked to replace it
          // with an actionable message. Sets same _dailyLimitHit sticky
          // flag so the engine's outer loop stops iterating on this run.
          this._rateLimitHit = true;
          this._dailyLimitHit = true; // reuse existing engine stop flag
          try {
            const findCloseBtn = (root) => {
              if (!root || !root.querySelector) return null;
              const bySel = root.querySelector('button[aria-label*="Got it" i], button[aria-label*="Dismiss" i], button[aria-label*="Close" i]');
              if (bySel) return bySel;
              const btns = root.querySelectorAll ? root.querySelectorAll('button') : [];
              return [...btns].find(b => /^got it$|^j.ai compris$|^fermer$|^ok$/i.test((b.textContent||'').trim())) || null;
            };
            const closeBtn = findCloseBtn(document) || findCloseBtn(this._getInteropShadowRoot());
            if (closeBtn) closeBtn.click();
          } catch (_) {}
          console.warn('[EAM] Soft rate-limit detected — pausing iteration to protect the LinkedIn account.');
          try { window.EAM.utils.log && window.EAM.utils.log('⏳ Waiting a few minutes to avoid LinkedIn rate limit — this keeps your account safe. Auto-apply will resume shortly.'); } catch (_) {}
          _emitDiag('rate_limit_throttle', {});
          return false;
        }
        if (state === 'daily-limit') {
          // Set a sticky flag the engine can read to STOP iteration.
          // Without this every remaining card eats a 20s timeout and the
          // user thinks the bot "skipped all jobs".
          this._dailyLimitHit = true;
          // Dismiss the popup so the next card click isn't blocked by it.
          // Look in BOTH light DOM and the interop-outlet shadow root.
          try {
            const findCloseBtn = (root) => {
              if (!root || !root.querySelector) return null;
              const bySelector = root.querySelector('button[aria-label*="Got it" i], button[aria-label*="Dismiss" i], button[aria-label*="Close" i]');
              if (bySelector) return bySelector;
              const buttons = root.querySelectorAll ? root.querySelectorAll('button') : [];
              return [...buttons].find(b => /^got it$|^j.ai compris$|^fermer$/i.test((b.textContent||'').trim())) || null;
            };
            const closeBtn = findCloseBtn(document) || findCloseBtn(this._getInteropShadowRoot());
            if (closeBtn) closeBtn.click();
          } catch (_) {}
          console.warn('[EAM] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.warn('[EAM] LinkedIn DAILY Easy Apply LIMIT REACHED.');
          console.warn('[EAM] No more applications will succeed today.');
          console.warn('[EAM] The bot is stopping iteration cleanly.');
          console.warn('[EAM] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          try { window.EAM.utils.log && window.EAM.utils.log('⚠ Daily Easy Apply limit reached. Try again tomorrow.'); } catch (_) {}
          _emitDiag('daily_limit_reached', {});
          return false; // engine moves on; outer loop checks _dailyLimitHit
        }

        // Per-job tracking — initialised once at first poll for this jobId.
        // We use these counters for BOTH the panel-driven retry (below) and
        // the blind-timing retry that fires when LinkedIn opens the modal
        // silently (no panel text at all) but the synthetic EA click was
        // swallowed by React. Browser-MCP scenario testing on 2026-06-27
        // showed: real mouse click reliably opens the modal in <1s, but
        // `element.click()` (what u().click() dispatches) sometimes fails
        // entirely. Without a blind retry the bot ate the full 20s timeout
        // on those cards and skipped them.
        const jobKey = (location.href.match(/currentJobId=(\d+)/) || [])[1] || 'unknown';
        this._loadingPollsByJob = this._loadingPollsByJob || new Map();
        const polls = (this._loadingPollsByJob.get(jobKey) || 0) + 1;
        this._loadingPollsByJob.set(jobKey, polls);
        this._eaClicksByJob = this._eaClicksByJob || new Map();
        const eaClicks = this._eaClicksByJob.get(jobKey) || 0;

        const tryReclickEa = (reason) => {
          const ea = document.querySelector('a[aria-label="Easy Apply to this job"], a[aria-label*="Easy Apply"], button[aria-label*="Easy Apply"]');
          if (ea && ea.offsetParent !== null && eaClicks < 3) {
            this._eaClicksByJob.set(jobKey, eaClicks + 1);
            console.log('[EAM] EA re-click ' + (eaClicks + 1) + '/3 (' + reason + ', poll ' + polls + ')');
            try { ea.click(); } catch (_) {}
            return true;
          }
          return false;
        };

        if (state === 'qualifications-panel') {
          // Profile mismatch OR match — LinkedIn injects a pre-modal preview
          // panel in the right pane. Clicking EA again is the ack flow that
          // opens the actual modal. Use the per-job counter so we can't
          // double-trigger via both panel + blind retry paths.
          if (tryReclickEa('qualifications panel')) return true;
          console.log('[EAM] qualifications panel still up after ' + eaClicks + ' acks — skipping card');
          _emitDiag('modal_stuck', { reason: 'qualifications_panel', ea_clicks: eaClicks });
          return false;
        }

        // BLIND RETRY — no panel, no modal, no daily limit. Most likely cause:
        // the original synthetic click was swallowed by React (right pane
        // was still rendering skeletons when u().click() fired). Re-fire at
        // poll #6 (~3s into the iteration) and poll #12 (~6s). After 18
        // polls (~9s) with no modal, give up and let the engine move on.
        if (polls === 6 || polls === 12) {
          if (tryReclickEa('no modal, blind retry')) return true;
        }
        if (polls > 18) {
          console.log('[EAM] modal never opened after ' + polls + ' polls (' + eaClicks + ' EA clicks) — skipping card');
          _emitDiag('modal_stuck', { reason: 'modal_never_opened', ea_clicks: eaClicks, polls });
          return false;
        }

        console.debug('[EAM Diag] isLoading: no shadow modal yet (poll ' + polls + ', EA clicks ' + eaClicks + ') — falling through');
      }
      // Fall back to the base utils helper (covers /jobs/search/ legacy)
      const slow = await window.EAM.utils.isPageLoadingSlow();
      if (slow) console.debug('[EAM Diag] isPageLoadingSlow=true (legacy spinner / no .jobs-easy-apply-modal)');
      return slow;
    }

    // Engine reads this between cards to know whether to stop the whole
    // iteration (returns true once we hit LinkedIn's daily EA cap).
    shouldStopIteration() {
      return !!this._dailyLimitHit;
    }

    // ── MutationObserver-based modal capture ──────────────────────────
    // Synthetic clicks from MCP probes don't trigger React, so we can't
    // observe the live modal-open DOM during development. Instead, in the
    // real bot we arm a MutationObserver right before clicking Apply: it
    // watches the parent body + every iframe body for any added node that
    // looks like the Easy Apply modal (form inputs + a submit-like
    // button). The first match wins, regardless of class names — robust
    // against LinkedIn renaming hashes again.
    _armModalObserver() {
      if (this._modalObserver) this._disarmModalObserver();
      this._capturedModal = null;
      this._observerStartedAt = Date.now();

      const looksLikeModal = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const isFormish =
          el.tagName === 'FORM' ||
          (el.querySelector && (el.querySelector('input[type="email"], input[type="tel"], input[type="number"], textarea, select') ||
                                el.querySelector('button[aria-label*="Submit" i], button[aria-label*="Continue" i], button[aria-label*="Next" i], button[aria-label*="Review" i], button[aria-label*="Suivant" i], button[aria-label*="Soumettre" i]')));
        if (!isFormish) return false;
        // Reject obvious non-modals: tiny + no inputs
        if (el.getBoundingClientRect && el.getBoundingClientRect().width < 200) return false;
        return true;
      };

      const handle = (muts) => {
        if (this._capturedModal) return;
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (looksLikeModal(n)) { this._capturedModal = n; return; }
            // Sometimes the modal is added a few levels deep
            if (n.querySelector) {
              const inner = [...n.querySelectorAll('form, [role="dialog"], [class*="modal"], [class*="easy-apply"]')]
                .find(looksLikeModal);
              if (inner) { this._capturedModal = inner; return; }
            }
          }
        }
      };

      const obs = new MutationObserver(handle);
      this._modalObserver = obs;
      try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}

      // Also watch every same-origin iframe body — modal sometimes lands there
      this._iframeObservers = [];
      [...document.querySelectorAll('iframe')].forEach((ifr) => {
        try {
          const idoc = ifr.contentDocument;
          if (idoc && idoc.body) {
            const o = new MutationObserver(handle);
            o.observe(idoc.body, { childList: true, subtree: true });
            this._iframeObservers.push(o);
          }
        } catch (e) {}
      });
    }

    _disarmModalObserver() {
      try { this._modalObserver && this._modalObserver.disconnect(); } catch (e) {}
      this._modalObserver = null;
      if (this._iframeObservers) {
        for (const o of this._iframeObservers) {
          try { o.disconnect(); } catch (e) {}
        }
      }
      this._iframeObservers = [];
    }

    // Returns the Document/ShadowRoot we should query for modal-internal
    // elements. On /jobs/search/ this is always `document`. On /jobs/
    // search-results/ the modal lives inside an open Shadow DOM rooted
    // at <div id="interop-outlet">, so we hand back the shadowRoot so
    // `mdoc.querySelectorAll(...)` calls (Discard, Close, ESC fallback)
    // actually target the modal contents. ShadowRoot has the same
    // querySelector / querySelectorAll API as Document.
    _getModalDocument() {
      if (this._isNewSearchResults()) {
        const sr = this._getInteropShadowRoot();
        if (sr) return sr;
      }
      return document;
    }

    // ── Job cards ───────────────────────────────────────────────────────
    getJobCards() {
      if (this._isNewSearchResults()) {
        // VARIANT A (Apr 2026 v1): div[componentkey][role="button"][tabindex]
        // with company logo figure. Click updates right-pane in place.
        try {
          const cards = document.querySelectorAll('div[componentkey][role="button"][tabindex]:has(figure img)');
          if (cards.length > 0) {
            console.log('[EAM] getJobCards (variant A):', cards.length, 'cards');
            _emitDiag('scan_result', { cards_seen: cards.length, variant: 'A' });
            return cards;
          }
        } catch (e) { /* :has() unsupported — fall through */ }
        const fallbackA = [...document.querySelectorAll('div[componentkey][role="button"][tabindex]')]
          .filter(el => el.querySelector('figure img'));
        if (fallbackA.length > 0) {
          console.log('[EAM] getJobCards (variant A fallback):', fallbackA.length, 'cards');
          _emitDiag('scan_result', { cards_seen: fallbackA.length, variant: 'A_fallback' });
          return fallbackA;
        }

        // VARIANT B (Apr 2026 v2 — flat list, no right-pane): cards are
        // <a href="/jobs/view/JOBID"> directly, no componentkey wrapper.
        // Clicking them NAVIGATES (default <a> behavior + React handler),
        // which loses the search context, removes f_AL=true filter, and
        // breaks the bot's iteration. We CANNOT reliably auto-apply on
        // this surface — there's no in-place modal flow.
        // VARIANT B (flat <a href> list) — usually appears after a page
        // refresh / soft-reload that put LinkedIn into a degraded layout
        // state, OR for a few users LinkedIn rolled out this design
        // variant. In both cases there's no in-place Easy Apply modal
        // flow on this surface (clicks navigate to /jobs/view/JOBID/
        // instead of opening the modal in-place). Stop cleanly with a
        // clear instruction to use /jobs/search/ which is the most
        // reliable surface (legacy layout, in-place modal works
        // perfectly).
        const hrefCards = [...document.querySelectorAll('a[href*="/jobs/view/"]')]
          .filter(a => a.querySelector('figure img'));
        if (hrefCards.length > 0) {
          this._unsupportedLayout = true;
          _emitDiag('scan_zero_cards', { reason: 'degraded_layout_href_only', href_cards: hrefCards.length });
          console.warn('[EAM] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.warn('[EAM] Degraded LinkedIn layout detected — Easy Apply modal');
          console.warn('[EAM] doesn\'t open in-place on this surface (usually after');
          console.warn('[EAM] a refresh that triggered LinkedIn\'s alternate layout).');
          console.warn('[EAM] ');
          console.warn('[EAM] BEST URL — works reliably:');
          console.warn('[EAM]   https://www.linkedin.com/jobs/search/?keywords=YOUR_KW&f_AL=true');
          console.warn('[EAM] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          u().log('⚠ Degraded layout on this URL — Easy Apply modal won\'t open in-place.');
          u().log('   Open https://www.linkedin.com/jobs/search/?keywords=...&f_AL=true');
          return [];
        }
        return [];
      }

      // Legacy /jobs/search/ + /jobs/collections/easy-apply/
      let cards = document.querySelectorAll('li[data-occludable-job-id]');
      if (cards.length > 0) { console.debug('[EAM Diag] getJobCards (legacy occludable):', cards.length); return cards; }
      cards = document.querySelectorAll('.jobs-search-results__list-item, .scaffold-layout__list-item');
      if (cards.length > 0) { console.debug('[EAM Diag] getJobCards (legacy list-item):', cards.length); return cards; }
      cards = document.querySelectorAll('.job-card-container, [data-job-id]');
      console.debug('[EAM Diag] getJobCards (legacy container):', cards.length);
      return cards;
    }

    getJobInfo(jobCard) {
      if (this._isNewSearchResults()) {
        // New design parses by positional <p>. The first <p> contains both
        // the a11y label "<title> (<badge>)" and the visible title — strip
        // the parenthetical to keep just the role.
        const ps = [...jobCard.querySelectorAll('p')];
        let title = '';
        if (ps[0]) {
          const raw = (ps[0].textContent || '').replace(/\s+/g, ' ').trim();
          title = raw.replace(/\(.*?\)/g, '').trim();
          // Strip the a11y suffix LinkedIn appends to the verified-badge
          // duplicate ("Data Analyst\n\nData Analyst with verification").
          title = title.replace(/\s+with verification\b.*$/i, '').trim();
          // The title appears twice (a11y + visible). Dedupe: if the string
          // is a doubled prefix (with optional separator), keep the first half.
          const dedup = _dedupeDoubled(title);
          if (dedup) title = dedup;
        }
        const company = (ps[1]?.textContent || '').trim();
        const location = (ps[2]?.textContent || '').trim();
        // "Actively reviewing applicants" / "Posted X ago" — useful as description
        const description = [ps[3]?.textContent, ps[4]?.textContent].filter(Boolean).join(' · ').trim();
        // Always store canonical /jobs/view/{jobId}/ — search-results URLs with
        // `currentJobId=` reload the search and don't reliably re-open the job.
        let link = jobCard.querySelector('a[href*="/jobs/view/"]')?.href || window.location.href;
        link = _canonicalJobUrl(link) || link;
        return { title, company, description, link, location };
      }

      // Legacy
      let title = jobCard.querySelector(
        '.job-card-list__title, .artdeco-entity-lockup__title, ' +
        '.job-card-container__link strong, a[class*="job-card"] strong'
      )?.textContent.replace(/\s+/g, ' ').trim() || '';
      title = title.replace(/\s+with verification\b.*$/i, '').trim();
      const _dd = _dedupeDoubled(title); if (_dd) title = _dd;
      const company = jobCard.querySelector(
        '.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, ' +
        '.artdeco-entity-lockup__caption'
      )?.textContent.trim() || '';
      const description = jobCard.querySelector(
        '.job-card-container__metadata-item, .job-card-list__insight'
      )?.textContent.trim() || '';
      let link = jobCard.querySelector('a')?.href || window.location.href;
      link = _canonicalJobUrl(link) || link;
      const location = jobCard.querySelector(
        '.job-card-container__metadata-wrapper li, .artdeco-entity-lockup__caption, ' +
        '.job-card-container__metadata-item--workplace-type'
      )?.textContent.trim() ||
        document.querySelector(
          '.job-details-jobs-unified-top-card__primary-description-container .tvm__text, ' +
          '.jobs-unified-top-card__subtitle-primary-grouping .tvm__text'
        )?.textContent.trim() || '';
      return { title, company, description, link, location };
    }

    async clickJobCard(jobCard) {
      jobCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
      await u().wait(500);

      if (this._isNewSearchResults()) {
        // New cards have no inner <a> — click the card itself. React updates
        // ?currentJobId= in the URL and re-renders the right pane.
        // STRICT: track ONLY the currentJobId param (not the full URL).
        // LinkedIn's tracking refreshes referralSearchId/eBP on every
        // re-render, so window.location.href changes slightly even when
        // the focused job didn't actually switch. Comparing the full
        // URL would falsely report success for a no-op click. Comparing
        // currentJobId catches the real "did the focused job change?".
        const getJobId = (url) => (url.match(/currentJobId=(\d+)/) || [])[1] || null;
        const idBefore = getJobId(window.location.href);

        // ── EARLY EXIT: card is ALREADY the URL-focused job ────────────
        // Skas bug 2026-08-12 signature: on session start, cards[0] is the
        // pre-selected job (LinkedIn opens with ?currentJobId=X and cards
        // sorted such that card 0 = X). Any click on cards[0] is a no-op
        // by design — URL is already at X. Without this check, the retry
        // chain (wrapper → inner P → focus+Enter) all "fail" because URL
        // never changes, the card gets marked stale + skipped, and every
        // subsequent card iteration hits the same false-failure pattern
        // once React re-sorts. Detect via componentkey match and treat as
        // success — the right pane is already loaded, EA button ready.
        try {
          const _cardCk = jobCard.getAttribute && jobCard.getAttribute('componentkey');
          const _cardJobId = _cardCk && (_cardCk.match(/(\d{6,})/) || [])[1];
          if (_cardJobId && _cardJobId === idBefore) {
            console.log('[EAM] clickJobCard: card ' + _cardJobId + ' already URL-focused → skip click, proceed');
            return true;
          }
        } catch (_) {}

        // Retry chain for card selection. LinkedIn A/B experiments vary the
        // React attachment depth + which events they honor. Try progressively
        // stronger strategies, exit on first URL change:
        //   1. Native click on the componentkey wrapper (most sessions)
        //   2. Click on inner <a> / <p> (Skas Aug 2026 bucket where the
        //      React onClick is on a nested div, not the wrapper)
        //   3. Click on elementFromPoint at card center (mimics real mouse)
        //   4. focus() + Enter keydown — UI-CHANGE-PROOF. LinkedIn must
        //      keep role="button" tabindex="0" cards keyboard-accessible
        //      (WCAG 2.1), so Enter always fires their onClick. Bypasses
        //      the click event pipeline entirely — no sensitivity to React
        //      delegation quirks, Chrome version, or A/B DOM variants.
        // Total time budget: 4 targets × 3 polls × 400ms = ~4.8s worst case.
        const clickTargets = [jobCard];
        const innerCandidates = [
          ...jobCard.querySelectorAll('a[href*="/jobs/view/"], a[data-control-name*="job"], [role="link"]'),
          ...jobCard.querySelectorAll('p'),
        ];
        if (innerCandidates.length > 0) clickTargets.push(innerCandidates[0]);
        try {
          const r = jobCard.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const elAtPoint = document.elementFromPoint(cx, cy);
            if (elAtPoint && jobCard.contains(elAtPoint) && !clickTargets.includes(elAtPoint)) {
              clickTargets.push(elAtPoint);
            }
          }
        } catch (_) {}

        for (let tIdx = 0; tIdx < clickTargets.length; tIdx++) {
          const target = clickTargets[tIdx];
          if (tIdx > 0) {
            console.debug('[EAM] clickJobCard: previous target no-op, trying', tIdx, target.tagName);
          }
          // Use clickWithRetry (dispatchEvent chain + native click) — job
          // cards need this to trigger React's onClick. Do NOT change to
          // simple click() — that was the v2.5.44→52 regression that
          // broke fillFormStep. See utils.js comments.
          await u().clickWithRetry(target);
          for (let i = 0; i < 3; i++) {
            await u().wait(400);
            const idAfter = getJobId(window.location.href);
            if (idAfter && idAfter !== idBefore) {
              await u().wait(800);
              return true;
            }
          }
        }

        // Strategy 4: keyboard activation via focus + Enter. Verified
        // 2026-08-12 to reliably switch focus job on Théo's session AND
        // to work independent of React click-handler attachment (bypasses
        // the pipeline entirely). LinkedIn's accessibility contract makes
        // this the most stable path across UI updates + A/B buckets.
        try {
          console.debug('[EAM] clickJobCard: click targets exhausted, trying focus+Enter');
          jobCard.focus();
          await u().wait(150);
          const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          jobCard.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
          jobCard.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
          jobCard.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
          for (let i = 0; i < 4; i++) {
            await u().wait(400);
            const idAfter = getJobId(window.location.href);
            if (idAfter && idAfter !== idBefore) {
              console.log('[EAM] clickJobCard: recovered via focus+Enter');
              await u().wait(800);
              return true;
            }
          }
        } catch (kbErr) {
          console.debug('[EAM] focus+Enter fallback threw:', kbErr.message);
        }
        // Retry with a FRESH card reference. LinkedIn's virtualized list
        // may have unmounted/remounted the card since getJobCards() ran,
        // making our jobCard ref point to a detached DOM node. Re-query
        // by componentkey — verified 2026-08-12 that the new /jobs/search-
        // results/ cards have NO inner <a href> anchors at all. The only
        // stable per-card identifier is `componentkey="job-card-component-
        // ref-{jobId}"`. Fall back to /jobs/view/ anchor for legacy
        // layouts that still emit them (older LinkedIn A/B buckets).
        try {
          const ck = jobCard.getAttribute && jobCard.getAttribute('componentkey');
          const staleJobId =
            (ck && (ck.match(/(\d{6,})/) || [])[1]) ||
            (jobCard.querySelector && (jobCard.querySelector('a[href*="/jobs/view/"]')?.href || '').match(/\/jobs\/view\/(\d+)/)?.[1]);
          if (staleJobId) {
            const freshCards = document.querySelectorAll('div[componentkey][role="button"][tabindex]:has(figure img)');
            const fresh = [...freshCards].find(c => {
              const fck = c.getAttribute('componentkey') || '';
              if (fck.includes(staleJobId)) return true;
              return !!c.querySelector(`a[href*="/jobs/view/${staleJobId}"]`);
            });
            if (fresh && fresh !== jobCard) {
              console.log('[EAM] clickJobCard: retrying with fresh card ref for jobId', staleJobId);
              fresh.scrollIntoView({ block: 'start', behavior: 'auto' });
              await u().wait(300);
              await u().clickWithRetry(fresh);
              for (let i = 0; i < 6; i++) {
                await u().wait(500);
                const idAfter = getJobId(window.location.href);
                if (idAfter && idAfter !== idBefore) {
                  await u().wait(800);
                  return true;
                }
              }
            }
          }
        } catch (e) {
          console.debug('[EAM] fresh-card-retry threw:', e.message);
        }
        console.log('[EAM] clickJobCard: currentJobId did not change after click — stale card ref or React no-op');
        // ── DIAG BLOCK ─────────────────────────────────────────────────
        // Fires ONLY on persistent click failure (after both native + fresh-ref
        // retry failed). Dumps environment + DOM state so we can identify
        // what's different about this user's session (2026-08 Skas bug repro).
        // Rate-limited: only fires 3× per session to avoid log flood.
        try {
          window.__EAM_DIAG_COUNT = (window.__EAM_DIAG_COUNT || 0) + 1;
          if (window.__EAM_DIAG_COUNT <= 3) {
            const rect = jobCard.getBoundingClientRect();
            const cx = Math.round(rect.left + rect.width / 2);
            const cy = Math.round(rect.top + rect.height / 2);
            const elAtPoint = document.elementFromPoint(cx, cy);
            const overlays = [];
            let cur = elAtPoint;
            while (cur && cur !== jobCard && cur !== document.body && overlays.length < 4) {
              overlays.push(`${cur.tagName}${cur.id ? '#' + cur.id : ''}${cur.className && typeof cur.className === 'string' ? '.' + cur.className.slice(0, 40) : ''}`);
              cur = cur.parentElement;
            }
            const _ck = jobCard.getAttribute && jobCard.getAttribute('componentkey');
            const staleJobId =
              (_ck && (_ck.match(/(\d{6,})/) || [])[1]) ||
              (jobCard.querySelector && (jobCard.querySelector('a[href*="/jobs/view/"]')?.href || '').match(/\/jobs\/view\/(\d+)/)?.[1]);
            const allCardsNow = document.querySelectorAll('div[componentkey][role="button"][tabindex]:has(figure img)').length;
            const diag = {
              chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || navigator.userAgent.slice(0, 80),
              extVersion: (chrome?.runtime?.getManifest?.() || {}).version || '?',
              url: window.location.href,
              cardStillInDom: document.contains(jobCard),
              cardComponentKey: _ck || 'NONE',
              cardJobId: staleJobId || 'NONE',
              cardOuterHtmlTrunc: (jobCard.outerHTML || '').slice(0, 700),
              cardFirstChildren: [...jobCard.children].slice(0, 5).map(c => {
                const cn = (c.className && typeof c.className === 'string' ? c.className : '').slice(0, 50);
                return c.tagName + (cn ? '.' + cn : '');
              }),
              cardParentChain: (() => {
                const chain = [];
                let cur = jobCard.parentElement;
                for (let i = 0; i < 3 && cur; i++) {
                  const cn = (cur.className && typeof cur.className === 'string' ? cur.className : '').slice(0, 40);
                  chain.push(cur.tagName + (cn ? '.' + cn : ''));
                  cur = cur.parentElement;
                }
                return chain;
              })(),
              chromeExtCount: (function() {
                try { return chrome?.runtime?.getManifest ? 'own-manifest-only' : 'unknown'; }
                catch (_) { return 'blocked'; }
              })(),
              cardRect: `${Math.round(rect.width)}×${Math.round(rect.height)} @ ${Math.round(rect.left)},${Math.round(rect.top)}`,
              cardVisible: rect.width > 0 && rect.height > 0,
              scrollY: window.scrollY,
              elementAtClickPoint: elAtPoint ? `${elAtPoint.tagName}${elAtPoint.id ? '#' + elAtPoint.id : ''}` : 'NULL',
              overlayChain: overlays.join(' > '),
              overlayInterceptsClick: elAtPoint !== jobCard && !jobCard.contains(elAtPoint),
              cardsFoundOnPage: allCardsNow,
              currentJobIdInUrl: (window.location.href.match(/currentJobId=(\d+)/) || [])[1] || 'NONE',
              docHasFocus: document.hasFocus(),
              docVisibility: document.visibilityState,
            };
            console.warn('[EAM DIAG click-failure ' + window.__EAM_DIAG_COUNT + '/3]', JSON.stringify(diag, null, 2));
          }
        } catch (dErr) {
          console.warn('[EAM DIAG] failed to collect:', dErr.message);
        }
        return false;
      }

      // Legacy path (/jobs/search/, /jobs/collections/, /jobs/collections/easy-apply/)
      //
      // Empty-card hydration wait: on /jobs/collections/*, cards past the
      // viewport are Ember-virtualized (<li> with just <!----> inside). The
      // initial scrollIntoView above should trigger hydration but LinkedIn's
      // internal observer may lag. If the <li> still has no <a> after 500ms,
      // wait up to 3s (in 500ms slices) for React to hydrate before falling
      // back to clicking the <li> itself. Without this, empty cards silently
      // return true without navigating, and the engine then queries the
      // right pane from the PREVIOUS card → wrong isEasyApply / applyBtn
      // context, corrupting iteration.
      let link = jobCard.querySelector('a');
      for (let attempt = 0; attempt < 6 && !link; attempt++) {
        await u().wait(500);
        link = jobCard.querySelector('a');
      }
      const idBefore = (window.location.href.match(/currentJobId=(\d+)/) || [])[1] || null;
      if (link) {
        await u().click(link);
      } else {
        // Card never hydrated — click the <li> itself as a last resort.
        // React may or may not respond. If it doesn't, we detect via
        // currentJobId not changing and return false so mainLoop skips.
        console.log('[EAM] clickJobCard: card never hydrated, clicking <li> as fallback');
        await u().click(jobCard);
      }
      // Confirm navigation via currentJobId change (max 3s wait).
      for (let i = 0; i < 6; i++) {
        await u().wait(500);
        const idAfter = (window.location.href.match(/currentJobId=(\d+)/) || [])[1] || null;
        if (idAfter && idAfter !== idBefore) return true;
      }
      // No navigation — either stale card OR our fallback click did nothing.
      // Return false so engine skips this card cleanly instead of running
      // the apply flow against the previous card's pane.
      console.log('[EAM] clickJobCard: currentJobId did not change → skip stale card');
      return false;
    }

    // ── Pre-check: is this job Easy Apply? (from the card itself) ──────
    isEasyApply(jobCard) {
      const S = window.EAM.JobBoardStrings;

      // PRE-SKIP already-applied cards (any layout). On variant A the
      // applied badge appears as " Applied · " in the card's textContent.
      // Without this pre-skip, the bot clicks the card, finds the EA <a>
      // (which still exists for accessibility), clicks it, no modal opens
      // (LinkedIn knows the user already applied), 5s wasted, then skip.
      // Worse: on some layouts the EA <a> click navigates the whole page
      // away from the search results, breaking iteration. Reject early.
      const cardText = (jobCard.textContent || '');
      if (/\bApplied\b\s*[·•|]/i.test(cardText) ||
          /Application submitted/i.test(cardText) ||
          /Candidature envoyée/i.test(cardText) ||
          /Postulation envoyée/i.test(cardText) ||
          /Ya postulado/i.test(cardText) ||
          /Bewerbung gesendet/i.test(cardText)) {
        console.log('[EAM] isEasyApply=false — card has "Applied" badge, skip');
        return false;
      }

      if (this._isNewSearchResults()) {
        // The new card layout puts the "Easy Apply" badge as a standalone
        // <p> (no class hook). Text match is the only stable signal.
        const text = cardText.toLowerCase();
        if (/\beasy\s*apply\b/i.test(text)) return true;
        if (S && S.matchText(cardText, 'easy_apply')) return true;
        return false;
      }

      // Legacy: language-agnostic CSS class + bolt icon, then text fallback.
      // Apr 2026 LinkedIn renamed the bolt icon from `bolt-small` /
      // `li-icon[type="linkedin-bug"]` to `data-test-icon="linkedin-bug-
      // color-small"` (and dropped the `.apply-method` class entirely on
      // /jobs/collections/easy-apply/). We accept any "linkedin-bug"
      // variant so future renames keep matching.
      if (jobCard.querySelector('.job-card-container__apply-method, [class*="apply-method"], [class*="easy-apply"]')) {
        console.debug('[EAM Diag] isEasyApply: matched .apply-method class');
        return true;
      }
      if (jobCard.querySelector('li-icon[type*="linkedin-bug"], svg[data-test-icon*="linkedin-bug"], svg[data-test-icon="bolt-small"]')) {
        console.debug('[EAM Diag] isEasyApply: matched LinkedIn bolt/bug icon');
        return true;
      }
      const footer = jobCard.querySelector('.job-card-container__footer-wrapper, .job-card-list__footer-wrapper') || jobCard;
      if (S && S.matchText(footer.textContent, 'easy_apply')) {
        console.debug('[EAM Diag] isEasyApply: matched localized text');
        return true;
      }

      console.debug('[EAM Diag] isEasyApply=false — no match for', (jobCard.textContent||'').replace(/\s+/g,' ').slice(0, 60));
      return false;
    }

    // ── Apply button ────────────────────────────────────────────────────
    getApplyButton() {
      const S = window.EAM.JobBoardStrings;

      if (this._isNewSearchResults()) {
        // Arm the modal observer right before the bot clicks Apply.
        this._armModalObserver();

        // Helper: an Easy Apply button is only valid if it's visible.
        // Returning a hidden button (offsetParent === null, e.g., from a
        // job that was already applied to but still has the residual
        // `<a>` in the DOM) causes the bot to "click" nothing, then
        // wait 5s for a modal that never appears, and the engine
        // mis-categorizes this as either a daily-limit hit or a benign
        // skip — all of which break the iteration. Visibility check
        // is the safest filter.
        const visibleEA = (el) => el && el.offsetParent !== null;

        let a = document.querySelector('a[aria-label="Easy Apply to this job"]');
        if (visibleEA(a)) return a;
        a = document.querySelector('a[aria-label*="Easy Apply"]');
        if (visibleEA(a)) return a;
        if (S) {
          a = document.querySelector(S.attrSelector('aria-label', 'easy_apply'));
          if (visibleEA(a)) return a;
        }
        // Absolute last-ditch: any button/anchor whose text is "Easy Apply"
        const cand = [...document.querySelectorAll('a, button, [role="button"]')]
          .find(el => /^easy\s*apply$/i.test((el.textContent||'').trim()) && el.offsetParent !== null);
        if (cand) return cand;
        return null;
      }

      // Primary: the jobs-apply-button class is locale-independent
      let btn = document.querySelector('button.jobs-apply-button');
      if (btn) {
        // On /jobs/search/, make sure it's specifically the Easy Apply one
        // by checking the aria-label across languages. If we can't tell, accept.
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (!aria || (S && S.matchText(aria, 'easy_apply')) || (S && S.matchText(aria, 'apply'))) {
          return btn;
        }
      }

      // Fallback: attribute-contains selector across all translations.
      // SCOPE to the detail scaffold — otherwise the "Easy Apply filter."
      // toggle in the filters bar (top of /jobs/search/) matches first and
      // we mis-click a filter chip instead of the real Apply button. Same
      // for /jobs/view/{id}/ where the Apply is an <a>.
      const detailScope = document.querySelector(
        '.jobs-search__job-details, .scaffold-layout__detail, .job-view-layout, .jobs-details'
      ) || document;
      if (S) {
        const easyApplySel = S.attrSelector('aria-label', 'easy_apply');
        // Try scoped first, then any button/anchor
        btn = detailScope.querySelector(
          `button${easyApplySel.split(',').join(', button')}, ` +
          `a${easyApplySel.split(',').join(', a')}`
        );
        if (btn && btn.offsetParent !== null) return btn;
        // Fallback to any scope but exclude filter chips + toggles.
        const all = document.querySelectorAll(easyApplySel);
        for (const el of all) {
          if (el.offsetParent === null) continue;
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (/filter|filtre|filtro/i.test(aria)) continue;
          if (el.tagName !== 'BUTTON' && el.tagName !== 'A') continue;
          return el;
        }
      }

      // Last-resort fallback for collections pages (less strict)
      const isCollections = /\/jobs\/collections\//i.test(window.location.href);
      if (isCollections && S) {
        const applySel = S.attrSelector('aria-label', 'apply');
        btn = detailScope.querySelector(
          `button${applySel.split(',').join(', button')}, ` +
          `a${applySel.split(',').join(', a')}`
        );
        if (btn && btn.offsetParent !== null) return btn;
      }

      return null;
    }

    // ── Form modal ──────────────────────────────────────────────────────
    // /jobs/search-results/ (Apr 2026 redesign): Easy Apply modal is
    // mounted inside an OPEN Shadow DOM at <div id="interop-outlet">.
    // We pierce the shadow root and return the dialog/form element
    // inside. form-filler.js's `modal.querySelectorAll(...)` will then
    // resolve correctly against the shadow tree.
    getFormModal() {
      // ── /jobs/search-results/ (Apr 2026 redesign) ────────────────────
      // STRICT path: the Easy Apply modal only ever renders as a
      // [role="dialog"] inside the open shadow root at #interop-outlet.
      // Any other element matched by the legacy fallbacks (light-DOM
      // .artdeco-modal, ad iframes with form fields, messaging overlay)
      // would be a FALSE POSITIVE on this surface — and the user-reported
      // "Modal from previous job still open!" infinite loop is exactly
      // that case. So on /jobs/search-results/ we return EITHER the real
      // shadow dialog OR null. No fallbacks. No iframe scan. No light-DOM
      // sweep. No _capturedModal carryover.
      if (this._isNewSearchResults()) {
        const sr = this._getInteropShadowRoot();
        if (!sr) {
          console.log('[EAM strict] getFormModal: shadow root NOT mounted → null');
          return null;
        }
        // Find ALL visible dialogs — there may be multiple (e.g., a stale
        // "Application sent" success dialog AND the actual EA modal).
        const allDialogs = [...sr.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
          .filter(d => d.offsetParent !== null);
        if (allDialogs.length === 0) {
          console.log('[EAM strict] getFormModal: shadow root present, no visible dialog → null');
          return null;
        }

        // EA FINGERPRINT — a dialog is the Easy Apply modal ONLY if it has
        // at least ONE of these signals. Any other dialog (success popup,
        // job suggestion, save-job prompt, post-apply confirmation) is
        // NOT the EA modal and we must NOT treat it as a leftover.
        const isEAModal = (d) => {
          const className = (d.className || '') + '';
          // Strongest: legacy class that LinkedIn kept across redesigns
          if (/easy-apply|jobs-apply/i.test(className)) return 'class:' + className.slice(0, 60);
          if (d.querySelector && d.querySelector('[class*="easy-apply" i], [class*="jobs-apply" i]')) return 'inner-class';
          // 2026-08: New layout — modal identified by data-* attrs that
          // survive class hashing. Add before heading/text heuristics so
          // it fires even when the modal has no <h1> yet.
          if (d.querySelector && d.querySelector(
            '[data-test-modal-id*="easy-apply" i], ' +
            '[data-test-jobs-easy-apply-modal], ' +
            'form input[type="file"][name*="resume" i], ' +
            'button[data-live-test-easy-apply-submit-button]'
          )) return 'data-attr';
          // Heading "Apply to <company>" / localized
          const headings = d.querySelectorAll ? [...d.querySelectorAll('h1, h2, h3')] : [];
          for (const h of headings) {
            const t = (h.textContent || '').trim();
            if (/^(apply\s+to|postuler\s+(à|chez)|candidatar(-se)?|aplicar\s+a|bewerben\s+bei|申请)/i.test(t)) {
              return 'heading:' + t.slice(0, 50);
            }
          }
          // Inner button with EA-specific aria-label
          if (d.querySelector && d.querySelector(
            'button[aria-label*="Submit application" i], ' +
            'button[aria-label*="Continue applying" i], ' +
            'button[aria-label*="Soumettre la candidature" i], ' +
            'button[aria-label*="Continuer la candidature" i], ' +
            'button[aria-label*="Review your application" i], ' +
            'button[aria-label*="Vérifier votre candidature" i]'
          )) return 'submit-button';
          // Last resort: dialog text starts with "Apply to" / similar.
          // Use trimmed first 80 chars to avoid false positives from
          // long unrelated content.
          const txt = (d.textContent || '').replace(/\s+/g, ' ').trim();
          if (/^(dialog content start\.\s*)?(apply to|postuler|candidatar)/i.test(txt)) {
            return 'text-prefix:' + txt.slice(0, 50);
          }
          return null;
        };

        for (const d of allDialogs) {
          const sig = isEAModal(d);
          if (sig) {
            console.log('[EAM strict] getFormModal: EA dialog confirmed by fingerprint (' + sig + ') → returning');
            return d;
          }
        }

        // No dialog matches EA fingerprint — log details so we can extend
        // the fingerprint if a real EA modal ever gets filtered out, and
        // return null (engine treats this as "not a leftover").
        console.log('[EAM strict] getFormModal: ' + allDialogs.length + ' visible dialog(s) but NONE match EA fingerprint → null');
        for (const d of allDialogs.slice(0, 3)) {
          console.log('  dialog class="' + ((d.className || '') + '').slice(0, 80) + '"');
          console.log('  dialog text="' + (d.textContent || '').replace(/\s+/g, ' ').slice(0, 120) + '"');
        }
        return null;
      }

      // ── Legacy paths (/jobs/search/, /jobs/collections/...) ─────────
      if (this._capturedModal && this._capturedModal.offsetParent !== null) {
        return this._capturedModal;
      }
      const visible = (el) => el && el.offsetParent !== null;

      // 1. Legacy /jobs/search/ — unchanged
      let m = document.querySelector('.jobs-easy-apply-modal');
      if (visible(m)) return m;
      m = document.querySelector('.artdeco-modal');
      if (visible(m)) return m;

      // 2. Same-origin iframe scan (legacy edge case, kept for non-new-design)
      const isChromeInput = (i) =>
        /search/i.test(i.placeholder || '') ||
        /recaptcha/i.test(i.name || '') ||
        /adToggle|globalNav/i.test(i.id || '');

      const iframes = [...document.querySelectorAll('iframe')].filter(visible);
      const diag = [];
      for (const ifr of iframes) {
        const r = ifr.getBoundingClientRect();
        if (r.width < 500 || r.height < 350) continue;
        let idoc = null;
        try { idoc = ifr.contentDocument; } catch (e) { continue; }
        if (!idoc || !idoc.body) continue;

        const allInputs = [...idoc.querySelectorAll('input, textarea, select')];
        const formInputs = allInputs.filter(i => !isChromeInput(i));
        const hasFormButton = !!idoc.querySelector(
          'button[type="submit"], ' +
          'button[aria-label*="Submit application"], ' +
          'button[aria-label*="Continue applying"], ' +
          'button[aria-label*="Continue"], ' +
          'button[aria-label*="Review"], ' +
          'button[aria-label*="Submit"], ' +
          'button[aria-label*="Next"], ' +
          'button[aria-label*="Suivant"], ' +
          'button[aria-label*="Soumettre"]'
        );
        const hasModalClass = !!idoc.querySelector('.jobs-easy-apply-modal, .jobs-easy-apply-content, [data-test-modal-id*="easy-apply"]');

        diag.push({
          path: idoc.location && idoc.location.pathname,
          size: Math.round(r.width) + 'x' + Math.round(r.height),
          allInputs: allInputs.length,
          formInputs: formInputs.length,
          hasFormButton,
          hasModalClass,
        });

        if (hasModalClass || formInputs.length > 0 || hasFormButton) {
          return idoc.body;
        }
      }

      // 3. Last-ditch: any visible ARIA dialog whose text mentions Easy
      //    Apply. Useful if LinkedIn switches the modal back to the
      //    parent doc on a future rollout.
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].filter(visible);
      const ea = dialogs.find(d => /easy\s*apply|postulation/i.test(d.textContent || ''));
      if (ea) return ea;

      // 4. Diagnostic dump for fast iteration. Logs once per failed
      //    lookup so the user can paste back if the modal still isn't
      //    found. Cheap and only fires when nothing else matched.
      if (this._isNewSearchResults() && diag.length > 0) {
        try {
          console.warn('[EAM][getFormModal] no match — iframe states:', JSON.stringify(diag));
        } catch (e) {}
      }
      return null;
    }

    // ── Next / Submit button ────────────────────────────────────────────
    getNextStepButton(modal) {
      const S = window.EAM.JobBoardStrings;
      if (!S) return null;
      return Array.from(modal.querySelectorAll('button')).find(btn => {
        const text = btn.textContent;
        return S.matchText(text, 'next') ||
               S.matchText(text, 'review') ||
               S.matchText(text, 'submit');
      }) || null;
    }

    isSubmitButton(button) {
      const S = window.EAM.JobBoardStrings;
      return S ? S.matchText(button.textContent, 'submit') : false;
    }

    // ── Pre-submit: unfollow company ────────────────────────────────────
    async handlePreSubmit(modal, submitBtn) {
      u().log('Before Submit: unfollow company...');
      submitBtn.scrollIntoView({ block: 'end', behavior: 'smooth' });
      await u().wait(800);

      const followCheckbox = modal.querySelector('input[id="follow-company-checkbox"]') ||
                            modal.querySelector('input[id*="follow-company"][type="checkbox"]');
      if (followCheckbox && followCheckbox.checked) {
        followCheckbox.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await u().wait(500);
        const label = modal.querySelector(`label[for="${followCheckbox.id}"]`);
        if (label) {
          await u().click(label);
          u().log('Company UNFOLLOWED');
        } else {
          followCheckbox.click();
          u().log('Company UNFOLLOWED (fallback)');
        }
      }
      await u().wait(500);
    }

    // ── Done button (post-submit) ───────────────────────────────────────
    async findAndClickDoneButton(contextElement = document, contextName = 'page', maxAttempts = 15) {
      u().log(`[${contextName}] Searching for Done/Dismiss button...`);
      const S = window.EAM.JobBoardStrings;
      let doneBtn = null;

      for (let attempt = 0; attempt < maxAttempts && !doneBtn; attempt++) {
        await u().wait(1000);

        // METHOD 0: X (close) button on "Application sent" modal — locale-independent
        // by class + data-attr, plus aria-label fallback across languages.
        const classSelectors = [
          'button.artdeco-modal__dismiss',
          'button[data-test-modal-close-btn]',
        ];
        for (const sel of classSelectors) {
          const xBtn = contextElement.querySelector(sel) || document.querySelector(sel);
          if (xBtn && xBtn.offsetParent !== null) { doneBtn = xBtn; break; }
        }
        if (doneBtn) break;

        // aria-label across all supported languages
        if (S) {
          const ariaSel = S.attrSelector('aria-label', 'close');
          const xBtn = contextElement.querySelector(ariaSel) || document.querySelector(ariaSel);
          if (xBtn && xBtn.offsetParent !== null) { doneBtn = xBtn; break; }
        }

        // METHOD 1+2: any button/span whose text matches Done/Submit across languages
        const buttons = Array.from(contextElement.querySelectorAll('button, [role="button"], span.artdeco-button__text'));
        for (const el of buttons) {
          if (!S) break;
          const text = el.textContent;
          if (S.matchText(text, 'done') || S.matchText(text, 'submit') || S.matchText(text, 'close')) {
            const clickable = el.closest('button, [role="button"], .artdeco-button') || el;
            if (clickable.offsetParent !== null) { doneBtn = clickable; break; }
          }
        }
        if (doneBtn) break;

        // METHOD 3: data-control-name (LinkedIn's internal event names — locale-independent)
        for (const name of ['done', 'submit', 'continue_application', 'dismiss']) {
          const controlBtn = contextElement.querySelector(`button[data-control-name*="${name}"]`);
          if (controlBtn && controlBtn.offsetParent !== null) { doneBtn = controlBtn; break; }
        }
      }

      if (doneBtn) {
        try {
          doneBtn.click();
          await u().wait(500);
          u().updateActivity();
          await u().wait(700);
          return { success: true, clicked: true };
        } catch (e1) {
          try {
            doneBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            await u().wait(500);
            return { success: true, clicked: true };
          } catch (e2) {
            try {
              doneBtn.focus();
              await u().wait(200);
              doneBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
              doneBtn.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
              await u().wait(500);
              return { success: true, clicked: true };
            } catch (e3) {
              return { success: false, clicked: false, reason: 'Click failed' };
            }
          }
        }
      }
      return { success: false, clicked: false, reason: 'Button not found' };
    }

    // ── Clear ALL modals/popups (robust post-submit cleanup) ──────────
    // Handles: "Application sent", "Your application was sent to X!",
    // "Done", confirmation dialogs, any artdeco-modal still open.
    async clearAllModals(maxAttempts = 5) {
      const MODAL_SELECTORS = [
        '.artdeco-modal--is-open',
        '.jobs-easy-apply-modal',
        '.artdeco-modal[role="dialog"]',
        '[role="dialog"].artdeco-modal',
        '.jobs-apply-modal',
        '[role="dialog"]',           // generic — covers /jobs/search-results/
        '[aria-modal="true"]',
      ];
      const X_BUTTON_SELECTORS = [
        'button.artdeco-modal__dismiss',
        'button[aria-label="Dismiss"]',
        'button[aria-label="Fermer"]',
        'button[aria-label="Close"]',
        'button[data-test-modal-close-btn]',
        'button.msg-overlay-bubble-header__control--new-convo-btn', // message overlay
      ];
      const CLOSE_TEXTS = /^(done|close|dismiss|fermer|terminé|got it|ok|continue|continuer)$/i;

      // On /jobs/search-results/ the post-submit "Application sent" / "Done"
      // dialog lives inside the open shadow root at #interop-outlet — plain
      // document.querySelector won't see it. Pierce the shadow first.
      const queryRoots = [document];
      const sr = this._getInteropShadowRoot();
      if (sr) queryRoots.push(sr);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Find any visible modal across all roots (parent doc + shadow)
        let modal = null;
        for (const root of queryRoots) {
          for (const sel of MODAL_SELECTORS) {
            const el = root.querySelector(sel);
            if (el && el.offsetParent !== null) { modal = el; break; }
          }
          if (modal) break;
        }
        if (!modal) return true; // No modal — all clear

        u().log(`[clearAllModals] Modal found (attempt ${attempt + 1}/${maxAttempts})`);

        // Strategy 1: X button (inside modal or on page)
        let clicked = false;
        for (const sel of X_BUTTON_SELECTORS) {
          const xBtn = modal.querySelector(sel) || document.querySelector(sel);
          if (xBtn && xBtn.offsetParent !== null) {
            try { xBtn.click(); } catch (e) {
              xBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            clicked = true;
            u().log(`[clearAllModals] Clicked X button: ${sel}`);
            break;
          }
        }

        // Strategy 2: Any button matching close text
        if (!clicked) {
          const closeBtn = Array.from(modal.querySelectorAll('button, [role="button"]')).find(b =>
            b.offsetParent !== null && CLOSE_TEXTS.test(b.textContent.trim())
          );
          if (closeBtn) {
            try { closeBtn.click(); } catch (e) {
              closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            clicked = true;
            u().log(`[clearAllModals] Clicked text button: "${closeBtn.textContent.trim()}"`);
          }
        }

        // Strategy 3: SVG close icon (li-icon type="close")
        if (!clicked) {
          const svgClose = modal.querySelector('button li-icon[type="close-medium"], button li-icon[type="close"], button svg[data-test-icon="close"]');
          if (svgClose) {
            const btn = svgClose.closest('button');
            if (btn && btn.offsetParent !== null) {
              btn.click();
              clicked = true;
              u().log('[clearAllModals] Clicked SVG close icon');
            }
          }
        }

        // Strategy 4: ESC key
        if (!clicked) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
          u().log('[clearAllModals] Sent ESC key');
        }

        await u().wait(800);

        // Check for discard confirmation dialog (appears after clicking X on form)
        const discardBtn = Array.from(document.querySelectorAll('button')).find(b =>
          b.offsetParent !== null && /^(discard|abandonner|descarter)$/i.test(b.textContent.trim())
        );
        if (discardBtn) {
          discardBtn.click();
          u().log('[clearAllModals] Confirmed discard dialog');
          await u().wait(800);
        }
      }

      // Final check
      const stillOpen = MODAL_SELECTORS.some(sel => {
        const el = document.querySelector(sel);
        return el && el.offsetParent !== null;
      });
      if (stillOpen) u().log('[clearAllModals] WARNING: modal still open after all attempts');
      return !stillOpen;
    }

    // ── Discard application ─────────────────────────────────────────────
    async discardApplication() {
      u().log('DISCARD: Starting discard sequence...');
      const discardTexts = ['discard', 'annuler', 'cancel', 'abandonner', 'descarter'];
      // On /jobs/search-results/ the modal lives inside an iframe; query
      // its document instead of the parent so Close/Discard/Cancel buttons
      // actually resolve. Falls back to the parent document otherwise.
      const mdoc = this._getModalDocument();

      try {
        // Only reload if a modal is actually present AND stuck. Without
        // this guard, calling discardApplication() on a non-Easy-Apply
        // job (or on a page where the bot just couldn't open the modal)
        // would refresh the page even though nothing was wrong, costing
        // the user the rest of their search results in the list.
        const presentModal = this.getFormModal();
        const modalIsStuckAndVisible = presentModal && presentModal.offsetParent !== null
          && u().checkForStuckLoadingPopup();
        if (modalIsStuckAndVisible) {
          // Skip reload if the stuck-heuristic actually caught a rate-limit
          // or daily-limit popup — those have working buttons and should
          // be handled by their own branches, not by a page refresh that
          // just re-serves the same popup and confuses users.
          const rateLimit = u().checkRateLimit && u().checkRateLimit();
          const dailyLimit = u().checkDailyLimit && u().checkDailyLimit();
          if (rateLimit || dailyLimit) {
            u().log('Stuck heuristic fired but ' +
                    (dailyLimit ? 'daily-limit' : 'rate-limit') +
                    ' popup is up — skipping reload.');
            return false;
          }
          // NEVER auto-reload on /jobs/search-results/ (see engine.js for
          // full rationale — Skas 2026-08 refresh loop bug).
          if (/\/jobs\/search-results\//i.test(window.location.pathname)) {
            u().log('⚠ Stuck-loading in discardApplication on /jobs/search-results/ — NOT refreshing (preserve filter).');
            return false;
          }
          u().log('Stuck loading popup detected - refreshing...');
          location.reload();
          await u().wait(2000);
          return true;
        }
        // No modal at all → nothing to discard, just return success so the
        // engine can move on to the next job card without losing context.
        if (!presentModal) {
          console.debug('[EAM Diag] discardApplication: no modal in DOM, treating as already-clean');
          return true;
        }

        // STEP 1: X / Close button
        const closeButtons = mdoc.querySelectorAll('button[aria-label*="Dismiss"], button[aria-label*="Close"], button.artdeco-modal__dismiss');
        for (const btn of closeButtons) {
          if (btn.offsetParent) {
            btn.click();
            await u().wait(1000);
            const discardBtn = Array.from(mdoc.querySelectorAll('button')).find(b =>
              b.offsetParent && discardTexts.some(t => b.textContent.trim().toLowerCase().includes(t))
            );
            if (discardBtn) {
              discardBtn.click();
              await u().wait(1500);
            }
            const modal = this.getFormModal();
            if (!modal || modal.offsetParent === null) return true;
          }
        }

        // STEP 2: ESC key
        mdoc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        mdoc.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
        await u().wait(1000);

        // STEP 3: Discard / Cancel buttons
        for (let attempt = 1; attempt <= 3; attempt++) {
          const allButtons = Array.from(mdoc.querySelectorAll('button, [role="button"]'));
          for (const btn of allButtons) {
            if (!btn.offsetParent) continue;
            const btnText = btn.textContent.trim().toLowerCase();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            const dataControl = (btn.getAttribute('data-control-name') || '').toLowerCase();
            const isDiscard = discardTexts.some(t =>
              btnText === t || btnText.includes(t) || ariaLabel.includes(t) || dataControl.includes(t)
            );
            if (isDiscard) {
              try { btn.click(); await u().wait(300); btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (e) {}
              await u().wait(1500);
              const modal = this.getFormModal();
              if (!modal || modal.offsetParent === null) return true;
            }
          }
          await u().wait(1000);
        }
        return false;
      } catch (error) {
        u().log(`Discard error: ${error.message}`);
        return false;
      }
    }

    // ── Validation errors ───────────────────────────────────────────────
    hasValidationErrors(modal) {
      const selectors = ['[role="alert"]', '.artdeco-inline-feedback--error', '.fb-form-element-label__error'];
      for (const selector of selectors) {
        const errors = modal.querySelectorAll(selector);
        for (const error of errors) {
          if (error.offsetParent !== null) {
            const text = error.textContent.toLowerCase();
            if (text.includes('please enter') || text.includes('valid answer') ||
                text.includes('required') || text.includes('must be') ||
                text.includes('invalid') || text.includes('veuillez') || text.includes('requis')) {
              return true;
            }
          }
        }
      }
      return false;
    }

    // ── Next page ───────────────────────────────────────────────────────
    async goToNextPage() {
      // Try infinite scroll first (collections, search-results, newer UI)
      const container = document.querySelector('.jobs-search-results-list, .scaffold-layout__list-container, .jobs-search-results__list');
      if (container) {
        const before = this.getJobCards().length;
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        await u().wait(2000);
        const after = this.getJobCards().length;
        if (after > before) {
          u().log(`Loaded ${after - before} more jobs (total: ${after})`);
          return true;
        }
      }

      // VARIANT A pagination — Apr 2026 redesign uses obfuscated CSS classes
      // (no `.jobs-search-pagination__pages` wrapper) but keeps stable
      // aria attributes. Page buttons are <button aria-label="Page N">
      // with `aria-current="true"` on the active page. Find current,
      // click N+1.
      const pageButtons = [...document.querySelectorAll('button[aria-label^="Page "]')]
        .filter(b => b.offsetParent !== null);
      if (pageButtons.length > 0) {
        const activeBtn = pageButtons.find(b => b.getAttribute('aria-current') === 'true');
        if (activeBtn) {
          const currentPage = parseInt((activeBtn.getAttribute('aria-label').match(/Page (\d+)/) || [])[1] || '0');
          const nextPage = currentPage + 1;
          const nextBtn = pageButtons.find(b =>
            b.getAttribute('aria-label') === `Page ${nextPage}`
          );
          if (nextBtn) {
            u().log(`Pagination: clicking Page ${nextPage} (was on Page ${currentPage})`);
            nextBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
            await u().wait(400);
            await u().click(nextBtn);
            await u().wait(2500);
            // Verify next page loaded by checking new card list
            return true;
          }
          u().log(`Pagination: no Page ${nextPage} button — last page reached`);
        }
      }

      // Legacy /jobs/search/ pagination wrapper
      const pagination = document.querySelector('.jobs-search-pagination__pages');
      if (pagination) {
        const activeBtn = pagination.querySelector('button.active, button[aria-current="true"], li.active button, li.selected button');
        if (activeBtn) {
          const page = parseInt(activeBtn.textContent);
          const nextBtn = pagination.querySelector(`button[aria-label="Page ${page + 1}"]`) ||
                         pagination.querySelector(`button[data-test-pagination-page-btn="${page + 1}"]`);
          if (nextBtn && nextBtn.offsetParent !== null) {
            await u().click(nextBtn);
            await u().wait(1000);
            return true;
          }
        }
      }

      // Fallback: "Next" button
      const nextButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of nextButtons) {
        if (!btn.offsetParent) continue;
        const text = btn.textContent.trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text === 'next' || text === 'suivant' || text === 'siguiente' ||
            ariaLabel.includes('next') || ariaLabel.includes('suivant')) {
          const isPagination = btn.closest('.jobs-search-pagination') ||
                              btn.closest('[class*="pagination"]') ||
                              btn.getAttribute('aria-label')?.includes('page');
          if (isPagination) {
            await u().click(btn);
            await u().wait(1000);
            return true;
          }
        }
      }

      // Icon-based next
      const iconBtn = document.querySelector('.jobs-search-pagination button[aria-label*="Next"], .jobs-search-pagination button svg[class*="chevron-right"]')?.closest('button');
      if (iconBtn && iconBtn.offsetParent !== null && !iconBtn.disabled) {
        await u().click(iconBtn);
        await u().wait(1000);
        return true;
      }

      return false;
    }

    // ── Experience-based skip ───────────────────────────────────────────
    shouldSkipByExperience(jobCard, maxYearsRequired) {
      if (!maxYearsRequired || maxYearsRequired <= 0) return false;
      try {
        const title = jobCard.querySelector(
          '.job-card-list__title, .artdeco-entity-lockup__title, ' +
          '.job-card-container__link strong, a[class*="job-card"] strong'
        )?.textContent || '';
        const subtitle = jobCard.querySelector(
          '.job-card-container__metadata-item, .job-card-list__insight'
        )?.textContent || '';
        const years = u().extractYearsRequired(title + ' ' + subtitle);
        if (years > 0 && years > maxYearsRequired) {
          u().log(`Skip: ${years}+ years required (max: ${maxYearsRequired})`);
          return true;
        }
      } catch (e) {}
      return false;
    }
  }

  // Register with the site registry
  const adapter = new LinkedInAdapter();
  window.EAM.registry.register(adapter);

  // VERSION SENTINEL — if the user's bug logs don't include this exact line,
  // the browser is still running a cached/old adapter, not the strict-modal
  // build. Plain console.log (not console.debug) so it's never filtered.
  console.log('%c[EAM v' + (chrome.runtime.getManifest?.().version || '?') + ' strict-modal] LinkedIn adapter loaded ' + new Date().toISOString(),
              'color:#0a66c2;font-weight:bold');
})();
