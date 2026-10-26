/**
 * ext v2.5.128 — live gate 2026-10-26 (premium FR, DXC Technology Easy Apply, submitted):
 *   "What is your level of proficiency in Englis ?" / "… in Frenc ?" (names cut by the employer) → "None" ×2.
 *   The language was not recognised (left blank), then the validation repair picked the first option ("None").
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25128-lang-level.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/').replace(/\/?$/, '/');
const FILES = ['core/utils.js', 'core/job-board-strings.js', 'core/ai-form.js', 'core/form-filler.js'];
const THEO = { firstName: 'Theo', city: 'Paris', country: 'FR', languages: [{ name: 'French', level: 'Native' }, { name: 'English', level: 'Fluent' }],
  cvProfile: { education: [], experience: [], skills: [] } };
const OPTS = ['None', 'Elementary proficiency', 'Limited working proficiency', 'Professional working proficiency', 'Full professional proficiency', 'Native or bilingual proficiency'];

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage(); if (process.env.DBG) page.on('console', m => console.log('  [page]', m.text().slice(0, 200)));
  await page.setContent('<!doctype html><html lang="en"><body></body></html>');
  await page.evaluate(() => {
    window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} }, sendMessage: (m, cb) => { cb && cb({ answer: '' }); } },
      storage: { local: { get: (k, cb) => { const r = { plan: 'premium', isPremium: true }; cb && cb(r); return Promise.resolve(r); }, set: () => Promise.resolve(), remove: () => Promise.resolve() }, sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'en' } };
  });
  for (const f of FILES) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });
  const sel = (id, q) => `<div data-test-form-element><label for="${id}">${q}</label><select id="${id}"><option value="">Select an option</option>${OPTS.map((o, i) => `<option value="v${i}">${o}</option>`).join('')}</select>`;
  const ERR = '<div class="artdeco-inline-feedback artdeco-inline-feedback--error" role="alert" style="display:block">Please make a selection</div>';
  const run = (html, fn, cfg) => page.evaluate(async ([html, fn, cfg]) => {
    window.EAM.utils.isRunning = true; window.EAM.utils.userExplicitlyClickedStart = true;
    const m = document.createElement('div'); m.className = 'jobs-easy-apply-modal'; m.innerHTML = html; document.body.appendChild(m);
    await window.EAM.FormFiller[fn](m, cfg);
    const out = Array.from(m.querySelectorAll('select')).map(s => s.selectedIndex > 0 ? s.options[s.selectedIndex].text : '');
    m.remove(); return out;
  }, [html, fn, cfg]);

  let r = await run(sel('a', 'What is your level of proficiency in Englis ?*') + '</div>' + sel('b', 'What is your level of proficiency in Frenc ?*') + '</div>', 'fillSelectDropdowns', THEO);
  T('fill: "Englis ?" → English level (Fluent), never None', /professional/i.test(r[0]) && r[0] !== 'None', r);
  T('fill: "Frenc ?" → French level (Native)', /native/i.test(r[1]), r);
  r = await run(sel('c', 'What is your level of proficiency in English?*') + '</div>', 'fillSelectDropdowns', THEO);
  T('fill: full name unchanged', /professional/i.test(r[0]), r);
  // validation repair: a level list the fill left blank never gets the first option
  r = await run(sel('d', 'What is your level of proficiency in Englis ?*') + ERR + '</div>', 'repairValidationErrors', THEO);
  T('repair: "Englis ?" level list → English level, not None', r[0] && r[0] !== 'None', r);
  r = await run(sel('e', 'What is your level of proficiency in Klingon ?*') + ERR + '</div>', 'repairValidationErrors', THEO);
  T('repair: unknown language level list → left blank (never None / first option)', r[0] === '', r);
  // no regression: a plain yes/no select is still repaired with Yes
  r = await run('<div data-test-form-element><label for="y">Are you comfortable working in shifts?</label><select id="y"><option value="">Select an option</option><option value="y">Yes</option><option value="n">No</option></select>' + ERR + '</div>', 'repairValidationErrors', THEO);
  T('repair: yes/no select still → Yes', r[0] === 'Yes', r);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
