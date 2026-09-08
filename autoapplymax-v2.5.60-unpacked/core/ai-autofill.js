/**
 * AutoApplyMax - AI Autofill Content Script
 * Injected into active tab to extract job info and fill creative fields with AI content.
 * Handles two messages: 'eam-extract-job-info' and 'eam-ai-fill'.
 */
(function () {
  'use strict';

  if (window.__eamAiAutofillLoaded) return;
  window.__eamAiAutofillLoaded = true;

  // ─── React-compatible value setter (same pattern as autofill.js) ────

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ─── Job info extraction ────────────────────────────────────────────

  function extractJobInfo() {
    let jobTitle = '';
    let company = '';
    let jobDescription = '';

    // 1. JSON-LD structured data
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
      try {
        const data = JSON.parse(script.textContent);
        const posting = data['@type'] === 'JobPosting' ? data
          : (Array.isArray(data['@graph']) ? data['@graph'].find(i => i['@type'] === 'JobPosting') : null);
        if (posting) {
          jobTitle = posting.title || '';
          company = typeof posting.hiringOrganization === 'object'
            ? (posting.hiringOrganization.name || '') : (posting.hiringOrganization || '');
          jobDescription = posting.description || '';
          if (jobDescription) {
            // Strip HTML tags from description
            const tmp = document.createElement('div');
            tmp.innerHTML = jobDescription;
            jobDescription = tmp.textContent || tmp.innerText || '';
          }
          break;
        }
      } catch (e) { /* ignore parse errors */ }
    }

    // 2. Known site selectors
    if (!jobDescription) {
      const selectors = [
        // LinkedIn (multiple class patterns — LinkedIn changes often)
        { desc: '.description__text, .jobs-description__content, .jobs-box__html-content', title: '.top-card-layout__title, .t-24.job-details-jobs-unified-top-card__job-title, h1.t-24, .job-details-jobs-unified-top-card__job-title h1', company: '.topcard__org-name-link, .job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name a' },
        // Indeed
        { desc: '#jobDescriptionText, .jobsearch-JobComponent-description', title: '.jobsearch-JobInfoHeader-title, h1[data-testid="jobsearch-JobInfoHeader-title"], h1.jobsearch-JobInfoHeader-title', company: '[data-testid="inlineHeader-companyName"], .jobsearch-InlineCompanyRating-companyHeader, [data-company-name]' },
        // WTTJ
        { desc: '[data-testid="job-section-description"], [class*="JobDescription"], .sc-bXCLTC', title: 'h1, [data-testid="job-header-title"]', company: '[data-testid="job-header-company-name"], [class*="CompanyName"]' },
        // Greenhouse
        { desc: '#content .content-intro + div, .content-intro ~ div, #content', title: '.app-title, h1', company: '.company-name' },
        // Lever
        { desc: '.posting-page .content, .section-wrapper, .posting-description', title: '.posting-headline h2', company: '.posting-headline .company, .posting-categories .sort-by-time' },
        // Workday
        { desc: '[data-automation-id="jobPostingDescription"]', title: '[data-automation-id="jobPostingHeader"] h2', company: '[data-automation-id="company"]' },
        // Ashby
        { desc: '.ashby-job-posting-description, [class*="job-description"]', title: 'h1', company: '[class*="company-name"]' },
        // SmartRecruiters
        { desc: '.job-sections, .sectionBody', title: 'h1', company: '.company-header-info h2' },
        // Generic
        { desc: '[class*="description"], [class*="job-detail"], [id*="description"]', title: 'h1', company: null }
      ];

      for (const sel of selectors) {
        const descEl = sel.desc ? document.querySelector(sel.desc) : null;
        if (descEl && descEl.textContent.trim().length > 100) {
          jobDescription = descEl.textContent.trim();
          if (!jobTitle && sel.title) {
            const titleEl = document.querySelector(sel.title);
            if (titleEl) jobTitle = titleEl.textContent.trim();
          }
          if (!company && sel.company) {
            const compEl = document.querySelector(sel.company);
            if (compEl) company = compEl.textContent.trim();
          }
          break;
        }
      }
    }

    // 3. Heuristic: find largest text block with job-related keywords
    if (!jobDescription) {
      const keywords = /responsibilities|qualifications|requirements|missions|profil|experience|compétences|skills|about the role|what you|nous recherchons/i;
      let bestBlock = '';
      const candidates = document.querySelectorAll('div, section, article');
      for (const el of candidates) {
        const text = el.textContent.trim();
        if (text.length > 200 && text.length < 15000 && keywords.test(text) && text.length > bestBlock.length) {
          bestBlock = text;
        }
      }
      if (bestBlock) jobDescription = bestBlock;
    }

    // 4. Fallback: page title + main content
    if (!jobTitle) {
      const h1 = document.querySelector('h1');
      jobTitle = h1 ? h1.textContent.trim() : document.title.split(/[|\-–—]/)[0].trim();
    }
    if (!jobDescription) {
      const main = document.querySelector('main') || document.body;
      jobDescription = main.textContent.trim();
    }

    // Truncate
    jobTitle = jobTitle.substring(0, 200);
    company = company.substring(0, 100);
    jobDescription = jobDescription.substring(0, 3000);

    return { jobTitle, company, jobDescription };
  }

  // ─── AI content field filling ───────────────────────────────────────

  const CREATIVE_PATTERNS = {
    coverLetter: /cover.?letter|lettre.?de.?motivation|motivation/i,
    whyThisCompany: /why.*(work|join|company|us|interested)|pourquoi.*(entreprise|nous|rejoindre|postuler|intéress)/i,
    summary: /additional|other|comments|notes|message|remarks|anything.?else|complément|remarques|informations?.?complémentaires/i
  };

  function fillAiContent(content) {
    if (!content) return { filled: 0 };

    let filled = 0;
    const usedFields = new Set();

    // Collect all textarea and large input fields
    const fields = document.querySelectorAll('textarea, input[type="text"]');
    const creativeFields = [];

    for (const field of fields) {
      if (field.offsetParent === null || field.disabled || field.readOnly) continue;
      if (field.dataset.eamAiFilled === 'true') continue;

      // Skip small inputs that are likely standard fields (name, email, etc.)
      if (field.tagName === 'INPUT') {
        const isSmallInput = !field.getAttribute('class')?.match(/large|big|textarea|multiline/i);
        const inputType = classifyAsStandardField(field);
        if (isSmallInput && inputType) continue;
      }

      creativeFields.push(field);
    }

    // Match fields to AI content by label/context
    for (const field of creativeFields) {
      const hints = getFieldHints(field);
      let matched = false;

      for (const [key, pattern] of Object.entries(CREATIVE_PATTERNS)) {
        if (usedFields.has(key)) continue;
        if (content[key] && pattern.test(hints)) {
          setNativeValue(field, content[key]);
          field.style.outline = '2px solid #8b5cf6';
          field.dataset.eamAiFilled = 'true';
          usedFields.add(key);
          filled++;
          matched = true;
          break;
        }
      }

      // Fallback: fill empty textareas with coverLetter if nothing matched
      if (!matched && field.tagName === 'TEXTAREA' && !field.value.trim() && !usedFields.has('coverLetter') && content.coverLetter) {
        setNativeValue(field, content.coverLetter);
        field.style.outline = '2px solid #8b5cf6';
        field.dataset.eamAiFilled = 'true';
        usedFields.add('coverLetter');
        filled++;
      }
    }

    showAiBadge(filled);
    return { filled };
  }

  function getFieldHints(el) {
    const hints = [];
    hints.push(el.getAttribute('name') || '');
    hints.push(el.getAttribute('id') || '');
    hints.push(el.getAttribute('aria-label') || '');
    hints.push(el.getAttribute('placeholder') || '');

    const id = el.getAttribute('id');
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) hints.push(label.textContent);
    }

    const parentLabel = el.closest('label');
    if (parentLabel) hints.push(parentLabel.textContent);

    const parent = el.closest('div, fieldset, li, td');
    if (parent) {
      const nearby = parent.querySelector('label, legend, span, h3, h4, p');
      if (nearby && nearby.textContent.length < 120) hints.push(nearby.textContent);
    }

    return hints.join(' ');
  }

  function classifyAsStandardField(el) {
    const hints = getFieldHints(el).toLowerCase();
    const standardPatterns = [
      /\b(first.?name|fname|prénom)\b/,
      /\b(last.?name|lname|nom)\b/,
      /\b(e?.?mail)\b/,
      /\b(phone|téléphone|tel|mobile)\b/,
      /\b(city|ville|location|address)\b/,
      /\b(linkedin)\b/,
      /\b(company|entreprise|employeur)\b/,
      /\b(title|titre|poste)\b/,
      /\b(salary|salaire)\b/,
      /\b(experience|years|années)\b/,
      /\b(portfolio|website|github)\b/,
      /\b(zip|postal|code)\b/,
      /\b(state|province|country|pays)\b/
    ];
    return standardPatterns.some(p => p.test(hints));
  }

  function showAiBadge(count) {
    const existing = document.getElementById('eam-ai-badge');
    if (existing) existing.remove();

    const badge = document.createElement('div');
    badge.id = 'eam-ai-badge';
    badge.textContent = count > 0
      ? `AI Autofill: ${count} field${count > 1 ? 's' : ''} filled`
      : 'AI Autofill: No creative fields found';
    badge.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${count > 0 ? 'linear-gradient(135deg, #8b5cf6, #0a66c2)' : '#6b7280'};
      color: white;
      padding: 12px 20px;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 999999;
      transition: opacity 0.3s ease;
    `;
    document.body.appendChild(badge);
    setTimeout(() => {
      badge.style.opacity = '0';
      setTimeout(() => badge.remove(), 300);
    }, 5000);
  }

  // ─── Message listener ───────────────────────────────────────────────

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.action === 'eam-extract-job-info') {
        const info = extractJobInfo();
        sendResponse(info);
      } else if (msg && msg.action === 'eam-ai-fill' && msg.content) {
        const result = fillAiContent(msg.content);
        sendResponse(result);
      }
      return true;
    });
  }
})();
