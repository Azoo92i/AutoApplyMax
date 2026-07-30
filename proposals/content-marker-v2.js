// Content script — runs on autoapplymax.com/dashboard pages
// v2 (2026-07-30): adds aam_pending_jd push for "Generate CV for this job"
//   content-marker.js already bridges chrome.storage → DOM element for
//   applied counts + profile fields. This version also pushes the
//   pending JD payload (set by generate-cv-button.js on job pages).
//
// DIFF from v1:
//   - Adds `aam_pending_jd` to the local.get keys
//   - Adds `aam_pending_jd` to the data object pushed to `#eam-extension-data`
//   - Adds an `eam-clear-pending-jd` message handler that clears the payload
//     from storage (dashboard fires it after prefilling to prevent stale reuse)

document.documentElement.setAttribute('data-eam-extension', 'true');

if (typeof chrome !== 'undefined' && chrome.storage) {

  function pushDataToPage() {
    chrome.storage.local.get(
      ['appliedJobs', 'appliedCount', 'skippedCount', 'aam_pending_jd'],
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

  pushDataToPage();
  setInterval(pushDataToPage, 5000);

  const ALLOWED_ORIGINS = [
    'https://autoapplymax.com',
    'https://www.autoapplymax.com',
    'http://localhost',
    'http://127.0.0.1'
  ];

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!ALLOWED_ORIGINS.some(o => event.origin.startsWith(o))) return;

    if (event.data?.type === 'eam-sync-request') {
      pushDataToPage();
    } else if (event.data?.type === 'eam-clear-pending-jd') {
      chrome.storage.local.remove('aam_pending_jd', () => pushDataToPage());
    } else if (event.data?.type === 'eam-auth-session') {
      const session = event.data.session;
      if (session && typeof session === 'object' && session.access_token && session.refresh_token) {
        chrome.storage.local.set({ eam_session: session });
      } else if (session === null || session === undefined) {
        chrome.storage.local.remove('eam_session');
      }
    }
  });
}
