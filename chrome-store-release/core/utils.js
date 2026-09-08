/**
 * AutoApplyMax - Shared Utilities
 * Extracted from content-simple.js
 * Namespace: window.EAM.utils
 */

(function () {
  'use strict';

  // Initialize namespace
  window.EAM = window.EAM || {};

  // ─── State ────────────────────────────────────────────────────────────
  let isRunning = false;
  let userExplicitlyClickedStart = false;
  let appliedCount = 0;
  let skippedCount = 0;
  let appliedJobs = [];
  let lastActivityTime = Date.now();
  let lastJobIndex = -1;
  const STUCK_TIMEOUT = 120000; // 2 minutes

  let config = {};
  let resumeFile = null;
  let resumeFileName = null;
  let resumeFileType = null;

  // ─── Logging ──────────────────────────────────────────────────────────
  function log(msg) {
    console.log('[EAM Bot]', msg);
    try {
      chrome.runtime.sendMessage({ type: 'log', message: msg });
    } catch (e) {}
  }

  // ─── Wait ─────────────────────────────────────────────────────────────
  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Click (PROTECTED) ────────────────────────────────────────────────
  async function click(element) {
    if (!isRunning || !userExplicitlyClickedStart) {
      console.error('SECURITY VIOLATION: Attempted click() but bot is NOT running!');
      console.error('isRunning:', isRunning, '| userExplicitlyClickedStart:', userExplicitlyClickedStart);
      console.trace('Call stack:');
      return;
    }
    // For <a href>: install a one-shot capture-phase preventDefault BEFORE
    // dispatching click. React's onClick handler still runs (in bubble
    // phase) and opens the in-place modal, but the browser's default
    // navigation is blocked. Without this, clicking the LinkedIn Easy
    // Apply <a> on certain page layouts navigates to /jobs/view/JOBID/
    // apply/ which breaks the bot's iteration (filter dropped, layout
    // changes, user loses LinkedIn session). Idempotent — no-op for
    // non-anchor elements.
    if (element && element.tagName === 'A' && element.hasAttribute('href')) {
      const blocker = (e) => { e.preventDefault(); };
      element.addEventListener('click', blocker, { once: true, capture: true });
    }
    // Simple native click — the ONLY safe default for form-filler which
    // clicks radios, selects, checkboxes, custom dropdowns, Next/Review/
    // Submit buttons. The double-fire pattern (dispatchEvent chain + native
    // click) that was here from v2.5.44→52 broke fillFormStep on some
    // LinkedIn custom widgets: dispatchEvent opens a custom dropdown, then
    // native click closes it → form-filler never sees the options → AI
    // form-answer never fires. Correlated with the 2026-08-12 form-answer
    // outage (17 calls/day → 0). The retry-chain that fixed Skas's card
    // click no-op has been moved into the dedicated `clickWithRetry` used
    // by linkedin-adapter.clickJobCard only.
    element.click();
    updateActivity();
    await wait(500);
  }

  // ─── Click with retry (for card selection only, NOT form fields) ─────
  // Used exclusively by linkedin-adapter.clickJobCard which needs the full
  // pointer+mouse sequence to trigger React's onClick on virtualized job
  // cards. Do NOT use on form fields — see rationale above the `click()`
  // function.
  async function clickWithRetry(element) {
    if (!isRunning || !userExplicitlyClickedStart) {
      console.error('SECURITY VIOLATION: Attempted clickWithRetry() but bot is NOT running!');
      return;
    }
    // Guard inner anchors on the wrapper (blocks default navigation).
    if (element && element.querySelectorAll && element.tagName !== 'A') {
      element.querySelectorAll('a[href]').forEach(a => {
        a.addEventListener('click', e => { e.preventDefault(); }, { once: true, capture: true });
      });
    }
    // Dispatch full pointer+mouse+click sequence — React 17+ delegated
    // onClick handlers on job cards need this. Fires with real coordinates
    // and bubbles.
    try {
      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent('mousedown', opts));
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
      }
      element.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
      element.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
    } catch (_) { /* fall through to native click */ }
    try { element.click(); } catch (_) {}
    updateActivity();
    await wait(500);
  }

  // ─── Fill (PROTECTED) ─────────────────────────────────────────────────
  function fill(input, value) {
    if (!isRunning || !userExplicitlyClickedStart) {
      console.error('SECURITY VIOLATION: Attempted fill() but bot is NOT running!');
      console.error('isRunning:', isRunning, '| userExplicitlyClickedStart:', userExplicitlyClickedStart);
      return;
    }
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ─── Activity tracking ────────────────────────────────────────────────
  let _lastHeartbeatWrite = 0;
  function updateActivity() {
    lastActivityTime = Date.now();
    // Refresh the cross-tab engine claim heartbeat every 30s. Fire-and-
    // forget — the claim only matters when a SECOND tab tries to Start.
    // Extension edge-case audit 2026-08-14 added this + the mutex check
    // in engine.js request.action==='start'. 90s TTL on the claim gives
    // us 3 heartbeat windows of resilience against SW restarts.
    if (isRunning && (lastActivityTime - _lastHeartbeatWrite) > 30000) {
      _lastHeartbeatWrite = lastActivityTime;
      try {
        chrome.storage.local.set({ engineOwnerClaimedAt: lastActivityTime }).catch(() => {});
      } catch (_) { /* fire-and-forget */ }
    }
  }

  function isStuck() {
    return (Date.now() - lastActivityTime) > STUCK_TIMEOUT;
  }

  // ─── File utilities ───────────────────────────────────────────────────
  function base64ToFile(base64String, filename, mimeType) {
    try {
      const base64Data = base64String.includes(',') ? base64String.split(',')[1] : base64String;
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new File([bytes], filename, { type: mimeType });
    } catch (error) {
      log(`Error converting base64 to file: ${error.message}`);
      return null;
    }
  }

  async function fillFileInput(fileInput, file) {
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Resume uploaded: ${file.name}`);
      return true;
    } catch (error) {
      log(`Error filling file input: ${error.message}`);
      return false;
    }
  }

  // ─── Storage helpers ──────────────────────────────────────────────────
  function updateAppliedCount() {
    chrome.storage.local.set({ appliedCount });
    try {
      chrome.runtime.sendMessage({ type: 'updateCount', count: appliedCount });
    } catch (e) {}
  }

  function updateSkippedCount() {
    chrome.storage.local.set({ skippedCount });
    try {
      chrome.runtime.sendMessage({ type: 'updateSkippedCount', count: skippedCount });
    } catch (e) {}
  }

  function saveAppliedJobsToStorage() {
    chrome.storage.local.set({ appliedJobs });
  }

  // ─── Skip logic ───────────────────────────────────────────────────────
  function shouldSkipByBlacklist(title, company, description, blacklistKeywords) {
    if (!blacklistKeywords || blacklistKeywords.trim() === '') return false;
    const keywords = blacklistKeywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);
    if (keywords.length === 0) return false;
    const jobText = (title + ' ' + company + ' ' + description).toLowerCase();
    for (const keyword of keywords) {
      if (jobText.includes(keyword)) {
        log(`Skip (Blacklist): "${keyword}" found in job`);
        log(`   Title: ${title.substring(0, 50)}`);
        return true;
      }
    }
    return false;
  }

  function extractYearsRequired(text) {
    if (!text) return 0;
    const patterns = [
      /(\d+)\+?\s*(?:years?|yrs?)/gi,
      /(\d+)\+?\s*(?:ans?|années?)/gi,
      /(\d+)\+?\s*años?/gi,
      /(\d+)\+?\s*jahre?/gi,
      /(\d+)\+?\s*anni?/gi
    ];
    const years = [];
    patterns.forEach(pattern => {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const num = parseInt(match[1]);
        if (num > 0 && num <= 20) years.push(num);
      }
    });
    return years.length > 0 ? Math.max(...years) : 0;
  }

  // ─── Daily limit detection ────────────────────────────────────────────
  // Only scan VISIBLE modals/toasts/alerts — never raw body.innerText.
  // Body text contains job descriptions, suggestions, ads, footer copy
  // etc. which can legitimately contain words like "limit", "tomorrow",
  // "apply" and false-trigger this check, causing the bot to call
  // stopBot() mid-iteration and break the for loop with "Bot stopped"
  // even though no real limit was hit (reported bug, Apr 2026).
  function _scanDialogsForPatterns(patterns, returnElement) {
    // Combine parent doc dialogs with shadow root dialogs (the new
    // /jobs/search-results/ design renders limit modals in the shadow).
    // LinkedIn's daily/rate-limit popup uses native <dialog> element
    // (HTML5 tag, no explicit role="dialog"). querySelector on the role
    // selector alone misses it — verified live 2026-08-13 that Théo hit
    // the daily cap but bot kept applying because our scan returned false.
    // Include the tag selector `dialog` to catch native HTML5 dialogs too.
    // 2026-09-04: added `returnElement` opt-in so callers can hide the
    // scary LinkedIn popup after detection (rate-limit UX pass).
    const collect = (root) => [
      ...root.querySelectorAll('dialog, [role="dialog"], [role="alert"], [role="alertdialog"], .artdeco-modal__content, .artdeco-toast-item, .artdeco-inline-feedback'),
    ];
    const scopes = [...collect(document)];
    try {
      const sr = document.getElementById('interop-outlet')?.shadowRoot;
      if (sr) scopes.push(...collect(sr));
    } catch (e) {}
    for (const el of scopes) {
      // Visibility check via bounding rect — offsetParent is null for
      // position:fixed elements (per HTML5 spec), and LinkedIn's
      // daily-limit / rate-limit modals are ALWAYS fixed-positioned.
      // The old offsetParent-only check silently skipped them → users
      // hit the daily cap, bot didn't detect, kept trying → burned the
      // remaining cards each with a 20s timeout.
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
      if (rect.width === 0 && rect.height === 0 && el !== document.body) continue;
      const text = (el.textContent || '').toLowerCase();
      for (const p of patterns) {
        if (text.includes(p)) return returnElement ? { pattern: p, element: el } : p;
      }
    }
    return null;
  }

  // ─── Replace LinkedIn rate-limit popup CONTENT with our friendly message ─
  // LinkedIn's raw message ("automation tools may put your account at risk
  // of restriction") scares users who signed up for a tool that automates
  // job applications. Théo 2026-09-08: instead of hiding LinkedIn's popup
  // and rendering our banner beside it, REPLACE the popup's inner HTML in
  // place — user sees a single friendly message in LinkedIn's own container,
  // preserving position and dismiss ergonomics. Falls back to hide+banner
  // if the container structure is unexpected.
  function _replaceRateLimitContent(el) {
    if (!el) return { replaced: false };
    try {
      // Preserve original outerHTML so we can restore on resume.
      const original = el.outerHTML;
      el.setAttribute('data-eam-rate-limit-original', 'yes');
      // Store original in a data attribute (base64 to survive round-trips).
      try { el.dataset.eamOriginalHtml = btoa(unescape(encodeURIComponent(original)).slice(0, 32000)); } catch (_) {}
      // Replace inner content with our friendly text — keep the LinkedIn
      // container so styling/positioning match native artdeco toast/modal.
      // Use minimal inline styles that inherit LinkedIn's typography.
      el.innerHTML =
        '<div data-eam-rate-limit-replacement="1" style="padding:14px 18px;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Inter,sans-serif;line-height:1.45;color:#0f172a;background:linear-gradient(135deg,#eff6ff,#dbeafe);border-radius:8px;">' +
          '<div style="display:flex;gap:10px;align-items:flex-start">' +
            '<span style="font-size:18px;line-height:1">⏳</span>' +
            '<div style="flex:1">' +
              '<div style="font-weight:600;color:#0f172a;margin-bottom:4px;font-size:14px">Short pause to protect your account</div>' +
              '<div style="color:#334155;font-size:13px">Waiting a few minutes to avoid LinkedIn rate limit — this is a normal safety pause. Auto-apply will resume automatically. Keep this tab in the foreground for best results.</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      // Never let the replaced element be display:none — some LinkedIn CSS
      // hides `.artdeco-toast-item` after N seconds; keep ours visible for
      // the full pause window (up to 3 min per strike).
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
      return { replaced: true, mode: 'in-place' };
    } catch (e) {
      // Fall back to hide + banner if in-place replacement fails
      try {
        el.style.setProperty('display', 'none', 'important');
        el.setAttribute('data-eam-hidden', 'rate-limit');
      } catch (_) {}
      return { replaced: false, mode: 'fallback-hide', error: e.message };
    }
  }

  // Legacy alias kept for callers that were pinned to the older name.
  function _hideRateLimitPopup(el) { return _replaceRateLimitContent(el); }

  // Called when rate-limit resolves — restore original LinkedIn content so
  // the user can interact with the actual popup again if it re-fires later,
  // and any hidden fallbacks come back too.
  function _restoreHiddenRateLimit() {
    try {
      // First: elements we replaced in-place — restore original outerHTML.
      const replaced = document.querySelectorAll('[data-eam-rate-limit-original="yes"]');
      replaced.forEach((n) => {
        try {
          const raw = n.dataset.eamOriginalHtml;
          if (raw) {
            const orig = decodeURIComponent(escape(atob(raw)));
            n.outerHTML = orig; // note: replaces the node itself with restored markup
            return;
          }
        } catch (_) {}
        // Fallback: at least remove our injected block so it doesn't linger.
        n.removeAttribute('data-eam-rate-limit-original');
        delete n.dataset.eamOriginalHtml;
        const injected = n.querySelector('[data-eam-rate-limit-replacement="1"]');
        if (injected) injected.remove();
      });
      // Second: legacy hidden elements (from the fallback path).
      const hidden = document.querySelectorAll('[data-eam-hidden="rate-limit"]');
      hidden.forEach((n) => {
        n.style.removeProperty('display');
        n.removeAttribute('data-eam-hidden');
      });
    } catch (_) {}
  }

  function _showFriendlyRateLimitBanner(rect) {
    // Idempotent — one banner at a time.
    if (document.getElementById('eam-rate-limit-banner')) return;
    try {
      // Adaptive placement: pin to the same viewport corner where LinkedIn's
      // hidden toast/dialog was, so the user's eye lands where the warning
      // used to be. Default = bottom-left (LinkedIn's default artdeco-toast
      // position). rect is captured in checkRateLimit BEFORE the hide.
      let pos = 'bottom:20px;left:20px;'; // default
      try {
        if (rect && (rect.width > 0 || rect.height > 0)) {
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 720;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const vertical = cy < vh / 2 ? `top:${Math.max(10, Math.round(rect.top))}px;` : `bottom:${Math.max(10, Math.round(vh - rect.bottom))}px;`;
          const horizontal = cx < vw / 2 ? `left:${Math.max(10, Math.round(rect.left))}px;` : `right:${Math.max(10, Math.round(vw - rect.right))}px;`;
          pos = vertical + horizontal;
        }
      } catch (_) {}
      const banner = document.createElement('div');
      banner.id = 'eam-rate-limit-banner';
      banner.style.cssText = 'position:fixed;' + pos + 'z-index:2147483647;background:linear-gradient(135deg,#eff6ff,#dbeafe);border:1px solid #93c5fd;border-radius:10px;padding:14px 18px;max-width:360px;box-shadow:0 8px 24px rgba(30,64,175,0.18);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;color:#1e3a8a;font-size:13px;line-height:1.45';
      banner.innerHTML =
        '<div style="display:flex;gap:10px;align-items:flex-start">' +
        '<span style="font-size:18px;line-height:1">⏳</span>' +
        '<div style="flex:1">' +
        '<div style="font-weight:600;color:#0f172a;margin-bottom:4px">Short pause to protect your account</div>' +
        '<div style="color:#475569">Waiting a few minutes to avoid LinkedIn rate limit — this is a normal safety pause. Auto-apply will resume automatically. Keep this tab in the foreground for best results.</div>' +
        '</div>' +
        '<button type="button" aria-label="Dismiss" style="background:transparent;border:0;color:#64748b;font-size:18px;cursor:pointer;padding:0 2px;line-height:1;margin-left:4px">×</button>' +
        '</div>';
      banner.querySelector('button').addEventListener('click', () => banner.remove());
      document.body.appendChild(banner);
      // Auto-remove after 90s so the banner doesn't linger after the pause.
      setTimeout(() => banner.remove(), 90000);
    } catch (_) {}
  }

  // ─── Easy Apply filter nudge ───────────────────────────────────────────
  // Show ONCE per tab. User dismissed → don't nag. Ege 2026-09-07 lesson:
  // when the bot is launched on unfiltered search results, most jobs are
  // external Apply → all skipped → user thinks "the paid feature is broken".
  function _showEasyApplyFilterHint() {
    if (document.getElementById('eam-easy-apply-hint')) return;
    if (sessionStorage.getItem('eam-easy-apply-hint-dismissed') === '1') return;
    try {
      const banner = document.createElement('div');
      banner.id = 'eam-easy-apply-hint';
      banner.style.cssText = 'position:fixed;top:80px;right:20px;z-index:2147483646;background:linear-gradient(135deg,#fefce8,#fef3c7);border:1px solid #fbbf24;border-radius:10px;padding:14px 18px;max-width:340px;box-shadow:0 8px 24px rgba(180,120,10,0.18);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;color:#78350f;font-size:13px;line-height:1.45';
      banner.innerHTML =
        '<div style="display:flex;gap:10px;align-items:flex-start">' +
        '<span style="font-size:18px;line-height:1">💡</span>' +
        '<div style="flex:1">' +
        '<div style="font-weight:600;color:#7c2d12;margin-bottom:4px">Enable the "Easy Apply" filter</div>' +
        '<div style="color:#78350f">Most external-Apply jobs are being skipped. Click the <b>Easy Apply</b> chip in LinkedIn\'s filter row to only show jobs the bot can auto-apply to.</div>' +
        '</div>' +
        '<button type="button" aria-label="Dismiss" style="background:transparent;border:0;color:#92400e;font-size:18px;cursor:pointer;padding:0 2px;line-height:1;margin-left:4px">×</button>' +
        '</div>';
      banner.querySelector('button').addEventListener('click', () => {
        try { sessionStorage.setItem('eam-easy-apply-hint-dismissed', '1'); } catch (_) {}
        banner.remove();
      });
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 25000);
    } catch (_) {}
  }

  function checkDailyLimit() {
    try {
      const limitPatterns = [
        "you've reached today's easy apply limit",
        "you have reached today's easy apply limit",
        "reached today's easy apply limit",
        "exceeded the daily application limit",
        "save this job and continue applying tomorrow",
        "great effort applying today",
        "limit daily submissions",
      ];
      const matched = _scanDialogsForPatterns(limitPatterns);
      if (matched) {
        log('DAILY LIMIT REACHED!');
        log(`   Pattern: "${matched}"`);
        log(`   Applied: ${appliedCount} | Skipped: ${skippedCount}`);
        return true;
      }
      return false;
    } catch (error) {
      log(`Error checking daily limit: ${error.message}`);
      return false;
    }
  }

  // ─── Rate limit detection (LinkedIn "fast pace" warning) ─────────────
  // Scans dialogs + toasts + modal wrappers. Includes .artdeco-toast-item
  // (LinkedIn's real rate-limit UI in 2026 is a TOAST, not a modal —
  // verified 2026-09-06 with Théo live: v2.5.61 strict-scan missed it).
  // Skip .artdeco-inline-feedback (form errors, too broad).
  //
  // Size guard: never touch elements wider than 90% viewport AND taller
  // than 70% — that's the scaffold, never a popup.
  function _scanRateLimitModalsOnly(patterns) {
    const sel = [
      'dialog',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[role="alert"]',
      '.artdeco-modal__content',
      '.artdeco-modal',
      '.artdeco-modal-overlay',
      '.artdeco-toast-item',
      '.artdeco-inline-feedback',
      '.jobs-easy-apply-modal',
      // Fallback: any small fixed-positioned popup at the viewport top/right
      '[class*="toast"]',
      '[class*="notice"]',
      '[class*="banner"]',
      '[class*="alert"]',
    ].join(', ');
    const scopes = Array.from(document.querySelectorAll(sel));
    try {
      const sr = document.getElementById('interop-outlet')?.shadowRoot;
      if (sr) scopes.push(...sr.querySelectorAll(sel));
    } catch (e) {}
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    for (const el of scopes) {
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
      if (rect.width === 0 && rect.height === 0) continue;
      // Size guard — never touch scaffold-sized elements.
      if (rect.width > vpW * 0.9 && rect.height > vpH * 0.7) continue;
      const text = (el.textContent || '').toLowerCase();
      for (const p of patterns) {
        if (text.includes(p)) return { pattern: p, element: el };
      }
    }
    // Selector-based scan missed — fall back to a text-based walk of
    // small visible elements. LinkedIn ships this warning inside variable
    // wrapper classes (verified 2026-09-07 Théo live test: strict scan
    // returned false while the toast was visible). Walk every direct
    // child of body + shadow-root children up to 640px wide (typical
    // toast/banner size), look for any pattern text, and return the
    // narrowest match (deepest element that still contains all the text).
    try {
      const all = Array.from(document.querySelectorAll('body *'));
      let best = null;
      for (const el of all) {
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        if (rect.width === 0 || rect.width > 640) continue;
        if (rect.height === 0 || rect.height > vpH * 0.6) continue;
        const text = (el.textContent || '').toLowerCase();
        for (const p of patterns) {
          if (text.includes(p)) {
            // Prefer a smaller (deeper) match to avoid hiding the whole body.
            if (!best || rect.width * rect.height < best.rect.width * best.rect.height) {
              best = { pattern: p, element: el, rect };
            }
          }
        }
      }
      if (best) return { pattern: best.pattern, element: best.element };
    } catch (_) {}
    return null;
  }

  // Background poller — LinkedIn's rate-limit toast can appear between
  // the engine's discrete checkRateLimit() calls (only at 2 points in the
  // main loop), and stay visible while the engine sleeps on isLoading()
  // or form-fill. Poll every 2.5s while the bot is running so we detect
  // + hide + pause fast. Runs as a top-level interval owned by utils.
  // Idempotent — reuses one interval per page.
  let _rateLimitPollHandle = null;
  function _startRateLimitPoller() {
    if (_rateLimitPollHandle) return;
    _rateLimitPollHandle = setInterval(() => {
      try {
        // Poll only while the bot is actively running. Otherwise no need
        // to hide LinkedIn's own UI on a page where the user is idle.
        if (!isRunning) return;
        if (checkRateLimit()) {
          // checkRateLimit already hid the popup + showed our banner.
          // Set a pending flag the engine can respect at its next await.
          _pendingRateLimitPause = true;
        }
      } catch (_) {}
    }, 2500);
  }
  function _stopRateLimitPoller() {
    if (_rateLimitPollHandle) { clearInterval(_rateLimitPollHandle); _rateLimitPollHandle = null; }
  }
  let _pendingRateLimitPause = false;

  function checkRateLimit() {
    try {
      // Very specific phrases from LinkedIn's actual rate-limit warning
      // (verified 2026-09-06 with Théo's live test). Kept ONLY strings
      // that would never appear in innocent LinkedIn UI.
      const rateLimitPatterns = [
        "applying at a fast pace",
        "briefly paused easy apply as a safeguard",
        "briefly paused easy apply",
        "safeguard against automated inauthentic",
        "safeguard against automated",
        "third-party automation tools may put your account",
        "automation tools may put your account at risk",
        // French variants
        "candidatures à un rythme rapide",
        "nous avons temporairement mis en pause easy apply",
        "outils d'automatisation tiers",
        "outils d'automatisation",
      ];
      const hit = _scanRateLimitModalsOnly(rateLimitPatterns);
      if (hit) {
        log(`Rate-limit safeguard triggered — replacing LinkedIn popup content. Pattern: "${hit.pattern}"`);
        // Capture the toast/dialog's bounding rect BEFORE mutating (in case
        // fallback path fires and we need to pin our floating banner at the
        // same viewport corner).
        let rect = null;
        try { rect = hit.element.getBoundingClientRect(); } catch (_) {}
        const result = _replaceRateLimitContent(hit.element);
        // Only show the FLOATING banner if the in-place replacement failed —
        // otherwise the user sees our friendly message INSIDE the LinkedIn
        // container (in-place, Théo 2026-09-08 ask), no duplicate UI.
        if (!result || !result.replaced) {
          _showFriendlyRateLimitBanner(rect);
        }
        return true;
      }
      return false;
    } catch (error) {
      log(`Error checking rate limit: ${error.message}`);
      return false;
    }
  }

  // ─── Loading detection ────────────────────────────────────────────────
  async function isPageLoadingSlow() {
    // Only signal "loading" when an actual visible loader/spinner is up.
    // Previous version also returned true whenever `.jobs-easy-apply-modal`
    // was missing — a false positive during normal browsing that stalled
    // the engine's inner step-loop for 20s per card (2026-08 selector rot).
    try {
      if (document.readyState !== 'complete') return true;
      // Only match LinkedIn-specific loaders. Generic .spinner/.loading match
      // decorative page elements (avatars, image lazy-loaders) and cause
      // false-positive "loading" for the whole session.
      const spinners = document.querySelectorAll(
        '.artdeco-loader:not([aria-hidden="true"]), ' +
        '[class^="artdeco-loader"]:not([aria-hidden="true"]), ' +
        '.jobs-easy-apply-modal [role="progressbar"], ' +
        '[data-test-jobs-easy-apply-modal] [role="progressbar"]'
      );
      for (const spinner of spinners) {
        if (spinner.offsetParent !== null) return true;
      }
      return false;
    } catch (error) {
      return false; // fail-open — don't block engine on utility error
    }
  }

  function checkForStuckLoadingPopup() {
    try {
      const loadingIndicators = document.querySelectorAll('.artdeco-loader, .loading, .spinner, [role="progressbar"]');
      for (const indicator of loadingIndicators) {
        if (indicator.offsetParent !== null) return true;
      }
      // Broadened modal detection: legacy .jobs-easy-apply-modal PLUS any
      // visible role=dialog that contains an EA form (survives class rename).
      const candidates = [
        ...document.querySelectorAll('.jobs-easy-apply-modal, [data-test-modal-id*="easy-apply" i], [data-test-jobs-easy-apply-modal]'),
        ...[...document.querySelectorAll('[role="dialog"]')].filter(d => d.querySelector('form input[type="file"], form button[aria-label*="Submit" i], form button[data-live-test-easy-apply-submit-button]')),
      ];
      for (const modal of candidates) {
        // Skip via bounding rect (handles position:fixed correctly, which
        // offsetParent gets wrong per HTML5 spec).
        const mRect = modal.getBoundingClientRect ? modal.getBoundingClientRect() : { width: 0, height: 0 };
        if (mRect.width === 0 && mRect.height === 0) continue;
        const buttons = modal.querySelectorAll('button');
        const clickableButtons = Array.from(buttons).filter(b => {
          if (b.disabled) return false;
          const bRect = b.getBoundingClientRect ? b.getBoundingClientRect() : { width: 0, height: 0 };
          return bRect.width > 0 || bRect.height > 0;
        });
        if (clickableButtons.length === 0) return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // ─── Export as namespace ──────────────────────────────────────────────
  window.EAM.utils = {
    // Logging & waiting
    log,
    wait,

    // Protected DOM interactions
    click,
    clickWithRetry,
    fill,

    // Activity tracking
    updateActivity,
    isStuck,

    // File utilities
    base64ToFile,
    fillFileInput,

    // Storage helpers
    updateAppliedCount,
    updateSkippedCount,
    saveAppliedJobsToStorage,

    // Skip logic
    shouldSkipByBlacklist,
    extractYearsRequired,

    // Daily limit, rate limit & loading
    checkDailyLimit,
    checkRateLimit,
    _restoreHiddenRateLimit,
    _showEasyApplyFilterHint,
    _startRateLimitPoller,
    _stopRateLimitPoller,
    isPageLoadingSlow,
    checkForStuckLoadingPopup,

    // Rate-limit pending flag (background poller sets true; engine reads +
    // clears it after handling the pause). Prevents the bot from continuing
    // to click Easy Apply between the main loop's discrete rate-limit checks.
    get pendingRateLimitPause() { return _pendingRateLimitPause; },
    set pendingRateLimitPause(v) { _pendingRateLimitPause = v; },

    // State getters/setters
    get isRunning() {
      return isRunning;
    },
    set isRunning(v) {
      isRunning = v;
      // Flip the background rate-limit poller on/off with the bot state.
      try {
        if (v) _startRateLimitPoller();
        else _stopRateLimitPoller();
      } catch (_) {}
    },
    get userExplicitlyClickedStart() { return userExplicitlyClickedStart; },
    set userExplicitlyClickedStart(v) { userExplicitlyClickedStart = v; },
    get appliedCount() { return appliedCount; },
    set appliedCount(v) { appliedCount = v; },
    get skippedCount() { return skippedCount; },
    set skippedCount(v) { skippedCount = v; },
    get appliedJobs() { return appliedJobs; },
    set appliedJobs(v) { appliedJobs = v; },
    get config() { return config; },
    set config(v) { config = v; },
    get resumeFile() { return resumeFile; },
    set resumeFile(v) { resumeFile = v; },
    get resumeFileName() { return resumeFileName; },
    set resumeFileName(v) { resumeFileName = v; },
    get resumeFileType() { return resumeFileType; },
    set resumeFileType(v) { resumeFileType = v; },
    get lastJobIndex() { return lastJobIndex; },
    set lastJobIndex(v) { lastJobIndex = v; },

    STUCK_TIMEOUT
  };
})();
