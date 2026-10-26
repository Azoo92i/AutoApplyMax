/**
 * ext v2.5.129 — test agent 2026-10-26: no "Tailor CV" button on fr.indeed.com/viewjob. Indeed's new layout has no
 * #jobDescriptionText / jobsearch-JobInfoHeader-title any more (title = [data-testid="vj-job-title"], description =
 * the block after [data-testid="vj-job-description-heading"], starting with <style> rules).
 * Fixture: tests/fixtures/indeed-viewjob-fr-2026-10-26.html (public page captured read-only, trimmed, no scripts).
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25129-indeed-cv-button.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/').replace(/\/?$/, '/');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'indeed-viewjob-fr-2026-10-26.html'), 'utf8');
const SRC = fs.readFileSync(ROOT + 'core/generate-cv-button.js', 'utf8');
const CV = 'Chef de projet digital, gestion de projet, hébergement, infrastructure, cloud, AWS, agile, scrum, budget, pilotage de prestataires, marchés publics, sécurité, Linux, réseaux. '.repeat(3);
const LEGACY = `<!doctype html><html><head><title>Data Analyst - Lyon - Indeed.com</title></head><body>
  <div class="jobsearch-JobComponent"><h1 class="jobsearch-JobInfoHeader-title">Data Analyst</h1>
  <div data-testid="inlineHeader-companyName"><a href="#">Acme</a></div>
  <div id="jobDescriptionText">${'Nous recherchons un data analyst SQL Python Tableau pour analyser les ventes et piloter les KPI. '.repeat(4)}</div></div></body></html>`;

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext();
  await ctx.route('https://fr.indeed.com/**', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: r.request().url().includes('legacy') ? LEGACY : FIXTURE }));
  await ctx.addInitScript((cv) => {
    const local = { cvText: cv };
    window.__opened = [];
    window.open = (u) => { window.__opened.push(u); return null; };
    window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} }, sendMessage: (m, cb) => { cb && cb({}); } },
      storage: { local: { get: (k, cb) => { const r = k === null ? Object.assign({}, local) : {}; if (Array.isArray(k)) k.forEach(x => { if (x in local) r[x] = local[x]; }); cb && cb(r); return Promise.resolve(r); },
        set: (o, cb) => { Object.assign(local, o); window.__local = local; cb && cb(); return Promise.resolve(); } }, sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } } };
  }, CV);

  async function runOn(url) {
    const page = await ctx.newPage();
    await page.goto(url);
    await page.addScriptTag({ content: SRC });
    await page.waitForSelector('#aam-tailor-cv-btn', { timeout: 6000 }).catch(() => null);
    return page;
  }

  // 1. Current (2026-10) layout
  let page = await runOn('https://fr.indeed.com/viewjob?jk=b5533e886443cc15');
  let st = await page.evaluate(() => { const b = document.getElementById('aam-tailor-cv-btn'); return { btn: !!b, txt: b ? b.innerText : '' }; });
  T('new Indeed layout: Tailor CV button rendered', st.btn, st);
  if (st.btn) {
    await page.evaluate(() => { const b = document.getElementById('aam-tailor-cv-btn'); const main = b.querySelector('[data-action="tailor"], .aam-tcv-main, button') || b; main.click(); });
    await page.waitForTimeout(400);
    const pj = await page.evaluate(() => (window.__local || {}).aam_pending_jd || null);
    T('click stores the job title from [data-testid="vj-job-title"]', pj && pj.title === 'Chef de projet Hébergements numériques (F/H)', pj && pj.title);
    T('JD text is the description (≥ 1000 chars, contains the posting body)', pj && pj.jd.length >= 1000 && /CNFPT/.test(pj.jd), pj && pj.jd.slice(0, 120));
    T('JD text has no CSS from the <style> block', pj && !/@layer|\{\s*[a-z-]+\s*:/.test(pj.jd), pj && pj.jd.slice(0, 200));
    T('company from company-info-metadata', pj && /EP/.test(pj.company), pj && pj.company);
  }
  await page.close();

  // 2. Legacy layout still works (fallback selectors kept)
  page = await runOn('https://fr.indeed.com/viewjob?legacy=1');
  st = await page.evaluate(() => ({ btn: !!document.getElementById('aam-tailor-cv-btn') }));
  T('legacy Indeed layout (#jobDescriptionText): button still rendered', st.btn, st);
  await page.close();

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
