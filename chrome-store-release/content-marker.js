// Content script — runs on autoapplymax.com pages
// Bridges chrome.storage ↔ dashboard web page via DOM element.
//
// v2 (2026-07-31): pushes eam_session to page + reacts to chrome.storage
// changes immediately. Fixes the ~6h re-signin bug (refresh_token
// rotation ping-pong: extension and page both refresh, one invalidates
// the other's rotated refresh_token → sign-in prompt). Now page can
// adopt the extension's fresher session via supabase-config.js
// _adoptExtensionSessionIfFresher() before its auto-refresh runs.
//
// Also adds aam_pending_jd bridging for "Generate CV for this job"
// button (proposals/generate-cv-button.js).

document.documentElement.setAttribute('data-eam-extension', 'true');

if (typeof chrome !== 'undefined' && chrome.storage) {

  // v2.5.120 (security audit 2026-10-18 #12): the session tokens are written into the page only where
  // supabase-js lives (pages loading supabase-config.js: dashboard, auth, premium, admin, ATS checker) or
  // where the page already holds its own session for our project (auth modal on other pages) — never on
  // blog / landing pages, where they would be one more copy readable by any third-party script.
  const TOKEN_PATHS_RX = /^\/(dashboard|auth|premium|admin)(\.html)?(\/|$)|^\/tools\/ats-score-checker(\.html)?\/?$/;
  function tokensAllowedHere() {
    try { if (TOKEN_PATHS_RX.test(window.location.pathname || '')) return true; } catch (_) {}
    try { return !!window.localStorage.getItem('sb-tgknaopmwbelterrhrnz-auth-token'); } catch (_) { return false; }
  }

  function pushDataToPage() {
    chrome.storage.local.get(
      ['appliedJobs', 'appliedCount', 'skippedCount', 'aam_pending_jd', 'eam_session'],
      (local) => {
        chrome.storage.sync.get(
          [
            'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode',
            'city', 'yearsOfExperience', 'expectedSalary',
            'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense'
          ],
          (sync) => {
            const data = {
              appliedJobs: local.appliedJobs || [],
              appliedCount: local.appliedCount || 0,
              skippedCount: local.skippedCount || 0,
              aam_pending_jd: local.aam_pending_jd || null,
              // Only expose the two token fields the page needs to
              // hydrate supabase-js — never leak user object metadata.
              eam_session: (local.eam_session && tokensAllowedHere()) ? {
                access_token: local.eam_session.access_token,
                refresh_token: local.eam_session.refresh_token,
              } : null,
              firstName: sync.firstName || '',
              lastName: sync.lastName || '',
              email: sync.email || '',
              phone: sync.phone || '',
              phoneCountryCode: sync.phoneCountryCode || '',
              city: sync.city || '',
              yearsOfExperience: sync.yearsOfExperience || '',
              expectedSalary: sync.expectedSalary || '',
              visaSponsorship: sync.visaSponsorship || '',
              legallyAuthorized: sync.legallyAuthorized || '',
              willingToRelocate: sync.willingToRelocate || '',
              driversLicense: sync.driversLicense || '',
              // 2.5.124 "Application answers": this extension records blocking questions + takes custom answers
              // from the dashboard (eam-custom-answers).
              features: ['answers']
            };

            let el = document.getElementById('eam-extension-data');
            if (!el) {
              el = document.createElement('script');
              el.type = 'application/json';
              el.id = 'eam-extension-data';
              document.documentElement.appendChild(el);
            }
            el.textContent = JSON.stringify(data);
            document.dispatchEvent(new CustomEvent('eam-data-ready'));
          }
        );
      }
    );
  }

  // Push immediately. v2.5.120: no more 5-second re-push — storage.onChanged (below) re-pushes as soon as
  // anything the page reads changes, and the dashboard asks with eam-sync-request.
  pushDataToPage();

  // ─── Auto-sync cvProfile from user_profiles.cv_data ────────────────
  // Extension needs cvProfile in chrome.storage.local so the Tailor CV
  // button can compute match scores on LinkedIn. Prior version required
  // the user to upload CV via popup — for OAuth signups who already have
  // cv_data on the web (from onboarding upload), the extension stayed
  // empty until manual popup upload, so the match score never showed.
  // Now: pull cv_data from Supabase whenever we have a valid session +
  // the Smart Profile changed. v2.5.102: compare user_profiles.cv_data_updated_at
  // (moved by a DB trigger only when cv_data content changes) with the stamp of
  // our copy on every dashboard visit — a few bytes — and re-download only on
  // change; the dashboard also posts AAM_PROFILE_UPDATED right after a Smart
  // Profile save. The old 24 h rule stays as a fallback when no stamp exists.
  const SB_URL = 'https://tgknaopmwbelterrhrnz.supabase.co/rest/v1/user_profiles';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRna25hb3Btd2JlbHRlcnJocm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NzYzMTcsImV4cCI6MjA5NDI1MjMxN30.2-V5Z6-ZIKOkC6RJEjdEEAVKjGYbSOdX_FSd3yPdE6Q';
  let cvSyncRunning = false;
  async function syncCvProfileFromWeb(force) {
    if (cvSyncRunning) return;
    cvSyncRunning = true;
    try {
      const local = await new Promise(res => chrome.storage.local.get(['eam_session', 'cvProfile', 'cvProfileSyncedAt', 'cvProfileServerStamp'], res));
      const session = local.eam_session;
      if (!session?.access_token) return;
      const headers = { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + session.access_token };
      let stamp = null;
      // v2.5.113: a copy taken right after signup is an empty object (cv_data = {}) → never "up to date".
      const c0 = local.cvProfile;
      const hasCv = !!(c0 && typeof c0 === 'object' && ((Array.isArray(c0.experience) && c0.experience.length) || (Array.isArray(c0.skills) && c0.skills.length) || (Array.isArray(c0.education) && c0.education.length) || c0.rawText || c0.summary));
      if (!force) {
        try {
          const s = await fetch(SB_URL + '?select=cv_data_updated_at&limit=1', { headers });
          if (s.ok) stamp = (await s.json())?.[0]?.cv_data_updated_at || null;
        } catch (_) {}
        if (stamp) {
          if (hasCv && local.cvProfileServerStamp === stamp) return; // unchanged
        } else {
          // No stamp available: previous rule (skip if synced within 24 h).
          const staleAfter = 24 * 60 * 60 * 1000;
          if (hasCv && local.cvProfileSyncedAt && (Date.now() - local.cvProfileSyncedAt < staleAfter)) return;
        }
      }
      // Fetch user_profiles.cv_data via authed Supabase REST
      const r = await fetch(SB_URL + '?select=cv_data,cv_data_updated_at&limit=1', { headers });
      if (!r.ok) return;
      const rows = await r.json();
      const cv = rows?.[0]?.cv_data;
      stamp = rows?.[0]?.cv_data_updated_at || stamp;
      if (!cv || typeof cv !== 'object') return;
      // Build a lightweight cvText from cv_data structure so generate-cv-button.js
      // can compute match scores immediately (its loadUserCvText prefers cvText).
      const cvText = [
        cv.summary || '',
        Array.isArray(cv.skills) ? cv.skills.join(', ') : '',
        Array.isArray(cv.experience) ? cv.experience.map(e => `${e.title || ''} ${e.company || ''} ${(Array.isArray(e.bullets) ? e.bullets.join(' ') : '')}`).join('\n') : '',
        Array.isArray(cv.education) ? cv.education.map(e => `${e.degree || ''} ${e.school || ''}`).join('\n') : '',
      ].filter(Boolean).join('\n').trim();
      const updates = { cvProfile: cv, cvProfileSyncedAt: Date.now(), cvProfileServerStamp: stamp };
      if (cvText.length > 100) updates.cvText = cvText;
      chrome.storage.local.set(updates);
    } catch (_e) { /* silent — non-critical */ }
    finally { cvSyncRunning = false; }
  }
  // Kick off sync after a short delay (let session settle)
  setTimeout(() => syncCvProfileFromWeb(false), 2000);
  // Smart Profile saved on the dashboard → re-sync now (same-origin page message).
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    if (ev.data && ev.data.type === 'AAM_PROFILE_UPDATED') setTimeout(() => syncCvProfileFromWeb(true), 500);
  });

  // React immediately when background.js writes eam_session (via alarm
  // keep-alive or reactive 401 refresh). Without this the page has to
  // wait up to 5s for the fresh token — long enough for supabase-js to
  // auto-refresh with its stale localStorage token and invalidate the
  // extension's rotated refresh_token via Supabase's rotation policy.
  const PUSHED_LOCAL_KEYS = ['appliedJobs', 'appliedCount', 'skippedCount', 'aam_pending_jd', 'eam_session'];
  const PUSHED_SYNC_KEYS = ['firstName', 'lastName', 'email', 'phone', 'phoneCountryCode', 'city', 'yearsOfExperience',
    'expectedSalary', 'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense'];
  chrome.storage.onChanged.addListener((changes, area) => {
    const keys = area === 'local' ? PUSHED_LOCAL_KEYS : area === 'sync' ? PUSHED_SYNC_KEYS : [];
    if (keys.some(k => Object.prototype.hasOwnProperty.call(changes, k))) pushDataToPage();
  });

  // Allowed origins for message passing
  // v2.5.120: production origins only (this script never runs on localhost anyway).
  const ALLOWED_ORIGINS = [
    'https://autoapplymax.com',
    'https://www.autoapplymax.com'
  ];

  // Listen for sync requests from the dashboard page
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    // Verify origin is from a trusted domain
    // Security 2026-10-18: exact origin match (startsWith accepted "https://autoapplymax.com.evil.tld").
    let okOrigin = false;
    try { const o = new URL(event.origin); okOrigin = !o.port && ALLOWED_ORIGINS.includes(o.protocol + '//' + o.hostname); } catch (_) { okOrigin = false; }
    if (!okOrigin) return;

    if (event.data?.type === 'eam-sync-request') {
      // Dashboard is requesting fresh data — re-push immediately
      pushDataToPage();
    } else if (event.data?.type === 'eam-clear-pending-jd') {
      chrome.storage.local.remove('aam_pending_jd', () => pushDataToPage());
    } else if (event.data?.type === 'eam-auth-session') {
      // Bridge auth session from web page to chrome.storage
      const session = event.data.session;
      // Validate session structure before storing
      // Security 2026-10-18: only adopt a real AutoApplyMax user session (our project, role
      // authenticated, sane sizes) — not any object a page script posts (session fixation).
      let sessionOk = false;
      if (session && typeof session === 'object' && typeof session.access_token === 'string' && typeof session.refresh_token === 'string'
          && session.access_token.length < 8192 && session.refresh_token.length < 1024) {
        try {
          const b64 = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          const claims = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4)));
          sessionOk = /^https:\/\/tgknaopmwbelterrhrnz\.supabase\.co\/auth\/v1\/?$/.test(String(claims.iss || '')) && claims.role === 'authenticated' && typeof claims.sub === 'string';
        } catch (_) { sessionOk = false; }
      }
      if (sessionOk) {
        chrome.storage.local.set({ eam_session: session });
      } else if (session === null || session === undefined) {
        chrome.storage.local.remove('eam_session');
      }
    } else if (event.data?.type === 'eam-custom-answers') {
      // 2.5.124 "Application answers" (dashboard Smart Profile): the user's answers to custom questions. Shape-checked
      // again in the service worker (application-answers.js normalizeCustom: key ≤160, question ≤300, answer ≤500).
      const list = Array.isArray(event.data.answers) ? event.data.answers.slice(0, 50) : [];
      const custom = list.filter(a => a && typeof a.key === 'string' && typeof a.question === 'string' && typeof a.answer === 'string')
        .map(a => ({ key: a.key.slice(0, 160), question: a.question.slice(0, 300), answer: a.answer.slice(0, 500) }));
      if (custom.length) try { chrome.runtime.sendMessage({ type: 'answersSaveCustom', custom }, () => void chrome.runtime.lastError); } catch (_) {}
    } else if (event.data?.type === 'eam-profile-update') {
      // Bridge Settings save from dashboard.js to chrome.storage.sync — direct
      // chrome.storage.sync.set from the dashboard's web-page context is a NOOP
      // (chrome.storage is undefined there). Whitelist the fields the extension
      // actually consumes so a malicious page can't inject arbitrary sync keys.
      const p = event.data.profile;
      if (!p || typeof p !== 'object') return;
      const ALLOWED_PROFILE_FIELDS = [
        'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode',
        'city', 'country', 'yearsOfExperience', 'expectedSalary',
        'visaSponsorship', 'legallyAuthorized', 'willingToRelocate',
        'driversLicense', 'maxYearsRequired', 'noticePeriod', 'blacklistKeywords',
        // 2026-10-15: dashboard Smart Profile "Application details" (apply-prefs-sync.js).
        'currentSalary', 'dateOfBirth', 'postalCode', 'gender',
        // 2026-10-19: Smart Profile "Application answers" / Application details.
        'nationality'
      ];
      const update = {};
      for (const k of ALLOWED_PROFILE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(p, k)) {
          const v = p[k];
          // 2026-10-15: an empty dashboard field never wipes a value set in the popup.
          if (typeof v === 'string' && !v.trim()) continue;
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            update[k] = typeof v === 'string' ? v.slice(0, 200) : v;
          }
        }
      }
      if (Object.keys(update).length) chrome.storage.sync.set(update, () => {
        // 2026-10-15: reconcile the application details with the account (edit times, apply-prefs-sync.js).
        try { chrome.runtime.sendMessage({ type: 'syncApplyPrefs' }, () => void chrome.runtime.lastError); } catch (_) {}
      });
    }
  });
}
