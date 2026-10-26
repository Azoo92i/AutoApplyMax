/**
 * ext v2.5.129 — auto-apply side of the "+1 default" bug (test agent 2026-10-26): the engine reads phoneCountryCode from
 * chrome.storage.sync, where older popups stored "+1" for every user who never picked a code. FormFiller.resolveDialCode
 * (called by engine.js at Start) applies the popup's rule; findCountryOption / profileCountry then pick the right country.
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25129-engine-dial.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/').replace(/\/?$/, '/');
const FILES = ['core/utils.js', 'core/job-board-strings.js', 'core/ai-form.js', 'core/form-filler.js'];

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  await page.setContent('<!doctype html><html lang="en"><body></body></html>');
  await page.evaluate(() => {
    window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} }, sendMessage: (m, cb) => { cb && cb({}); } },
      storage: { local: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); }, set: () => Promise.resolve(), remove: () => Promise.resolve() }, sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'en' } };
  });
  for (const f of FILES) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });

  const cases = [
    // [name, config, accountProfile, expected {code, changed}]
    ['legacy +1 (no source), account FR country only → +33', { phoneCountryCode: '+1' }, { country: 'FR' }, { code: '+33', changed: true }],
    ['legacy +1, account IN phoneCountryCode "91" → +91', { phoneCountryCode: '+1' }, { country: 'IN', phoneCountryCode: '91' }, { code: '+91', changed: true }],
    ['legacy +1, account US → unchanged', { phoneCountryCode: '+1' }, { country: 'US', phoneCountryCode: '+1' }, { code: '+1', changed: false }],
    ['legacy +1, no account info → unchanged', { phoneCountryCode: '+1' }, { country: '' }, { code: '+1', changed: false }],
    ['legacy +44, account FR → unchanged (deliberate)', { phoneCountryCode: '+44' }, { country: 'FR' }, { code: '+44', changed: false }],
    ['user-picked +44, account FR → unchanged', { phoneCountryCode: '+44', phoneCountryCodeSource: 'user' }, { country: 'FR', phoneCountryCode: '+33' }, { code: '+44', changed: false }],
    ['timezone +33, account IN → +91', { phoneCountryCode: '+33', phoneCountryCodeSource: 'timezone' }, { country: 'IN' }, { code: '+91', changed: true }],
    ['default +1, no account info → dropped', { phoneCountryCode: '+1', phoneCountryCodeSource: 'default' }, null, { code: '', changed: true }],
    ['default +1, account US → unchanged', { phoneCountryCode: '+1', phoneCountryCodeSource: 'default' }, { country: 'US' }, { code: '+1', changed: false }],
    ['garbage account code "+919623292288", country IN → +91', { phoneCountryCode: '+1' }, { country: 'IN', phoneCountryCode: '+919623292288' }, { code: '+91', changed: true }],
  ];
  for (const [n, cfg, ap, want] of cases) {
    const r = await page.evaluate(([cfg, ap]) => window.EAM.FormFiller.resolveDialCode(cfg, ap), [cfg, ap]);
    T(n, r.code === want.code && r.changed === want.changed, r);
  }
  T('dialForCountry("France") = 33, ("IN") = 91, ("") = ""', await page.evaluate(() => { const F = window.EAM.FormFiller; return F.dialForCountry('France') === '33' && F.dialForCountry('IN') === '91' && F.dialForCountry('') === ''; }), null);

  // LinkedIn "Phone country code" select after the engine applied the rule (country from the dashboard = "FR")
  const pick = await page.evaluate(() => {
    const F = window.EAM.FormFiller;
    const opts = ['Select an option', 'United States (+1)', 'Canada (+1)', 'France (+33)', 'India (+91)'];
    const cfg = { phoneCountryCode: '+1', country: 'FR' };
    const rd = F.resolveDialCode(cfg, { country: 'FR' }); if (rd.changed) cfg.phoneCountryCode = rd.code;
    const a = F.findCountryOption(opts, x => x, cfg);
    const cfg2 = { phoneCountryCode: '+1', phoneCountryCodeSource: 'default' };
    const rd2 = F.resolveDialCode(cfg2, null); if (rd2.changed) cfg2.phoneCountryCode = rd2.code;
    return { fr: a, code: cfg.phoneCountryCode, none: F.findCountryOption(opts, x => x, cfg2), noneCountry: F.profileCountry(cfg2) };
  });
  T('LinkedIn phone-country select: FR account + legacy +1 → "France (+33)"', pick.fr === 'France (+33)' && pick.code === '+33', pick);
  T('nobody-chose +1 and no account → no country invented (not United States)', pick.none == null && pick.noneCountry === '', pick);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
