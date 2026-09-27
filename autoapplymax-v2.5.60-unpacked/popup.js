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
async function loadSupabaseConfig() {
  try {
    const cached = await chrome.storage.local.get(['supabase_config_cached', 'supabase_config_cached_at']);
    const age = Date.now() - (cached.supabase_config_cached_at || 0);
    if (cached.supabase_config_cached && age < SUPABASE_CONFIG_TTL_MS) {
      SUPABASE_URL = cached.supabase_config_cached.url;
      SUPABASE_ANON_KEY = cached.supabase_config_cached.anon_key;
      return;
    }
  } catch (e) {}
  try {
    const res = await fetch(SUPABASE_CONFIG_URL, { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg && cfg.url && cfg.anon_key) {
        SUPABASE_URL = cfg.url;
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

function extractJobTitleFromPageTitle(title) {
  if (!title) return '';
  const separators = [' | ', ' - ', ' – ', ' — ', ' at ', ' @ '];
  let extracted = title;
  for (const sep of separators) {
    const idx = extracted.indexOf(sep);
    if (idx > 0) {
      extracted = extracted.substring(0, idx).trim();
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
async function initTrackSection(tab) {
  const section = document.getElementById('track-section');
  const detected = document.getElementById('track-detected');
  const already = document.getElementById('track-already');
  const auto = document.getElementById('track-auto');

  if (!section || !tab?.url) return;

  // Hide for non-HTTP pages
  if (!tab.url.startsWith('http')) return;

  // Hide on our own site
  if (/autoapplymax\.com/i.test(tab.url)) return;

  const site = detectSite(tab.url);

  // On supported auto-apply sites, no need to show tracking info
  if (site && site.key !== 'manual') {
    return;
  }

  // Check if URL already tracked
  const { appliedJobs = [] } = await chrome.storage.local.get(['appliedJobs']);
  const normalized = normalizeUrl(tab.url);
  const alreadyTracked = appliedJobs.some(j => normalizeUrl(j.link) === normalized);

  if (alreadyTracked) {
    section.style.display = 'block';
    already.style.display = 'flex';
    return;
  }

  // Show tracking form with auto-fill
  section.style.display = 'block';
  detected.style.display = 'block';

  const titleInput = document.getElementById('track-title');
  const companyInput = document.getElementById('track-company');
  const trackBtn = document.getElementById('track-btn');
  if (!titleInput || !companyInput || !trackBtn) return;

  titleInput.value = extractJobTitleFromPageTitle(tab.title);
  companyInput.value = extractCompanyFromUrl(tab.url);

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

    // Switch to "already tracked" state
    detected.style.display = 'none';
    already.style.display = 'flex';

    showToast('Application tracked!', 'success');
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

  // Detect current site and update badge + init track section
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const site = detectSite(tab?.url);
    updateSiteBadge(site);
    await initTrackSection(tab);
  } catch (e) {}
});

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

// Load saved configuration
async function loadConfig() {
  let config = {}, local = {};
  try {
    config = await chrome.storage.sync.get([
      'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode', 'city', 'gender',
      'yearsOfExperience', 'maxYearsRequired', 'blacklistKeywords', 'autoNextPage', 'expectedSalary',
      'noticePeriod', 'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense'
    ]);
    local = await chrome.storage.local.get(['resumeFile', 'resumeFileName']);
  } catch (e) {
    console.error('Failed to load config:', e);
  }

  document.getElementById('firstName').value = config.firstName || '';
  document.getElementById('lastName').value = config.lastName || '';
  document.getElementById('email').value = config.email || '';
  document.getElementById('phoneCountryCode').value = config.phoneCountryCode || '+1';
  document.getElementById('phone').value = config.phone || '';
  document.getElementById('city').value = config.city || '';
  const genderEl = document.getElementById('gender');
  if (genderEl) genderEl.value = config.gender || '';
  document.getElementById('yearsOfExperience').value = config.yearsOfExperience || '2';
  document.getElementById('maxYearsRequired').value = config.maxYearsRequired || '3';
  document.getElementById('expectedSalary').value = config.expectedSalary || '';
  document.getElementById('noticePeriod').value = config.noticePeriod || '';
  document.getElementById('blacklistKeywords').value = config.blacklistKeywords || '';
  document.getElementById('autoNextPage').checked = config.autoNextPage !== false;
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
    phone: document.getElementById('phone').value,
    city: document.getElementById('city').value,
    gender: document.getElementById('gender')?.value || '',
    yearsOfExperience: document.getElementById('yearsOfExperience').value,
    maxYearsRequired: document.getElementById('maxYearsRequired').value,
    expectedSalary: document.getElementById('expectedSalary').value,
    noticePeriod: document.getElementById('noticePeriod').value,
    blacklistKeywords: document.getElementById('blacklistKeywords').value,
    autoNextPage: document.getElementById('autoNextPage').checked,
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
    'city', 'gender', 'yearsOfExperience', 'maxYearsRequired', 'expectedSalary', 'blacklistKeywords',
    'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense'
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
}

// ─── Start automation (MULTI-SITE) ─────────────────────────────────────
document.getElementById('start-btn').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const site = detectSite(tab?.url);

    if (!site || site.key !== 'linkedin') {
      showToast('Auto-apply works on LinkedIn only. Use Autofill for other sites!', 'info', 6000);
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
      'yearsOfExperience', 'expectedSalary',
      'gender', 'visaSponsorship', 'legallyAuthorized', 'willingToRelocate',
      'driversLicense', 'noticePeriod',
    ]);

    if (!config.firstName && !config.email) {
      showToast('Please fill in at least your name or email in Personal Info first.', 'warning');
      return;
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
        config.phone = '+' + rawCC + rawPhone.replace(/^0+/, '');
      } else if (!rawPhone.startsWith('+')) {
        // Phone starts with the country digits but no + prefix — add +
        config.phone = '+' + rawPhone.replace(/^00/, '');
      }
    }

    // Enrich with cvProfile data (Smart Profile from uploaded CV).
    try {
      const { cvProfile } = await chrome.storage.local.get(['cvProfile']);
      if (cvProfile) {
        if (cvProfile.linkedin) config.linkedinUrl = cvProfile.linkedin;
        if (cvProfile.website) config.portfolioUrl = cvProfile.website;
        if (cvProfile.experience && cvProfile.experience.length > 0) {
          const latest = cvProfile.experience[0];
          if (latest.company) config.currentCompany = latest.company;
          if (latest.title) config.currentTitle = latest.title;
        }
        if (cvProfile.summary) config.summary = cvProfile.summary;
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

    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['core/autofill.js']
    });

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
      Array.from({ length: 16 }, (_, fid) => fid).map(async fid => {
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { action: 'eam-autofill', config }, { frameId: fid });
          return r?.filled || 0;
        } catch (_) { return 0; }
      })
    );
    count = perFrame.reduce((a, b) => a + b, 0);
    if (count > 0) {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> ${count} field${count > 1 ? 's' : ''} filled!`;
      btn.style.background = '#059669';
    } else {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 9v4M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/></svg> No fields found`;
      btn.style.background = '#6b7280';
    }

    setTimeout(() => {
      btn.innerHTML = originalHTML;
      btn.style.background = '';
      btn.disabled = false;
    }, 3000);

  } catch (error) {
    console.error('Autofill error:', error);
    showToast('Error running autofill. Make sure you are on a regular webpage.', 'error');
    btn.innerHTML = originalHTML;
    btn.style.background = '';
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
  if (currentSiteInfo) {
    statusEl.textContent = running ? `Running · ${currentSiteInfo.name}` : `${text} · ${currentSiteInfo.name}`;
  } else {
    statusEl.textContent = text;
  }
  statusEl.className = running ? 'status-value running' : 'status-value stopped';
}

// Update status from storage
async function updateStatus() {
  const local = await chrome.storage.local.get(['appliedCount', 'skippedCount', 'appliedJobs']);
  // Use appliedJobs array length as source of truth, fallback to counter
  const jobsCount = (local.appliedJobs && local.appliedJobs.length) || local.appliedCount || 0;
  document.getElementById('applied-count').textContent = jobsCount;
  document.getElementById('skipped-count').textContent = local.skippedCount || 0;
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
    showRateLimitBanner(request.message);
  } else if (request.type === 'botActionableStop') {
    // Actionable stop reasons — unsupported layout / daily limit / rate limit.
    // Reuse the persistent rate-limit banner UI (same style + auto-persist)
    // so user sees the reason next time they open the popup, not just now.
    isRunning = false;
    updateButtons();
    updateStatusDisplay('Stopped', false);
    showRateLimitBanner(request.message);
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
    renderRateLimitBanner({ message: b.message, ts: b.ts });
  });
} catch (e) {}

function showRateLimitBanner(message) {
  // Persist the banner across popup re-opens by stashing it in storage —
  // popups close as soon as the user clicks elsewhere.
  const payload = { message, ts: Date.now() };
  try { chrome.storage.local.set({ eam_rate_limit_banner: payload }); } catch (e) {}
  renderRateLimitBanner(payload);
}

function renderRateLimitBanner(payload) {
  if (!payload || !payload.message) return;
  // Auto-dismiss banners older than 30 minutes — by then the user has
  // probably already retried and we don't want a stale warning.
  if (Date.now() - (payload.ts || 0) > 30 * 60 * 1000) return;

  let banner = document.getElementById('eam-rate-limit-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'eam-rate-limit-banner';
    banner.style.cssText = 'background:#fef3c7;border:1px solid #f59e0b;color:#78350f;' +
      'padding:10px 12px;margin:8px;border-radius:6px;font-size:12px;line-height:1.4;' +
      'display:flex;align-items:flex-start;gap:8px';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:none;border:none;font-size:18px;cursor:pointer;' +
      'color:#78350f;line-height:1;padding:0;flex-shrink:0';
    closeBtn.onclick = () => {
      banner.remove();
      try { chrome.storage.local.remove('eam_rate_limit_banner'); } catch (e) {}
    };
    const text = document.createElement('div');
    text.id = 'eam-rate-limit-banner-text';
    text.style.cssText = 'flex:1';
    banner.appendChild(text);
    banner.appendChild(closeBtn);
    document.body.insertBefore(banner, document.body.firstChild);
  }
  document.getElementById('eam-rate-limit-banner-text').textContent = payload.message;
}

// Re-render any pending rate-limit banner on popup open
(async () => {
  try {
    const { eam_rate_limit_banner } = await chrome.storage.local.get('eam_rate_limit_banner');
    if (eam_rate_limit_banner) renderRateLimitBanner(eam_rate_limit_banner);
  } catch (e) {}
})();

// Update status (counters) every 2 seconds
setInterval(async () => { await updateStatus(); }, 2000);

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
    btn.style.background = '#059669';
    setTimeout(() => { btn.innerHTML = originalHTML; btn.style.background = ''; }, 3000);
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
    btn.style.background = '#059669';
    setTimeout(() => { btn.innerHTML = originalHTML; btn.style.background = ''; }, 2000);
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

    const sortedJobs = [...appliedJobs].sort((a, b) => new Date(b.date) - new Date(a.date));
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
        <a href="${job.link}" target="_blank" class="job-link">
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
      `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=plan,ai_credits_used,ai_credits_total,credits_reset_date,email,first_name`,
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
        const monthlyTotal = plan === 'premium' ? 30 : 2;
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
    } else {
      // Profile exists in auth but no user_profiles row yet
      showLoggedInState({
        email: eam_session.user?.email || eam_session.email || '',
        first_name: '',
        plan: 'free',
        ai_credits_used: 0,
        ai_credits_total: 2
      }, eam_session);
    }
  } catch (e) {
    console.log('Auth check failed:', e);
    showLoggedOutState();
  }
}

function showLoggedOutState() {
  const headerRight = document.getElementById('header-right');
  const premiumCard = document.getElementById('premium-card');
  const dashLinkRow = document.querySelector('.dash-block-row');

  if (headerRight) {
    headerRight.innerHTML = '<button id="header-sign-in-btn" class="header-sign-in">Sign In</button>';
    document.getElementById('header-sign-in-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://autoapplymax.com/auth.html' });
    });
  }
  if (premiumCard) premiumCard.style.display = '';
  if (dashLinkRow) dashLinkRow.style.display = 'none';

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
  const creditsTotal = profile.ai_credits_total || (plan === 'premium' ? 30 : 2);
  const creditsLeft = Math.max(0, creditsTotal - creditsUsed);

  if (headerRight) {
    const creditsHtml = plan !== 'unlimited'
      ? `<span class="header-credits">${creditsLeft} AI Credit${creditsLeft !== 1 ? 's' : ''}</span>`
      : '';
    headerRight.innerHTML = `${creditsHtml}<a href="#" class="header-plan-badge" id="header-plan-link">${planLabel}</a>`;
    document.getElementById('header-plan-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://autoapplymax.com/dashboard.html#upgrade' });
    });
  }

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

// ─── Dashboard link handlers ────────────────────────────────────────────
function setupDashboardLinks() {
  const BASE_URL = 'https://autoapplymax.com';
  const links = {
    'link-dashboard': '/dashboard.html',
    'link-ai-resume': '/dashboard.html#cv-generator',
    'link-cover-letter': '/dashboard.html#cover-letter',
    'link-analytics': '/dashboard.html#analytics',
    'view-dashboard-applications': '/dashboard.html#applications',
    'header-sign-in-btn': '/auth.html'
  };

  for (const [id, path] of Object.entries(links)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: BASE_URL + path });
    });
  }

  // Premium card upgrade link
  const upgradeLink = document.getElementById('premium-upgrade-link');
  if (upgradeLink) {
    upgradeLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: BASE_URL + '/dashboard.html#upgrade' });
    });
  }

  // Premium feature links
  document.querySelectorAll('.premium-feature-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const section = link.dataset.section;
      if (section) {
        chrome.tabs.create({ url: `https://autoapplymax.com/dashboard.html#${section}` });
      }
    });
  });
}
