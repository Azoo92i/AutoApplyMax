/**
 * AutoApplyMax — AI Draft button for manual-apply forms (2026-07-28)
 * ────────────────────────────────────────────────────────────────────
 * Simplify-style feature. Injects "✨ AI Draft" button next to every
 * meaningful <textarea> on job sites that AREN'T LinkedIn (LinkedIn
 * auto-apply handles it via the engine + adapters).
 *
 * Used when user applies MANUALLY on Indeed, Glassdoor, Greenhouse,
 * Workday, Lever, Ashby, WTTJ, Monster, or any company career site.
 * Click → the same AI form-answer path used by auto-apply (askAI in
 * ai-form.js), pre-fills the textarea, user reviews + edits + submits.
 *
 * Namespace: window.EAM.aiDraftManual
 * Depends on: window.EAM.aiForm.askAI (loaded before this script)
 */
(function () {
  'use strict';

  // Only run in top window (some job forms are in iframes we shouldn't touch)
  if (window !== window.top) return;

  // Skip LinkedIn — the auto-apply engine owns that domain
  const host = location.hostname;
  if (/(^|\.)linkedin\.com$/.test(host)) return;

  // Skip our own domain (autoapplymax.com) — nothing to draft there
  if (/autoapplymax\.com$/.test(host)) return;

  const log = (...a) => (window.EAM?.utils?.log || console.log)('[ai-draft]', ...a);

  const BUTTON_CLASS = 'aam-ai-draft-btn';
  const PROCESSED_ATTR = 'data-aam-draft-attached';
  const MIN_QUESTION_LENGTH = 8;
  const MIN_TEXTAREA_WIDTH = 200;
  const MIN_TEXTAREA_HEIGHT = 40;

  // Premium gate — AI Draft is a Premium feature (adds cost via Groq/Gemini
  // calls). Check chrome.storage.local.isPremium; if false, skip everything.
  // React to plan changes: if user upgrades mid-session, chrome.storage
  // onChanged fires with isPremium=true → we init at that point.
  let _isPremium = null;
  let _initialised = false;
  function checkPremiumThenInit() {
    chrome.storage.local.get(['isPremium', 'plan'], (data) => {
      const now = !!(data.isPremium || ['premium', 'pro', 'unlimited'].includes(data.plan));
      if (now !== _isPremium) {
        _isPremium = now;
        log(`premium = ${now}`);
        if (now && !_initialised) {
          _initialised = true;
          waitForAiForm(bootScan);
        }
      }
    });
  }
  checkPremiumThenInit();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.isPremium || changes.plan) checkPremiumThenInit();
  });

  // Wait for EAM.aiForm to be available. content_scripts run in declared
  // order but some sites load slowly, so retry a few times.
  let readyRetries = 20;
  function waitForAiForm(cb) {
    if (window.EAM?.aiForm?.askAI) return cb();
    if (--readyRetries <= 0) return log('EAM.aiForm never loaded — abort');
    setTimeout(() => waitForAiForm(cb), 250);
  }

  function findQuestionForTextarea(ta) {
    // Multi-strategy label discovery — different frameworks label textareas
    // differently. We try the most specific first.

    // 1. <label for="id">
    if (ta.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(ta.id)}"]`);
      if (lbl) return cleanText(lbl.textContent);
    }
    // 2. aria-label
    const aria = ta.getAttribute('aria-label');
    if (aria) return cleanText(aria);
    // 3. aria-labelledby (space-separated IDs concatenated)
    const labelledby = ta.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map(id => document.getElementById(id))
        .filter(Boolean).map(el => el.textContent).join(' ');
      if (parts) return cleanText(parts);
    }
    // 4. Walk up 5 levels looking for <legend>, <label>, or a heading/paragraph
    //    that clearly labels the field. Stop as soon as we find one.
    let el = ta.parentElement;
    for (let i = 0; i < 5 && el; i++) {
      const lgd = el.querySelector('legend');
      if (lgd) return cleanText(lgd.textContent);
      // Sibling label INSIDE this container but not a wrapper around the textarea
      const siblingLabel = [...el.querySelectorAll('label')]
        .find(l => !l.contains(ta));
      if (siblingLabel) return cleanText(siblingLabel.textContent);
      // Heading immediately before this container in the parent tree
      const heading = el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .field-label, :scope > .form-label');
      if (heading) return cleanText(heading.textContent);
      el = el.parentElement;
    }
    // 5. Previous sibling text (up to 3 back)
    let sib = ta.previousElementSibling;
    for (let i = 0; i < 3 && sib; i++) {
      const txt = cleanText(sib.textContent || '');
      if (txt && txt.length < 400 && txt.length >= MIN_QUESTION_LENGTH) return txt;
      sib = sib.previousElementSibling;
    }
    // 6. Placeholder as last resort
    return cleanText(ta.placeholder || '');
  }

  function cleanText(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(/[*:]\s*$/, '').trim();
  }

  function shouldOfferDraft(ta) {
    if (ta.hasAttribute(PROCESSED_ATTR)) return false;
    if (ta.disabled || ta.readOnly) return false;
    if (ta.name === 'aam-noscan') return false;
    const rect = ta.getBoundingClientRect();
    if (rect.width < MIN_TEXTAREA_WIDTH) return false;
    if (rect.height < MIN_TEXTAREA_HEIGHT) return false;
    // Skip textareas already filled with substantial content (probably user typing)
    if ((ta.value || '').trim().length > 30) return false;
    return true;
  }

  async function loadUserConfig() {
    return new Promise(resolve => {
      chrome.storage.local.get(null, data => resolve(data || {}));
    });
  }

  async function handleClick(ta, btn, question) {
    if (btn.disabled) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '⏳ Writing…';
    try {
      const config = await loadUserConfig();
      const answer = await window.EAM.aiForm.askAI(question, config, 'textarea');
      if (answer) {
        ta.focus();
        ta.value = answer;
        // Notify frameworks (React, Vue, Angular) so state updates
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        btn.textContent = '✅ Filled';
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
      } else {
        btn.textContent = '⚠ Try again';
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2000);
      }
    } catch (e) {
      log('draft click error', e);
      btn.textContent = '⚠ Error';
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2000);
    }
  }

  function injectButton(ta) {
    if (!shouldOfferDraft(ta)) return;
    ta.setAttribute(PROCESSED_ATTR, '1');

    const question = findQuestionForTextarea(ta);
    if (!question || question.length < MIN_QUESTION_LENGTH) {
      log('no meaningful question for textarea, skip');
      return;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.textContent = '✨ AI Draft';
    btn.title = `Fill this field with AI (question: "${question.slice(0, 80)}")`;
    btn.style.cssText = [
      'position:absolute',
      'top:2px',
      'right:2px',
      'z-index:9998',
      'background:#0a66c2',
      'color:#fff',
      'border:0',
      'border-radius:4px',
      'padding:3px 8px',
      'font-size:11px',
      'font-weight:600',
      'line-height:1.3',
      'cursor:pointer',
      'font-family:system-ui,-apple-system,sans-serif',
      'box-shadow:0 1px 3px rgba(0,0,0,.2)',
      'opacity:0.9',
    ].join(';');
    btn.addEventListener('mouseover', () => btn.style.opacity = '1');
    btn.addEventListener('mouseout', () => btn.style.opacity = '0.9');

    // Anchor the button relative to the textarea's immediate parent
    const parent = ta.parentElement;
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    parent.appendChild(btn);

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      handleClick(ta, btn, question);
    });
  }

  function scan() {
    document.querySelectorAll('textarea').forEach(injectButton);
  }

  // Bootstrap function — called only after premium check passes
  // (see checkPremiumThenInit above). Non-premium users see NO AI Draft
  // buttons (Premium-gated feature, encourages upgrade).
  function bootScan() {
    log(`AI Draft button active on ${host} (premium)`);
    scan();
    // Rescan when DOM changes (SPA nav, dynamically added form fields)
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'TEXTAREA') { injectButton(node); continue; }
          if (node.querySelectorAll) node.querySelectorAll('textarea').forEach(injectButton);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Fallback: rescan every 3s for sites that don't fire mutations reliably
    setInterval(scan, 3000);
  }

  window.EAM = window.EAM || {};
  window.EAM.aiDraftManual = { scan };
})();
