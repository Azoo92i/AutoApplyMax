/**
 * AutoApplyMax — Match Score badge on job pages (2026-07-28)
 * ────────────────────────────────────────────────────────────
 * Simplify-style feature. Injects a small "78% match" badge next to the
 * job title on LinkedIn Easy Apply pages, LinkedIn job detail pages, and
 * Indeed job pages. Colour-coded: green ≥75, yellow 55-75, orange <55.
 * Click badge → panel with matched keywords + missing keywords + CTA.
 *
 * 100% client-side keyword-overlap analysis — no AI cost, instant. Ports
 * the essential logic from ats-analyzer.js keyword branch (~60% of the
 * full ATS score; enough for a directional badge).
 *
 * Namespace: window.EAM.matchScore
 * Runs on: LinkedIn (excluding /jobs/collections and /jobs/search — those
 * are lists, no single JD), Indeed job pages, Glassdoor job pages.
 */
(function () {
  'use strict';

  if (window !== window.top) return;

  // Site-specific DOM selectors for job title + JD body. Update per DOM
  // changes upstream. Keep short — if any site adds anti-scrape hurdles,
  // rewrite the extract fn for that site.
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
    },
    'indeed.com': {
      titleSel: [
        'h1.jobsearch-JobInfoHeader-title',
        'h2[data-testid="jobsearch-JobInfoHeader-title"]',
        'h1[data-testid="jobsearch-JobInfoHeader-title"]',
      ],
      jdSel: [
        '#jobDescriptionText',
        'div[data-testid="jobDescriptionText"]',
      ],
    },
    'glassdoor.com': {
      titleSel: ['h1[data-test="job-title"]', '.JobDetails_jobTitle__'],
      jdSel: ['div[data-test="jobDescriptionContent"]', '.JobDetails_jobDescription__'],
    },
    'welcometothejungle.com': {
      titleSel: ['h2[data-testid="job-title"]', 'section h2'],
      jdSel: ['section[data-testid="job-section-description"]'],
    },
  };

  const HOST = location.hostname.replace(/^www\./, '');
  const config = Object.entries(SITES).find(([host]) => HOST.endsWith(host))?.[1];
  if (!config) return; // Not a supported site

  const BADGE_ID = 'aam-match-score-badge';
  const PANEL_ID = 'aam-match-score-panel';

  // ─── Lightweight ATS analyzer (ported from ats-analyzer.js keyword branch) ───

  const STOP_WORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from',
    'is','are','was','were','be','been','have','has','had','do','does','did','will','would',
    'could','should','may','might','this','that','these','those','we','you','they','them','their',
    'our','your','its','who','which','what','where','when','why','how','all','each','both','few',
    'more','most','some','such','no','not','only','very','just','also','work','working','experience',
    'role','position','team','company','ability','strong','looking','join','opportunity','including',
    'within','across','well','new','about','than','other','can','into','over','after','before',
    'between','under','through','during','any','here','there','own','being','make','like','get','got',
    'must','need','use','used','using','shall','much','many','then','while','still','already','often',
    'every','even','really','always','never','part','way','based','requirements','required','qualifications',
    'responsibilities','description','details','apply','application','job','jobs','candidate','candidates',
    // French common
    'le','la','les','un','une','des','de','du','au','aux','et','ou','mais','dans','sur','sous','avec',
    'sans','pour','par','en','ce','cette','ces','je','tu','il','elle','nous','vous','ils','elles','est',
    'sont','été','être','avoir','fait','faire','peut','deux','ans','tout','tous','toute','toutes','même',
    'autre','autres','comme','entre','poste','sein','mission','profil','recherche','rejoindre',
  ]);

  function extractKeywords(text) {
    if (!text || typeof text !== 'string') return [];
    const words = text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s+#.-]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && w.length <= 30 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
    // Frequency-count → keep top 40 (avoids over-scoring dilution)
    const counts = {};
    words.forEach(w => { counts[w] = (counts[w] || 0) + 1; });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([w]) => w);
  }

  function computeMatch(cvText, jdText) {
    const jdKeywords = extractKeywords(jdText);
    if (!jdKeywords.length) return { score: 0, matched: [], missing: [], total: 0 };
    const cvLower = (cvText || '').toLowerCase();
    const matched = [];
    const missing = [];
    for (const kw of jdKeywords) {
      if (cvLower.includes(kw)) matched.push(kw);
      else missing.push(kw);
    }
    return {
      score: Math.round((matched.length / jdKeywords.length) * 100),
      matched, missing, total: jdKeywords.length,
    };
  }

  // ─── DOM extraction ─────────────────────────────────────────────────

  function firstMatching(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function extractJobText() {
    const titleEl = firstMatching(config.titleSel);
    const jdEl = firstMatching(config.jdSel);
    if (!titleEl || !jdEl) return null;
    const title = (titleEl.textContent || '').trim();
    const jd = (jdEl.textContent || '').trim();
    if (!title || jd.length < 100) return null;
    return { title, jd, titleEl };
  }

  // ─── User CV text (from storage) ────────────────────────────────────

  async function loadUserCvText() {
    const data = await new Promise(resolve => {
      chrome.storage.local.get(null, d => resolve(d || {}));
    });
    // Prefer uploaded CV text if present, else stitch profile fields
    if (data.cvText && typeof data.cvText === 'string' && data.cvText.length > 200) {
      return data.cvText;
    }
    // Fallback: build from profile
    const cv = data.cvProfile || {};
    const parts = [
      cv.summary || data.summary || '',
      (cv.skills || []).join(', '),
      (cv.experience || []).map(e => `${e.title || ''} ${e.company || ''} ${(e.bullets || []).join(' ')}`).join('\n'),
      (cv.education || []).map(e => `${e.degree || ''} ${e.school || ''}`).join('\n'),
      (cv.certifications || []).join(', '),
      (cv.languages || []).map(l => typeof l === 'string' ? l : l.name || '').join(', '),
    ];
    return parts.filter(Boolean).join('\n');
  }

  // ─── Badge rendering ────────────────────────────────────────────────

  function colorForScore(s) {
    if (s >= 75) return { bg: '#16a34a', label: 'Great match' };
    if (s >= 55) return { bg: '#eab308', label: 'Decent match' };
    if (s >= 30) return { bg: '#f97316', label: 'Weak match' };
    return { bg: '#dc2626', label: 'Poor match' };
  }

  function removeExisting() {
    document.getElementById(BADGE_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
  }

  function renderBadge(job, result) {
    removeExisting();
    const { bg, label } = colorForScore(result.score);
    const badge = document.createElement('button');
    badge.id = BADGE_ID;
    badge.type = 'button';
    badge.title = `${label} — click to see matched + missing keywords`;
    badge.textContent = `${result.score}% match`;
    badge.style.cssText = [
      'display:inline-block',
      'margin-left:10px',
      'vertical-align:middle',
      `background:${bg}`,
      'color:#fff',
      'border:0',
      'border-radius:6px',
      'padding:4px 10px',
      'font-size:12px',
      'font-weight:700',
      'font-family:system-ui,-apple-system,sans-serif',
      'cursor:pointer',
      'box-shadow:0 1px 3px rgba(0,0,0,.2)',
    ].join(';');
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(job, result);
    });
    job.titleEl.appendChild(badge);
  }

  function togglePanel(job, result) {
    const existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    const { bg, label } = colorForScore(result.score);
    panel.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:99999',
      'width:340px', 'max-height:70vh', 'overflow-y:auto',
      'background:#fff', 'border-radius:10px',
      'box-shadow:0 8px 24px rgba(0,0,0,.16), 0 2px 4px rgba(0,0,0,.08)',
      'font-family:system-ui,-apple-system,sans-serif',
      'font-size:13px', 'line-height:1.45', 'color:#0f172a',
      'padding:16px 18px',
    ].join(';');
    const missingChips = result.missing.slice(0, 15).map(k =>
      `<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 7px;background:#fee2e2;color:#991b1b;border-radius:10px;font-size:11px;font-weight:500">${escapeHtml(k)}</span>`
    ).join('');
    const matchedChips = result.matched.slice(0, 12).map(k =>
      `<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 7px;background:#dcfce7;color:#166534;border-radius:10px;font-size:11px;font-weight:500">${escapeHtml(k)}</span>`
    ).join('');
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <div style="font-weight:700;font-size:15px">${result.score}% match — ${label}</div>
          <div style="color:#64748b;font-size:12px;margin-top:2px">${result.matched.length}/${result.total} keywords matched</div>
        </div>
        <button id="aam-close-panel" style="background:transparent;border:0;font-size:20px;cursor:pointer;color:#64748b;line-height:1">×</button>
      </div>
      ${result.missing.length ? `<div style="margin-bottom:12px">
        <div style="font-weight:600;font-size:12px;margin-bottom:6px;color:#334155">Missing keywords (${result.missing.length})</div>
        ${missingChips}
      </div>` : ''}
      ${result.matched.length ? `<div style="margin-bottom:12px">
        <div style="font-weight:600;font-size:12px;margin-bottom:6px;color:#334155">Matched keywords (${result.matched.length})</div>
        ${matchedChips}
      </div>` : ''}
      <a href="https://www.autoapplymax.com/dashboard#cv-generator" target="_blank" style="display:block;background:#0a66c2;color:#fff;text-align:center;padding:9px;border-radius:6px;font-weight:600;text-decoration:none;font-size:13px;margin-top:8px">Tailor CV for this job →</a>
      <div style="text-align:center;margin-top:10px;font-size:11px;color:#94a3b8">Client-side keyword match — no data sent to servers</div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#aam-close-panel')?.addEventListener('click', () => panel.remove());
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ─── Scanning ───────────────────────────────────────────────────────

  let currentJobKey = null; // dedupe rescans for the same job
  async function scan() {
    const job = extractJobText();
    if (!job) return;
    const key = (job.title + '|' + job.jd.slice(0, 100));
    if (key === currentJobKey && document.getElementById(BADGE_ID)) return;
    currentJobKey = key;
    const cvText = await loadUserCvText();
    if (!cvText || cvText.length < 100) {
      removeExisting();
      return;
    }
    const result = computeMatch(cvText, job.jd);
    if (result.total === 0) return;
    renderBadge(job, result);
  }

  scan();

  // Debounced rescan on DOM churn (SPA navigation on LinkedIn/Indeed)
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 700);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also rescan on URL change (SPA)
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentJobKey = null;
      setTimeout(scan, 500);
    }
  }, 800);

  window.EAM = window.EAM || {};
  window.EAM.matchScore = { scan, computeMatch };
})();
