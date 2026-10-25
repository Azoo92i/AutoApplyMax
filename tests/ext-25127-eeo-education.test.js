/**
 * ext v2.5.127 — bug report 2026-10-22 (free US user, LinkedIn Easy Apply "Apply to Justworks", ext 2.5.120):
 *   - "Are you a veteran?", "Are you a spouse or domestic partner to a veteran?", "Would you describe yourself as
 *     transgender?", "Voluntary self-identification of disability" → "Yes" (free-path Oui default)
 *   - gender identity / sexual orientation / ethnicity checkbox groups left blank
 *   - "Please select the highest level of education…" radios → "GED or high school diploma" for a Master's profile
 * + ops alert 2026-10-25 (premium FR): "Quel est votre plus haut niveau de diplôme obtenu ?" text field, AI empty → skip.
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25127-eeo-education.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/').replace(/\/?$/, '/');
const FILES = ['core/utils.js', 'core/job-board-strings.js', 'core/ai-form.js', 'core/form-filler.js'];

const ALAY = { firstName: 'Alay', lastName: 'Test', city: 'Dallas', country: 'US', cvProfile: {
  education: [{ degree: 'Master of Science, Computer Science', school: 'University of Texas at Arlington' },
    { degree: 'Bachelor of Engineering, Computer Engineering', school: 'Gujarat Technological University (GTU)' }],
  experience: [{ title: 'Software Engineer', company: 'Acme' }], skills: ['Java'] } };
const ALAY_M = { ...ALAY, gender: 'male' };
const NOEDU = { ...ALAY, cvProfile: { ...ALAY.cvProfile, education: [] } };
const THEO = { firstName: 'Theo', city: 'Paris', cvProfile: { education: [{ degree: 'MBA (Management International)', school: 'ICN Business School' }], experience: [], skills: [] } };
const YND = ['Yes', 'No', "I don't wish to answer"];
const EDU_OPTS = ['GED or high school diploma', 'Apprenticeship, boot camp, and/or professional certificate', "Associate's", "Bachelor's", "Master's, JD, and/or PhD", "I don't wish to answer"];
const GENDER_OPTS = ['Female', 'Gender nonconforming', 'Gender fluid', 'Gender queer', 'Intersex', 'Male', 'Nonbinary', 'Transitioning', 'I prefer to self-describe', "I don't wish to answer"];
const ORIENT_OPTS = ['Asexual', 'Bisexual', 'Gay', 'Heterosexual', 'Lesbian', 'Pansexual', 'Same-gender loving', 'Queer', 'Questioning', 'I prefer to self-describe', "I don't wish to answer"];
const ETH_OPTS = ['Black (including African-American)', 'East Asian (including Chinese, Japanese, Korean, Mongolian, Tibetan, and Taiwanese)', 'Hispanic, Latino/a or Latinx', 'Middle Eastern or North African', 'South Asian', 'White', "I don't wish to answer"];

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  await page.setContent('<!doctype html><html lang="en"><body><div id="root"></div></body></html>');
  await page.evaluate(() => {
    window.__plan = 'free';
    window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} }, sendMessage: (m, cb) => { cb && cb({ answer: 'skip' }); } },
      storage: { local: { get: (k, cb) => { const r = { plan: window.__plan, isPremium: window.__plan !== 'free' }; cb && cb(r); return Promise.resolve(r); }, set: () => Promise.resolve(), remove: () => Promise.resolve() }, sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'en' } };
  });
  for (const f of FILES) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });
  await page.evaluate(() => { window.EAM.utils.isRunning = true; window.EAM.utils.userExplicitlyClickedStart = true; });

  // One radio group (LinkedIn-like fieldset/legend); plan + AI mocked; returns the checked label.
  const radio = (q, opts, config, { plan = 'free', ai = 'Yes', pre = -1 } = {}) => page.evaluate(async ({ q, opts, config, plan, ai, pre }) => {
    window.__plan = plan;
    window.EAM.aiForm.askAI = async () => ai;
    const root = document.getElementById('root');
    root.innerHTML = `<div class="m"><fieldset><legend><span>${q}</span></legend>${opts.map((o, i) =>
      `<div><input type="radio" id="r${i}" name="g" value="${o.replace(/"/g, '&quot;')}"${i === pre ? ' checked' : ''}><label for="r${i}">${o}</label></div>`).join('')}</fieldset></div>`;
    await window.EAM.FormFiller.fillRadioButtons(root.querySelector('.m'), config);
    const c = root.querySelector('input:checked');
    return c ? c.value : '';
  }, { q, opts, config, plan, ai, pre });
  const FF = (fn, ...args) => page.evaluate(([fn, args]) => window.EAM.FormFiller[fn](...args), [fn, args]);

  const VET = 'Veteran status | Are you a veteran?*';
  const SPOUSE = 'Are you a spouse or domestic partner to a veteran?*';
  const TRANS = 'Would you describe yourself as transgender?*';
  const DISAB = 'Voluntary self-identification of disability | Please select*';
  const DISAB_OPTS = ['Yes, I have a disability, or have a history/record of having a disability', "No, I don't have a disability, or a history/record of having a disability", "I don't wish to answer"];
  const EDUQ = 'Educational and learning experiences | We understand that folks gain expertise and knowledge through a variety of means. So, how did you get to know what you know?! Please select the highest level of education or training that you have*';

  for (const plan of ['free', 'premium']) {
    T(`[${plan}] veteran → No`, (await radio(VET, YND, ALAY, { plan })) === 'No');
    T(`[${plan}] spouse of veteran → No`, (await radio(SPOUSE, YND, ALAY, { plan })) === 'No');
    T(`[${plan}] transgender → No`, (await radio(TRANS, YND, ALAY, { plan })) === 'No');
    T(`[${plan}] disability → No, I don't…`, (await radio(DISAB, DISAB_OPTS, ALAY, { plan })).startsWith('No,'));
    T(`[${plan}] saved "Yes" veteran corrected → No`, (await radio(VET, YND, ALAY, { plan, pre: 0 })) === 'No');
    T(`[${plan}] education radios → Master's`, (await radio(EDUQ, EDU_OPTS, ALAY, { plan })).startsWith("Master's"));
    T(`[${plan}] education radios, saved GED → Master's`, (await radio(EDUQ, EDU_OPTS, ALAY, { plan, pre: 0 })).startsWith("Master's"));
    T(`[${plan}] education radios, no CV degree → decline (never GED)`, (await radio(EDUQ, EDU_OPTS, NOEDU, { plan })) === "I don't wish to answer");
  }
  T('veteran without a No option → decline', (await radio(VET, ['Yes', 'I prefer not to say'], ALAY)) === 'I prefer not to say');
  T('veteran "I am not a protected veteran"', (await radio('Veteran status*', ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', "I don't wish to answer"], ALAY)) === 'I am not a protected veteran');

  // Non-EEO questions keep the Oui rule (no regression).
  T('Oui rule kept: "experience supporting people with disabilities?"', (await radio('Do you have experience supporting people with disabilities?', ['Yes', 'No'], ALAY)) === 'Yes');
  T('Oui rule kept: "Do you have experience with Java?"', (await radio('Do you have experience with Java?', ['Yes', 'No'], ALAY)) === 'Yes');
  T('Oui rule kept: "experience working with veterans?"', (await radio('Do you have experience working with veterans?', ['Yes', 'No'], ALAY)) === 'Yes');

  // Checkbox groups
  const cb = async (q, opts, config) => (await FF('checkboxGroupPicks', q, opts, config)).map(i => opts[i]);
  const GQ = 'Beyond the binary | We understand that gender expression and identity should not be conflated. What is your gender identity?*';
  T('gender identity checkboxes, no gender set → decline', JSON.stringify(await cb(GQ, GENDER_OPTS, ALAY)) === JSON.stringify(["I don't wish to answer"]), await cb(GQ, GENDER_OPTS, ALAY));
  T('gender identity checkboxes, gender male → Male', JSON.stringify(await cb(GQ, GENDER_OPTS, ALAY_M)) === JSON.stringify(['Male']), await cb(GQ, GENDER_OPTS, ALAY_M));
  T('sexual orientation → decline', JSON.stringify(await cb('Love is love | What is your sexual orientation?*', ORIENT_OPTS, ALAY)) === JSON.stringify(["I don't wish to answer"]));
  T('ethnicity → decline', JSON.stringify(await cb('Ethnicity and race | Race is a social construct and no group is a monolith. How would you describe yourself? *', ETH_OPTS, ALAY)) === JSON.stringify(["I don't wish to answer"]));

  // eduRankOption
  T('eduRankOption("Master\'s, JD, and/or PhD") = 5', (await FF('eduRankOption', "Master's, JD, and/or PhD")) === 5);
  T('eduRankOption("Bac+5 (Master, école d\'ingénieur)") = 5', (await FF('eduRankOption', "Bac+5 (Master, école d'ingénieur)")) === 5);
  T('eduRankOption("Doctorat / PhD") = 8', (await FF('eduRankOption', 'Doctorat / PhD')) === 8);
  T('eduRankOption("GED or high school diploma") = 1', (await FF('eduRankOption', 'GED or high school diploma')) === 1);

  // Text field (ops alert 2026-10-25)
  const det = await FF('deterministicTextAnswer', 'Quel est votre plus haut niveau de diplôme obtenu ?', THEO);
  T('text "plus haut niveau de diplôme" → CV degree', /MBA/.test(det || ''), det);
  const det2 = await FF('deterministicTextAnswer', "Avez-vous le niveau d'études requis : Maîtrise ?", THEO);
  T('yes/no "niveau d\'études requis" text not answered with the degree', det2 == null || !/MBA/.test(det2), det2);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
