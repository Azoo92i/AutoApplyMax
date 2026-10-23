/**
 * ext v2.5.126 hotfix — yes/no policy (Théo 2026-10-23: "Forcer oui si pas d'IA (sauf si on sait que non) et IA
 * choisi le oui non"). Live gate g126 (Powerdot): "classe préparatoire ?", "top grande école d'ingénieur ?",
 * "Did you attend CentraleSupélec, Polytechnique, Mines…?" → Yes for a DUT GEA + ICN Business School profile.
 *   1. PREMIUM (AI answers): the AI's Yes / No is applied as-is (the 2.5.116 overrule of an AI "No" is gone);
 *      leanYes no longer flips an AI / cached "No".
 *   2. FREE / no AI: Oui is forced unless the CV says No (knownNoFromProfile: named school / school type / specific
 *      degree / named employer not in the CV); no education data = unknown = Oui.
 *   3. Pre-filled answers: a saved "Oui" to a school the CV does not show → "Non"; a saved "Non" to a skill → "Oui".
 *   4. Opt-ins stay No (unchanged).
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25126-yesno-ai-choice.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/').replace(/\/?$/, '/');
const FILES = ['core/utils.js', 'core/job-board-strings.js', 'core/ai-form.js', 'core/form-filler.js'];

const THEO = { firstName: 'Theo', lastName: 'Test', city: 'Paris', noticePeriod: '1 month', cvProfile: {
  education: [{ degree: 'Triple Diplôme Master – Management, Finance & Business International', school: 'ICN Business School, France' },
    { degree: 'DUT Gestion des Entreprises et des Administrations', school: 'Université de Lille, France' }],
  experience: [{ title: 'Stagiaire Stratégie', company: 'Google' }, { title: 'Co-Fondateur', company: 'SHINE' }], skills: ['Excel', 'SQL'] } };
const XGRAD = { ...THEO, cvProfile: { ...THEO.cvProfile, education: [{ degree: "Diplôme d'ingénieur", school: 'École Polytechnique' }, { degree: 'Classe préparatoire MP*', school: 'Lycée Louis-le-Grand' }] } };
const NOEDU = { ...THEO, cvProfile: { ...THEO.cvProfile, education: [] } };
const PREPA = 'Avez-vous fait une classe préparatoire aux grandes écoles ?';
const TOPX = "Avez-vous intégré une top grande école d'ingénieur ?";
const CENTRALE = 'Did you attend CentraleSupélec, Polytechnique, Mines ParisTech or Ponts ParisTech?';

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  await page.setContent('<!doctype html><html lang="fr"><body><div id="root"></div></body></html>');
  await page.evaluate(() => {
    window.__plan = 'free';
    window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} }, sendMessage: (m, cb) => { cb && cb({ answer: 'skip' }); } },
      storage: { local: { get: (k, cb) => { const r = { plan: window.__plan, isPremium: window.__plan !== 'free' }; cb && cb(r); return Promise.resolve(r); }, set: () => Promise.resolve(), remove: () => Promise.resolve() }, sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'fr' } };
  });
  for (const f of FILES) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });
  await page.evaluate(() => { window.EAM.utils.isRunning = true; window.EAM.utils.userExplicitlyClickedStart = true; window.__realAskAI = window.EAM.aiForm.askAI; });

  // One yes/no radio group; plan + AI answer mocked; returns the checked label (or '').
  const radio = (q, config, { plan = 'free', ai = null, pre = null, yes = 'Oui', no = 'Non' } = {}) => page.evaluate(async ({ q, config, plan, ai, pre, yes, no }) => {
    window.__plan = plan;
    window.__aiCalls = 0;
    window.EAM.aiForm.askAI = async () => { window.__aiCalls++; return ai; };
    const root = document.getElementById('root');
    root.innerHTML = `<div class="m"><fieldset><legend><span>${q}</span></legend>
      <div><input type="radio" id="y" name="g" value="${yes}"${pre === 'yes' ? ' checked' : ''}><label for="y">${yes}</label></div>
      <div><input type="radio" id="n" name="g" value="${no}"${pre === 'no' ? ' checked' : ''}><label for="n">${no}</label></div></fieldset></div>`;
    await window.EAM.FormFiller.fillRadioButtons(root.querySelector('.m'), config);
    const c = root.querySelector('input:checked');
    return { picked: c ? c.value : '', aiCalls: window.__aiCalls };
  }, { q, config, plan, ai, pre, yes, no });

  const FF = (fn, ...args) => page.evaluate(([fn, args]) => window.EAM.FormFiller[fn](...args), [fn, args]);

  // knownNoFromProfile
  for (const q of [PREPA, TOPX, CENTRALE]) T(`knownNo(Théo, "${q.slice(0, 40)}")`, !!(await FF('knownNoFromProfile', q, THEO)));
  for (const q of [PREPA, TOPX, CENTRALE]) T(`not knownNo (Polytechnique grad, "${q.slice(0, 40)}")`, !(await FF('knownNoFromProfile', q, XGRAD)));
  T('no education data → unknown (not known No)', !(await FF('knownNoFromProfile', PREPA, NOEDU)));
  T('skill question is never a known No', !(await FF('knownNoFromProfile', 'Do you have experience with Salesforce CPQ?', THEO)));
  T('business school question with ICN → not known No', !(await FF('knownNoFromProfile', 'Did you graduate from a business school?', THEO)));
  T('named employer Powerdot not in CV → known No', !!(await FF('knownNoFromProfile', 'Have you worked at Powerdot?', THEO)));
  T('named employer Google in CV → not known No', !(await FF('knownNoFromProfile', 'Have you worked at Google?', THEO)));

  // FREE / no AI
  let r;
  r = await radio(PREPA, THEO); T('free: Théo prépa → Non (known No), no AI call', r.picked === 'Non' && r.aiCalls === 0, r);
  r = await radio(TOPX, THEO); T('free: Théo top grande école d\'ingénieur → Non', r.picked === 'Non', r);
  r = await radio(CENTRALE, THEO, { yes: 'Yes', no: 'No' }); T('free: Théo Centrale/Polytechnique → No', r.picked === 'No', r);
  r = await radio(CENTRALE, XGRAD, { yes: 'Yes', no: 'No' }); T('free: Polytechnique grad → Yes', r.picked === 'Yes', r);
  r = await radio('Avez-vous une expérience avec Salesforce CPQ ?', THEO); T('free: skill not in CV → forced Oui', r.picked === 'Oui' && r.aiCalls === 0, r);
  r = await radio(PREPA, NOEDU); T('free: no education data → forced Oui', r.picked === 'Oui', r);
  r = await radio('Would you like to receive job alerts by email?', THEO, { yes: 'Yes', no: 'No' }); T('free: opt-in → No (unchanged)', r.picked === 'No', r);

  // PREMIUM (AI answers)
  r = await radio('Do you have experience with Salesforce CPQ?', THEO, { plan: 'premium', ai: 'No', yes: 'Yes', no: 'No' });
  T('premium: AI "No" on a skill question → No (no overrule)', r.picked === 'No' && r.aiCalls === 1, r);
  r = await radio('Do you have experience with Excel?', THEO, { plan: 'premium', ai: 'Yes', yes: 'Yes', no: 'No' });
  T('premium: AI "Yes" → Yes', r.picked === 'Yes', r);
  r = await radio('Avez-vous une expérience en cabinet de conseil ?', THEO, { plan: 'premium', ai: 'skip' });
  T('premium: AI "skip" → Oui default', r.picked === 'Oui', r);
  r = await radio(PREPA, THEO, { plan: 'premium', ai: 'Oui' });
  T('premium: Théo prépa → Non even if the AI said Oui (known No first, no AI call)', r.picked === 'Non' && r.aiCalls === 0, r);
  r = await radio(CENTRALE, XGRAD, { plan: 'premium', ai: 'Yes', yes: 'Yes', no: 'No' });
  T('premium: Polytechnique grad → Yes', r.picked === 'Yes', r);

  // Pre-filled (LinkedIn saved answers)
  r = await radio(PREPA, THEO, { pre: 'yes' }); T('pre-filled "Oui" to prépa (Théo) → corrected to Non', r.picked === 'Non', r);
  r = await radio('Avez-vous une expérience avec Salesforce CPQ ?', THEO, { pre: 'no' }); T('pre-filled "Non" to a skill → Oui (no-AI Oui rule kept)', r.picked === 'Oui', r);
  r = await radio(CENTRALE, XGRAD, { pre: 'yes', yes: 'Yes', no: 'No' }); T('pre-filled "Yes" for a Polytechnique grad stays Yes', r.picked === 'Yes', r);

  // leanYes is a pass-through now
  const ly = await page.evaluate(() => [window.EAM.aiForm.leanYes('Do you have experience with X?', 'radio', ['Yes', 'No'], 'No'), window.EAM.aiForm.leanYes('Do you know X?', 'text', [], 'Non')]);
  T('leanYes no longer flips an AI / cached "No"', ly[0] === 'No' && ly[1] === 'Non', ly);
  // prompt text: no "always Yes" rule left
  const src = fs.readFileSync(ROOT + 'core/ai-form.js', 'utf8');
  T('ai-form prompt: truthful YES/NO rule, no "the rule for this candidate is to answer Yes"', /YES\/NO QUESTIONS \(2\.5\.126\): choose "Yes" or "No" TRUTHFULLY/.test(src) && !/the rule for this candidate is to answer "Yes"/.test(src) && !/never "No" for a capability/.test(src));
  T('AI cache version bumped (stale flipped answers dropped)', /const CACHE_VERSION = 4;/.test(src));

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
