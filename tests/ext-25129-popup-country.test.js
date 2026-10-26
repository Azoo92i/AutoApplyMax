/**
 * ext v2.5.129 — test agent 2026-10-26 (popup, real extension page):
 *   1. phone country code defaulted to "+1" when nothing was stored, sign-in never filled it from the account and the first
 *      save persisted it → FR / IN users autofilled as US ("+1…", Country = United States, "Paris, TX").
 *   2. free plan monthly reset wrote 2 credits (free = 1 since 2026-10-06).
 *   4. "Track this job" title on Lever "Palantir Technologies - Administrative Business Partner" = "Palantir Technologies".
 * Loads the real popup.html (chrome-extension://) with a fake session; Supabase REST answered by ctx.route (no network).
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25129-popup-country.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const EXT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/');

let pass = 0, fail = 0;
const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };

async function withPopup(tz, { sync = {}, account = null }, fn) {
  const tmp = path.join(os.tmpdir(), 'pw-25129-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  const ctx = await chromium.launchPersistentContext(tmp, { headless: false, timezoneId: tz, viewport: { width: 420, height: 800 },
    args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, '--window-position=-3000,0', '--no-first-run'] });
  const patches = [];
  try {
    await ctx.route('https://tgknaopmwbelterrhrnz.supabase.co/**', async (r) => {
      const req = r.request();
      if (req.method() === 'PATCH') { try { patches.push(JSON.parse(req.postData() || '{}')); } catch (_) {} return r.fulfill({ status: 204, body: '' }); }
      if (/\/rest\/v1\/user_profiles/.test(req.url())) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(account ? [account] : []) });
      return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 30000 });
    const id = sw.url().split('/')[2];
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${id}/manifest.json`);
    await p.evaluate(async ({ sync, signedIn }) => {
      await chrome.storage.sync.clear();
      if (Object.keys(sync).length) await chrome.storage.sync.set(sync);
      await chrome.storage.local.set({ onboardingCompleted: true, onboardingStep: 99, isRunning: false });
      if (signedIn) await chrome.storage.local.set({ eam_session: { access_token: 'fake.jwt.token', refresh_token: 'x', user_id: '00000000-0000-4000-8000-000000000129', user: { id: '00000000-0000-4000-8000-000000000129', email: 'aam-test@example.com' } } });
    }, { sync, signedIn: !!account });
    await p.goto(`chrome-extension://${id}/popup.html`);
    await p.waitForTimeout(3500);
    await fn(p, patches);
  } finally {
    await ctx.close().catch(() => {});
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}
const state = (p) => p.evaluate(async () => {
  const s = await chrome.storage.sync.get(['phoneCountryCode', 'phoneCountryCodeSource']);
  const a = (await chrome.storage.local.get(['accountProfile'])).accountProfile || null;
  return { select: document.getElementById('phoneCountryCode').value, stored: s.phoneCountryCode || null, source: s.phoneCountryCodeSource, accountCountry: a && a.country,
    credits: (document.querySelector('.header-credits') || {}).textContent || null };
});
const ACC = (o) => Object.assign({ plan: 'free', ai_credits_used: 0, ai_credits_total: 1, credits_reset_date: new Date().toISOString(), email: 'aam-test@example.com',
  first_name: 'Test', last_name: 'User', phone: '612345678', phone_country_code: null, city: 'Paris', country: null, years_of_experience: 3, expected_salary: null }, o);

(async () => {
  // ── 1. signed out, nothing stored: time zone, never a blind +1 ──
  for (const [tz, want, src] of [['Europe/Paris', '+33', 'timezone'], ['Asia/Kolkata', '+91', 'timezone'], ['America/Chicago', '+1', 'timezone'], ['Antarctica/Troll', '+1', 'default']]) {
    await withPopup(tz, {}, async (p) => {
      const s = await state(p);
      T(`signed out, ${tz}: select = ${want}`, s.select === want, s);
      // first save (any field) persists the code with its source
      await p.fill('#city', 'Paris'); await p.waitForTimeout(1200);
      const s2 = await state(p);
      T(`signed out, ${tz}: first save stores ${want} with source "${src}"`, s2.stored === want && s2.source === src, s2);
    });
  }

  // ── 2. signed in, nothing stored, US time zone: account code wins (phone_country_code '33', and '91' without +) ──
  await withPopup('America/New_York', { account: ACC({ country: 'FR', phone_country_code: '33' }) }, async (p) => {
    const s = await state(p);
    T('signed in FR (+33) in a US time zone → +33 stored, source account', s.select === '+33' && s.stored === '+33' && s.source === 'account', s);
    T('checkAuthState stores the account country for autofill / auto-apply', s.accountCountry === 'FR', s);
  });
  await withPopup('America/New_York', { account: ACC({ country: 'IN', phone_country_code: '91', city: 'Pune' }) }, async (p) => {
    const s = await state(p);
    T('signed in IN ("91" without +) → +91', s.select === '+91' && s.stored === '+91', s);
  });
  await withPopup('America/New_York', { account: ACC({ country: 'IN', phone_country_code: '+919623292288' }) }, async (p) => {
    const s = await state(p);
    T('garbage phone_country_code ("+919623292288") → country IN → +91', s.select === '+91', s);
  });

  // ── 3. legacy installs (no source) ──
  await withPopup('Europe/Paris', { sync: { firstName: 'A', phoneCountryCode: '+1' }, account: ACC({ country: 'IN', phone_country_code: '+91' }) }, async (p) => {
    const s = await state(p);
    T('legacy untouched +1, account IN → replaced by +91', s.select === '+91' && s.stored === '+91' && s.source === 'account', s);
  });
  await withPopup('Europe/Paris', { sync: { firstName: 'A', phoneCountryCode: '+1' }, account: ACC({ country: 'US', phone_country_code: '+1' }) }, async (p) => {
    const s = await state(p);
    T('legacy +1, account US → kept +1', s.select === '+1' && s.stored === '+1', s);
  });
  await withPopup('Europe/Paris', { sync: { firstName: 'A', phoneCountryCode: '+1' }, account: ACC({ country: null, phone_country_code: null }) }, async (p) => {
    const s = await state(p);
    T('legacy +1, account without country / code → kept +1 (cannot tell)', s.select === '+1' && s.stored === '+1', s);
  });
  await withPopup('America/New_York', { sync: { firstName: 'A', phoneCountryCode: '+44' }, account: ACC({ country: 'FR', phone_country_code: '+33' }) }, async (p) => {
    const s = await state(p);
    T('legacy non-default +44, account FR → kept +44', s.select === '+44', s);
  });

  // ── 4. a code the user picked is never overridden ──
  await withPopup('Europe/Paris', { sync: { firstName: 'A', phoneCountryCode: '+44', phoneCountryCodeSource: 'user' }, account: ACC({ country: 'FR', phone_country_code: '+33' }) }, async (p) => {
    const s = await state(p);
    T('user-picked +44, account FR → kept +44', s.select === '+44' && s.stored === '+44' && s.source === 'user', s);
  });
  await withPopup('Europe/Paris', {}, async (p) => {
    await p.selectOption('#phoneCountryCode', '+49'); await p.waitForTimeout(1200);
    const s = await state(p);
    T('picking +49 in the select → stored with source "user"', s.stored === '+49' && s.source === 'user', s);
  });

  // ── 4b. stale popup form: settings written after the popup opened must survive the account prefill ──
  //        (fixture S1 2026-10-26: the code relabel triggered a full saveConfig() from the stale form → email wiped)
  await withPopup('America/New_York', { account: ACC({ country: 'FR', phone_country_code: null }) }, async (p) => {
    await p.evaluate(async () => {
      await chrome.storage.sync.set({ firstName: 'Late', email: 'late@example.com', phone: '611111111', phoneCountryCode: '+1', phoneCountryCodeSource: 'timezone' });
      await checkAuthState();
    });
    await p.waitForTimeout(800);
    const s = await p.evaluate(async () => chrome.storage.sync.get(['email', 'firstName', 'phone', 'phoneCountryCode', 'phoneCountryCodeSource']));
    T('stale form: email / name / phone written meanwhile are kept', s.email === 'late@example.com' && s.firstName === 'Late' && s.phone === '611111111', s);
    T('stale form: stored auto +1 replaced by the account country code (+33)', s.phoneCountryCode === '+33' && s.phoneCountryCodeSource === 'account', s);
  });

  // ── 5. credits: free monthly reset = 1 ──
  await withPopup('Europe/Paris', { account: ACC({ country: 'FR', credits_reset_date: '2026-08-01T00:00:00Z', ai_credits_total: 2, ai_credits_used: 2 }) }, async (p, patches) => {
    const s = await state(p);
    const reset = patches.find(b => 'ai_credits_total' in b);
    T('free monthly reset writes ai_credits_total = 1 (not 2)', reset && reset.ai_credits_total === 1, patches);
    T('header shows "1 AI credit"', /^1 AI credit$/.test(String(s.credits || '').trim()), s);
  });

  // ── 6. helpers + Track-this-job title (bug 4), in the popup page ──
  await withPopup('Europe/Paris', {}, async (p) => {
    const r = await p.evaluate(() => {
      const c = window._aamCc;
      return {
        norm: ['+91', '91', ' +33 ', '600026', '+919623292288', '1 8638442472', '', null, '0033'].map(c._normDial),
        iso: ['FR', 'in', 'UK', 'ZZ', 'France', ''].map(c._validIso),
        name: ['FR', 'IN', 'US', 'GB'].map(c._isoName),
        titles: [
          ['Palantir Technologies - Administrative Business Partner', 'Palantir'],
          ['Job Application for Senior Data Engineer at Stripe', 'Stripe'],
          ['Senior Product Designer @ Ashby', 'Ashby'],
          ['Product Manager - Paris | Welcome to the Jungle', 'Welcometothejungle'],
          ['Chef de projet Hébergements numériques (F/H) - Paris (75) - Indeed.com', 'Indeed'],
          ['Acme - Acme', 'Acme'],
          ['Software Engineer', 'Lever'],
        ].map(([t, co]) => extractJobTitleFromPageTitle(t, co)),
        srCompany: extractCompanyFromUrl('https://jobs.smartrecruiters.com/oneclick-ui/company/Eurofins/publication/13554163-191f?dcr_ci=Eu'),
        ats: ['https://jobs.lever.co/palantir/abc', 'https://job-boards.greenhouse.io/stripe/jobs/1', 'https://jobs.ashbyhq.com/ashby/x', 'https://jobs.smartrecruiters.com/X/1', 'https://apply.workable.com/x/j/1', 'https://acme.wd5.myworkdayjobs.com/x', 'https://fr.indeed.com/viewjob'].map(_isAtsJobHost),
        headingsSrc: _pageJobHeadings.toString(),
      };
    });
    T('_normDial', JSON.stringify(r.norm) === JSON.stringify(['+91', '+91', '+33', '', '', '', '', '', '']), r.norm);
    T('_validIso', JSON.stringify(r.iso) === JSON.stringify(['FR', 'IN', 'GB', '', '', '']), r.iso);
    T('_isoName', JSON.stringify(r.name) === JSON.stringify(['France', 'India', 'United States', 'United Kingdom']), r.name);
    T('title: Lever "Palantir Technologies - Administrative Business Partner" → the job title', r.titles[0] === 'Administrative Business Partner', r.titles[0]);
    T('title: Greenhouse "Job Application for X at Stripe" → X', r.titles[1] === 'Senior Data Engineer', r.titles[1]);
    T('title: "X @ Ashby" → X', r.titles[2] === 'Senior Product Designer', r.titles[2]);
    T('title: "Title - City | Board" unchanged (cut at the first " | ")', r.titles[3] === 'Product Manager - Paris', r.titles[3]);
    T('title: Indeed unchanged', r.titles[4] === 'Chef de projet Hébergements numériques (F/H)', r.titles[4]);
    T('title: "Acme - Acme" (both company) → first part kept', r.titles[5] === 'Acme', r.titles[5]);
    T('title: no separator unchanged', r.titles[6] === 'Software Engineer', r.titles[6]);
    T('company: SmartRecruiters oneclick URL → Eurofins (not "Oneclick Ui")', r.srCompany === 'Eurofins', r.srCompany);
    T('ATS hosts detected (Lever/Greenhouse/Ashby/SmartRecruiters/Workable/Workday), Indeed not', JSON.stringify(r.ats) === JSON.stringify([true, true, true, true, true, true, false]), r.ats);

    // _pageJobHeadings on ATS-like DOMs (structure of the live pages)
    const DOMS = {
      lever: '<div class="main-header-content"><a class="main-header-logo"><img alt="Palantir Technologies logo"></a></div><div class="posting-headline"><h2>Administrative Business Partner</h2><div class="posting-categories">London</div></div>',
      greenhouse: '<div id="header"><h1 class="app-title">Senior Data Engineer</h1><span class="company-name">at Stripe</span></div>',
      ashby: '<header><h1>Ashby</h1></header><div class="ashby-job-posting-heading"><h1 class="_title_ud4nd_34">Senior Product Designer</h1></div>',
      smart: '<h1 class="job-title" itemprop="title">Account Executive</h1>',
    };
    const out = {};
    for (const [k, html] of Object.entries(DOMS)) {
      out[k] = await p.evaluate(([html, src]) => { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); const r = (0, eval)('(' + src + ')')(); d.remove(); return r; }, [html, r.headingsSrc]);
    }
    T('headings: Lever → "Administrative Business Partner" first', out.lever[0] === 'Administrative Business Partner', out.lever);
    T('headings: Greenhouse → h1.app-title', out.greenhouse[0] === 'Senior Data Engineer', out.greenhouse);
    T('headings: Ashby → company h1 then title (popup drops the company one)', out.ashby.includes('Senior Product Designer') && out.ashby.filter(x => x !== 'Ashby')[0] === 'Senior Product Designer', out.ashby);
    T('headings: SmartRecruiters → h1.job-title', out.smart[0] === 'Account Executive', out.smart);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
