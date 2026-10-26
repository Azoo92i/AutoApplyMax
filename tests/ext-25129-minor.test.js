/**
 * ext v2.5.129 — minor fixes from the test agent run 2026-10-26 (universal autofill, never submitted):
 *  a. Ashby field ids leaked into the AI question: "Additional Information f189fed2-624b-41a1-a76f-0c67a2611d1a f189fed2 624b …".
 *  b. Lever required "Current location": the suggestion list did not open for the first keystrokes → left empty.
 *     Now retyped once with a longer wait. With country France the French "Paris" is picked (not "Paris, TX").
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25129-minor.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/').replace(/\/?$/, '/');

const STUB = () => {
  window.__prompts = [];
  window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} },
      sendMessage: (m, cb) => { if (m && m.type === 'ai-form-answer') window.__prompts.push(m.prompt); cb && cb({ answer: '' }); } },
    storage: { local: { get: (k, cb) => { const r = { plan: 'premium', isPremium: true }; cb && cb(r); return Promise.resolve(r); }, set: () => Promise.resolve(), remove: () => Promise.resolve() },
      sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'en' } };
};
// Lever-like location autocomplete: suggestions only answer the SECOND typing burst when slow=1 (first API call "lost").
const LEVER = (slow) => `<!doctype html><form><div class="application-question"><div class="application-label">Current location<span class="required">*</span></div>
  <div class="application-field"><input id="location-input" class="location-input" name="location" type="text" autocomplete="off" required>
  <div class="dropdown-container" id="dd" style="display:none"></div></div></div></form>
  <script>
    (function () {
      const inp = document.getElementById('location-input'), dd = document.getElementById('dd');
      let bursts = 0, last = '';
      inp.addEventListener('input', function () {
        if (inp.value.length === 1 && last.length !== 1) bursts++;
        last = inp.value;
        dd.innerHTML = ''; dd.style.display = 'none';
        if (inp.value.length < 3 || (${slow ? 'bursts < 2' : 'false'})) return;
        const q = inp.value.toLowerCase();
        ['Paris, Île-de-France, FRA', 'Paris, TX, USA', 'Paris, Ogooué et Lacs, Moyen-Ogooué, GAB'].filter(s => s.toLowerCase().startsWith(q)).forEach(s => {
          const d = document.createElement('div'); d.className = 'dropdown-location'; d.textContent = s;
          d.addEventListener('click', () => { inp.value = s; dd.style.display = 'none'; });
          dd.appendChild(d);
        });
        dd.style.display = 'block';
      });
    })();
  </script>`;

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });

  // ── a. UUIDs stripped from AI questions ──
  {
    const page = await b.newPage();
    await page.setContent('<!doctype html><html lang="en"><body></body></html>');
    await page.evaluate(STUB);
    for (const f of ['core/utils.js', 'core/job-board-strings.js', 'core/ai-form.js']) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });
    const r = await page.evaluate(() => {
      const s = window.EAM.aiForm.stripIdTokens;
      return [
        s('Additional Information f189fed2-624b-41a1-a76f-0c67a2611d1a f189fed2 624b 41a1 a76f 0c67a'),
        s('Why do you want to join us? 3f2c9a7be1d04c55a1b2c3d4e5f60718'),
        s('Do you have 5 years of experience with C++ and AWS?'),
        s('Have you worked with base64 or MD5 hashes like "deadbeef"?'),
      ];
    });
    T('Ashby "Additional Information <uuid> <uuid fragments>" → "Additional Information"', r[0] === 'Additional Information', r[0]);
    T('32-hex id stripped', r[1] === 'Why do you want to join us?', r[1]);
    T('normal question untouched', r[2] === 'Do you have 5 years of experience with C++ and AWS?', r[2]);
    T('short hex-looking words untouched', r[3] === 'Have you worked with base64 or MD5 hashes like "deadbeef"?', r[3]);
    await page.evaluate(async () => {
      try { await window.EAM.aiForm.askAI('Additional Information f189fed2-624b-41a1-a76f-0c67a2611d1a f189fed2 624b 41a1 a76f 0c67a', { firstName: 'T', email: 't@x.co', cvProfile: { experience: [] } }, 'textarea'); } catch (_) {}
    });
    const prompts = await page.evaluate(() => window.__prompts);
    const qLine = (prompts[0] || '').split('\n').find(l => /^Question:/.test(l)) || '';
    T('prompt sent to the AI has the clean question', prompts.length === 1 && qLine === 'Question: "Additional Information"', { n: prompts.length, qLine });
    await page.close();
  }

  // ── b. Lever location: slow suggestions retried; FR country → French Paris ──
  for (const [slow, label] of [[true, 'slow API (first typing lost)'], [false, 'normal']]) {
    const page = await b.newPage();
    await page.setContent(LEVER(slow));
    await page.evaluate(STUB);
    for (const f of ['core/utils.js', 'core/job-board-strings.js', 'core/form-filler.js', 'core/autofill.js']) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });
    const v = await page.evaluate(async () => {
      window.EAM.aiForm = { isPremiumBlocked: () => false, askAI: async () => null };
      try { await window.__eamAutofill({ firstName: 'Theo', lastName: 'T', email: 't@example.com', city: 'Paris', country: 'France', phoneCountryCode: '+33' }); } catch (e) { return 'THROW ' + e.message; }
      return document.getElementById('location-input').value;
    });
    T(`Lever location, ${label} → "Paris, Île-de-France, FRA"`, v === 'Paris, Île-de-France, FRA', v);
    await page.close();
  }

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
