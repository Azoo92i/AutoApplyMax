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
              eam_session: local.eam_session ? {
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
              driversLicense: sync.driversLicense || ''
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

  // Push immediately + auto-refresh every 5s
  pushDataToPage();
  setInterval(pushDataToPage, 5000);

  // ─── Auto-sync cvProfile from user_profiles.cv_data ────────────────
  // Extension needs cvProfile in chrome.storage.local so the Tailor CV
  // button can compute match scores on LinkedIn. Prior version required
  // the user to upload CV via popup — for OAuth signups who already have
  // cv_data on the web (from onboarding upload), the extension stayed
  // empty until manual popup upload, so the match score never showed.
  // Now: pull cv_data from Supabase whenever we have a valid session +
  // cvProfile is missing or stale (>24h). Runs at most once per page load.
  let cvSyncTried = false;
  async function syncCvProfileFromWeb() {
    if (cvSyncTried) return;
    cvSyncTried = true;
    try {
      const local = await new Promise(res => chrome.storage.local.get(['eam_session', 'cvProfile', 'cvProfileSyncedAt'], res));
      const session = local.eam_session;
      if (!session?.access_token) return;
      // Skip if cvProfile already exists AND was synced within the last 24h
      const staleAfter = 24 * 60 * 60 * 1000;
      if (local.cvProfile && local.cvProfileSyncedAt && (Date.now() - local.cvProfileSyncedAt < staleAfter)) return;
      // Fetch user_profiles.cv_data + cvText via authed Supabase REST
      const r = await fetch('https://tgknaopmwbelterrhrnz.supabase.co/rest/v1/user_profiles?select=cv_data&limit=1', {
        headers: {
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRna25hb3Btd2JlbHRlcnJocm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NzYzMTcsImV4cCI6MjA5NDI1MjMxN30.2-V5Z6-ZIKOkC6RJEjdEEAVKjGYbSOdX_FSd3yPdE6Q',
          'Authorization': 'Bearer ' + session.access_token,
        }
      });
      if (!r.ok) return;
      const rows = await r.json();
      const cv = rows?.[0]?.cv_data;
      if (!cv || typeof cv !== 'object') return;
      // Build a lightweight cvText from cv_data structure so generate-cv-button.js
      // can compute match scores immediately (its loadUserCvText prefers cvText).
      const cvText = [
        cv.summary || '',
        Array.isArray(cv.skills) ? cv.skills.join(', ') : '',
        Array.isArray(cv.experience) ? cv.experience.map(e => `${e.title || ''} ${e.company || ''} ${(Array.isArray(e.bullets) ? e.bullets.join(' ') : '')}`).join('\n') : '',
        Array.isArray(cv.education) ? cv.education.map(e => `${e.degree || ''} ${e.school || ''}`).join('\n') : '',
      ].filter(Boolean).join('\n').trim();
      const updates = { cvProfile: cv, cvProfileSyncedAt: Date.now() };
      if (cvText.length > 100) updates.cvText = cvText;
      chrome.storage.local.set(updates);
    } catch (_e) { /* silent — non-critical */ }
  }
  // Kick off sync after a short delay (let session settle)
  setTimeout(syncCvProfileFromWeb, 2000);

  // React immediately when background.js writes eam_session (via alarm
  // keep-alive or reactive 401 refresh). Without this the page has to
  // wait up to 5s for the fresh token — long enough for supabase-js to
  // auto-refresh with its stale localStorage token and invalidate the
  // extension's rotated refresh_token via Supabase's rotation policy.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.eam_session) pushDataToPage();
  });

  // Allowed origins for message passing
  const ALLOWED_ORIGINS = [
    'https://autoapplymax.com',
    'https://www.autoapplymax.com',
    'http://localhost',
    'http://127.0.0.1'
  ];

  // Listen for sync requests from the dashboard page
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    // Verify origin is from a trusted domain
    if (!ALLOWED_ORIGINS.some(o => event.origin.startsWith(o))) return;

    if (event.data?.type === 'eam-sync-request') {
      // Dashboard is requesting fresh data — re-push immediately
      pushDataToPage();
    } else if (event.data?.type === 'eam-clear-pending-jd') {
      chrome.storage.local.remove('aam_pending_jd', () => pushDataToPage());
    } else if (event.data?.type === 'eam-auth-session') {
      // Bridge auth session from web page to chrome.storage
      const session = event.data.session;
      // Validate session structure before storing
      if (session && typeof session === 'object' && session.access_token && session.refresh_token) {
        chrome.storage.local.set({ eam_session: session });
      } else if (session === null || session === undefined) {
        chrome.storage.local.remove('eam_session');
      }
    }
  });
}
