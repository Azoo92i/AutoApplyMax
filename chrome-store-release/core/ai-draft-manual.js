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
  // v2.5.119 (coverage audit 2026-10-17): the plan was cached only when the popup opened — a Premium user who never
  // opened it got no button. No cached plan (but signed in) → ask the service worker once (user_profiles.plan).
  let _askedPlan = false;
  function checkPremiumThenInit() {
    chrome.storage.local.get(['isPremium', 'plan', 'eam_session'], (data) => {
      if (!data.plan && !data.isPremium && data.eam_session && data.eam_session.access_token && !_askedPlan) {
        _askedPlan = true;
        try { chrome.runtime.sendMessage({ type: 'refreshPlan' }, () => { void chrome.runtime.lastError; }); } catch (_) {}
      }
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

  // v2.5.119 (coverage audit 2026-10-17): on Lever and Greenhouse the old walk-up took the first <legend> / <label>
  // of a HIGH ancestor — another question's label (often the EEO "Gender" legend) — so the AI got the wrong question,
  // replied '"' or "N/A", and the button said "Filled". Now: the textarea's own label (for= / aria), else the label of
  // the smallest block that holds ONLY this field (Lever .application-label, Greenhouse / Ashby question containers).
  function _rootOf(el) { const r = el.getRootNode && el.getRootNode(); return r && r.querySelector ? r : document; }
  function _visibleText(node) {
    try {
      const c = node.cloneNode(true);
      c.querySelectorAll('svg, script, style, [aria-hidden="true"], button, .' + BUTTON_CLASS + ', textarea, input, select').forEach(x => x.remove());
      return cleanText(c.textContent);
    } catch (_) { return cleanText(node.textContent); }
  }
  function findQuestionForTextarea(ta) {
    const LABELISH = '.application-label, label, legend, [class*="question" i], [class*="label" i], [class*="title" i], h3, h4, h5, p';
    const GENERIC_PLACEHOLDER = /^(type your response|start typing|your answer|enter (your )?(answer|text)|write here|r[ée]ponse|tapez votre r[ée]ponse)\.*$/i;
    const ok = (t) => t && t.length >= 3 && t.length <= 500 && /[A-Za-zÀ-ÿ]{3,}/.test(t) && !GENERIC_PLACEHOLDER.test(t);
    const root = _rootOf(ta);
    if (ta.id) {
      const lbl = root.querySelector(`label[for="${CSS.escape(ta.id)}"]`) || document.querySelector(`label[for="${CSS.escape(ta.id)}"]`);
      const t = lbl && _visibleText(lbl); if (ok(t)) return t;
    }
    const labelledby = ta.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = cleanText(labelledby.split(/\s+/).map(id => root.getElementById ? root.getElementById(id) : document.getElementById(id)).filter(Boolean).map(_visibleText).join(' '));
      if (ok(t)) return t;
    }
    const aria = cleanText(ta.getAttribute('aria-label'));
    if (ok(aria) && !/^(cards?\[|question_)/i.test(aria)) return aria;
    const wrap = ta.closest('label'); if (wrap) { const t = _visibleText(wrap); if (ok(t)) return t; }
    let node = ta.parentElement;
    for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
      // Stop once the block holds another field: its label would be that field's question.
      const others = [...node.querySelectorAll('input:not([type=hidden]), textarea, select')].filter(c => c !== ta && c.type !== 'file' && !c.closest('.' + BUTTON_CLASS));
      if (others.length) break;
      const cand = [...node.querySelectorAll(LABELISH)].find(c => !c.contains(ta) && ok(_visibleText(c)));
      if (cand) return _visibleText(cand).slice(0, 400);
    }
    // Previous siblings (up to 3), then the placeholder when it is a real question.
    let sib = ta.previousElementSibling;
    for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) { const t = _visibleText(sib); if (ok(t) && t.length >= MIN_QUESTION_LENGTH) return t; }
    const ph = cleanText(ta.placeholder || '');
    return ok(ph) ? ph : '';
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

  // v2.5.119: the extension settings live in chrome.storage.sync (the AI got no name / years / salary before) and the
  // CV in chrome.storage.local — same shape as the popup Autofill config.
  async function loadUserConfig() {
    const sync = await new Promise(r => { try { chrome.storage.sync.get(['firstName', 'lastName', 'email', 'phone', 'city', 'yearsOfExperience', 'expectedSalary', 'noticePeriod', 'gender', 'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense', 'currentSalary', 'dateOfBirth', 'postalCode'], d => r(d || {})); } catch (_) { r({}); } });
    const local = await new Promise(r => { try { chrome.storage.local.get(['cvProfile', 'accountProfile'], d => r(d || {})); } catch (_) { r({}); } });
    const config = Object.assign({}, sync);
    const ap = local.accountProfile || {};
    if (!String(config.expectedSalary || '').trim() && /^\d[\d\s,.]*$/.test(String(ap.expectedSalary || ''))) config.expectedSalary = String(Math.round(parseFloat(String(ap.expectedSalary).replace(/[\s,]/g, ''))));
    if (!String(config.city || '').trim() && ap.city) config.city = ap.city;
    const cv = local.cvProfile;
    if (cv && typeof cv === 'object') {
      config.cvProfile = { summary: cv.summary, skills: cv.skills, experience: cv.experience, education: cv.education, languages: cv.languages, linkedin: cv.linkedin, website: cv.website };
      if (cv.linkedin) config.linkedinUrl = cv.linkedin;
      if (cv.website) config.portfolioUrl = cv.website;
      const ex = Array.isArray(cv.experience) ? cv.experience : [];
      if (ex[0] && ex[0].title) config.currentTitle = ex[0].title;
      if (ex[0] && ex[0].company) config.currentCompany = ex[0].company;
      if (cv.summary) config.summary = cv.summary;
    }
    return config;
  }

  // v2.5.119: answers in the page's language (Dutch form got English) + the job on the page for cover letters.
  const LANG_NAMES = { en: 'English', fr: 'French', nl: 'Dutch', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };
  const LANG_STOP = {
    en: /\b(the|and|your|you|with|what|are|please|have|this|for|why|how|our)\b/g,
    fr: /\b(le|la|les|et|vous|votre|vos|des|une|pour|avec|quel|quelle|pourquoi|êtes|avez|nous|est)\b/g,
    nl: /\b(de|het|een|en|je|jouw|uw|van|met|voor|wat|waarom|bent|heb|ons|onze|niet|bij)\b/g,
    de: /\b(der|die|das|und|sie|ihr|ihre|mit|für|was|warum|sind|haben|wir|unser|nicht|bitte)\b/g,
    es: /\b(el|los|las|y|usted|tu|su|con|para|qué|por|eres|tiene|nuestro|nuestra)\b/g,
    it: /\b(il|lo|gli|e|tu|tuo|tua|con|per|che|perché|sei|hai|nostro|nostra)\b/g,
    pt: /\b(os|as|e|você|seu|sua|com|para|que|porque|é|tem|nosso|nossa|não)\b/g,
  };
  function formLanguage() {
    try {
      const txt = [...document.querySelectorAll('label, legend, h1, h2, h3, button, p')].slice(0, 300).map(e => e.textContent || '').join(' ').toLowerCase().slice(0, 8000);
      const ranked = Object.entries(LANG_STOP).map(([k, re]) => [k, (txt.match(re) || []).length]).sort((a, b) => b[1] - a[1]);
      const html = String(document.documentElement.getAttribute('lang') || '').toLowerCase().slice(0, 2);
      if (ranked[0][1] >= 8 && ranked[0][1] >= (ranked[1][1] || 0) * 1.4) return LANG_NAMES[ranked[0][0]];
      return LANG_NAMES[html] || (ranked[0][1] >= 4 ? LANG_NAMES[ranked[0][0]] : '');
    } catch (_) { return ''; }
  }
  function pageJob() {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const meta = (n) => clean((document.querySelector(`meta[property="${n}"], meta[name="${n}"]`) || {}).content);
    const h = [...document.querySelectorAll('h1, .posting-headline h2, .app-title, [class*="job-title" i]')].find(e => e.getBoundingClientRect().width > 0 && clean(e.textContent).length >= 3 && clean(e.textContent).length <= 140);
    const title = (clean(h && h.textContent) || meta('og:title') || clean(document.title).split(/\s+[|–—-]\s+/)[0]).replace(/^(job\s+application\s+for|apply\s+(for|to))\s+/i, '').replace(/\s+at\s+[^@]{2,60}$/i, '');
    // SmartRecruiters one-click: /oneclick-ui/company/<Company>/publication/… (live 2026-10-17 read "Oneclick Ui").
    const _parts = location.pathname.split('/').filter(Boolean); const _ci = _parts.indexOf('company');
    const seg = ((_ci >= 0 && _parts[_ci + 1]) || (/^(oneclick-ui|o|j|jobs|careers)$/i.test(_parts[0] || '') ? '' : _parts[0]) || '').replace(/[-_]+/g, ' ');
    const t = clean(document.title).match(/\bat\s+([^|–—-]{2,60})/i);
    let company = (t && t[1]) || (meta('og:site_name') && !/greenhouse|lever|ashby|workable|smartrecruiters/i.test(meta('og:site_name')) ? meta('og:site_name') : seg);
    if (company && company === company.toLowerCase()) company = company.replace(/\b[a-z]/g, m => m.toUpperCase());
    let desc = '';
    for (const b of document.querySelectorAll('[class*="description" i], [id*="description" i], article, main')) {
      if (b.querySelector('input, textarea, select') || !(b.getBoundingClientRect().width > 0)) continue;
      const x = clean(b.innerText || b.textContent); if (x.length > desc.length) desc = x;
    }
    return { title: clean(title).slice(0, 140), company: clean(company), description: (desc || meta('og:description')).slice(0, 1800) };
  }
  const COVER_RE = /cover[\s_-]*letter|covering\s+letter|motivation(al)?\s+letter|lettre\s+de\s+motivation|motivatiebrief|anschreiben|carta\s+de\s+presentaci[oó]n|message\s+(to|for)\s+(the\s+)?(hiring|recruit)/i;
  // '"', '""', "N/A", "None", "-" … are not drafts.
  const NON_ANSWER_RE = /^\s*["'“”‘’`]*\s*(n\s*\/?\s*a|none|nil|null|not applicable|non applicable|sans objet|skip|-+|—)?\s*["'“”‘’`]*\s*\.?\s*$/i;

  async function handleClick(ta, btn, question) {
    if (btn.disabled) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Writing…';
    const done = (label, ms) => { btn.textContent = label; setTimeout(() => { btn.textContent = original; btn.disabled = false; }, ms); };
    try {
      const config = await loadUserConfig();
      config.formLanguage = formLanguage();
      const own = [ta.name, ta.id, ta.getAttribute('aria-label'), ta.placeholder].join(' ');
      if (COVER_RE.test(question) || COVER_RE.test(own)) { config.jobContext = pageJob(); config.coverNote = true; }
      let answer = await window.EAM.aiForm.askAI(config.coverNote ? 'Cover letter' : question, config, 'textarea');
      answer = String(answer == null ? '' : answer).trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
      if (!answer || NON_ANSWER_RE.test(answer) || answer.replace(/[^A-Za-zÀ-ÿ0-9]/g, '').length < 3) {
        log(`no usable draft for "${question.slice(0, 60)}" (got ${JSON.stringify(answer).slice(0, 40)})`);
        const blocked = window.EAM.aiForm.isPremiumBlocked && window.EAM.aiForm.isPremiumBlocked();
        done(blocked ? 'Premium only' : 'No draft — write it yourself', 2500);
        return;
      }
      ta.focus();
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value');
      if (d && d.set) d.set.call(ta, answer); else ta.value = answer;
      // Notify frameworks (React, Vue, Angular) so state updates
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      // "Filled" only when the text really is in the field.
      if ((ta.value || '').trim() === answer) done('Filled', 1500);
      else done('Try again', 2000);
    } catch (e) {
      log('draft click error', e);
      done('Error — try again', 2000);
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
    btn.textContent = 'AI Draft';
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
