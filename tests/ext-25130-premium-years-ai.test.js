/**
 * ext v2.5.130 — PREMIUM "how many years of X / in sector Y" answered by the AI from the CV (Théo 2026-10-27:
 * "Laisse 3 comme base pour les non-premium. Avec l'IA (premium), il faut adapter la réponse à mon profil.").
 * Live run 2026-10-27 (C:/AAM/scratchpad/g126/run_daily/20261027/hold_*.txt): every "Depuis combien d'années
 * utilisez-vous X ?" got the total 3 for a consultant / project manager — C++, Python, HTML, Titrisation, Summit…
 *   1. FREE / no AI: unchanged — item absent → total years, no AI call.
 *   2. PREMIUM: skill / tool / sector years → one AI call (years prompt with every dated role), number clamped to
 *      [0, total]; AI error / no number → the deterministic answer. Generic "years of experience" → total, no AI call.
 *   3. PREMIUM pre-filled (LinkedIn saved answer): replaced by the AI figure in both directions; FREE never lowered.
 *   4. Cache: same question + same CV → no 2nd call; CV changed → asked again.
 *   5. Universal autofill path (askAI years guard) and years-range selects follow the same rule.
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
  skills: ['Excel Avancé', 'SQL', 'Tableau', 'Power BI', 'Agile/Scrum', 'Conduite du Changement', 'Analyse Financière', 'Gestion de projet'],
  education: [{ degree: 'Triple Diplôme Master – Management, Finance & Business International', school: 'ICN Business School' }] } };

// Questions of the 27/10 run (hold_*.txt), all answered 3 by the deterministic rule.
const HOLD_QS = [
  'Depuis combien d’années utilisez-vous Crédit corporate ?', 'Depuis combien d’années utilisez-vous SQL ?', 'Depuis combien d’années utilisez-vous Order to Cash ?',
  'Depuis combien d’années utilisez-vous Produits SAP ?', 'Depuis combien d’années utilisez-vous Monétique ?', 'Depuis combien d’années utilisez-vous Summit ?',
  'Depuis combien d’années utilisez-vous Gestion actif-passif ?', 'How many years of work experience do you have with Microsoft Azure?',
  'How many years of work experience do you have with Salesforce.com?', 'How many years of experience in IoT Service?', 'How many years of experience in Business analyst?',
  'Depuis combien d’années utilisez-vous Transformation financière ?', 'Depuis combien d’années utilisez-vous Solvabilité II ?', 'Depuis combien d’années utilisez-vous Canva ?',
  'Depuis combien d’années utilisez-vous Titrisation ?', 'Combien d’années d’expérience professionnelle avez-vous en Product Ownership ou gestion de produits IA ?',
  'Depuis combien d’années utilisez-vous ou have with Jav ?', 'Depuis combien d’années utilisez-vous ERP Microsoft Dynamics ?', 'Depuis combien d’années utilisez-vous Gestion de projet ?',
  'Combien d’années d’expérience avez-vous dans ce secteur (Services et conseil aux entreprises) ?', 'Depuis combien d’années utilisez-vous Microsoft Excel ?', 'Depuis combien d’années utilisez-vous JIRA ?',
  'Combien d’années d’expérience avez-vous en tant que Conseil ?', 'Depuis combien d’années utilisez-vous HTML ?', 'Depuis combien d’années utilisez-vous C++ ?',
  'Depuis combien d’années utilisez-vous Python (langage de programmation) ?', 'Combien d’années d’expérience avez-vous dans ce secteur (Banques d’investissement) ?',
  'How many years of work experience do you have with Databases?', 'Depuis combien d’années utilisez-vous Suite Atlassian ?',
];

(async () => {
  let pass = 0, fail = 0;
  const T = (n, ok, info) => { console.log((ok ? '✓ ' : '❌ ') + n + (ok ? '' : ' — ' + JSON.stringify(info))); ok ? pass++ : fail++; };
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage();
  await page.setContent('<!doctype html><html lang="fr"><body><div id="root"></div></body></html>');
  await page.evaluate(() => {
    window.__plan = 'free'; window.__prompts = []; window.__reply = () => ({ answer: '0' }); window.__store = {};
    window.chrome = { runtime: { getManifest: () => ({ version: 't' }), lastError: null, getURL: (x) => x, onMessage: { addListener() {} },
        sendMessage: (m, cb) => { if (m && m.type === 'ai-form-answer') { window.__prompts.push(m.prompt); const r = window.__reply(m.prompt); setTimeout(() => cb && cb(r), 0); } else cb && cb({}); } },
      storage: { local: { get: (k, cb) => { const r = { plan: window.__plan, isPremium: window.__plan !== 'free', ...window.__store }; cb && cb(r); return Promise.resolve(r); }, set: (o) => { Object.assign(window.__store, o); return Promise.resolve(); }, remove: () => Promise.resolve() }, sync: { get: (k, cb) => { cb && cb({}); return Promise.resolve({}); } }, onChanged: { addListener() {} } }, i18n: { getUILanguage: () => 'fr' } };
  });
  for (const f of FILES) await page.addScriptTag({ content: fs.readFileSync(ROOT + f, 'utf8') });
  await page.evaluate(() => { window.EAM.utils.isRunning = true; window.EAM.utils.userExplicitlyClickedStart = true; });

  // reply: { question-substring: answer } (default '0'); returns { value, calls, prompt }
  const field = (q, config, { plan = 'free', reply = {}, pre = '', type = 'text', fresh = true, err = null } = {}) => page.evaluate(async ({ q, config, plan, reply, pre, type, fresh, err }) => {
    window.__plan = plan; window.__prompts = [];
    if (fresh) { window.__store = {}; await window.EAM.aiForm.clearCache(); }
    window.__reply = (p) => { if (err) return { error: err }; const qq = (p.match(/\nQuestion: "([^"]*)"/) || [])[1] || ''; const k = Object.keys(reply).find(k => qq.includes(k)); return { answer: k ? reply[k] : '0' }; };
    const root = document.getElementById('root');
    root.innerHTML = `<div class="m"><div><label for="i">${q}</label><input type="${type}" id="i" value="${pre}"></div></div>`;
    await window.EAM.FormFiller.fillTextInputs(root.querySelector('.m'), config);
    return { value: root.querySelector('#i').value, calls: window.__prompts.length, prompt: window.__prompts[0] || '' };
  }, { q, config, plan, reply, pre, type, fresh, err });

  let r;
  // 1. FREE: unchanged (total years)
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO); T('free: C++ → total 3, no AI call', r.value === '3' && r.calls === 0, r);
  r = await field('Depuis combien d’années utilisez-vous SQL ?', THEO, { type: 'number' }); T('free (number input): SQL → 3, no AI call', r.value === '3' && r.calls === 0, r);
  const freeBad = [];
  for (const q of HOLD_QS) { const x = await field(q, THEO); const det = await page.evaluate(([q, c]) => String(window.EAM.FormFiller.yearsForQuestion(q, c).years), [q, THEO]); if (x.value !== det || x.calls) freeBad.push({ q, ...x, det }); }
  T(`free: all ${HOLD_QS.length} questions of the 27/10 run = the deterministic rule, no AI call`, !freeBad.length, freeBad.slice(0, 3));
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO, { pre: '3' }); T('free: pre-filled 3 kept (never lowered)', r.value === '3' && r.calls === 0, r);

  // 2. PREMIUM
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO, { plan: 'premium', reply: { 'C++': '0' } });
  T('premium: C++ → AI 0 → 0 (one AI call)', r.value === '0' && r.calls === 1, r);
  T('premium prompt: total, every role with months, bullets, skills, honest rules, ends with Question/Answer', /\nYears of experience: 3 \(total/.test(r.prompt) && /Consultant @ Freelance \(09\/2024 – Present\) — \d+ months/.test(r.prompt) && /Stagiaire Stratégie & Opérations @ Google \(Apr 2023 – Aug 2023\) — 5 months/.test(r.prompt)
    && /• Organised 30 events/.test(r.prompt) && /Top skills: .*Gestion de projet/.test(r.prompt) && /clearly absent and unrelated/.test(r.prompt) && /Reply with ONLY a single number/.test(r.prompt) && /\nQuestion: "Depuis combien d’années utilisez-vous C\+\+ \?"\nAnswer:$/.test(r.prompt), r.prompt.slice(-400));
  r = await field('Depuis combien d’années utilisez-vous Microsoft Excel ?', THEO, { plan: 'premium', reply: { Excel: '3' } }); T('premium: Excel → AI 3 → 3', r.value === '3' && r.calls === 1, r);
  r = await field('Depuis combien d’années utilisez-vous Gestion de projet ?', THEO, { plan: 'premium', reply: { Gestion: '7' } }); T('premium: AI 7 > total → capped at 3', r.value === '3', r);
  r = await field('Depuis combien d’années utilisez-vous HTML ?', THEO, { plan: 'premium', reply: { HTML: 'Environ 1 an' } }); T('premium: "Environ 1 an" → 1', r.value === '1', r);
  r = await field('Depuis combien d’années utilisez-vous HTML ?', THEO, { plan: 'premium', reply: { HTML: 'skip' } }); T('premium: AI with no number → deterministic 3', r.value === '3', r);
  r = await field('How many years of work experience do you have?', THEO, { plan: 'premium' }); T('premium: generic years question → total 3, no AI call', r.value === '3' && r.calls === 0, r);
  r = await field('Combien d’années d’expérience avez-vous dans ce secteur (Banques d’investissement) ?', THEO, { plan: 'premium', reply: { Banques: '0' } }); T('premium: sector (Banques d’investissement) → AI 0', r.value === '0' && r.calls === 1, r);
  r = await field('Depuis combien d’années utilisez-vous SQL ?', THEO, { plan: 'premium', reply: { SQL: '2' }, type: 'number' }); T('premium (number input): SQL → AI 2', r.value === '2' && r.calls === 1, r);
  r = await field('Depuis combien d’années utilisez-vous C++ ?', { ...THEO, cvProfile: { ...THEO.cvProfile, experience: [] } }, { plan: 'premium' }); T('premium without CV roles → deterministic (no AI call)', r.value === '3' && r.calls === 0, r);
  r = await field('Depuis combien d’années utilisez-vous SQL ?', THEO, { plan: 'premium', reply: { SQL: '0' } });
  T('premium: SQL (in the CV skills) AI 0 → floored at 1', r.value === '1' && r.calls === 1, r);
  T('premium prompt: text check says SQL is listed in the skills, no role names it', /Text check for "SQL": listed in Top skills/.test(r.prompt) && /roles naming it literally: none/.test(r.prompt), (r.prompt.match(/Text check[^\n]*/) || [''])[0]);
  r = await field('Depuis combien d’années utilisez-vous Microsoft Excel ?', THEO, { plan: 'premium', reply: { Excel: '2' } });
  T('premium prompt: Excel named in roles → text check lists them', /roles naming it literally: Consultant ; Stagiaire Stratégie & Opérations/.test(r.prompt), (r.prompt.match(/Text check[^\n]*/) || [''])[0]);
  r = await page.evaluate(() => { const c = { yearsOfExperience: '3', cvProfile: { experience: [{ title: 'Stagiaire', company: 'GOOGLE', duration: 'Avril – Août 2023' }, { title: 'Stagiaire', company: 'BEALIVR', duration: 'Janvier – Juin 2022' }] } }; return window.EAM.FormFiller.yearsAIPrompt('Depuis combien d’années utilisez-vous SQL ?', c, 3); });
  T('prompt: "Avril – Août 2023" / "Janvier – Juin 2022" get their months (Théo CV, were "dates unknown")', /Août 2023\) — 5 months/.test(r) && /Juin 2022\) — 6 months/.test(r), (r.match(/- Stagiaire[^\n]*/g) || []));

  // 3. PREMIUM pre-filled
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO, { plan: 'premium', pre: '3', reply: { 'C++': '0' } }); T('premium: saved 3 for C++ → AI 0 (lowered)', r.value === '0' && r.calls === 1, r);
  r = await field('Depuis combien d’années utilisez-vous Microsoft Excel ?', THEO, { plan: 'premium', pre: '1', reply: { Excel: '3' } }); T('premium: saved 1 for Excel → AI 3 (raised)', r.value === '3', r);
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO, { plan: 'premium', pre: '3', err: 'timeout' }); T('premium: AI failure keeps the saved value', r.value === '3', r);

  // 4. Cache
  await field('Depuis combien d’années utilisez-vous Summit ?', THEO, { plan: 'premium', reply: { Summit: '0' } });
  r = await field('Depuis combien d’années utilisez-vous Summit ?', THEO, { plan: 'premium', reply: { Summit: '2' }, fresh: false }); T('cache: same question + same CV → cached 0, no 2nd call', r.value === '0' && r.calls === 0, r);
  const THEO2 = { ...THEO, cvProfile: { ...THEO.cvProfile, experience: [{ title: 'Business Analyst Summit', company: 'Natixis', duration: '01/2022 – Present', bullets: ['Summit front-to-back'] }, ...THEO.cvProfile.experience] } };
  r = await field('Depuis combien d’années utilisez-vous Summit ?', THEO2, { plan: 'premium', reply: { Summit: '2' }, fresh: false }); T('cache: CV changed → asked again', r.value === '2' && r.calls === 1, r);
  const st = await page.evaluate(() => Object.keys(window.__store.eam_ai_cache || {}).filter(k => /^yearsaiv1/.test(k)).length);
  T('years answers live in their own cache namespace', st >= 2, st);

  // 5. askAI years guard (universal autofill) + years-range select
  const ask = (q, plan, reply) => page.evaluate(async ({ q, plan, reply }) => { window.__plan = plan; window.__prompts = []; window.__store = {}; await window.EAM.aiForm.clearCache(); window.__reply = () => ({ answer: reply }); const a = await window.EAM.aiForm.askAI(q, window.__cfg, 'text'); return { a, calls: window.__prompts.length }; }, { q, plan, reply });
  await page.evaluate((c) => { window.__cfg = c; }, THEO);
  r = await ask('How many years of experience do you have with Python?', 'premium', '0'); T('askAI (universal autofill) premium: Python → AI 0', r.a === '0' && r.calls === 1, r);
  r = await ask('How many years of experience do you have with Python?', 'free', '0'); T('askAI free: Python → total 3, no AI', r.a === '3' && r.calls === 0, r);
  const sel = (plan, reply) => page.evaluate(async ({ plan, reply }) => {
    window.__plan = plan; window.__prompts = []; window.__store = {}; await window.EAM.aiForm.clearCache(); window.__reply = () => ({ answer: reply });
    const root = document.getElementById('root');
    root.innerHTML = `<div class="m"><div><label for="s">How many years of experience do you have with Python?</label><select id="s"><option value="">Select an option</option><option>0-1 years</option><option>2-4 years</option><option>5+ years</option></select></div></div>`;
    await window.EAM.FormFiller.fillSelectDropdowns(root.querySelector('.m'), window.__cfg);
    const s = root.querySelector('#s'); return { v: s.options[s.selectedIndex].text, calls: window.__prompts.length };
  }, { plan, reply });
  r = await sel('premium', '0'); T('years-range select premium: Python AI 0 → "0-1 years"', r.v === '0-1 years' && r.calls === 1, r);
  r = await sel('free', '0'); T('years-range select free: Python → total 3 → "2-4 years"', r.v === '2-4 years' && r.calls === 0, r);

  const rad = (q, opts, plan, reply) => page.evaluate(async ({ q, opts, plan, reply }) => {
    window.__plan = plan; window.__prompts = []; window.__store = {}; await window.EAM.aiForm.clearCache(); window.__reply = () => ({ answer: reply });
    const root = document.getElementById('root');
    root.innerHTML = '<div class="m"><fieldset><legend><span>' + q + '</span></legend>' + opts.map((o, i) => '<div><input type="radio" id="r' + i + '" name="g" value="' + o + '"><label for="r' + i + '">' + o + '</label></div>').join('') + '</fieldset></div>';
    await window.EAM.FormFiller.fillRadioButtons(root.querySelector('.m'), window.__cfg);
    const c = root.querySelector('input:checked'); return { v: c ? c.value : '', calls: window.__prompts.length, years: window.__prompts.filter(p => /YEARS RULES/.test(p)).length };
  }, { q, opts, plan, reply });
  r = await rad('How many years of experience do you have with Python?', ['0-1 years', '2-4 years', '5+ years'], 'premium', '0'); T('years-range radios premium: Python AI 0 → "0-1 years"', r.v === '0-1 years' && r.years === 1, r);
  r = await rad('How many years of experience do you have with Python?', ['0-1 years', '2-4 years', '5+ years'], 'free', '0'); T('years-range radios free: Python → "2-4 years"', r.v === '2-4 years' && r.calls === 0, r);
  r = await rad('Do you have at least 5 years of experience with SAP?', ['Yes', 'No'], 'premium', 'No'); T('yes/no "at least 5 years" premium: no years-AI call (only the yes/no AI)', r.years === 0, r);

  // last: a 403 blocks the AI for the rest of the session
  r = await field('Depuis combien d’années utilisez-vous HTML ?', THEO, { plan: 'premium', err: 'premium_required' }); T('premium: server 403 → deterministic 3', r.value === '3', r);
  r = await field('Depuis combien d’années utilisez-vous C++ ?', THEO, { plan: 'premium', reply: { 'C++': '0' } }); T('premium after a 403 this session → deterministic, no more calls', r.value === '3' && r.calls === 0, r);

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
