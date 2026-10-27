/**
 * ext v2.5.130 — premium "how many years of X" (Théo 2026-10-27, final: "Mets le nombre d'années de base, il faut quand
 * même booster. Si déjà enregistré sur LinkedIn, garde la réponse de base. Réponds avec les années totales sauf pour les
 * choses vraiment spécifiques").
 * Live run 2026-10-27 (C:/AAM/scratchpad/g126/run_daily/20261027/hold_*.txt): every "Depuis combien d'années
 * utilisez-vous X ?" got the total 3 for a consultant / project manager — C++, Python, Titrisation, Summit, SAP…
 *   1. FREE / no AI: unchanged (total years with the default toggle).
 *   2. PREMIUM: total years (the boost), EXCEPT a really specific item (language / software / ERP / platform /
 *      regulation / niche) absent from the CV → 1 (never 0). Broad skills, functions, sectors → total. In the CV → the
 *      default answer (the specific term alone counts: "Base de données SQL" with SQL in the CV).
 *   3. Specific vs broad = lists; the AI is asked SPECIFIC / BROAD only for an unknown item, once (cached).
 *   4. LinkedIn-saved values are kept (never lowered; a saved 0 for a specific absent item → 1).
 *   5. Toggle "answer with my total years" OFF → per-skill CV years (both plans), the specific rule still applies.
 *   6. Universal autofill (askAI years guard), years-range radios and selects follow the same rule.
 * Usage: EXT_DIR=C:/CleanExt-hotfix126/chrome-store-release NODE_PATH=C:/AAM/node_modules node tests/ext-25130-premium-years-ai.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = (process.env.EXT_DIR || path.join(__dirname, '..', 'chrome-store-release')).replace(/\\/g, '/').replace(/\/?$/, '/');
const FILES = ['core/utils.js', 'core/job-board-strings.js', 'core/ai-form.js', 'core/form-filler.js'];

// Théo-like profile: 3 years total, consulting / project management / business development, no coding role.
const THEO = { firstName: 'Theo', lastName: 'Test', city: 'Paris', yearsOfExperience: '3', skillYearsAsTotal: true, cvProfile: {
  summary: 'Consultant and project manager with international experience (Shanghai, Milan).',
  experience: [
    { title: 'Consultant', company: 'Freelance', duration: '09/2024 – Present', bullets: ['Project management and change management for SME clients', 'Excel / Power BI reporting for finance teams'] },
    { title: 'Co-Fondateur & Directeur Événementiel', company: 'SHINE', duration: 'Sep 2023 – Jul 2024', bullets: ['Organised 30 events for international students in Shanghai'] },
    { title: 'Stagiaire Stratégie & Opérations', company: 'Google', duration: 'Apr 2023 – Aug 2023', bullets: ['Built Excel / Tableau dashboards for the sales team'] },
  ],
  skills: ['Excel Avancé', 'SQL', 'Tableau', 'Power BI', 'Salesforce', 'Agile/Scrum', 'Conduite du Changement', 'Analyse Financière', 'Gestion de projet'],
  education: [{ degree: 'Triple Diplôme Master – Management, Finance & Business International', school: 'ICN Business School' }] } };

// [question of the 27/10 run, expected premium answer] (total 3)
const HOLD = [
  ['Depuis combien d’années utilisez-vous C++ ?', 1], ['Depuis combien d’années utilisez-vous Python (langage de programmation) ?', 1], ['Depuis combien d’années utilisez-vous HTML ?', 1],
  ['Depuis combien d’années utilisez-vous Titrisation ?', 1], ['Depuis combien d’années utilisez-vous Solvabilité II ?', 1], ['Depuis combien d’années utilisez-vous Summit ?', 1],
  ['Depuis combien d’années utilisez-vous Produits SAP ?', 1], ['How many years of work experience do you have with SAP Products?', 1], ['Depuis combien d’années utilisez-vous NetSuite ?', 1],
  ['Depuis combien d’années utilisez-vous ERP Microsoft Dynamics ?', 1], ['How many years of work experience do you have with Microsoft Azure?', 1], ['Depuis combien d’années utilisez-vous Adobe Photoshop ?', 1],
  ['Depuis combien d’années utilisez-vous Canva ?', 1], ['Depuis combien d’années utilisez-vous JIRA ?', 1], ['Depuis combien d’années utilisez-vous Suite Atlassian ?', 1],
  ['Depuis combien d’années utilisez-vous Monétique ?', 1], ['Depuis combien d’années utilisez-vous Gestion actif-passif ?', 1], ['How many years of experience in IoT Service?', 1],
  ['Depuis combien d’années utilisez-vous ou have with Jav ?', 1], ['Depuis combien d’années utilisez-vous ou have with Linu ?', 1],
  // in the CV (the specific term alone counts) → default total
  ['Depuis combien d’années utilisez-vous SQL ?', 3], ['Depuis combien d’années utilisez-vous Base de données SQL ?', 3], ['Depuis combien d’années utilisez-vous ou have with SQ ?', 3],
  ['How many years of work experience do you have with Salesforce Sales Cloud?', 3], ['How many years of work experience do you have with Salesforce.com?', 3],
  // broad → total
  ['Depuis combien d’années utilisez-vous Gestion de projet ?', 3], ['Combien d’années d’expérience avez-vous en tant que Conseil ?', 3], ['Combien d’années d’expérience avez-vous en tant que Finance ?', 3],
  ['How many years of experience in Business analyst?', 3], ['Depuis combien d’années utilisez-vous Gestion budgétaire ?', 3], ['Depuis combien d’années utilisez-vous Microsoft Excel ?', 3],
  ['Depuis combien d’années utilisez-vous Microsoft Office ?', 3], ['Depuis combien d’années utilisez-vous Comptabilité ?', 3], ['Depuis combien d’années utilisez-vous Crédit corporate ?', 3],
  ['Depuis combien d’années utilisez-vous Order to Cash ?', 3], ['Depuis combien d’années utilisez-vous Transformation financière ?', 3], ['Depuis combien d’années utilisez-vous Consolidation comptable ?', 3],
  ['Depuis combien d’années utilisez-vous Marchés financiers ?', 3], ['Depuis combien d’années utilisez-vous Formation utilisateur ?', 3], ['Depuis combien d’années utilisez-vous Déploiement logiciel ?', 3],
  ['How many years of work experience do you have with Databases?', 3], ['Depuis combien d’années travaillez vous sur des sujets digitaux achats ?', 3],
  ['Combien d’années d’expérience avez-vous dans ce secteur (Assurances) ?', 3], ['Combien d’années d’expérience avez-vous dans ce secteur (Banques d’investissement) ?', 3],
  ['Combien d’années d’expérience professionnelle avez-vous en Product Ownership ou gestion de produits IA ?', 3],
];

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  await page.setContent('<!doctype html><html lang="fr"><body><div id="root"></div></body></html>');
  await page.evaluate(() => {
    window.__plan = 'free'; window.__prompts = []; window.__reply = () => ({ answer: 'BROAD' }); window.__store = {};
    window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} },
        sendMessage: (m, cb) => { if (m && m.type === 'ai-form-answer') { window.__prompts.push(m); const r = window.__reply(m.prompt); setTimeout(() => cb && cb(r), 0); } else cb && cb({}); } },
      storage: { local: { get: (k, cb) => { const r = { plan: window.__plan, isPremium: window.__plan !== 'free', ...window.__store }; cb && cb(r); return Promise.resolve(r); }, set: (o) => { Object.assign(window.__store, o); return Promise.resolve(); }, remove: () => Promise.resolve() }, sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'fr' } };
  });
  for (const f of FILES) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });
  await page.evaluate(() => { window.EAM.utils.isRunning = true; window.EAM.utils.userExplicitlyClickedStart = true; });

  const field = (q, config, { plan = 'free', reply = 'BROAD', pre = '', type = 'text', fresh = true, err = null } = {}) => page.evaluate(async ({ q, config, plan, reply, pre, type, fresh, err }) => {
    window.__plan = plan; window.__prompts = [];
    if (fresh) { window.__store = {}; await window.EAM.aiForm.clearCache(); }
    window.__reply = () => (err ? { error: err } : { answer: reply });
    const root = document.getElementById('root');
    root.innerHTML = `<div class="m"><div><label for="i">${q}</label><input type="${type}" id="i" value="${pre}"></div></div>`;
    await window.EAM.FormFiller.fillTextInputs(root.querySelector('.m'), config);
    return { value: root.querySelector('#i').value, calls: window.__prompts.length, prompt: (window.__prompts[0] || {}).prompt || '', temp: (window.__prompts[0] || {}).temperature };
  }, { q, config, plan, reply, pre, type, fresh, err });
  const FF = (fn, ...args) => page.evaluate(([fn, args]) => window.EAM.FormFiller[fn](...args), [fn, args]);

  // classifier
  for (const it of ['C++', 'Python (langage de programmation)', 'Produits SAP', 'Summit', 'Salesforce Sales Cloud', 'NetSuite', 'Adobe Photoshop', 'Titrisation', 'Solvabilité II', 'Gestion actif-passif', 'Monétique', 'Jav', 'ERP Microsoft Dynamics'])
    T(`kind "${it}" = specific`, (await FF('yearsItemKind', it)) === 'specific');
  for (const it of ['Gestion de projet', 'Conseil', 'Finance', 'Business analyst', 'Gestion budgétaire', 'Microsoft Excel', 'Microsoft Office', 'Comptabilité', 'Marchés financiers', 'Order to Cash', 'Gestion d’actifs', 'Databases'])
    T(`kind "${it}" = broad`, (await FF('yearsItemKind', it)) === 'broad');
  T('kind "R&D" is not specific (no bare "R" language match)', (await FF('yearsItemKind', 'R&D')) !== 'specific');
  T('kind "Dimension" = unknown (→ AI)', (await FF('yearsItemKind', 'Dimension')) === '');

  let r;
  // 1. FREE unchanged
  const freeBad = [];
  for (const [q] of HOLD) { const x = await field(q, THEO); if (x.value !== '3' || x.calls) freeBad.push({ q, ...x }); }
  T(`free: all ${HOLD.length} questions of the 27/10 run → 3, no AI call`, !freeBad.length, freeBad.slice(0, 3));

  // 2. PREMIUM
  const premBad = [];
  for (const [q, want] of HOLD) { const x = await field(q, THEO, { plan: 'premium' }); if (x.value !== String(want)) premBad.push({ q, want, ...x }); }
  T(`premium: the ${HOLD.length} questions → 1 for specific items absent from the CV, 3 otherwise`, !premBad.length, premBad.slice(0, 4));
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO, { plan: 'premium' }); T('premium: C++ decided by the lists (no AI call)', r.value === '1' && r.calls === 0, r);
  r = await field('Depuis combien d’années utilisez-vous SQL ?', THEO, { plan: 'premium', type: 'number' }); T('premium (number input): SQL in the CV → 3', r.value === '3' && r.calls === 0, r);
  r = await field('How many years of work experience do you have?', THEO, { plan: 'premium' }); T('premium: generic years question → total 3', r.value === '3' && r.calls === 0, r);
  r = await field('Depuis combien d’années utilisez-vous C++ ?', { ...THEO, yearsOfExperience: '0', accountYears: 0, cvProfile: { ...THEO.cvProfile, experience: [{ title: 'Stagiaire', company: 'X', duration: 'Jan 2026 – Mar 2026' }] } }, { plan: 'premium' });
  T('premium: total 0 → specific absent still 1 (never 0)', r.value === '1', r);
  r = await field('Depuis combien d’années utilisez-vous C++ ?', { ...THEO, cvProfile: { ...THEO.cvProfile, experience: [] } }, { plan: 'premium' }); T('premium without CV roles → default 3', r.value === '3' && r.calls === 0, r);
  const DEV = { ...THEO, cvProfile: { ...THEO.cvProfile, experience: [{ title: 'Développeur C++', company: 'Thales', duration: '01/2024 – Present', bullets: ['Moteur temps réel en C++'] }, ...THEO.cvProfile.experience] } };
  r = await field('Depuis combien d’années utilisez-vous C++ ?', DEV, { plan: 'premium' }); T('premium: C++ in a role → default 3', r.value === '3', r);

  // 3. AI only for unknown items, cached, temperature 0
  r = await field('Depuis combien d’années utilisez-vous Dimension ?', THEO, { plan: 'premium', reply: 'SPECIFIC' });
  T('premium: unknown "Dimension" → AI SPECIFIC → 1 (temperature 0, classification prompt)', r.value === '1' && r.calls === 1 && r.temp === 0 && /SPECIFIC or BROAD/.test(r.prompt) && /\nQuestion: "Dimension"\nAnswer:$/.test(r.prompt), { ...r, prompt: r.prompt.slice(-120) });
  r = await field('How many years have you used Dimension?', THEO, { plan: 'premium', reply: 'BROAD', fresh: false }); T('AI kind cached per item (no 2nd call)', r.value === '1' && r.calls === 0, r);
  r = await field('Depuis combien d’années utilisez-vous Dimension ?', THEO, { plan: 'premium', reply: 'BROAD' }); T('premium: unknown item → AI BROAD → 3', r.value === '3' && r.calls === 1, r);
  r = await field('Depuis combien d’années utilisez-vous Dimension ?', THEO, { plan: 'premium', reply: 'hmm' }); T('premium: unknown item, unusable AI answer → 3 (boost)', r.value === '3', r);

  // 4. pre-filled LinkedIn values kept
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO, { plan: 'premium', pre: '3' }); T('premium: saved 3 for C++ kept (never lowered)', r.value === '3', r);
  r = await field('Depuis combien d’années utilisez-vous Adobe Photoshop ?', THEO, { plan: 'premium', pre: '4' }); T('premium: saved 4 for Photoshop kept', r.value === '4', r);
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO, { plan: 'premium', pre: '0' }); T('premium: saved 0 for C++ → raised to 1', r.value === '1', r);
  r = await field('Depuis combien d’années utilisez-vous Gestion de projet ?', THEO, { plan: 'premium', pre: '1' }); T('premium: saved 1 for a broad item → raised to 3 (as before)', r.value === '3', r);

  // 5. toggle OFF (per-skill CV years) on both plans
  const OFF = { ...THEO, skillYearsAsTotal: false };
  r = await field('Depuis combien d’années utilisez-vous C++ ?', OFF, { plan: 'free' }); T('toggle OFF free: C++ absent → total 3 (2.5.116)', r.value === '3', r);
  r = await field('Depuis combien d’années utilisez-vous C++ ?', OFF, { plan: 'premium' }); T('toggle OFF premium: C++ absent → 1', r.value === '1', r);
  r = await field('Depuis combien d’années utilisez-vous Tableau ?', OFF, { plan: 'premium' }); T('toggle OFF premium: Tableau (Google role, 5 months) → 1 (role years, ≥ 1)', r.value === '1', r);

  // 6. universal autofill + radios + selects
  await page.evaluate((c) => { window.__cfg = c; }, THEO);
  const ask = (q, plan) => page.evaluate(async ({ q, plan }) => { window.__plan = plan; window.__prompts = []; window.__store = {}; await window.EAM.aiForm.clearCache(); const a = await window.EAM.aiForm.askAI(q, window.__cfg, 'text'); return { a, calls: window.__prompts.length }; }, { q, plan });
  r = await ask('How many years of experience do you have with Python?', 'premium'); T('askAI (universal autofill) premium: Python → 1', r.a === '1' && r.calls === 0, r);
  r = await ask('How many years of experience do you have with Python?', 'free'); T('askAI free: Python → 3', r.a === '3' && r.calls === 0, r);
  const sel = (plan) => page.evaluate(async ({ plan }) => {
    window.__plan = plan; window.__prompts = []; window.__store = {}; await window.EAM.aiForm.clearCache();
    const root = document.getElementById('root');
    root.innerHTML = `<div class="m"><div><label for="s">How many years of experience do you have with Python?</label><select id="s"><option value="">Select an option</option><option>0-1 years</option><option>2-4 years</option><option>5+ years</option></select></div></div>`;
    await window.EAM.FormFiller.fillSelectDropdowns(root.querySelector('.m'), window.__cfg);
    const s = root.querySelector('#s'); return { v: s.options[s.selectedIndex].text };
  }, { plan });
  r = await sel('premium'); T('years-range select premium: Python → "0-1 years"', r.v === '0-1 years', r);
  r = await sel('free'); T('years-range select free: Python → "2-4 years"', r.v === '2-4 years', r);
  const rad = (q, opts, plan, reply = 'No') => page.evaluate(async ({ q, opts, plan, reply }) => {
    window.__plan = plan; window.__prompts = []; window.__store = {}; await window.EAM.aiForm.clearCache(); window.__reply = () => ({ answer: reply });
    const root = document.getElementById('root');
    root.innerHTML = '<div class="m"><fieldset><legend><span>' + q + '</span></legend>' + opts.map((o, i) => '<div><input type="radio" id="r' + i + '" name="g" value="' + o + '"><label for="r' + i + '">' + o + '</label></div>').join('') + '</fieldset></div>';
    await window.EAM.FormFiller.fillRadioButtons(root.querySelector('.m'), window.__cfg);
    const c = root.querySelector('input:checked'); return { v: c ? c.value : '', kindCalls: window.__prompts.filter(p => /SPECIFIC or BROAD/.test(p.prompt)).length };
  }, { q, opts, plan, reply });
  r = await rad('How many years of experience do you have with Python?', ['0-1 years', '2-4 years', '5+ years'], 'premium'); T('years-range radios premium: Python → "0-1 years"', r.v === '0-1 years', r);
  r = await rad('How many years of experience do you have with Python?', ['0-1 years', '2-4 years', '5+ years'], 'free'); T('years-range radios free: Python → "2-4 years"', r.v === '2-4 years', r);
  r = await rad('Do you have at least 5 years of experience with Dimension?', ['Yes', 'No'], 'premium'); T('yes/no "at least 5 years" premium: no specific/broad call', r.kindCalls === 0, r);

  // last: a 403 blocks the AI for the rest of the session → unknown items stay broad (3)
  r = await field('Depuis combien d’années utilisez-vous Dimension ?', THEO, { plan: 'premium', err: 'premium_required' }); T('premium: server 403 on the kind check → 3', r.value === '3', r);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
