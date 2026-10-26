// Popup script for UI management - Multi-site support v2.0
let isRunning = false;
let currentSiteInfo = null;

// ─── Supabase config — fetched from autoapplymax.com at startup ────────
// Instead of hardcoding the URL/anon key into the extension bundle (which
// would force a full CWS republish + 24-72h propagation any time we need
// to switch backend), we fetch the active config from a static JSON on
// the website. Falls back to hardcoded defaults if the fetch fails so
// the extension still works offline / during a Vercel outage.
const SUPABASE_CONFIG_URL = 'https://www.autoapplymax.com/supabase-config.json';
const SUPABASE_CONFIG_FALLBACK = {
  url: 'https://tgknaopmwbelterrhrnz.supabase.co',
  anon_key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRna25hb3Btd2JlbHRlcnJocm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NzYzMTcsImV4cCI6MjA5NDI1MjMxN30.2-V5Z6-ZIKOkC6RJEjdEEAVKjGYbSOdX_FSd3yPdE6Q',
};
let SUPABASE_URL = SUPABASE_CONFIG_FALLBACK.url;
let SUPABASE_ANON_KEY = SUPABASE_CONFIG_FALLBACK.anon_key;

// Cache the resolved config in chrome.storage to avoid one network round-trip
// on every popup open, refresh every 6 hours.
const SUPABASE_CONFIG_TTL_MS = 6 * 60 * 60 * 1000;
// v2.5.120 (security audit 2026-10-18 #12): the remote config may only point at OUR project — a tampered
// supabase-config.json (or a poisoned cache) must never send the user's session to another backend.
function _eamValidSupabaseCfg(cfg) {
  try {
    if (!cfg || typeof cfg.url !== 'string' || typeof cfg.anon_key !== 'string') return false;
    if (!/^https:\/\/tgknaopmwbelterrhrnz\.supabase\.co\/?$/.test(cfg.url)) return false;
    // Supabase's new publishable keys are opaque (no JWT) — still only usable against the URL above.
    if (/^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(cfg.anon_key)) return true;
    const b64 = cfg.anon_key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const c = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4)));
    return c.ref === 'tgknaopmwbelterrhrnz' && c.role === 'anon';
  } catch (_) { return false; }
}
async function loadSupabaseConfig() {
  try {
    const cached = await chrome.storage.local.get(['supabase_config_cached', 'supabase_config_cached_at']);
    const age = Date.now() - (cached.supabase_config_cached_at || 0);
    if (cached.supabase_config_cached && age < SUPABASE_CONFIG_TTL_MS && _eamValidSupabaseCfg(cached.supabase_config_cached)) {
      SUPABASE_URL = cached.supabase_config_cached.url.replace(/\/$/, '');
      SUPABASE_ANON_KEY = cached.supabase_config_cached.anon_key;
      return;
    }
  } catch (e) {}
  try {
    const res = await fetch(SUPABASE_CONFIG_URL, { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      if (_eamValidSupabaseCfg(cfg)) {
        SUPABASE_URL = cfg.url.replace(/\/$/, '');
        SUPABASE_ANON_KEY = cfg.anon_key;
        try { await chrome.storage.local.set({ supabase_config_cached: cfg, supabase_config_cached_at: Date.now() }); } catch (e) {}
      }
    }
  } catch (e) {
    console.warn('Could not fetch Supabase config, using fallback:', e?.message);
  }
}
// Kick off non-blocking config fetch as soon as popup loads
loadSupabaseConfig();

// Stamp real version from manifest so footer + bug-report link stay in sync.
// Was hardcoded "v2.5.2" — every release we forgot to bump it. Now derived
// from manifest at popup open.
try {
  const mv = chrome.runtime.getManifest().version;
  const versionEl = document.getElementById('ext-version');
  if (versionEl) versionEl.textContent = 'v' + mv;
  const bugLink = document.getElementById('report-bug-btn');
  if (bugLink && bugLink.href) {
    const u = new URL(bugLink.href);
    u.searchParams.set('v', mv);
    bugLink.href = u.toString();
  }
} catch (e) {}

// ─── Site detection ─────────────────────────────────────────────────────
const SUPPORTED_SITES = {
  linkedin:  { name: 'LinkedIn',                color: '#0a66c2', pattern: /linkedin\.com/i,                  jobPath: /\/jobs\//i },
  indeed:    { name: 'Indeed',                   color: '#2164f3', pattern: /indeed\.(com|fr|co\.uk|de|es|it|ca|com\.au)|smartapply\.indeed\.com/i, jobPath: /\/(jobs|viewjob|q-|beta\/indeedapply)/i },
  wttj:      { name: 'Welcome to the Jungle',    color: '#ffcd00', pattern: /welcometothejungle\.(com|co)/i,  jobPath: /\/(jobs|companies)/i },
  glassdoor: { name: 'Glassdoor',                color: '#0caa41', pattern: /glassdoor\.(com|fr|co\.uk|de|es|it|ca|com\.au)/i, jobPath: /\/(Job|job|Jobs|jobs)/i },
  monster:   { name: 'Monster',                  color: '#6e45a5', pattern: /monster\.(com|fr|co\.uk|de|es|it|ca|com\.au)/i,   jobPath: /\/(jobs|job-openings)/i },
  manual:    { name: 'Manual',                   color: '#8b5cf6', pattern: /^$/,                                              jobPath: /^$/ }
};

// ─── ATS patterns for manual tracking extraction ────────────────────────
const ATS_PATTERNS = [
  { pattern: /lever\.co\/([^/]+)/i,              extract: 1 },
  { pattern: /boards\.greenhouse\.io\/([^/]+)/i, extract: 1 },
  { pattern: /([^.]+)\.workday\.com/i,           extract: 1 },
  { pattern: /([^.]+)\.recruitee\.com/i,         extract: 1 },
  { pattern: /([^.]+)\.bamboohr\.com/i,          extract: 1 },
  { pattern: /jobs\.ashbyhq\.com\/([^/]+)/i,     extract: 1 },
  { pattern: /([^.]+)\.taleo\.net/i,             extract: 1 },
  { pattern: /([^.]+)\.icims\.com/i,             extract: 1 },
  { pattern: /smartrecruiters\.com\/oneclick-ui\/company\/([^/?#]+)/i, extract: 1 },   // v2.5.129: was "Oneclick Ui"
  { pattern: /jobs\.smartrecruiters\.com\/([^/]+)/i, extract: 1 },
  { pattern: /careers\.([^.]+)\./i,              extract: 1 },
  { pattern: /jobs\.([^.]+)\./i,                 extract: 1 }
];

function extractCompanyFromUrl(url) {
  try {
    for (const ats of ATS_PATTERNS) {
      const match = url.match(ats.pattern);
      if (match && match[ats.extract]) {
        const raw = match[ats.extract];
        return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
    }
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const parts = hostname.split('.');
    const name = parts.length > 2 ? parts[parts.length - 2] : parts[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch (e) {
    return '';
  }
}

// v2.5.129: "Palantir Technologies" vs the URL company "Palantir" → same company.
function _companyKey(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }
function _sameCompany(text, company) {
  const a = _companyKey(text), b = _companyKey(company);
  if (a.length < 3 || b.length < 3) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function _isAtsJobHost(url) {
  try { return /(^|\.)(lever\.co|greenhouse\.io|ashbyhq\.com|smartrecruiters\.com|workable\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com)$/i.test(new URL(url).hostname); }
  catch (_) { return false; }
}
// Runs IN the job page (chrome.scripting): visible job-title headings, most specific ATS selectors first.
function _pageJobHeadings() {
  const sels = ['.posting-headline h2', 'h1.app-title', '.job__title h1', '#header h1', 'h1.section-header', '[data-automation-id="jobPostingHeader"]',
    'h1[data-ui="job-title"]', 'h1.job-title', '.job-title h1', '[class*="jobPostingTitle"]', 'h1[class*="title" i]', 'h1'];
  const out = [];
  for (const s of sels) {
    let els = [];
    try { els = document.querySelectorAll(s); } catch (_) { continue; }
    for (const el of els) {
      if (!el.getClientRects().length) continue;
      const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 3 && t.length <= 120 && !out.includes(t)) out.push(t);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

function extractJobTitleFromPageTitle(title, company) {
  if (!title) return '';
  const separators = [' | ', ' - ', ' – ', ' — ', ' at ', ' @ '];
  // Greenhouse: "Job Application for <title> at <company>".
  let extracted = String(title).replace(/^\s*(job application for|application for|apply for)\s+/i, '');
  for (const sep of separators) {
    const idx = extracted.indexOf(sep);
    if (idx > 0) {
      const first = extracted.substring(0, idx).trim();
      const rest = extracted.substring(idx + sep.length).trim();
      // v2.5.129 (test agent 2026-10-26, Lever "Palantir Technologies - Administrative Business Partner" saved as
      // "Palantir Technologies"): when the first part is the company, the title is the part after the separator.
      if (rest && _sameCompany(first, company) && !_sameCompany(rest, company)) {
        extracted = rest;
        for (const s2 of [' | ', ' - ', ' – ', ' — ', ' @ ']) { const j = extracted.indexOf(s2); if (j > 0) { extracted = extracted.substring(0, j).trim(); break; } }
      } else {
        extracted = first;
      }
      break;
    }
  }
  if (extracted.length > 80) extracted = extracted.substring(0, 80);

  // Clean up Indeed badge text and duplication
  extracted = extracted
    .replace(/\s+with verification$/i, '')
    .replace(/\s+avec vérification$/i, '')
    .replace(/\s+- new!?$/i, '')
    .replace(/\s+urgently hiring$/i, '')
    .trim();

  // Fix title duplication: "Title Title" → "Title"
  if (extracted.length >= 6) {
    for (let i = 3; i <= Math.floor(extracted.length / 2) + 2 && i < extracted.length; i++) {
      const part = extracted.substring(0, i).trim();
      const rest = extracted.substring(i).trim();
      if (part.length >= 3 && rest === part) {
        extracted = part;
        break;
      }
    }
  }

  return extracted;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch (e) {
    return url;
  }
}

function detectSite(url) {
  if (!url) return null;
  for (const [key, site] of Object.entries(SUPPORTED_SITES)) {
    if (site.pattern.test(url)) {
      return { key, ...site };
    }
  }
  return null;
}

function isOnJobPage(url, site) {
  if (!site) return false;
  return site.jobPath.test(url);
}

// ─── Update site badge in popup UI ──────────────────────────────────────
function updateSiteBadge(site) {
  currentSiteInfo = site || null;
  // Re-render status display with current running state
  updateStatusDisplay(isRunning ? 'Running' : 'Stopped', isRunning);
}

// ─── Script injection for multi-site ────────────────────────────────────
async function injectModularScripts(tabId, siteKey) {
  // Injection order matters: utils → strings → registry → base-adapter →
  // ai-form → form-filler → engine → site adapter. ai-form MUST precede
  // form-filler since form-filler calls `window.EAM.aiForm.askAI(...)` as
  // the final fallback for unknown fields.
  const scripts = [
    'core/utils.js',
    'core/job-board-strings.js',
    'core/site-registry.js',
    'adapters/base-adapter.js',
    'core/ai-form.js',
    'core/form-filler.js',
    'core/engine.js'
  ];

  // Add the site-specific adapter
  const adapterMap = {
    linkedin:  'adapters/linkedin-adapter.js',
    indeed:    'adapters/indeed-adapter.js',
    wttj:      'adapters/wttj-adapter.js',
    glassdoor: 'adapters/glassdoor-adapter.js',
    monster:   'adapters/monster-adapter.js'
  };
  if (adapterMap[siteKey]) {
    scripts.push(adapterMap[siteKey]);
  }

  // Inject scripts in order
  for (const file of scripts) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: siteKey === 'indeed' || siteKey === 'glassdoor' },
        files: [file]
      });
    } catch (err) {
      console.log(`Script ${file} may already be injected: ${err.message}`);
    }
  }

  // Initialize the engine after all scripts are loaded
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.EAM && window.EAM.BotEngine && !window.EAM._engineInitialized) {
          window.EAM.BotEngine.init();
          window.EAM._engineInitialized = true;
        }
      }
    });
  } catch (err) {
    console.log('Engine init may have already run:', err.message);
  }
}

// ─── Fallback: inject legacy content-simple.js for LinkedIn ─────────────
async function injectLegacyScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-simple.js']
    });
    console.log('Legacy content-simple.js injected');
  } catch (err) {
    console.log('Legacy script may already be injected:', err.message);
  }
}

// Load running state from storage
async function loadRunningState() {
  const local = await chrome.storage.local.get(['isRunning']);
  isRunning = local.isRunning || false;
  updateButtons();
  updateStatusDisplay(isRunning ? 'Running' : 'Stopped', isRunning);
}

// ─── Track section logic ─────────────────────────────────────────────────
// v2.5.92: the form opens from the "Track this job" button (it used to pop
// open by itself on every non-LinkedIn page). An already-tracked page still
// shows its "Already tracked" line on its own.
let _trackTab = null;
let _trackWired = false;
async function initTrackSection(tab) {
  _trackTab = tab || null;
  const section = document.getElementById('track-section');
  const already = document.getElementById('track-already');
  if (!section || !tab?.url || !tab.url.startsWith('http') || /autoapplymax\.com/i.test(tab.url)) return;
  const { appliedJobs = [] } = await chrome.storage.local.get(['appliedJobs']);
  const normalized = normalizeUrl(tab.url);
  if (appliedJobs.some(j => normalizeUrl(j.link) === normalized)) {
    section.style.display = 'block';
    already.style.display = 'flex';
    const btn = document.getElementById('track-job-btn');
    if (btn) { btn.disabled = true; btn.lastChild.textContent = ' Tracked'; }
  }
}

async function openTrackForm() {
  const tab = _trackTab;
  if (!tab || !tab.url || !/^https?:\/\//.test(tab.url) || /autoapplymax\.com/i.test(tab.url)) {
    showToast('Open the job\'s page first, then click Track this job.', 'info');
    return;
  }
  if (/linkedin\.com/i.test(tab.url)) {
    showToast('LinkedIn applications sent by auto-apply are tracked automatically.', 'info');
    return;
  }
  const section = document.getElementById('track-section');
  const detected = document.getElementById('track-detected');
  const already = document.getElementById('track-already');
  if (!section || !detected) return;
  section.style.display = 'block';
  already.style.display = 'none';
  detected.style.display = 'block';
  if (_trackWired) { document.getElementById('track-title')?.focus(); return; }
  _trackWired = true;

  const titleInput = document.getElementById('track-title');
  const companyInput = document.getElementById('track-company');
  const trackBtn = document.getElementById('track-btn');
  if (!titleInput || !companyInput || !trackBtn) return;

  const company0 = extractCompanyFromUrl(tab.url);
  // v2.5.129: on ATS job pages the page heading is the job title (the tab title often starts with the company).
  let heading = '';
  if (_isAtsJobHost(tab.url) && tab.id != null) {
    try {
      const inj = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: _pageJobHeadings }),
        new Promise(r => setTimeout(() => r(null), 1500)),
      ]);
      const cands = (inj && inj[0] && Array.isArray(inj[0].result)) ? inj[0].result : [];
      heading = cands.find(c => !_sameCompany(c, company0)) || '';
    } catch (_) {}
  }
  titleInput.value = heading || extractJobTitleFromPageTitle(tab.title, company0);
  companyInput.value = company0;

  // Track button
  trackBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const company = companyInput.value.trim();

    if (!title || !company) {
      showToast('Please fill in both job title and company', 'warning');
      return;
    }

    const newJob = {
      title,
      company,
      link: tab.url,
      date: new Date().toISOString(),
      source: 'manual',
      location: ''
    };

    const { appliedJobs: jobs = [] } = await chrome.storage.local.get(['appliedJobs']);
    jobs.push(newJob);

    const { appliedCount = 0 } = await chrome.storage.local.get(['appliedCount']);
    await chrome.storage.local.set({
      appliedJobs: jobs,
      appliedCount: appliedCount + 1
    });

    document.getElementById('applied-count').textContent = appliedCount + 1;
    // v2.5.92: also sync it to the dashboard (it used to stay on this browser only).
    try { chrome.runtime.sendMessage({ type: 'jobApplied', ...newJob }); } catch (_) {}

    // Switch to "already tracked" state
    detected.style.display = 'none';
    already.style.display = 'flex';
    const tb = document.getElementById('track-job-btn');
    if (tb) { tb.disabled = true; tb.lastChild.textContent = ' Tracked'; }

    showToast('Job tracked — it is on your dashboard.', 'success');
  });

  // Dismiss button
  document.getElementById('track-dismiss-btn').addEventListener('click', () => {
    section.style.display = 'none';
  });
}

// Load config on startup
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await updateStatus();
  await loadRunningState();
  setupTabs();
  setupResumeUpload();
  setupValidation();
  checkOnboarding();

  // Auth state + dashboard links
  checkAuthState();
  setupDashboardLinks();
  setupSecondaryActions();
  renderRunExtras();

  // Detect current site and update badge + init track section
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const site = detectSite(tab?.url);
    updateSiteBadge(site);
    setPageContext(tab);
    await initTrackSection(tab);
  } catch (e) {}
});

// ─── v2.5.92: context-aware second action ─────────────────────────────
// body[data-context]: 'linkedin' → "Tailor my CV to this job";
// 'other' (any other website) → Autofill this form + Track this job, and
// Autofill becomes the primary action; 'none' (new tab, chrome://) → same
// buttons as 'other', they explain what to open first.
let _pageTab = null;
function setPageContext(tab) {
  _pageTab = tab || null;
  const url = (tab && tab.url) || '';
  const ctx = /^https?:\/\/([^/]*\.)?linkedin\.com\//i.test(url) ? 'linkedin'
    : /^https?:\/\//i.test(url) && !/autoapplymax\.com/i.test(url) ? 'other' : 'none';
  document.body.dataset.context = ctx;
}

function setupSecondaryActions() {
  document.getElementById('track-job-btn')?.addEventListener('click', () => openTrackForm());
  document.getElementById('tailor-cv-btn')?.addEventListener('click', async () => {
    const tab = _pageTab;
    // On a LinkedIn job with our in-page "Match · Tailor CV" button, reuse it:
    // it stores the job description so the CV generator opens pre-filled.
    if (tab && tab.id && /linkedin\.com\/jobs\//i.test(tab.url || '')) {
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          const b = document.getElementById('aam-tailor-cv-btn');
          if (b) { b.click(); return true; }
          return false;
        } });
        if (res && res.result) { window.close(); return; }
      } catch (_) {}
    }
    chrome.tabs.create({ url: 'https://www.autoapplymax.com/dashboard.html#cv-generator' });
  });
}

// ─── v2.5.92: streak + pause + Premium notice (refreshed every 2 s) ────────
// Streak: same rule as the dashboard (weekdays in a row with ≥1 application),
// computed from applications saved on this browser.
function computeStreak(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return { count: 0, todayDone: false };
  const days = new Set();
  for (const j of jobs) {
    const d = new Date(j.date || j.appliedAt || j.created_at || '');
    if (!isNaN(d.getTime())) days.add(d.toISOString().slice(0, 10));
  }
  if (!days.size) return { count: 0, todayDone: false };
  const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
  const dayStr = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const todayDone = days.has(dayStr(now));
  const anchor = new Date(now);
  while (isWeekend(anchor)) anchor.setDate(anchor.getDate() - 1);
  if (!isWeekend(now) && !todayDone) {
    anchor.setDate(anchor.getDate() - 1);
    while (isWeekend(anchor)) anchor.setDate(anchor.getDate() - 1);
  }
  let count = 0;
  const cursor = new Date(anchor);
  for (let i = 0; i < 365; i++) {
    if (!days.has(dayStr(cursor))) break;
    count++;
    do { cursor.setDate(cursor.getDate() - 1); } while (isWeekend(cursor));
  }
  return { count, todayDone };
}

let _pauseActive = false;
async function renderRunExtras() {
  try {
    const { appliedJobs = [], eam_pause_state: p, eam_ai_premium_notice: n, isRunning: running, plan, isPremium } =
      await chrome.storage.local.get(['appliedJobs', 'eam_pause_state', 'eam_ai_premium_notice', 'isRunning', 'plan', 'isPremium']);
    // Streak
    const st = computeStreak(appliedJobs);
    const el = document.getElementById('streak');
    if (el) { el.hidden = st.count < 1; const c = document.getElementById('streak-count'); if (c) c.textContent = st.count; }
    // Pause (set by the engine while it waits out a LinkedIn slow-down)
    const now = Date.now();
    if (p && p.until > now) {
      const mins = Math.max(1, Math.ceil((p.until - now) / 60000));
      _pauseActive = true;
      const statusEl = document.getElementById('status');
      if (statusEl) { statusEl.textContent = 'Paused · resumes in ~' + mins + ' min'; statusEl.className = 'status-value paused'; }
      const body = 'LinkedIn asked us to slow down — auto-apply resumes automatically in about ' + mins + ' min. If it doesn\'t, click Start auto-apply again.';
      let box = document.getElementById('eam-pause-alert');
      if (!box) {
        box = buildAlert({ id: 'eam-pause-alert', bodyId: 'eam-pause-alert-text', tone: 'warning', title: 'Auto-apply paused', body });
        document.getElementById('alert-slot')?.prepend(box);
      } else {
        const t = document.getElementById('eam-pause-alert-text'); if (t) t.textContent = body;
      }
    } else if (_pauseActive) {
      _pauseActive = false;
      document.getElementById('eam-pause-alert')?.remove();
      updateStatusDisplay(isRunning ? 'Running' : 'Stopped', isRunning);
    }
    // Premium notice — after a run that skipped applications on questions
    // only AI can answer (free plan). Once per session (ai-form re-arms it).
    const paid = isPremium || ['premium', 'pro', 'unlimited'].includes(plan) || ['premium', 'pro', 'unlimited'].includes(document.body.dataset.plan);
    if (n && !n.seen && (n.skipped || 0) > 0 && !running && !paid && !document.getElementById('ai-premium-notice')) {
      // 2.5.122: the local price even before the profile loaded (the HTML default "$6.99" showed next to "€6.99" in FR).
      const price = localPremiumPrice();
      const box = buildAlert({
        id: 'ai-premium-notice',
        tone: 'info',
        title: 'Some applications were skipped',
        body: (n.skipped > 1 ? n.skipped + ' applications' : 'One application') + ' had complex screening questions. Go Premium to let AI answer them.',
        // Resolved at click time: auth may still be loading when the notice renders.
        action: { text: 'Go Premium — ' + price + '/month', url: () => 'https://www.autoapplymax.com' + (document.body.dataset.auth === 'in' ? '/dashboard?section=upgrade&src=ext_ai_skipped' : '/premium?src=ext_ai_skipped') },
        onClose: async () => { try { await chrome.storage.local.set({ eam_ai_premium_notice: { ...n, seen: true } }); } catch (_) {} },
        closeOnAction: true,
      });
      document.getElementById('alert-slot')?.appendChild(box);
    }
  } catch (_) {}
}

// Shared alert card (rate limit / daily limit / AI-skipped notice) rendered in
// #alert-slot under the header. tone: 'warning' (amber) | 'info' (blue) | 'success'.
const ALERT_ICONS = {
  warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
};
function buildAlert({ id, tone = 'warning', title, body, bodyId, link, action, closeOnAction, onClose }) {
  const box = document.createElement('div');
  if (id) box.id = id;
  box.className = 'alert alert-' + tone;
  box.setAttribute('role', 'status');
  const icon = document.createElement('span');
  icon.className = 'alert-icon';
  icon.innerHTML = ALERT_ICONS[tone] || ALERT_ICONS.info;
  const txt = document.createElement('div');
  txt.className = 'alert-body';
  if (title) { const t = document.createElement('strong'); t.textContent = title; txt.appendChild(t); }
  const p = document.createElement('div');
  if (bodyId) p.id = bodyId;
  p.textContent = body || '';
  txt.appendChild(p);
  if (link) {
    const a = document.createElement('a');
    a.href = '#'; a.textContent = link.text + ' →';
    a.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: link.url }); });
    txt.appendChild(a);
  }
  if (action) {
    // v2.5.92: a real button ("See dashboard", "Go Premium") under the text.
    const wrap = document.createElement('div');
    wrap.className = 'alert-action';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn btn-primary btn-sm'; b.textContent = action.text;
    if (action.id) b.id = action.id;
    b.addEventListener('click', () => {
      chrome.tabs.create({ url: typeof action.url === 'function' ? action.url() : action.url });
      if (closeOnAction) { box.remove(); if (onClose) onClose(); }
    });
    wrap.appendChild(b);
    txt.appendChild(wrap);
  }
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'alert-close'; x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = (window.UI_ICON && window.UI_ICON.close) || '×';
  x.addEventListener('click', () => { box.remove(); if (onClose) onClose(); });
  box.append(icon, txt, x);
  return box;
}

// Setup tabs
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.getAttribute('data-tab');
      document.getElementById(`${tabName}-tab`).classList.add('active');
      if (tabName === 'applied') loadAppliedJobs();
    });
  });
}

// ─── v2.5.129: phone country code / country never default to the US ─────
// Test agent 2026-10-26: the select fell back to "+1" when nothing was stored, the first auto-save persisted it,
// and autofill derived Country = United States from it (phone "+1…", city "Paris, TX", "Based in US? Yes").
// Where the code came from is stored as phoneCountryCodeSource: 'user' (picked in the select — never overridden),
// 'account' (dashboard profile), 'timezone' (browser guess), 'default' (+1, nothing known — never used to derive
// a country). Legacy installs have no source: a stored "+1" is then treated as the untouched default.
const _ISO_DIAL = { FR: '33', US: '1', CA: '1', IN: '91', GB: '44', UK: '44', DE: '49', ES: '34', IT: '39', BE: '32', CH: '41', NL: '31', PT: '351', IE: '353', LU: '352',
  MA: '212', PK: '92', AE: '971', SG: '65', AU: '61', KR: '82', JP: '81', CN: '86', HK: '852', TW: '886', BR: '55', MX: '52', AR: '54', CO: '57', CL: '56', PE: '51',
  ZA: '27', NG: '234', KE: '254', EG: '20', SA: '966', QA: '974', KW: '965', BH: '973', OM: '968', JO: '962', LB: '961', IQ: '964', IR: '98', TR: '90', PL: '48', SE: '46',
  NO: '47', DK: '45', FI: '358', AT: '43', GR: '30', RO: '40', CZ: '420', HU: '36', UA: '380', IL: '972', PH: '63', MY: '60', ID: '62', TH: '66', VN: '84', BD: '880',
  LK: '94', NP: '977', NZ: '64', TN: '216', DZ: '213', SN: '221', CI: '225', EE: '372', LV: '371', LT: '370', CY: '357', HR: '385', SK: '421', SI: '386', BG: '359',
  RS: '381', MT: '356', IS: '354', GH: '233', MG: '261', SS: '211', SD: '249', ET: '251', UG: '256', TZ: '255', RW: '250', CM: '237', ZW: '263', ZM: '260', RU: '7', KZ: '7', UZ: '998' };
const _TZ_ISO = { 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/London': 'GB', 'Europe/Madrid': 'ES', 'Atlantic/Canary': 'ES', 'Europe/Rome': 'IT', 'Europe/Brussels': 'BE',
  'Europe/Zurich': 'CH', 'Europe/Amsterdam': 'NL', 'Europe/Lisbon': 'PT', 'Europe/Dublin': 'IE', 'Europe/Luxembourg': 'LU', 'Europe/Vienna': 'AT', 'Europe/Warsaw': 'PL',
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Athens': 'GR', 'Europe/Bucharest': 'RO', 'Europe/Prague': 'CZ',
  'Europe/Budapest': 'HU', 'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA', 'Europe/Istanbul': 'TR', 'Europe/Tallinn': 'EE', 'Europe/Riga': 'LV', 'Europe/Vilnius': 'LT',
  'Asia/Nicosia': 'CY', 'Europe/Zagreb': 'HR', 'Europe/Bratislava': 'SK', 'Europe/Ljubljana': 'SI', 'Europe/Sofia': 'BG', 'Europe/Belgrade': 'RS', 'Europe/Malta': 'MT',
  'Africa/Casablanca': 'MA', 'Africa/Tunis': 'TN', 'Africa/Algiers': 'DZ', 'Africa/Cairo': 'EG', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE', 'Africa/Johannesburg': 'ZA',
  'Africa/Accra': 'GH', 'Africa/Dakar': 'SN', 'Africa/Abidjan': 'CI', 'Africa/Addis_Ababa': 'ET', 'Africa/Kampala': 'UG', 'Africa/Dar_es_Salaam': 'TZ',
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Karachi': 'PK', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Qatar': 'QA', 'Asia/Kuwait': 'KW', 'Asia/Bahrain': 'BH',
  'Asia/Muscat': 'OM', 'Asia/Amman': 'JO', 'Asia/Beirut': 'LB', 'Asia/Baghdad': 'IQ', 'Asia/Tehran': 'IR', 'Asia/Singapore': 'SG', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW', 'Asia/Manila': 'PH', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID', 'Asia/Bangkok': 'TH',
  'Asia/Ho_Chi_Minh': 'VN', 'Asia/Saigon': 'VN', 'Asia/Dhaka': 'BD', 'Asia/Colombo': 'LK', 'Asia/Kathmandu': 'NP', 'Asia/Katmandu': 'NP', 'Asia/Jerusalem': 'IL',
  'Asia/Tel_Aviv': 'IL', 'Pacific/Auckland': 'NZ', 'America/Sao_Paulo': 'BR', 'America/Mexico_City': 'MX', 'America/Argentina/Buenos_Aires': 'AR', 'America/Buenos_Aires': 'AR',
  'America/Bogota': 'CO', 'America/Santiago': 'CL', 'America/Lima': 'PE', 'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'America/Montreal': 'CA', 'America/Regina': 'CA', 'America/St_Johns': 'CA', 'Pacific/Honolulu': 'US' };
const _US_TZ = /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Adak|Sitka|Nome|Yakutat|Metlakatla|Menominee|Indiana\/|Kentucky\/|North_Dakota\/)/;
function _tzIso() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (_TZ_ISO[tz]) return _TZ_ISO[tz];
    if (_US_TZ.test(tz)) return 'US';
    if (/^Australia\//.test(tz)) return 'AU';
  } catch (_) {}
  return '';
}
// "+91" / "91" / " +33 " → "+91"; garbage seen in user_profiles ("600026", "+919623292288", "1 8638442472") → ''.
function _normDial(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s()-]/g, '');
  return /^\+?\d{1,4}$/.test(s) && !/^\+?0/.test(s) ? '+' + s.replace(/^\+/, '') : '';
}
// ISO-2 code of the account country ("FR", "in", "UK") — '' when not a real region code.
function _validIso(raw) {
  let c = String(raw || '').trim().toUpperCase();
  if (c === 'UK') c = 'GB';
  if (!/^[A-Z]{2}$/.test(c)) return '';
  if (_ISO_DIAL[c]) return c;
  try { const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(c); return n && n !== c && !/unknown/i.test(n) ? c : ''; } catch (_) { return ''; }
}
function _isoName(iso) {
  try { const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(iso); if (n && n !== iso) return n; } catch (_) {}
  return '';
}
function _dialForIso(iso) { return iso && _ISO_DIAL[iso] ? '+' + _ISO_DIAL[iso] : ''; }
// Dial code the account implies: its phone_country_code, else its country.
function _accountDial(p) {
  if (!p) return '';
  return _normDial(p.phone_country_code != null ? p.phone_country_code : p.phoneCountryCode) || _dialForIso(_validIso(p.country));
}
// Stored code is not a user choice and may be replaced by the account's: auto-filled, or the legacy untouched "+1".
function _ccOverridable(code, source, accDial) {
  if (source === 'user') return false;
  if (source === 'account' || source === 'timezone' || source === 'default') return true;
  return _normDial(code) === '+1' && !!accDial && accDial !== '+1';   // legacy: only the untouched +1, only for a non-US account
}
function _setDialSelect(el, dial) {
  if (!el || !dial) return;
  el.value = dial;
  if (el.value !== dial) { const o = document.createElement('option'); o.value = dial; o.textContent = dial; el.appendChild(o); el.value = dial; }
}
let _ccSource = '';
if (typeof window !== 'undefined') window._aamCc = { _normDial, _validIso, _isoName, _dialForIso, _accountDial, _ccOverridable, _tzIso };

// Load saved configuration
async function loadConfig() {
  let config = {}, local = {};
  try {
    config = await chrome.storage.sync.get([
      'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode', 'phoneCountryCodeSource', 'city', 'gender',
      'yearsOfExperience', 'maxYearsRequired', 'blacklistKeywords', 'autoNextPage', 'skillYearsAsTotal', 'expectedSalary', 'currentSalary', 'dateOfBirth', 'postalCode',
      'noticePeriod', 'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense'
    ]);
    local = await chrome.storage.local.get(['resumeFile', 'resumeFileName']);
  } catch (e) {
    console.error('Failed to load config:', e);
  }

  document.getElementById('firstName').value = config.firstName || '';
  document.getElementById('lastName').value = config.lastName || '';
  document.getElementById('email').value = config.email || '';
  // v2.5.114 (live gate 2026-10-15): older versions stored the dial code without "+" ("33"). It matched no <option>,
  // the select showed blank and the next auto-save wrote "" over it (country code lost for every legacy user).
  {
    const ccEl = document.getElementById('phoneCountryCode');
    const rawCc = String(config.phoneCountryCode || '').trim();
    const normCc = /^\+?\d{1,4}$/.test(rawCc) ? '+' + rawCc.replace(/^\+/, '') : rawCc;
    if (normCc) {
      _setDialSelect(ccEl, normCc);   // unknown code: kept selectable rather than blank (a save must never erase it)
      _ccSource = config.phoneCountryCodeSource || '';
    } else {
      // v2.5.129: nothing stored → the browser time zone's code (the account's replaces it once signed in), never a blind +1.
      const tzDial = _dialForIso(_tzIso());
      _setDialSelect(ccEl, tzDial || '+1');
      _ccSource = tzDial ? 'timezone' : 'default';
    }
    // A code picked by hand is the user's: never replaced by the account / time zone afterwards.
    ccEl.addEventListener('change', () => { _ccSource = 'user'; });   // programmatic .value never fires change
  }
  document.getElementById('phone').value = config.phone || '';
  document.getElementById('city').value = config.city || '';
  const genderEl = document.getElementById('gender');
  if (genderEl) genderEl.value = config.gender || '';
  document.getElementById('yearsOfExperience').value = config.yearsOfExperience || '2';
  document.getElementById('maxYearsRequired').value = config.maxYearsRequired || '3';
  document.getElementById('expectedSalary').value = config.expectedSalary || '';
  const curSalEl = document.getElementById('currentSalary');
  if (curSalEl) curSalEl.value = config.currentSalary || '';
  const dobEl = document.getElementById('dateOfBirth');
  if (dobEl) dobEl.value = config.dateOfBirth || '';
  const pcEl = document.getElementById('postalCode');
  if (pcEl) pcEl.value = config.postalCode || '';
  document.getElementById('noticePeriod').value = config.noticePeriod || '';
  document.getElementById('blacklistKeywords').value = config.blacklistKeywords || '';
  // v2.5.92: on by default for new installs; a saved choice is always kept.
  document.getElementById('autoNextPage').checked = config.autoNextPage !== false;
  if (config.autoNextPage === undefined) { try { chrome.storage.sync.set({ autoNextPage: true }); } catch (_) {} }
  // v2.5.113 (Théo 2026-10-15): skill years questions answered with the total years — default ON.
  { const sy = document.getElementById('skillYearsAsTotal'); if (sy) sy.checked = config.skillYearsAsTotal !== false; }
  document.getElementById('visaSponsorship').value = config.visaSponsorship || 'no';
  document.getElementById('legallyAuthorized').value = config.legallyAuthorized || 'yes';
  document.getElementById('willingToRelocate').value = config.willingToRelocate || 'yes';
  document.getElementById('driversLicense').value = config.driversLicense || 'yes';

  if (local.resumeFileName) {
    document.getElementById('resumeFileName').textContent = local.resumeFileName;
    document.getElementById('resumeFileName').classList.add('has-file');
    document.getElementById('removeResumeBtn').style.display = 'inline-flex';
  }

  setupAutoSave();
}

// Auto-save indicator
let saveTimeout;
function showAutoSaveIndicator(saving = false) {
  const indicator = document.getElementById('autosave-indicator');
  indicator.classList.remove('show', 'saving');
  if (saving) {
    indicator.classList.add('saving', 'show');
    indicator.querySelector('span').textContent = 'Saving...';
  } else {
    indicator.classList.add('show');
    indicator.querySelector('span').textContent = 'Saved';
    setTimeout(() => { indicator.classList.remove('show'); }, 2000);
  }
}

// Auto-save configuration
async function saveConfig() {
  const config = {
    firstName: document.getElementById('firstName').value,
    lastName: document.getElementById('lastName').value,
    email: document.getElementById('email').value,
    phoneCountryCode: document.getElementById('phoneCountryCode').value,
    phoneCountryCodeSource: _ccSource,   // '' = legacy install, kept as is
    phone: document.getElementById('phone').value,
    city: document.getElementById('city').value,
    gender: document.getElementById('gender')?.value || '',
    yearsOfExperience: document.getElementById('yearsOfExperience').value,
    maxYearsRequired: document.getElementById('maxYearsRequired').value,
    expectedSalary: document.getElementById('expectedSalary').value,
    currentSalary: document.getElementById('currentSalary')?.value || '',
    dateOfBirth: document.getElementById('dateOfBirth')?.value || '',
    postalCode: (document.getElementById('postalCode')?.value || '').trim(),
    noticePeriod: document.getElementById('noticePeriod').value,
    blacklistKeywords: document.getElementById('blacklistKeywords').value,
    autoNextPage: document.getElementById('autoNextPage').checked,
    skillYearsAsTotal: document.getElementById('skillYearsAsTotal') ? document.getElementById('skillYearsAsTotal').checked : true,
    visaSponsorship: document.getElementById('visaSponsorship').value,
    legallyAuthorized: document.getElementById('legallyAuthorized').value,
    willingToRelocate: document.getElementById('willingToRelocate').value,
    driversLicense: document.getElementById('driversLicense').value
  };
  showAutoSaveIndicator(true);
  await chrome.storage.sync.set(config);
  showAutoSaveIndicator(false);
}

// Setup auto-save on all form fields
function setupAutoSave() {
  const inputFields = [
    'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode',
    'city', 'gender', 'yearsOfExperience', 'maxYearsRequired', 'expectedSalary', 'currentSalary', 'dateOfBirth', 'postalCode', 'blacklistKeywords',
    'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense',
    'noticePeriod' // 2026-10-15: was missing — typing a notice period was only saved when another field changed
  ];
  inputFields.forEach(fieldId => {
    const field = document.getElementById(fieldId);
    if (field) {
      field.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => { saveConfig(); }, 500);
      });
    }
  });
  const checkbox = document.getElementById('autoNextPage');
  if (checkbox) {
    checkbox.addEventListener('change', () => { saveConfig(); });
  }
  const syCb = document.getElementById('skillYearsAsTotal');
  if (syCb) syCb.addEventListener('change', () => { saveConfig(); });
}

// ─── Start automation (MULTI-SITE) ─────────────────────────────────────
document.getElementById('start-btn').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const site = detectSite(tab?.url);

    if (!site || site.key !== 'linkedin') {
      showToast('Auto-apply works on LinkedIn Easy Apply. On other sites, use Autofill or Track job.', 'info', 6000);
      return;
    }

    if (!isOnJobPage(tab.url, site)) {
      showToast(`Please navigate to the jobs page on ${site.name} first!`, 'warning', 6000);
      return;
    }

    if (!validateAllFields()) {
      // Switch to Personal Info tab so user sees the errors
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('[data-tab="personal"]')?.classList.add('active');
      document.getElementById('personal-tab')?.classList.add('active');
      showToast('Please fill in your personal information before starting', 'error');
      return;
    }

    console.log(`Injecting scripts for ${site.name} (${site.key})...`);

    // Use modular architecture for all sites
    await injectModularScripts(tab.id, site.key);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Send start message with adapter hint
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'start',
      adapter: site.key
    });

    if (response && response.success) {
      console.log('Bot started:', response.message);
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  } catch (error) {
    console.error('Start error:', error);
    showToast('Error starting bot. Please reload the page (F5) and try again.', 'error');
  }
});

// Stop automation
document.getElementById('stop-btn').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const site = detectSite(tab?.url);

    if (!site) {
      await chrome.storage.local.set({ isRunning: false });
      await loadRunningState();
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'stop' });
    if (response && response.success) {
      console.log('Bot stopped:', response.message);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  } catch (error) {
    console.error('Stop error:', error);
    await chrome.storage.local.set({ isRunning: false });
    await loadRunningState();
  }
});

// ─── v2.5.100: free plan — open questions left after Autofill ─────────
const AUTOFILL_UPSELL_URL = 'https://www.autoapplymax.com/dashboard?promo=WELCOMEBACK20&src=ext_autofill_free#upgrade';
function showAutofillPremiumHint(count, open) {
  try {
    document.getElementById('autofill-premium-hint')?.remove();
    const q = open === 1 ? '1 open question' : open + ' open questions';
    const box = buildAlert({
      id: 'autofill-premium-hint',
      tone: 'info',
      title: (count > 0 ? count + ' field' + (count === 1 ? '' : 's') + ' filled' : 'Form already filled') + ' · ' + q + ' left for you',
      body: 'Premium answers them with AI. You still review and submit.',
      link: { text: 'See Premium', url: AUTOFILL_UPSELL_URL },
    });
    box.querySelector('a')?.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'track-autofill-upsell-click', where: 'popup' }); } catch (_) {}
    });
    document.getElementById('alert-slot')?.prepend(box);
  } catch (_) {}
}

// ─── Autofill handler ────────────────────────────────────────────────
document.getElementById('autofill-btn').addEventListener('click', async () => {
  const btn = document.getElementById('autofill-btn');
  const originalHTML = btn.innerHTML;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.match(/^https?:\/\//)) {
      showToast('Cannot autofill on this page. Please open a website first.', 'warning');
      return;
    }

    // Read config from storage — include every field the AI prompt consumes
    const config = await chrome.storage.sync.get([
      'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode', 'city',
      'yearsOfExperience', 'expectedSalary', 'currentSalary', 'dateOfBirth', 'postalCode',
      'gender', 'visaSponsorship', 'legallyAuthorized', 'willingToRelocate',
      'driversLicense', 'noticePeriod', 'phoneCountryCodeSource',
    ]);

    if (!config.firstName && !config.email) {
      showToast('Please fill in at least your name or email in Personal Info first.', 'warning');
      return;
    }

    // v2.5.129: the account country wins over the dial code for "Country" fields, and an auto / untouched "+1"
    // gives way to the account's code (FR / IN users were filled as US: "+1…", "Paris, TX", "Based in US? Yes").
    {
      let ap = null;
      try { ap = (await chrome.storage.local.get(['accountProfile'])).accountProfile || null; } catch (_) {}
      const accIso = _validIso(ap && ap.country);
      const accDial = _accountDial(ap);
      if (accDial && _normDial(config.phoneCountryCode) !== accDial && _ccOverridable(config.phoneCountryCode, config.phoneCountryCodeSource, accDial)) config.phoneCountryCode = accDial;
      // "+1" chosen by nobody (no account, no time zone hint) → no code and no country rather than the US.
      if (!accDial && config.phoneCountryCodeSource === 'default') config.phoneCountryCode = '';
      if (accIso) config.country = _isoName(accIso) || '';
    }

    // Combine phone with country code — but ONLY if the phone doesn't already
    // start with a +, the country code digits, or "00". Old code blindly
    // prepended "33" onto "+33612345678" → "33+33612345678". Multi-site
    // audit 2026-08-14 caught this on Greenhouse + Lever fills.
    if (config.phone && config.phoneCountryCode) {
      const rawCC = String(config.phoneCountryCode).replace(/^\+/, '').trim();
      const rawPhone = String(config.phone).trim();
      const digitsOnly = rawPhone.replace(/[^\d]/g, '');
      const alreadyHasCC = rawPhone.startsWith('+') || rawPhone.startsWith('00') || digitsOnly.startsWith(rawCC);
      if (!alreadyHasCC) {
        // v2.5.118: a spaced local number keeps a space after the code ("6 12 34 56 78" → "+33 6 12 34 56 78";
        // live 2026-10-17 Lever / Ashby showed "+336 12 34 56 78").
        const local = rawPhone.replace(/^0+/, '').trim();
        config.phone = '+' + rawCC + (/[\s.-]/.test(local) ? ' ' : '') + local;
      } else if (!rawPhone.startsWith('+')) {
        // Phone starts with the country digits but no + prefix — add +
        config.phone = '+' + rawPhone.replace(/^00/, '');
      }
    }

    // v2.5.93: country for "Country" dropdowns/comboboxes, from the phone country code.
    {
      const CC = { '33': 'France', '91': 'India', '1': 'United States', '44': 'United Kingdom', '49': 'Germany', '34': 'Spain', '39': 'Italy', '32': 'Belgium', '41': 'Switzerland', '31': 'Netherlands', '351': 'Portugal', '352': 'Luxembourg', '212': 'Morocco', '216': 'Tunisia', '213': 'Algeria', '971': 'United Arab Emirates', '92': 'Pakistan', '61': 'Australia', '353': 'Ireland', '48': 'Poland' };
      const cc = String(config.phoneCountryCode || '').replace(/[^\d]/g, '');
      if (!config.country && CC[cc]) config.country = CC[cc];
      // v2.5.129: any other one-country code → its country (+1 stays United States via the table above).
      if (!config.country && cc) { const iso = Object.keys(_ISO_DIAL).find(k => _ISO_DIAL[k] === cc && !['UK', 'KZ', 'CA'].includes(k)); if (iso) config.country = _isoName(iso); }
    }

    // v2.5.119: dashboard Smart Profile values for settings left empty here (expected salary, city) — same fallback
    // as auto-apply (accountProfile, synced by the service worker). Empty on both sides stays empty (never invented).
    try {
      const { accountProfile } = await chrome.storage.local.get(['accountProfile']);
      if (accountProfile) {
        const es = String(accountProfile.expectedSalary || '').trim();
        if (!String(config.expectedSalary || '').trim() && /^\d[\d\s,.]*$/.test(es)) config.expectedSalary = String(Math.round(parseFloat(es.replace(/[\s,]/g, ''))));
        if (!String(config.city || '').trim() && accountProfile.city) config.city = String(accountProfile.city);
      }
    } catch (_) {}

    // Enrich with cvProfile data (Smart Profile from uploaded CV).
    try {
      const { cvProfile } = await chrome.storage.local.get(['cvProfile']);
      if (cvProfile) {
        if (cvProfile.linkedin) config.linkedinUrl = cvProfile.linkedin;
        if (cvProfile.website) config.portfolioUrl = cvProfile.website;
        if (cvProfile.experience && cvProfile.experience.length > 0) {
          const latest = _latestCvRole(cvProfile.experience) || cvProfile.experience[0];
          if (latest.company) config.currentCompany = latest.company;
          if (latest.title) config.currentTitle = latest.title;
        }
        // v2.5.92: never send a pasted job description as the candidate's summary.
        if (cvProfile.summary && !/\b(looking for (someone|a |an )|we(?:'re| are) (looking|hiring|seeking)|you will\b|must have\b|requirements?\b|responsibilities\b|required\b|the ideal candidate|job description)/i.test(cvProfile.summary)) config.summary = cvProfile.summary;
        // Full profile so the AI prompt can ground answers in real CV data
        config.cvProfile = {
          summary: cvProfile.summary,
          skills: cvProfile.skills,
          experience: cvProfile.experience,
          education: cvProfile.education,
          languages: cvProfile.languages,
          linkedin: cvProfile.linkedin,
          website: cvProfile.website,
        };
      }
    } catch (e) { /* cvProfile not available */ }

    // Show loading state
    btn.disabled = true;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="animation: spin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Filling...`;

    // Inject utils + ai-form first so autofill's AI fallback has access
    // to window.EAM.aiForm.askAI for unknown / date / open-ended fields.
    // allFrames:true handles SmartRecruiters / Workday / oneclick portals
    // that render the actual form inside an iframe — top-frame-only
    // injection gave "No fields detected" on Eurofins SmartRecruiters
    // (2026-08-13). The frame's own autofill listener responds; total
    // filled count is best-effort from top frame only.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['core/utils.js', 'core/ai-form.js']
      });
    } catch (e) { /* may already be injected */ }
    // v2.5.110: the auto-apply answer rules (years per skill, pay conversion) for the popup Autofill too.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['core/job-board-strings.js', 'core/form-filler.js']
      });
    } catch (e) { /* optional — autofill.js falls back to its own values */ }

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['core/autofill.js']
    });
    // v2.5.90: message exactly the frames we injected into. The old blind
    // 0..15 fan-out reached the top frame twice on Lever/Greenhouse, so every
    // form ran twice (2× AI calls, 2 tool_usage rows) — gate 2026-09-26.
    const frameIds = [...new Set((injected || []).map(r => r.frameId).filter(n => Number.isInteger(n)))];

    // Small delay to ensure script is loaded
    await new Promise(r => setTimeout(r, 200));

    // Send config to the injected script.
    // Fan-out to every frame so iframe-hosted forms (Greenhouse / Lever /
    // Ashby / SmartRecruiters) get filled — top-frame-only would miss the
    // 21/8/6 fields those pages hide behind iframes (multi-site audit
    // 2026-08-14). We iterate frameIds 0..15 with per-frame try/catch — this
    // uses the existing "tabs" permission and avoids adding the noisy
    // "webNavigation" permission which shows a "read browsing history"
    // warning to users at install.
    let count = 0;
    const perFrame = await Promise.all(
      (frameIds.length ? frameIds : [0]).map(async fid => {
        try {
          return (await chrome.tabs.sendMessage(tab.id, { action: 'eam-autofill', config }, { frameId: fid })) || {};
        } catch (_) { return {}; }
      })
    );
    count = perFrame.reduce((a, r) => a + (r.filled || 0), 0);
    // v2.5.100: open questions left empty because AI answers are Premium (a frame reports
    // them only when the AI was refused for the plan → never shown to Premium users).
    const openLeft = perFrame.reduce((a, r) => a + (r.premiumHint ? (r.openLeft || 0) : 0), 0);
    // v2.5.100: result state through a class with solid colours (white on #047857 / #475569).
    btn.disabled = false;
    btn.classList.remove('af-result-ok', 'af-result-none');
    const alreadyFilled = perFrame.reduce((a, r) => a + (r.alreadyFilled || 0), 0);
    btn.classList.add((count > 0 || alreadyFilled > 0) ? 'af-result-ok' : 'af-result-none');
    if (count === 0 && alreadyFilled > 0) {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Already filled`;
    } else if (count > 0) {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> ${count} field${count > 1 ? 's' : ''} filled`;
    } else {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 9v4M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/></svg> No fields found`;
    }
    if (openLeft > 0) showAutofillPremiumHint(count, openLeft);

    setTimeout(() => {
      btn.innerHTML = originalHTML;
      btn.classList.remove('af-result-ok', 'af-result-none');
      btn.disabled = false;
    }, 4000);

  } catch (error) {
    console.error('Autofill error:', error);
    showToast('Error running autofill. Make sure you are on a regular webpage.', 'error');
    btn.innerHTML = originalHTML;
    btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = '';
    btn.disabled = false;
  }
});

// Update button states
function updateButtons() {
  document.getElementById('start-btn').disabled = isRunning;
  document.getElementById('stop-btn').disabled = !isRunning;
}

// Update status display
function updateStatusDisplay(text, running) {
  const statusEl = document.getElementById('status');
  if (_pauseActive && running) return; // "Paused · resumes in ~N min" wins while paused
  if (currentSiteInfo) {
    // v2.5.117: the site name made the pill overflow next to the streak badge ("Running · L", live 2026-10-16) —
    // the site is already named under the Start button; it stays in the tooltip.
    statusEl.textContent = running ? 'Running' : text;
    statusEl.title = (running ? 'Running' : text) + ' · ' + currentSiteInfo.name;
  } else {
    statusEl.textContent = text;
  }
  statusEl.className = running ? 'status-value running'
    : /rate-limited|paused/i.test(text) ? 'status-value paused' : 'status-value stopped';
}

// Update status from storage
async function updateStatus() {
  const local = await chrome.storage.local.get(['appliedCount', 'skippedCount', 'appliedJobs', 'eam_skip_session']);
  // Use appliedJobs array length as source of truth, fallback to counter
  const jobsCount = (local.appliedJobs && local.appliedJobs.length) || local.appliedCount || 0;
  document.getElementById('applied-count').textContent = jobsCount;
  document.getElementById('skipped-count').textContent = local.skippedCount || 0;
  renderSkipBreakdown(local.eam_skip_session);
}

// ─── v2.5.96: why jobs were skipped (current / last run) ───────────────────
// Reason keys are written by core/utils.js noteSkip(); groups mirror
// utils.groupSkipReasons. EN + FR (browser UI language).
const SKIP_GROUPS = {
  applied: ['already_applied', 'applied_pane', 'applied_nomodal'],
  not_ea: ['not_easy_apply', 'no_apply_btn'],
  filters: ['blacklist', 'years_req', 'years_card'],
  questions: ['questions', 'form_invalid', 'btn_disabled'],
};
// v2.5.97: the rest of the popup is English-only — a French browser got ONE French
// line ("Ignorées pendant cette session…") inside an English popup (live 2026-10-03).
// Full i18n or English-only, never a mix: English until the whole popup is translated.
function popupLang() { return 'en'; }
const SKIP_COPY = {
  // [singular, plural]
  en: { lead: (n) => 'Skipped this run (' + n + '): ', applied: ['already applied', 'already applied'], not_ea: ['not Easy Apply', 'not Easy Apply'], filters: ['filtered by your settings', 'filtered by your settings'], questions: ['question not answered', 'questions not answered'], other: ['LinkedIn error', 'LinkedIn errors'],
    tip: 'Already-applied and non-Easy-Apply jobs are skipped on purpose. The skipped counter above counts every run since you installed or reset.' },
  fr: { lead: (n) => 'Ignorées pendant cette session (' + n + ') : ', applied: ['déjà postulée', 'déjà postulées'], not_ea: ['sans candidature simplifiée', 'sans candidature simplifiée'], filters: ['exclue par vos filtres', 'exclues par vos filtres'], questions: ['question sans réponse', 'questions sans réponse'], other: ['erreur LinkedIn', 'erreurs LinkedIn'],
    tip: 'Les offres déjà postulées ou sans candidature simplifiée sont ignorées volontairement. Le compteur au-dessus cumule toutes les sessions depuis l\'installation ou la remise à zéro.' },
};
function renderSkipBreakdown(sess) {
  const box = document.getElementById('run-skips');
  const txt = document.getElementById('run-skips-text');
  if (!box || !txt) return;
  if (!sess || !(sess.skipped > 0)) { box.hidden = true; return; }
  const g = { applied: 0, not_ea: 0, filters: 0, questions: 0, other: 0 };
  for (const [k, n] of Object.entries(sess.reasons || {})) {
    const grp = Object.keys(SKIP_GROUPS).find(x => SKIP_GROUPS[x].includes(k)) || 'other';
    g[grp] += Number(n) || 0;
  }
  const C = SKIP_COPY[popupLang()];
  txt.textContent = '';
  txt.appendChild(document.createTextNode(C.lead(sess.skipped)));
  const order = ['applied', 'not_ea', 'filters', 'questions', 'other'].filter(k => g[k] > 0);
  order.forEach((k, i) => {
    const b = document.createElement('b'); b.textContent = String(g[k]);
    txt.appendChild(b);
    txt.appendChild(document.createTextNode(' ' + C[k][g[k] > 1 ? 1 : 0] + (i < order.length - 1 ? ' · ' : '')));
  });
  box.title = C.tip;
  box.hidden = false;
  // v2.5.112: jobs skipped only because a setting is empty → say which one.
  const miss = sess.missing || {};
  const MISS_COPY = { expectedSalary: 'your expected salary', currentSalary: 'your current salary / CTC', postalCode: 'your postal code', dateOfBirth: 'your date of birth', gender: 'your gender' };
  const parts = Object.keys(MISS_COPY).filter(k => miss[k] > 0).map(k => miss[k] + ' asked ' + MISS_COPY[k]);
  if (parts.length) {
    const hint = document.createElement('span');
    hint.className = 'run-skips-missing';
    hint.textContent = ' — ' + parts.join(', ') + ': add it in Preferences to apply to these jobs.';
    txt.appendChild(hint);
  }
}

// Listen for updates from content script
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'updateCount') {
    document.getElementById('applied-count').textContent = request.count;
  } else if (request.type === 'updateSkippedCount') {
    document.getElementById('skipped-count').textContent = request.count;
  } else if (request.type === 'botStarted') {
    isRunning = true;
    updateButtons();
    updateStatusDisplay('Running', true);
  } else if (request.type === 'botStopped') {
    isRunning = false;
    updateButtons();
    updateStatusDisplay('Stopped', false);
  } else if (request.type === 'rateLimitStop') {
    isRunning = false;
    updateButtons();
    updateStatusDisplay('Rate-limited', false);
    showRateLimitBanner(request.message, 'warning');
  } else if (request.type === 'botActionableStop') {
    // Actionable stop reasons — unsupported layout / daily limit / rate limit.
    // Reuse the persistent rate-limit banner UI (same style + auto-persist)
    // so user sees the reason next time they open the popup, not just now.
    isRunning = false;
    updateButtons();
    updateStatusDisplay('Stopped', false);
    showRateLimitBanner(request.message, request.tone);
  }
});

// On popup open: show persistent actionable-stop banner if one was set
// while popup was closed (e.g. bot hit unsupported layout, user opens
// popup later wondering why nothing happened).
try {
  chrome.storage.local.get(['eam_actionable_stop_banner'], (data) => {
    const b = data.eam_actionable_stop_banner;
    if (!b || !b.message) return;
    // Auto-expire after 30 min so a stale reason doesn't confuse user later
    if (Date.now() - (b.ts || 0) > 30 * 60 * 1000) {
      chrome.storage.local.remove('eam_actionable_stop_banner');
      return;
    }
    renderRateLimitBanner({ message: b.message, ts: b.ts, tone: b.tone, reason: b.reason });
  });
} catch (e) {}

function showRateLimitBanner(message, tone) {
  // Persist the banner across popup re-opens by stashing it in storage —
  // popups close as soon as the user clicks elsewhere.
  const payload = { message, tone: tone || 'warning', ts: Date.now() };
  try { chrome.storage.local.set({ eam_rate_limit_banner: payload }); } catch (e) {}
  renderRateLimitBanner(payload);
}

function renderRateLimitBanner(payload) {
  if (!payload || !payload.message) return;
  // Auto-dismiss banners older than 30 minutes — by then the user has
  // probably already retried and we don't want a stale warning.
  if (Date.now() - (payload.ts || 0) > 30 * 60 * 1000) return;

  const isDaily = /daily/i.test(payload.message + ' ' + (payload.reason || ''));
  const tone = payload.tone === 'info' || isDaily ? 'info' : 'warning';
  const title = isDaily ? 'LinkedIn daily Easy Apply limit reached'
    : /unsupported|isn't supported/i.test(payload.message) ? 'This LinkedIn page isn\'t supported'
    : 'Auto-apply stopped';
  if (isDaily) payload = { ...payload, message: 'Try again tomorrow. Review your applications on your dashboard.' };
  // v2.5.96: the extension has no daily cap of its own — this is LinkedIn's
  // (~35 Easy Apply submissions per 24 h per account in 2026-09 telemetry),
  // the same on every AutoApplyMax plan.
  const existing = document.getElementById('eam-rate-limit-banner');
  if (existing) existing.remove();
  const banner = buildAlert({
    id: 'eam-rate-limit-banner',
    bodyId: 'eam-rate-limit-banner-text',
    tone,
    title,
    body: payload.message,
    action: isDaily ? { id: 'daily-see-dashboard', text: 'See dashboard', url: 'https://www.autoapplymax.com/dashboard.html#applications' } : null,
    onClose: () => { try { chrome.storage.local.remove(['eam_rate_limit_banner', 'eam_actionable_stop_banner']); } catch (e) {} },
  });
  const slot = document.getElementById('alert-slot');
  if (slot) slot.prepend(banner); else document.body.insertBefore(banner, document.body.firstChild);
  if (isDaily) maybeAddDailyPremium();
}

// v2.5.96: one Premium line under the daily-limit alert — signed-in FREE plan
// only, true claims only (Premium does not raise LinkedIn's daily limit).
// Called again once the profile has loaded (auth/plan resolve async).
const DAILY_PREMIUM_URL = 'https://www.autoapplymax.com/dashboard?promo=WELCOMEBACK20&src=ext_daily_limit#upgrade';
function maybeAddDailyPremium() {
  try {
    const banner = document.getElementById('eam-rate-limit-banner');
    if (!banner || document.getElementById('daily-premium')) return;
    if (!/daily/i.test(banner.querySelector('strong')?.textContent || '')) return;
    if (document.body.dataset.auth !== 'in' || document.body.dataset.plan !== 'free') return;
    const fr = popupLang() === 'fr';
    const box = document.createElement('div');
    box.id = 'daily-premium';
    box.className = 'alert-premium';
    box.textContent = fr
      ? 'Premium : l\'IA répond aux questions de présélection pendant l\'auto-candidature, 30 crédits IA/mois pour adapter CV et lettres, remplissage IA sur 100+ portails ATS (vous validez l\'envoi). La limite quotidienne de LinkedIn est la même pour tous les forfaits.'
      : 'Premium: AI answers screening questions during auto-apply, 30 AI credits/month for tailored resumes & cover letters, AI autofill on 100+ ATS portals (you submit). LinkedIn\'s daily limit is the same on every plan.';
    const wrap = document.createElement('div');
    wrap.className = 'alert-action';
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'daily-premium-btn'; b.className = 'btn btn-primary btn-sm';
    b.textContent = fr ? 'Passer Premium — -20 % sur le 1er paiement' : 'Get Premium — 20% off your first payment';
    b.addEventListener('click', () => chrome.tabs.create({ url: DAILY_PREMIUM_URL }));
    wrap.appendChild(b);
    box.appendChild(wrap);
    banner.querySelector('.alert-body')?.appendChild(box);
  } catch (_) {}
}

// Re-render any pending rate-limit banner on popup open
(async () => {
  try {
    const { eam_rate_limit_banner } = await chrome.storage.local.get('eam_rate_limit_banner');
    if (eam_rate_limit_banner) renderRateLimitBanner(eam_rate_limit_banner);
  } catch (e) {}
})();

// Update status (counters) every 2 seconds
setInterval(async () => { await updateStatus(); await renderRunExtras(); }, 2000);

// Export jobs to CSV
document.getElementById('export-csv-btn').addEventListener('click', async () => {
  try {
    const local = await chrome.storage.local.get(['appliedJobs']);
    const jobs = local.appliedJobs || [];
    if (jobs.length === 0) {
      showToast('No jobs applied yet. Start the bot first!', 'info');
      return;
    }
    const csvContent = convertToCSV(jobs);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `autoapplymax_jobs_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    const btn = document.getElementById('export-csv-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Exported ${jobs.length} jobs!`;
    btn.style.background = '#059669'; btn.style.color = '#fff'; btn.style.borderColor = '#059669';
    setTimeout(() => { btn.innerHTML = originalHTML; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }, 3000);
  } catch (error) {
    console.error('Export error:', error);
    showToast('Error exporting jobs: ' + error.message, 'error');
  }
});

// Reset counters
document.getElementById('reset-counters-btn').addEventListener('click', async () => {
  if (!confirm('Reset all counters and clear applied jobs list?')) return;
  try {
    await chrome.storage.local.set({ appliedCount: 0, skippedCount: 0, appliedJobs: [] });
    try { await chrome.storage.local.remove('eam_skip_session'); renderSkipBreakdown(null); } catch (_) {}
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab.url) {
        await chrome.tabs.sendMessage(tab.id, { action: 'resetCounters' });
      }
    } catch (e) {
      console.log('Content script not available, counters reset in storage only');
    }
    document.getElementById('applied-count').textContent = '0';
    document.getElementById('skipped-count').textContent = '0';
    const btn = document.getElementById('reset-counters-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Reset!`;
    btn.style.background = '#059669'; btn.style.color = '#fff'; btn.style.borderColor = '#059669';
    setTimeout(() => { btn.innerHTML = originalHTML; btn.style.background = ''; btn.style.color = ''; btn.style.borderColor = ''; }, 2000);
  } catch (error) {
    console.error(error);
  }
});

// Convert jobs to CSV (now with source column)
function convertToCSV(jobs) {
  const headers = ['Date', 'Job Title', 'Company', 'Source', 'Link'];
  const rows = jobs.map(job => [
    new Date(job.date).toLocaleString(),
    `"${(job.title || '').replace(/"/g, '""')}"`,
    `"${(job.company || '').replace(/"/g, '""')}"`,
    job.source || 'linkedin',
    job.link
  ]);
  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
}

// Load and display applied jobs (with source badge)
async function loadAppliedJobs() {
  try {
    const { appliedJobs = [] } = await chrome.storage.local.get(['appliedJobs']);
    const listContainer = document.getElementById('applied-jobs-list');
    const countElement = document.getElementById('applied-jobs-count');
    countElement.textContent = appliedJobs.length;

    if (appliedJobs.length === 0) {
      listContainer.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 6H16V4C16 2.89543 15.1046 2 14 2H10C8.89543 2 8 2.89543 8 4V6H4C2.89543 6 2 6.89543 2 8V19C2 20.1046 2.89543 21 4 21H20C21.1046 21 22 20.1046 22 19V8C22 6.89543 21.1046 6 20 6Z" stroke="currentColor" stroke-width="2"/>
            <path d="M8 6V4H16V6" stroke="currentColor" stroke-width="2"/>
            <path d="M12 11V17M9 14H15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <p>No applications yet</p>
          <small>Start applying to see your job applications here</small>
        </div>
      `;
      return;
    }

    // v2.5.92: the 3 latest here — the full list lives on the dashboard.
    const sortedJobs = [...appliedJobs].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 3);
    listContainer.innerHTML = sortedJobs.map(job => {
      const source = job.source || 'linkedin';
      const siteInfo = SUPPORTED_SITES[source] || { name: source, color: '#666' };
      return `
      <div class="job-card">
        <div class="job-card-header">
          <div>
            <h4 class="job-title">${escapeHtml(job.title)}</h4>
            <p class="job-company">${escapeHtml(job.company)}</p>
            ${job.location ? `<p class="job-location">${escapeHtml(job.location)}</p>` : ''}
          </div>
          <div style="text-align:right">
            <span style="display:inline-block;padding:2px 6px;border-radius:8px;font-size:10px;font-weight:600;color:#fff;background:${siteInfo.color}">${siteInfo.name}</span>
            <br><span class="job-time">${formatTimeAgo(job.date)}</span>
          </div>
        </div>
        <a href="${escapeHtml(/^https?:\/\//i.test(String(job.link || '')) ? job.link : '#').replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer" class="job-link">
          View on ${siteInfo.name}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </a>
      </div>`;
    }).join('');
  } catch (error) {
    console.error('Error loading applied jobs:', error);
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Format time ago
function formatTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

// Clear all applied jobs
document.getElementById('clear-applied-jobs')?.addEventListener('click', async () => {
  if (!confirm('Clear all applied jobs from the list? This cannot be undone.')) return;
  try {
    await chrome.storage.local.set({ appliedJobs: [] });
    loadAppliedJobs();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'clearAppliedJobs' });
      } catch (e) {}
    }
  } catch (error) {
    console.error('Error clearing applied jobs:', error);
  }
});

// Resume upload functionality
function setupResumeUpload() {
  const fileInput = document.getElementById('resumeFile');
  const uploadBtn = document.getElementById('uploadResumeBtn');
  const fileName = document.getElementById('resumeFileName');
  const removeBtn = document.getElementById('removeResumeBtn');

  uploadBtn.addEventListener('click', () => { fileInput.click(); });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast('File too large! Please upload a file smaller than 5MB.');
      return;
    }
    const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowedTypes.includes(file.type)) {
      showToast('Invalid file type! Please upload PDF, DOC, or DOCX files only.');
      return;
    }
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64 = event.target.result;
        await chrome.storage.local.set({ resumeFile: base64, resumeFileName: file.name, resumeFileType: file.type });
        fileName.textContent = file.name;
        fileName.classList.add('has-file');
        removeBtn.style.display = 'inline-flex';
        showAutoSaveIndicator(false);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error('Error uploading resume:', error);
      showToast('Error uploading file. Please try again.');
    }
  });

  removeBtn.addEventListener('click', async () => {
    if (!confirm('Remove uploaded resume?')) return;
    try {
      await chrome.storage.local.remove(['resumeFile', 'resumeFileName', 'resumeFileType']);
      fileName.textContent = 'No file chosen';
      fileName.classList.remove('has-file');
      removeBtn.style.display = 'none';
      fileInput.value = '';
    } catch (error) {
      console.error('Error removing resume:', error);
    }
  });
}

// ─── Auth state detection ───────────────────────────────────────────────
async function checkAuthState() {
  try {
    let { eam_session } = await chrome.storage.local.get(['eam_session']);
    if (!eam_session || !eam_session.access_token) {
      showLoggedOutState();
      return;
    }

    const userId = eam_session.user_id || eam_session.user?.id;
    if (!userId) {
      showLoggedOutState();
      return;
    }

    const fetchProfile = (token) => fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=plan,ai_credits_used,ai_credits_total,credits_reset_date,email,first_name,last_name,phone,phone_country_code,city,country,years_of_experience,expected_salary`,
      { headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY } }
    );

    let res = await fetchProfile(eam_session.access_token);

    // Access token expired (Supabase default TTL is 1h). Ask the background
    // service worker to refresh via the stored refresh_token before
    // dropping the user back to a logged-out state — fixes the prior
    // behavior where every hour the popup forced a re-login.
    if (res.status === 401) {
      const refreshed = await new Promise(r => {
        chrome.runtime.sendMessage({ type: 'refreshToken' }, r);
      });
      if (refreshed?.access_token) {
        eam_session = refreshed;
        res = await fetchProfile(refreshed.access_token);
      }
    }

    if (res.status === 401) {
      showLoggedOutState();
      return;
    }

    const data = await res.json();
    const profile = data && data.length > 0 ? data[0] : null;

    if (profile) {
      // Check monthly credit reset
      const resetDate = profile.credits_reset_date ? new Date(profile.credits_reset_date) : null;
      const now = new Date();
      const needsReset = !resetDate ||
        resetDate.getUTCFullYear() < now.getUTCFullYear() ||
        resetDate.getUTCMonth() < now.getUTCMonth();

      if (needsReset && profile.plan !== 'unlimited') {
        const plan = profile.plan || 'free';
        // v2.5.129: free = 1 credit / month since 2026-10-06 (the server trigger enforces it; display only).
        const monthlyTotal = plan === 'premium' ? 30 : 1;
        profile.ai_credits_used = 0;
        profile.ai_credits_total = monthlyTotal;
        // Reset on server
        fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${eam_session.access_token}`,
            'apikey': SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            ai_credits_used: 0,
            ai_credits_total: monthlyTotal,
            credits_reset_date: now.toISOString()
          })
        }).catch(e => console.warn('Credit reset failed:', e));
      }
      showLoggedInState(profile, eam_session);
      // v2.5.129: country / dial code for autofill and auto-apply, without waiting for the service-worker sync.
      try {
        const { accountProfile: ap0 } = await chrome.storage.local.get(['accountProfile']);
        await chrome.storage.local.set({ accountProfile: Object.assign({}, ap0 || {}, { country: profile.country || '', phoneCountryCode: profile.phone_country_code || '' }) });
      } catch (_) {}
      prefillFromAccount(profile, eam_session);
    } else {
      // Profile exists in auth but no user_profiles row yet
      showLoggedInState({
        email: eam_session.user?.email || eam_session.email || '',
        first_name: '',
        plan: 'free',
        ai_credits_used: 0,
        ai_credits_total: 1
      }, eam_session);
    }
  } catch (e) {
    console.log('Auth check failed:', e);
    showLoggedOutState();
  }
}

// v2.5.92: "Your info" pre-filled from the AutoApplyMax account — only the
// fields still empty in this browser; a value the user typed is never
// overwritten. Runs after sign-in and from the onboarding "fill your info" step.
async function prefillFromAccount(profile, session) {
  try {
    if (!profile) return 0;
    const saved = await chrome.storage.sync.get(['firstName', 'lastName', 'email', 'phone', 'city', 'yearsOfExperience', 'expectedSalary', 'phoneCountryCode', 'phoneCountryCodeSource']);
    const digits = String(profile.phone || '').replace(/\D/g, '');
    const map = {
      firstName: profile.first_name,
      lastName: profile.last_name,
      email: profile.email || session?.user?.email || session?.email,
      phone: digits.length >= 7 && digits.length <= 15 ? digits : '',
      city: profile.city,
      yearsOfExperience: profile.years_of_experience != null && profile.years_of_experience !== '' ? String(profile.years_of_experience) : '',
      // v2.5.112 (telemetry 2026-10-13): the dashboard Smart Profile "expected salary" never reached the extension →
      // every salary question skipped although the user had set it there. Digits only (the field is numeric).
      expectedSalary: /^\s*\d[\d\s,.]*$/.test(String(profile.expected_salary || '')) ? String(Math.round(parseFloat(String(profile.expected_salary).replace(/[\s,]/g, '')))) : '',
    };
    let filled = 0;
    for (const [id, val] of Object.entries(map)) {
      const v = String(val || '').trim();
      if (!v || String(saved[id] || '').trim()) continue;
      const el = document.getElementById(id);
      if (el) { el.value = v; filled++; }
    }
    // v2.5.129: phone country code from the account (phone_country_code, else its country) unless the user picked one.
    // Decided on the STORED value (the popup form may be older than storage); only these two keys are written —
    // a full saveConfig() from a stale form overwrote settings written meanwhile (fixture S1 2026-10-26: email wiped).
    let ccWrite = null;
    {
      const ccEl = document.getElementById('phoneCountryCode');
      const accDial = _accountDial(profile);
      const storedCc = _normDial(saved.phoneCountryCode);
      const cur = storedCc || (ccEl ? ccEl.value : '');
      const src = storedCc ? (saved.phoneCountryCodeSource || '') : _ccSource;
      if (ccEl && accDial && (cur !== accDial ? _ccOverridable(cur, src, accDial) : (src === 'timezone' || src === 'default' || !storedCc))) {
        _setDialSelect(ccEl, accDial); _ccSource = 'account';
        ccWrite = { phoneCountryCode: accDial, phoneCountryCodeSource: 'account' };
      } else if (ccEl && storedCc && src !== _ccSource && src) {
        _setDialSelect(ccEl, storedCc); _ccSource = src;   // storage changed since the form loaded
      }
    }
    if (filled) await saveConfig();
    else if (ccWrite) await chrome.storage.sync.set(ccWrite);
    return filled + (ccWrite ? 1 : 0);
  } catch (_) { return 0; }
}
window.prefillFromAccount = prefillFromAccount;
// Used by the onboarding "Fill my info" step.
window.prefillFromAccountFromSession = async function () {
  try {
    const { eam_session } = await chrome.storage.local.get(['eam_session']);
    const uid = eam_session && (eam_session.user_id || eam_session.user?.id);
    if (!uid || !eam_session.access_token) return 0;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${uid}&select=email,first_name,last_name,phone,phone_country_code,country,city,years_of_experience,expected_salary`,
      { headers: { 'Authorization': `Bearer ${eam_session.access_token}`, 'apikey': SUPABASE_ANON_KEY } });
    if (!r.ok) return 0;
    const rows = await r.json();
    return rows && rows[0] ? prefillFromAccount(rows[0], eam_session) : 0;
  } catch (_) { return 0; }
};

// Local Premium price, same rule as the site (localizePrices): India → ₹,
// eurozone → €, else $. Country from the profile when signed in, otherwise
// guessed from the browser time zone. Display only — checkout prices are
// always decided server-side by the site.
const EUR_COUNTRIES = new Set(['AT','BE','CY','DE','EE','ES','FI','FR','GR','HR','IE','IT','LT','LU','LV','MT','NL','PT','SI','SK','AD','MC','SM','VA']);
const EUR_TZ = /^Europe\/(Vienna|Brussels|Nicosia|Berlin|Tallinn|Madrid|Helsinki|Paris|Athens|Zagreb|Dublin|Rome|Vilnius|Luxembourg|Riga|Malta|Amsterdam|Lisbon|Ljubljana|Bratislava|Andorra|Monaco|San_Marino|Vatican)$/;
function guessCountryFromTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IN';
    if (EUR_TZ.test(tz)) return 'FR'; // any eurozone country → € price
  } catch (_) {}
  return '';
}
let _localPriceCountry = '';
function localPremiumPrice(country) {
  const c = String(country || _localPriceCountry || guessCountryFromTimeZone() || '').toUpperCase();
  return c === 'IN' ? '₹299' : EUR_COUNTRIES.has(c) ? '€6.99' : '$6.99';
}
function applyLocalPremiumPrice(country) {
  if (country) _localPriceCountry = String(country).toUpperCase();
  const price = localPremiumPrice(country);
  const el = document.getElementById('premium-price');
  if (el) el.textContent = price;
  // 2.5.122: every other price already on screen (Premium notices) follows the same currency.
  try { document.querySelectorAll('#ai-premium-notice a, #ai-premium-notice button').forEach(b => { if (/[$€₹]\s?\d/.test(b.textContent)) b.textContent = b.textContent.replace(/[$€₹]\s?[\d.,]+/, price); }); } catch (_) {}
}

function showLoggedOutState() {
  const headerRight = document.getElementById('header-right');
  const premiumCard = document.getElementById('premium-card');
  const dashLinkRow = document.querySelector('.dash-block-row');

  document.body.dataset.auth = 'out';
  document.body.dataset.plan = 'free';
  // v2.5.96: the in-page daily-limit Premium line reads the cached plan —
  // signed-out means unknown, never "free".
  try { chrome.storage.local.remove('plan'); } catch (_) {}
  if (headerRight) {
    headerRight.innerHTML = '<button id="header-sign-in-btn" class="header-sign-in">Sign in</button>';
    document.getElementById('header-sign-in-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://www.autoapplymax.com/auth.html?src=ext_popup' });
    });
  }
  if (premiumCard) premiumCard.style.display = '';
  if (dashLinkRow) dashLinkRow.style.display = 'none';
  applyLocalPremiumPrice('');
}

function showLoggedInState(profile, session) {
  const headerRight = document.getElementById('header-right');
  const premiumCard = document.getElementById('premium-card');
  const dashLinkRow = document.querySelector('.dash-block-row');

  const email = profile.email || session?.user?.email || session?.email || '';
  const plan = (profile.plan || 'free').toLowerCase();
  const firstName = profile.first_name || '';
  const initial = (firstName || email || 'U').charAt(0).toUpperCase();
  const planLabels = { free: 'Free', premium: 'Premium', unlimited: 'Unlimited' };
  const planLabel = planLabels[plan] || 'Free';
  const creditsUsed = profile.ai_credits_used || 0;
  const creditsTotal = profile.ai_credits_total || (plan === 'premium' ? 30 : 1);   // v2.5.129: free = 1 / month
  const creditsLeft = Math.max(0, creditsTotal - creditsUsed);
  document.body.dataset.auth = 'in';
  document.body.dataset.plan = plan;

  if (headerRight) {
    const creditsHtml = plan !== 'unlimited'
      ? `<span class="header-credits" title="AI credits left this month">${creditsLeft} AI credit${creditsLeft !== 1 ? 's' : ''}</span>`
      : '';
    headerRight.innerHTML = `${creditsHtml}<a href="#" class="header-plan-badge" id="header-plan-link">${planLabel}</a>`;
    // Free → the upgrade section; paid → the same section, which shows the
    // current plan + "Manage subscription" (Stripe portal).
    document.getElementById('header-plan-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://www.autoapplymax.com/dashboard?section=upgrade&src=' + (plan === 'free' ? 'ext_badge' : 'ext_badge_manage') });
    });
    document.getElementById('header-plan-link')?.setAttribute('title', plan === 'free' ? 'See Premium plans' : 'Manage your subscription');
  }
  applyLocalPremiumPrice(profile.country);
  try { chrome.storage.local.set({ plan }); } catch (_) {}
  maybeAddDailyPremium();

  // Show AI links for logged-in users
  if (dashLinkRow) dashLinkRow.style.display = '';

  // Hide premium card for paid users (pro, premium, unlimited)
  if (premiumCard) {
    premiumCard.style.display = (plan === 'free') ? '' : 'none';
  }

}

// Listen for session changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.eam_session) {
    checkAuthState();
  }
});

// ─── LinkedIn Easy Apply search URL ──────────────────────────────────────
async function buildLinkedInSearchUrl() {
  const u = new URL('https://www.linkedin.com/jobs/search/');
  u.searchParams.set('f_AL', 'true');
  u.searchParams.set('sortBy', 'DD');
  try {
    const { cvProfile } = await chrome.storage.local.get(['cvProfile']);
    const { city } = await chrome.storage.sync.get(['city']);
    const role = (cvProfile && (cvProfile.targetRole || cvProfile.target_role || cvProfile.title ||
      (Array.isArray(cvProfile.experience) && (_latestCvRole(cvProfile.experience) || {}).title))) || '';
    if (role && String(role).length <= 60) u.searchParams.set('keywords', String(role).trim());
    if (city && String(city).length <= 60) u.searchParams.set('location', String(city).trim());
  } catch (_) {}
  return u.toString();
}
window.buildLinkedInSearchUrl = buildLinkedInSearchUrl;

// ─── Dashboard link handlers ────────────────────────────────────────────
function setupDashboardLinks() {
  const BASE_URL = 'https://www.autoapplymax.com';
  const links = {
    'link-dashboard': '/dashboard.html',
    'link-applications': '/dashboard.html#applications',
    'link-ai-resume': '/dashboard.html#cv-generator',
    'link-ats-score': '/dashboard.html#ats-checker',
    'view-dashboard-applications': '/dashboard.html#applications',
    'link-dashboard-logo': '/dashboard.html',
    'header-sign-in-btn': '/auth.html?src=ext_popup',
    'signin-card-btn': '/auth.html?mode=signup&src=ext_popup',
    'signin-card-login': '/auth.html?src=ext_popup'
  };

  // Easy Apply filter on — the layout auto-apply is built for.
  // v2.5.92: prefilled with the target role from the synced CV profile and
  // the city from "Your info" when known; Easy Apply filter on, newest first.
  document.getElementById('open-linkedin-search')?.addEventListener('click', async (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: await buildLinkedInSearchUrl() });
  });

  for (const [id, path] of Object.entries(links)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: BASE_URL + path });
    });
  }

  // Premium card upgrade link
  // 2026-09-18 (checkout-drop instrumentation): route to /premium?src=ext_popup
  // instead of /dashboard#upgrade so pricing_viewed fires with source
  // attribution (the ext popup used to be entirely dark to PostHog per fork
  // audit). No direct posthog.capture() here because the site pixel doesn't
  // run inside the popup; premium.html reads `?src=ext_popup` and forwards
  // the source into its own pricing_viewed event.
  const upgradeLink = document.getElementById('premium-upgrade-link');
  if (upgradeLink) {
    upgradeLink.addEventListener('click', (e) => {
      e.preventDefault();
      // Signed in → the dashboard upgrade section (the funnel's upgrade page,
      // src kept for attribution); signed out → the public /premium page.
      const signedIn = document.body.dataset.auth === 'in';
      chrome.tabs.create({ url: BASE_URL + (signedIn ? '/dashboard?section=upgrade&src=ext_card' : '/premium?src=ext_card') });
    });
  }

  // Premium feature links
  document.querySelectorAll('.premium-feature-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const section = link.dataset.section;
      if (section) {
        chrome.tabs.create({ url: `https://www.autoapplymax.com/dashboard.html#${section}` });
      }
    });
  });
}

// v2.5.115: most recent CV role (ongoing first, then the latest year in its dates) — CVs listed oldest-first used to
// give their first (oldest) entry as the current title. Same rule as FormFiller.latestCvRole, simplified.
function _latestCvRole(exp) {
  const list = (Array.isArray(exp) ? exp : []).filter(e => e && (e.title || e.company));
  if (!list.length) return null;
  const NOW = /present|current|now\b|today|aujourd|actuel|en cours|ongoing|actualidad|heute/i;
  const score = (e) => {
    const end = String(e.endDate || e.end || e.to || '');
    const dur = String(e.duration || e.dates || e.period || '').split(/\s*\|\s*/)[0];
    const ongoing = NOW.test(end) || (!end && NOW.test(dur.split(/\s*(?:–|—|-|to|à|au|until)\s+/i).pop() || ''));
    const years = (end + ' ' + dur).match(/\b(19|20)\d{2}\b/g) || [];
    return (ongoing ? 1e6 : 0) + (years.length ? Math.max(...years.map(Number)) : 0);
  };
  return list.map((e, i) => ({ e, i, s: score(e) })).sort((a, b) => (b.s - a.s) || (a.i - b.i))[0].e;
}
