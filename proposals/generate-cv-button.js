/**
 * AutoApplyMax — "Generate CV for this job" button (2026-07-30)
 * ─────────────────────────────────────────────────────────────
 * Injects a small "✨ Generate tailored CV" button next to the job title
 * on LinkedIn, Indeed, Glassdoor, Welcome to the Jungle job pages.
 *
 * Click flow:
 *  1. Extract job title + company + JD from the page
 *  2. chrome.storage.local.set({ aam_pending_jd: {title, jd, company, source, ts} })
 *  3. Open a new tab on autoapplymax.com/dashboard#cv-generator
 *  4. content-marker.js on dashboard pushes aam_pending_jd to the page
 *  5. dashboard.js reads it on cv-generator section open, prefills textarea
 *
 * Complements match-score-badge.js — the badge shows fit, this button
 * is the one-click action.
 *
 * Namespace: window.EAM.generateCvBtn
 */
(function () {
  'use strict';

  if (window !== window.top) return;

  const SITES = {
    'linkedin.com': {
      titleSel: [
        '.job-details-jobs-unified-top-card__job-title',
        '.jobs-unified-top-card__job-title',
        'h1.top-card-layout__title',
        'h1.jobs-details-top-card__job-title',
      ],
      jdSel: [
        '#job-details',
        '.jobs-description-content__text',
        '.jobs-description__content',
        '.description__text',
      ],
      companySel: [
        '.job-details-jobs-unified-top-card__company-name a',
        '.jobs-unified-top-card__company-name a',
        '.topcard__org-name-link',
      ],
    },
    'indeed.com': {
      titleSel: [
        'h2[data-testid="simpler-jobTitle"]',
        'h1[data-testid="simpler-jobTitle"]',
        'h2[data-testid="jobsearch-JobInfoHeader-title"]',
        'h1[data-testid="jobsearch-JobInfoHeader-title"]',
        'h1.jobsearch-JobInfoHeader-title',
        'h2.jobsearch-JobInfoHeader-title',
      ],
      jdSel: [
        '#jobDescriptionText',
        'div[data-testid="jobDescriptionText"]',
      ],
      companySel: [
        'div[data-testid="inlineHeader-companyName"] a',
        'div[data-company-name] a',
        '.jobsearch-InlineCompanyRating a',
      ],
    },
    'glassdoor.com': {
      titleSel: ['h1[data-test="job-title"]', '.JobDetails_jobTitle__'],
      jdSel: ['div[data-test="jobDescriptionContent"]', '.JobDetails_jobDescription__'],
      companySel: ['h4[data-test="employer-name"]', '.EmployerProfile_employerName__'],
    },
    'welcometothejungle.com': {
      titleSel: ['h2[data-testid="job-title"]', 'section h2'],
      jdSel: ['section[data-testid="job-section-description"]'],
      companySel: ['a[data-testid="job-organization-link"]'],
    },
  };

  const HOST = location.hostname.replace(/^www\./, '');
  const config = Object.entries(SITES).find(([host]) => HOST.endsWith(host))?.[1]
    || (HOST === 'localhost' || HOST === '127.0.0.1' ? SITES['linkedin.com'] : null);
  if (!config) return;

  const BTN_ID = 'aam-generate-cv-btn';
  const DASHBOARD_URL = 'https://www.autoapplymax.com/dashboard#cv-generator';

  function firstMatching(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function extractJob() {
    let titleEl = firstMatching(config.titleSel);
    const jdEl = firstMatching(config.jdSel);
    // Heuristic fallback: walk up from JD to find nearest h1/h2. Survives
    // DOM refactors on real sites (verified 2026-07-31 on Indeed).
    if (!titleEl && jdEl) {
      let scope = jdEl;
      for (let i = 0; i < 5 && scope; i++) {
        scope = scope.parentElement;
        if (!scope) break;
        const h = scope.querySelector('h1, h2');
        if (h && h.textContent && h.textContent.trim().length >= 5 && h.textContent.trim().length <= 100) {
          titleEl = h;
          break;
        }
      }
    }
    if (!titleEl || !jdEl) return null;
    const title = (titleEl.textContent || '').trim();
    const jd = (jdEl.textContent || '').trim();
    if (!title || jd.length < 100) return null;
    const companyEl = firstMatching(config.companySel || []);
    const company = (companyEl?.textContent || '').trim();
    return { title, jd, company, titleEl, source: HOST };
  }

  function renderButton(job) {
    document.getElementById(BTN_ID)?.remove();
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Open AutoApplyMax with this job description pre-filled';
    btn.innerHTML = '✨ Generate tailored CV';
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:4px',
      'margin-left:8px', 'vertical-align:middle',
      'background:linear-gradient(135deg,#0a66c2 0%,#1e88e5 100%)',
      'color:#fff', 'border:0', 'border-radius:6px',
      'padding:5px 12px', 'font-size:12px', 'font-weight:600',
      'font-family:system-ui,-apple-system,sans-serif',
      'cursor:pointer', 'box-shadow:0 1px 3px rgba(0,0,0,.2)',
      'transition:transform 0.1s',
    ].join(';');
    btn.addEventListener('mousedown', () => { btn.style.transform = 'scale(0.97)'; });
    btn.addEventListener('mouseup', () => { btn.style.transform = 'scale(1)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleClick(job);
    });
    if (job.titleEl.parentNode) {
      job.titleEl.parentNode.insertBefore(btn, job.titleEl.nextSibling);
    } else {
      job.titleEl.appendChild(btn);
    }
    return btn;
  }

  function handleClick(job) {
    const payload = {
      title: job.title,
      jd: job.jd.slice(0, 8000),
      company: job.company || '',
      source: job.source,
      url: location.href,
      ts: Date.now(),
    };
    try {
      chrome.storage.local.set({ aam_pending_jd: payload }, () => {
        window.open(DASHBOARD_URL, '_blank', 'noopener');
      });
    } catch (_e) {
      window.open(DASHBOARD_URL, '_blank', 'noopener');
    }
  }

  let currentKey = null;
  function scan() {
    const job = extractJob();
    if (!job) return;
    const key = (job.title + '|' + job.jd.slice(0, 80));
    if (key === currentKey && document.getElementById(BTN_ID)) return;
    currentKey = key;
    renderButton(job);
  }

  scan();

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 700);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentKey = null;
      setTimeout(scan, 500);
    }
  }, 800);

  window.EAM = window.EAM || {};
  window.EAM.generateCvBtn = { scan, extractJob };
})();
