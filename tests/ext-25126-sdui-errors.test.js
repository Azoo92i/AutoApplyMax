/**
 * ext v2.5.126 hotfix — "page before Review" step_limit (2.5.120 telemetry 2026-10-17 → 10-23: 168 step_limit skips /
 * 25 users in 7 days, btns Dismiss/Back/Review, errs=[] inv=0 empty=[]; paying IN user 19 step_limit vs 23 submits).
 * Root cause: on LinkedIn's native <dialog> (SDUI) Easy Apply, field messages are bare texts under the field. Only the
 * "This field is required" wording was recognised, so a filled-but-refused answer (number / format message) was never
 * seen, never repaired, and Review was clicked 10×.
 * Real DOM: two pages-before-Review captured live 2026-10-13 (tests/fixtures/linkedin-sdui-before-review-*.html).
 *   1. no false positive on the real pages (no error before the click), char counters / questions never errors
 *   2. number / format messages (EN + translations that keep "whole" / "decimal", as seen in ext_diag_events) under a
 *      field are errors, bound to their field; "This field is required" still detected
 *   3. repair: pay "4.5 LPA" in a number field → 450000 (same amount), LPA question → lakhs, whole-number field never
 *      rounded; yes/no asked as a number → 1
 *   4. page snapshot: unchanged page after a click is detected; new text under a field becomes an error only once armed
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25126-sdui-errors.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/').replace(/\/?$/, '/');
const FILES = ['core/utils.js', 'core/job-board-strings.js', 'core/ai-form.js', 'core/form-filler.js'];
const PAGE_A = fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-sdui-before-review-3of4.html'), 'utf8');
const PAGE_B = fs.readFileSync(path.join(__dirname, 'fixtures', 'linkedin-sdui-before-review-4of5.html'), 'utf8');

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
  await page.evaluate(() => {
    window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} }, sendMessage: (m, cb) => { cb && cb({ answer: 'skip' }); } },
      storage: { local: { get: (k, cb) => { cb && cb({ plan: 'free' }); return Promise.resolve({ plan: 'free' }); }, set: () => Promise.resolve(), remove: () => Promise.resolve() }, sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'en' } };
  });
  for (const f of FILES) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });
  await page.evaluate(() => { window.EAM.utils.isRunning = true; window.EAM.utils.userExplicitlyClickedStart = true; });

  const mount = (html) => page.evaluate((h) => {
    document.querySelectorAll('dialog').forEach(d => { try { d.close(); } catch (_) {} d.remove(); });
    const w = document.createElement('div'); w.innerHTML = h; const d = w.querySelector('dialog'); d.removeAttribute('open');
    document.getElementById('root').appendChild(d); d.showModal(); return true;
  }, html);

  // 1. real pages: nothing flagged
  for (const [name, html] of [['3/4 Y-VOIR', PAGE_A], ['4/5 Tech Riders', PAGE_B]]) {
    await mount(html);
    const n = await page.evaluate(() => window.EAM.FormFiller.fieldErrorElements(document.querySelector('dialog')).length);
    T(`real SDUI page ${name}: no error before any click`, n === 0, n);
  }
  const notErr = await page.evaluate(() => {
    const F = window.EAM.FormFiller;
    return ['1 of 20 characters', '0/20', 'Depuis combien d’années utilisez-vous Stratégie IT ?*', 'How many years of experience do you have with SAP?', 'Enter a number between 0 and 10 to rate your English?',
      'Résumé uploaded successfully', 'Your answers have been saved', 'Questions supplémentaires', '75 percent complete', '3/4 pages', 'Please enter your notice period in days*']
      .filter(t => F.isFormatErrMsg(t, null));
  });
  T('questions / counters / toasts are never format errors', notErr.length === 0, notErr);
  const isErr = await page.evaluate(() => {
    const F = window.EAM.FormFiller;
    // real messages from ext_diag_events (legacy forms) + the translated ones that keep the English token
    return ['Enter a decimal number larger than 0.0', 'Enter a whole number between 0 and 99', 'Enter a whole number larger than 100', 'Enter a decimal number between 0.0 and 9.9999998E12',
      '请输入whole编号 (长度介于 0 和 99 之间)', '0 - 99 arasında bir whole sayısı girin', 'إدخال رقم decimal أكبر من 0.0', 'Enter a valid number', 'Please enter a valid email address',
      'The answer must be a number', 'Veuillez saisir un nombre entier', 'Ingrese un número válido']
      .filter(t => !F.isFormatErrMsg(t, null));
  });
  T('number / format messages (EN + translated with whole/decimal) are errors', isErr.length === 0, isErr);

  // 2. a message under a field on the real page → error bound to that field; required message still detected
  await mount(PAGE_A);
  const bound = await page.evaluate(() => {
    const d = document.querySelector('dialog'); const F = window.EAM.FormFiller;
    const inp = d.querySelector('#_r_u_'); const info = d.querySelector('#_r_u_-info');
    const e = document.createElement('div'); e.innerHTML = '<p>Enter a whole number between 0 and 99</p>'; info.insertBefore(e, info.firstChild);
    const errs = F.fieldErrorElements(d); const det = F.validationErrorDetails(d);
    const req = document.createElement('p'); req.textContent = 'This field is required'; d.querySelector('#_r_v_-info').appendChild(req);
    const errs2 = F.fieldErrorElements(d).length;
    e.remove(); req.remove();
    return { n: errs.length, msg: det[0] && det[0].msg, label: det[0] && det[0].label, inp: !!inp, errs2 };
  });
  T('SDUI numeric message under "Transformation numérique" detected with its question', bound.n === 1 && /whole number/.test(bound.msg) && /Transformation num/.test(bound.label), bound);
  T('"This field is required" still detected next to it', bound.errs2 === 2, bound);
  const footerMsg = await page.evaluate(() => {
    const d = document.querySelector('dialog'); const F = window.EAM.FormFiller;
    const p = document.createElement('p'); p.textContent = 'Enter a valid answer to continue'; d.querySelector('footer').appendChild(p);
    const n = F.fieldErrorElements(d).length; p.remove(); return n;
  });
  T('a format-like text in the footer (no field) is not a field error', footerMsg === 0, footerMsg);

  // 3. repair
  const rep = await page.evaluate(async () => {
    const F = window.EAM.FormFiller; const d = document.querySelector('dialog');
    const out = {};
    const setQ = (q, val, msg) => {
      const inp = d.querySelector('#_r_u_'); inp.setAttribute('aria-label', q);
      const qp = inp.closest('[componentkey]').previousElementSibling; qp.textContent = q + '*';
      window.EAM.utils.fill(inp, val);
      const info = d.querySelector('#_r_u_-info'); info.querySelectorAll('[data-t]').forEach(x => x.remove());
      const e = document.createElement('div'); e.setAttribute('data-t', '1'); e.innerHTML = '<p>' + msg + '</p>'; info.insertBefore(e, info.firstChild);
      return inp;
    };
    let inp = setQ('What is your current CTC?', '4.5 LPA', 'Enter a decimal number larger than 0.0');
    out.ctc = (await F.repairValidationErrors(d, { currentSalary: '4.5 LPA', country: 'IN' })).fixed + ':' + inp.value;
    inp = setQ('What is your current CTC in LPA?', '4.5 LPA', 'Enter a decimal number larger than 0.0');
    out.lpa = (await F.repairValidationErrors(d, { currentSalary: '4.5 LPA', country: 'IN' })).fixed + ':' + inp.value;
    inp = setQ('What is your current CTC in LPA?', '4.5 LPA', 'Enter a whole number between 0 and 99');
    out.lpaWhole = (await F.repairValidationErrors(d, { currentSalary: '4.5 LPA', country: 'IN' })).fixed + ':' + inp.value;
    inp = setQ('What is your expected monthly salary?', '6000000 INR', 'Enter a whole number larger than 100');
    out.monthly = (await F.repairValidationErrors(d, { expectedSalary: '6000000 INR', country: 'IN' })).fixed + ':' + inp.value;
    inp = setQ('Have you managed a SAP rollout?', 'Yes', 'Enter a whole number between 0 and 99');
    out.yesno = (await F.repairValidationErrors(d, {})).fixed + ':' + inp.value;
    inp = setQ('What is your current CTC?', 'ask me', 'The answer must be a number');
    out.noSetting = (await F.repairValidationErrors(d, {})).fixed + ':' + inp.value;
    d.querySelector('#_r_u_-info').querySelectorAll('[data-t]').forEach(x => x.remove());
    return out;
  });
  T('repair: "4.5 LPA" current CTC in a number field → 450000', rep.ctc === '1:450000', rep);
  T('repair: LPA question → 4.5 lakhs', rep.lpa === '1:4.5', rep);
  T('repair: LPA question + whole-number field → never rounded (left, form_invalid)', rep.lpaWhole === '0:4.5 LPA', rep);
  T('repair: yearly "6000000 INR" for a monthly question → 500000', rep.monthly === '1:500000', rep);
  T('repair: yes/no asked as a number → 1', rep.yesno === '1:1', rep);
  T('repair: no CTC setting → never invented', rep.noSetting === '0:ask me', rep);

  // 4. snapshot / new text after an unchanged click
  const snap = await page.evaluate(() => {
    const F = window.EAM.FormFiller; const d = document.querySelector('dialog'); const r = {};
    F.clearClickSnapshot(); F.snapshotBeforeClick(d);
    r.same0 = F.samePageAsSnapshot(d);
    const info = d.querySelector('#_r_t_-info'); const e = document.createElement('div'); e.innerHTML = '<p>Antwort ungültig – nur Ziffern</p>'; info.insertBefore(e, info.firstChild);
    r.notArmed = F.fieldErrorElements(d).length;            // unknown wording, not armed → not an error (1st click)
    r.nt = F.newTextsAfterClick(d).map(x => x.text);
    F.snapshotBeforeClick(d);                                 // 2nd click on the same page keeps the first snapshot
    r.armed = F.armNewTextErrors(d);
    r.errs = F.validationErrorDetails(d).map(x => x.msg + ' | ' + x.label);
    e.remove();
    // page moved (progress changed) → nothing
    const pg = [...d.querySelectorAll('p')].find(p => /3\/4 pages/.test(p.textContent)); pg.textContent = '4/4 pages';
    r.moved = F.samePageAsSnapshot(d); r.ntMoved = F.newTextsAfterClick(d).length; pg.textContent = '3/4 pages';
    F.clearClickSnapshot();
    return r;
  });
  T('snapshot: same page right after the snapshot', snap.same0 === true, snap);
  T('unknown wording not an error before the 2nd unchanged click', snap.notArmed === 0, snap);
  T('new text under a field reported (telemetry nt)', snap.nt.length === 1 && /ungültig/.test(snap.nt[0]), snap);
  T('armed from the 2nd unchanged click: unknown message = error with its question', snap.armed && snap.errs.length === 1 && /Stratégie IT/.test(snap.errs[0]), snap);
  T('page moved → never armed / no new-text errors', snap.moved === false && snap.ntMoved === 0, snap);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
