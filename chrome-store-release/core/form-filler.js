/**
 * AutoApplyMax - Shared Form Filler
 * Handles intelligent form field detection and filling across all sites.
 * Extracted from content-simple.js lines 850-1337.
 * Namespace: window.EAM.FormFiller
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};
  const u = () => window.EAM.utils; // lazy ref to avoid load-order issues

  // ─── Label extraction helper ──────────────────────────────────────────
  function getFieldLabel(input, modal) {
    let labelText = '';
    labelText += ' ' + (input.getAttribute('aria-label') || '');
    labelText += ' ' + (input.getAttribute('name') || '');
    labelText += ' ' + (input.getAttribute('placeholder') || '');
    labelText += ' ' + (input.getAttribute('autocomplete') || '');
    labelText += ' ' + (input.getAttribute('data-automation-id') || '');
    const inputId = input.getAttribute('id');
    if (inputId) {
      const labelEl = modal.querySelector(`label[for="${inputId}"]`);
      if (labelEl) labelText += ' ' + labelEl.textContent;
      // Convert id underscores/dashes to spaces for matching
      labelText += ' ' + inputId.replace(/[-_]/g, ' ');
    }
    const parentLabel = input.closest('label');
    if (parentLabel) labelText += ' ' + parentLabel.textContent;
    // Proximity text: label/legend/span in parent div/fieldset
    const parentBlock = input.closest('div, fieldset');
    if (parentBlock) {
      const nearby = parentBlock.querySelector('label, legend, span');
      if (nearby && nearby.textContent.length < 80) {
        labelText += ' ' + nearby.textContent;
      }
    }
    return labelText;
  }

  // v2.5.88: the question as the USER sees it, for the AI. getFieldLabel() mixes
  // name/id/autocomplete/urn attributes for keyword matching, which gave the AI
  // "address single line text form component formelement urn…" instead of
  // "Address" (seen live 2026-09-26 14:35, VISEO form) → empty or wrong answers.
  function getFieldQuestion(input, modal) {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\*+\s*$/, '').trim();
    const inputId = input.getAttribute('id');
    let q = '';
    if (inputId) {
      try { q = clean(modal.querySelector(`label[for="${CSS.escape(inputId)}"]`)?.textContent); } catch (_) {}
    }
    if (!q) q = clean(input.getAttribute('aria-label'));
    if (!q) { const pl = input.closest('label'); if (pl) q = clean(pl.textContent); }
    if (!q) {
      const lb = input.getAttribute('aria-labelledby');
      if (lb) q = clean(lb.split(/\s+/).map(id => (modal.querySelector(`#${CSS.escape(id)}`) || document.getElementById(id))?.textContent || '').join(' '));
    }
    if (!q) {
      const block = input.closest('div, fieldset');
      const near = block && block.querySelector('label, legend');
      if (near && near.textContent.length < 300) q = clean(near.textContent);
    }
    if (!q) q = clean(input.getAttribute('placeholder'));
    return q || clean(getFieldLabel(input, modal));
  }

  // v2.5.88: deterministic profile-URL fields (no AI needed).
  // Returns 'LinkedIn' | 'GitHub' | 'Website' | null from the visible question.
  function profileUrlKind(question) {
    const q = String(question || '').toLowerCase();
    if (!q || q.length > 160) return null;
    // "How did you hear about us (LinkedIn, Indeed…)" is a source question, not a URL.
    if (/hear|entendu|connu|source|referr|référ|conoci|erfahren|venuto a conoscenza/.test(q)) return null;
    if (/linked\s*in/.test(q) && (/url|profil|profile|link|lien|page|perfil|address|adresse/.test(q) || q.replace(/[^a-z]/g, '').length <= 12)) return 'LinkedIn';
    if (/github|gitlab/.test(q)) return 'GitHub';
    if (/portfolio|website|web\s*site|site\s*web|site\s*internet|personal\s*(site|page)|página\s*web|sitio\s*web|webseite/.test(q)) return 'Website';
    return null;
  }
  function profileUrlValue(kind, config, modal) {
    const cv = (config && config.cvProfile) || {};
    const norm = (v) => { v = String(v || '').trim(); if (!v) return ''; return /^https?:\/\//i.test(v) ? v : 'https://' + v.replace(/^\/+/, ''); };
    if (kind === 'LinkedIn') {
      let v = config.linkedinUrl || cv.linkedin || '';
      // On LinkedIn itself: the applicant's own profile link on the Easy Apply
      // contact card (or the global nav "Me" link).
      if (!v && /linkedin\.com$/i.test(location.hostname)) {
        const a = (modal && modal.querySelector && modal.querySelector('a[href*="/in/"]'))
          || document.querySelector('.global-nav__me a[href*="/in/"], a.global-nav__primary-link-me-menu-trigger[href*="/in/"], nav a[href*="/in/"]');
        const m = a && (a.getAttribute('href') || '').match(/\/in\/([^/?#]+)/);
        if (m) v = `https://www.linkedin.com/in/${m[1]}/`;
      }
      return norm(v);
    }
    if (kind === 'GitHub') return norm(config.githubUrl || cv.github || (/github\.com/i.test(config.portfolioUrl || '') ? config.portfolioUrl : ''));
    if (kind === 'Website') return norm(config.portfolioUrl || cv.website || '');
    return '';
  }

  // ─── v2.5.89: years of experience for the question ACTUALLY asked ────────
  // Live 2026-09-26: "How many years of work experience do you have with Company
  // Secretarial Work?" got the global yearsOfExperience (3) for a project manager.
  // Rule: skill-specific question → years of the CV experience entries that mention
  // the skill (merged date ranges, capped at the total); skill only listed (skills /
  // summary) without dated evidence → 1 (never above the total); skill absent from
  // the CV → 0. Generic questions ("work experience", "this role") → total.
  const _MONTHS = { jan: 0, janv: 0, janvier: 0, january: 0, ene: 0, enero: 0, feb: 1, fev: 1, fevr: 1, fevrier: 1, february: 1, febrero: 1,
    mar: 2, mars: 2, march: 2, marzo: 2, apr: 3, avr: 3, avril: 3, april: 3, abr: 3, abril: 3, may: 4, mai: 4, mayo: 4,
    jun: 5, juin: 5, june: 5, junio: 5, jul: 6, juil: 6, juillet: 6, july: 6, julio: 6, aug: 7, aout: 7, august: 7, ago: 7, agosto: 7,
    sep: 8, sept: 8, septembre: 8, september: 8, septiembre: 8, oct: 9, octobre: 9, october: 9, octubre: 9,
    nov: 10, novembre: 10, november: 10, noviembre: 10, dec: 11, decembre: 11, december: 11, dic: 11, diciembre: 11 };
  const _deaccent = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  function _parseYM(s, isEnd) {
    const t = _deaccent(s).toLowerCase().trim();
    if (!t) return null;
    if (/present|current|now|today|aujourd|actuel|en cours|ongoing|actualidad|heute/.test(t)) { const d = new Date(); return d.getFullYear() * 12 + d.getMonth(); }
    let m = t.match(/(\d{1,2})[\/.\-](\d{4})/); if (m) return +m[2] * 12 + Math.min(11, Math.max(0, +m[1] - 1));
    m = t.match(/(\d{4})[\/.\-](\d{1,2})/); if (m) return +m[1] * 12 + Math.min(11, Math.max(0, +m[2] - 1));
    m = t.match(/([a-z]{3,9})\.?\s*(\d{4})/); if (m && _MONTHS[m[1]] != null) return +m[2] * 12 + _MONTHS[m[1]];
    m = t.match(/(\d{4})/); if (m) return +m[1] * 12 + (isEnd ? 11 : 0);
    return null;
  }
  // "01/2021 – Present", "Jan 2020 - Mar 2022", "2019 – 2021", "sept. 2019 à déc. 2020" → [startYM, endYM] or null
  function _entryRange(e) {
    const start = e.startDate || e.start || e.from, end = e.endDate || e.end || e.to;
    if (start) { const a = _parseYM(start, false), b = end ? _parseYM(end, true) : _parseYM('present', true); return a != null && b != null && b >= a ? [a, b] : null; }
    const raw = String(e.duration || e.dates || e.period || e.date || '');
    const parts = raw.split(/\s*(?:–|—|-|to|à|au|a|until|jusqu'?a|hasta|bis)\s+(?=\S)|\s*[–—]\s*/i).filter(Boolean);
    if (parts.length >= 2) { const a = _parseYM(parts[0], false), b = _parseYM(parts[parts.length - 1], true); if (a != null && b != null && b >= a) return [a, b]; }
    return null;
  }
  const _GENERIC_SKILL = /^(work|working|professional|relevant|total|overall|industry|full[- ]time|paid|similar|this|the|a|an|your|such|previous|prior)?\s*(work|experience|field|role|position|job|industry|domain|area|capacity|kind of role|similar role|similar position|this role|this position|this field|this industry)?\s*$/i;
  // Skill named in a years question, or '' for a generic question.
  function yearsQuestionSkill(question) {
    const q = String(question || '').replace(/\s+/g, ' ').replace(/[?*:]+\s*$/, '').trim();
    const pats = [
      // v2.5.92 (live 2026-09-27): role / tool questions that used to fall back to the total
      // ("worked as a Product Manager in ad-tech" → 3, "utilisez-vous Oracle Primavera" → 3,
      // "en tant que Conseil" → skill "tant que Conseil" → 0).
      /\b(?:worked|been\s+working|experience|exp[ée]rience)\s+(?:do\s+you\s+have\s+)?as\s+(?:an?\s+)?(.+)$/i,
      /\ben\s+tant\s+que\s+(?:l'|la\s+|le\s+|les\s+)?(.+)$/i,
      /\b(?:utilisez|pratiquez|maîtrisez|maitrisez)[- ]vous\s+(?:l'|la\s+|le\s+|les\s+)?(.+)$/i,
      /\btravaillez[- ]vous\s+(?:avec|sur|dans)\s+(?:l'|la\s+|le\s+|les\s+)?(.+)$/i,
      /experience\s+(?:do\s+you\s+have\s+|have\s+you\s+got\s+)?(?:with|in|using|of|on|working\s+with|working\s+in)\s+(.+)$/i,
      /years?\s+of\s+(?:professional\s+|work\s+|relevant\s+|hands[- ]on\s+|practical\s+)?(.+?)\s+experience\b/i,
      /years?\s+(?:have\s+you\s+)?(?:worked|been\s+working|used|been\s+using)\s+(?:with|in|on)?\s*(.+)$/i,
      /exp[ée]rience\s+(?:avez[- ]vous\s+|poss[ée]dez[- ]vous\s+)?(?:en|avec|dans|sur|de)\s+(?:l'|la\s+|le\s+|les\s+)?(.+)$/i,
      /experiencia\s+(?:tienes\s+|tiene\s+)?(?:con|en)\s+(.+)$/i,
    ];
    for (const re of pats) {
      const m = q.match(re);
      if (m) {
        let s = m[1].replace(/\b(do you have|avez[- ]vous|have you|as an?|in total|total|au total)\b.*$/i, '').replace(/^(the|la|le|les|l')\s+/i, '').trim();
        if (!s || s.length > 60 || _GENERIC_SKILL.test(s)) return '';
        return s;
      }
    }
    return '';
  }
  // Tail words that qualify a skill without being the skill ("Agile methodologies", "SAP systems").
  const _SKILL_TAIL = /^(methodolog\w*|methods?|tools?|frameworks?|technolog\w*|concepts?|principles?|practices?|skills?|environments?|software|systems?|platforms?|solutions?|products?|projects?|techniques?|m[ée]thodes?|outils?|logiciels?|environnements?)$/;
  // Minimal FR/ES → EN bridge so an English CV is not answered "0" to a French question (and vice versa).
  const _SKILL_SYNONYMS = [
    ['gestion de projet', 'project management'], ['chef de projet', 'project manager'], ['gestion de produit', 'product management'],
    ['developpement', 'development'], ['comptabilite', 'accounting'], ['ressources humaines', 'human resources'], ['recrutement', 'recruitment'],
    ['vente', 'sales'], ['analyse de donnees', 'data analysis'], ['gestion de programme', 'program management'], ['service client', 'customer service'],
    ['gestion de projets', 'project management'], ['gestion del proyecto', 'project management'], ['gestion de proyectos', 'project management'],
    ['conseil', 'consulting'], ['consultant', 'consulting'],
    // v2.5.101 (live 2026-10-05): "Combien d'années d'expérience en Management de projet ?" → 0 for a PMO /
    // chef de projet profile. FR variants of project management + the role titles that imply the skill.
    ['management de projets', 'project management'], ['management de projet', 'project management'],
    ['pilotage de projets', 'project management'], ['pilotage de projet', 'project management'],
    ['conduite de projets', 'project management'], ['conduite de projet', 'project management'],
    ['project management', 'project manager'], ['project management', 'chef de projet'], ['project management', 'pmo'],
    ['gestion de projet', 'pmo'], ['management de projet', 'chef de projet'], ['management de projet', 'pmo'],
  ];
  function _norm(s) { return ' ' + _deaccent(s).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim() + ' '; }
  function _tokens(s) {
    return _norm(s).trim().split(' ').filter(w => w.length >= 2 && !/^(and|or|the|of|in|with|for|de|des|du|et|en|la|le|les|work|experience|a|an)$/.test(w));
  }
  // Word match on a shared prefix (manager ~ management ~ managing, projet ~ projets) — min 5 chars, else exact.
  function _hasWord(t, w) {
    // v2.5.98: plural / FR adjective forms ("Méthodes agiles" → CV "Agile/Scrum" was answered 0).
    if (w.length >= 5 && /(?:s|x)$/.test(w)) w = w.slice(0, -1);
    if (w.length < 5) return t.includes(' ' + w + ' ');
    const stem = w.slice(0, Math.max(5, Math.min(w.length, 6)));
    return t.includes(' ' + stem);
  }
  function _mentionsOne(text, skill) {
    const t = _norm(text); const s = _norm(skill).trim();
    if (!s) return false;
    if (t.includes(' ' + s + ' ')) return true;
    const toks = _tokens(skill);
    if (!toks.length) return false;
    const core = toks.filter(w => !_SKILL_TAIL.test(w));
    const need = core.length ? core : toks;
    return need.every(w => _hasWord(t, w));
  }
  // Vendor prefix is not the skill ("Microsoft Excel" ~ "Excel"); the product word still has to match.
  const _VENDOR_PREFIX = /^\s*(microsoft|ms|google|adobe|apple|amazon|oracle|sap|ibm|atlassian|salesforce)\s+(?=\S)/i;
  function _mentions(text, skill) {
    if (_mentionsOne(text, skill)) return true;
    const bare = String(skill || '').replace(_VENDOR_PREFIX, '');
    if (bare !== String(skill || '') && bare.trim().length >= 3 && _mentionsOne(text, bare)) return true;
    const s = _norm(skill).trim();
    for (const [a, b] of _SKILL_SYNONYMS) {
      if (s.includes(a) && _mentionsOne(text, s.replace(a, b))) return true;
      if (s.includes(b) && _mentionsOne(text, s.replace(b, a))) return true;
    }
    return false;
  }
  function yearsForQuestion(question, config) {
    const total = parseInt(String((config && config.yearsOfExperience) || '').match(/\d+/)?.[0] || '0', 10) || 0;
    const skill = yearsQuestionSkill(question);
    if (!skill) return { years: total, basis: 'total' };
    // v2.5.98: soft skills ("Sens de l'écoute", "Sens de l'organisation", "Leadership"…) follow the
    // total experience — "0 years of listening skills" (live 2026-10-04, discarded) is not credible.
    if (/^(sens\s+(de\s+l.|du\s+|des\s+)?\S+|esprit\s+(d.|de\s+)\S+|capacit[ée]\s+d.\S+|communication|leadership|teamwork|team\s*work|travail\s+en\s+[ée]quipe|organisation|organization|rigueur|autonomie|autonomy|adaptabilit[ée]|adaptability|curiosit[ée]|cr[ée]ativit[ée]|creativity|problem[- ]solving|r[ée]solution\s+de\s+probl[èe]mes|[ée]coute(\s+active)?|active\s+listening|listening|gestion\s+du\s+temps|time\s+management|relationnel|interpersonal\s+skills|soft\s+skills|savoir[- ]être|empathie|empathy|proactivit[ée]|initiative|esprit\s+critique|critical\s+thinking)$/i.test(skill.trim())) {
      return { years: total, basis: `soft skill "${skill}" → total experience`, skill };
    }
    // v2.5.98: "Méthodologies Agile et Waterfall" → 0 although the CV lists Agile/Scrum (live
    // 2026-10-04, discarded): a compound skill is answered with its best-supported part.
    const parts = skill.split(/\s+(?:et|and|ou|or|und)\s+|\s*[\/,&+]\s*/i).map(s => s.trim()).filter(s => s.length >= 2);
    if (parts.length > 1) {
      let best = null;
      for (const p of parts) {
        const r = _yearsForSkill(p, config, total);
        if (!best || r.years > best.years) best = r;
      }
      return best;
    }
    return _yearsForSkill(skill, config, total);
  }
  function _yearsForSkill(skill, config, total) {
    const cv = config && config.cvProfile;
    if (!cv || !Array.isArray(cv.experience)) return { years: total, basis: 'total (no CV profile synced)', skill };
    const ranges = [];
    let mentionedInExp = false;
    for (const e of cv.experience) {
      const txt = [e.title, e.role, e.position, e.company, e.description, ...(Array.isArray(e.bullets) ? e.bullets : []), ...(Array.isArray(e.achievements) ? e.achievements : [])].filter(Boolean).join(' ');
      if (!_mentions(txt, skill)) continue;
      mentionedInExp = true;
      const r = _entryRange(e); if (r) ranges.push(r);
    }
    if (ranges.length) {
      ranges.sort((a, b) => a[0] - b[0]);
      let months = 0, cur = null;
      for (const r of ranges) { if (!cur || r[0] > cur[1] + 1) { if (cur) months += cur[1] - cur[0] + 1; cur = r.slice(); } else cur[1] = Math.max(cur[1], r[1]); }
      if (cur) months += cur[1] - cur[0] + 1;
      let y = Math.floor(months / 12); if (y === 0 && months >= 6) y = 1;
      if (total) y = Math.min(y, total);
      return { years: y, basis: `CV experience mentioning "${skill}" (${months} months)`, skill };
    }
    const listed = mentionedInExp || (Array.isArray(cv.skills) && cv.skills.some(s => _mentions(typeof s === 'string' ? s : (s && s.name) || '', skill)))
      || _mentions(cv.summary || '', skill);
    if (listed) return { years: Math.min(total || 1, 1), basis: `"${skill}" listed in the CV without dated experience`, skill };
    return { years: 0, basis: `"${skill}" not in the CV`, skill };
  }

  // ─── v2.5.98: yes/no "do you have experience in X" decided from the CV ──
  // Live 2026-10-04: "Do you have professional experience in the Airline/Aviation industry?" got the
  // blind Yes default. 'yes' only when X is in the CV (experience, skills, summary); 'no' otherwise;
  // null when the subject is generic ("this role") or there is no CV profile → caller's normal flow.
  const _GENERIC_SUBJECT = /^(this|that|the|a|an|such|similar|same|related|relevant|these|those|ce|cet|cette|ces|un|une|le|la|les|similar|similaire)\b.{0,25}\b(role|position|job|field|area|domain|capacity|environment|work|poste|domaine|fonction|emploi|r[ôo]le|type)s?\b|^(it|them|this|that|ça|cela)$/i;
  function experienceQuestionAnswer(questionText, config) {
    const q = String(questionText || '').replace(/\s+/g, ' ').trim();
    const pats = [
      /\b(?:do|did)\s+you\s+have\s+(?:any\s+)?(?:prior\s+|previous\s+|professional\s+|relevant\s+|hands[- ]on\s+|direct\s+|working\s+|practical\s+)*(?:work\s+)?experience\s+(?:in|with|within|of|on|at|working\s+(?:in|with|for))\s+(.+)$/i,
      /\bhave\s+you\s+(?:ever\s+|previously\s+|already\s+)?(?:worked|been\s+working)\s+(?:in|with|within|for|at|on)\s+(.+)$/i,
      /\b(?:avez|poss[ée]dez)[- ]vous\s+(?:d[ée]j[àa]\s+)?(?:une\s+|de\s+l'|d'|des\s+)?(?:premi[èe]re\s+)?(?:exp[ée]riences?)\s+(?:professionnelles?\s+)?(?:significatives?\s+)?(?:en|dans|avec|sur|de|du|des|au|aux|d')\s*(.+)$/i,
      /\bavez[- ]vous\s+(?:d[ée]j[àa]\s+)?travaill[ée]\s+(?:en|dans|avec|sur|pour|chez|au|aux)\s+(.+)$/i,
    ];
    let subj = '';
    for (const re of pats) { const m = q.match(re); if (m) { subj = m[1]; break; } }
    if (!subj) return null;
    subj = subj.split(/[?.;:]/)[0]
      .replace(/\b(industry|industries|sector|sectors|field|space|domain|environment|secteur|domaine|industrie|environnement|milieu)\b/gi, ' ')
      .replace(/^(the|a|an|le|la|les|l'|un|une|des|du)\s+/i, '').replace(/\s+/g, ' ').trim();
    if (!subj || subj.length < 2 || subj.length > 70 || _GENERIC_SUBJECT.test(subj)) return null;
    const cv = config && config.cvProfile;
    if (!cv || !Array.isArray(cv.experience) || !cv.experience.length) return null;
    const text = [
      ...cv.experience.map(e => [e.title, e.role, e.position, e.company, e.description, ...(Array.isArray(e.bullets) ? e.bullets : []), ...(Array.isArray(e.achievements) ? e.achievements : [])].filter(Boolean).join(' ')),
      ...(Array.isArray(cv.skills) ? cv.skills.map(s => typeof s === 'string' ? s : (s && s.name) || '') : []),
      (window.EAM && window.EAM.utils && window.EAM.utils.cleanProfileSummary ? window.EAM.utils.cleanProfileSummary(cv.summary) : '') || '',
    ].join(' \n ');
    const alts = subj.split(/\s*(?:\/|,|\bor\b|\bou\b|\band\/or\b|&)\s*/i).map(s => s.trim()).filter(s => s.length >= 2);
    return alts.some(a => _mentions(text, a)) ? 'yes' : 'no';
  }

  // ─── v2.5.98: yes/no "at least N years of (X) experience?" ──────────────
  // X named and in the CV → its dated years vs N; X absent → no; no X → total years vs N;
  // X only described by reference ("the tool mentioned in the ad") → no (cannot be verified).
  function minYearsQuestionAnswer(questionText, config) {
    const q = String(questionText || '').replace(/\s+/g, ' ').trim();
    const m = q.match(/\b(?:at least|minimum(?: of)?|more than|over|plus de|au moins|au minimum|minimum de|m[aá]s de|al menos|mindestens)\s+(\d{1,2})\s*\+?\s*(?:years?|yrs?|ans?|ann[ée]es?|a[nñ]os|jahre)\b/i)
      || q.match(/\b(\d{1,2})\s*\+\s*(?:years?|yrs?|ans?|ann[ée]es?)\b/i);
    if (!m) return null;
    if (!/experience|exp[ée]rience|experiencia|erfahrung|worked|travaill|utilis|using|used|pratique/i.test(q)) return null;
    const need = parseInt(m[1], 10);
    if (/\b(mentioned|listed|described|required|indicated|specified)\b.{0,30}\b(in the|in this)\b.{0,10}\b(ad|job|posting|description|offer)\b|\b(mentionn[ée]e?s?|cit[ée]e?s?|indiqu[ée]e?s?|pr[ée]cis[ée]e?s?|demand[ée]e?s?)\b.{0,20}\b(dans|par)\s+l.(annonce|offre)/i.test(q)) return 'no';
    const total = parseInt(String((config && config.yearsOfExperience) || '').match(/\d+/)?.[0] || '0', 10) || 0;
    const y = yearsForQuestion(q, config);
    if (y.skill) return y.years >= need ? 'yes' : 'no';
    return total >= need ? 'yes' : 'no';
  }

  // ─── v2.5.98: "are you willing to work in <place>?" / "are you based in <place>?" ──
  // 'yes' when the place is the candidate's own city / region / country, else the relocation setting
  // ('no' when unset). null when no concrete place is named ("on site", "the office", "hybrid").
  const _HOME_BY_COUNTRY = {
    fr: ['france', 'paris', 'ile-de-france', 'ile de france', 'idf', 'la defense', 'greater paris', 'region parisienne', 'region paris'],
    in: ['india'], us: ['united states', 'usa', 'us'], gb: ['united kingdom', 'uk', 'england'], uk: ['united kingdom', 'uk', 'england'],
    de: ['germany', 'deutschland'], es: ['spain', 'espana'], it: ['italy', 'italia'], ca: ['canada'], be: ['belgium', 'belgique'], ch: ['switzerland', 'suisse'],
  };
  function workLocationAnswer(questionText, config) {
    const q = _deaccent(String(questionText || '')).toLowerCase().replace(/\s+/g, ' ');
    const m = q.match(/\b(?:willing|able|open|prepared|ready|happy|comfortable|available)\s+to\s+(?:work|be\s+based|live|relocate|commute|move|travel)\s+(?:on[- ]?site\s+)?(?:in|to|at|from|near)\s+([^?.,;]+)/)
      || q.match(/\b(?:are\s+you|you\s+are)\s+(?:currently\s+)?(?:based|located|living|residing)\s+(?:in|near|within)\s+([^?.,;]+)/)
      || q.match(/\b(?:pret|prete|dispose|disposee|d'accord|accepteriez[- ]vous|acceptez[- ]vous|souhaitez[- ]vous)[^?]{0,25}?\b(?:travailler|vous\s+installer|demenager|vous\s+deplacer|vivre)\s+(?:a|en|au|aux|sur|dans)\s+([^?.,;]+)/)
      || q.match(/\b(?:residez|habitez|etes)[- ]vous\s+(?:actuellement\s+)?(?:base\s+|basee\s+|situe\s+|situee\s+)?(?:a|en|au|aux|dans)\s+([^?.,;]+)/);
    if (!m) return null;
    const place = m[1].replace(/\b(the|la|le|les|l')\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!place || /\b(office|site|hybrid|hybride|remote|team|environment|shift|shifts|weekend|night|nuit|bureau|bureaux|locaux|poste|teletravail|client|clients|fast[- ]paced|startup|this|that|location|area|region|city|ville|country|pays)\b/.test(place) && !/[A-Z]/.test(m[1])) {
      // "the office", "on site", "this location": not a named place → not ours to decide
      if (!/\b(paris|france|india|dubai|saudi|riyadh|london|uae|qatar|doha|singapore|germany|spain|italy|usa|canada)\b/.test(place)) return null;
    }
    const home = new Set();
    const city = _deaccent(String((config && config.city) || '')).toLowerCase().trim();
    if (city) home.add(city);
    const cc = _deaccent(String((config && config.country) || '')).toLowerCase().trim();
    if (cc) { home.add(cc); (_HOME_BY_COUNTRY[cc] || []).forEach(x => home.add(x)); for (const [k, v] of Object.entries(_HOME_BY_COUNTRY)) if (v.includes(cc)) v.concat(k).forEach(x => home.add(x)); }
    if (city === 'paris') _HOME_BY_COUNTRY.fr.forEach(x => home.add(x));
    const P = ' ' + place.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    for (const h of home) { if (h.length >= 2 && P.includes(' ' + h.replace(/[^a-z0-9]+/g, ' ').trim() + ' ')) return 'yes'; }
    if (/\b(based|located|living|residing|residez|habitez|etes)\b/.test(q)) return 'no';
    const rel = String((config && config.willingToRelocate) || '').toLowerCase();
    return rel === 'yes' ? 'yes' : 'no';
  }

  // ─── v2.5.89: salary answer shaped by the question ──────────────────────
  // Plain number by default (LinkedIn validates most salary fields as numbers).
  // Currency appended only when the question explicitly asks for it; the question's
  // own currency wins, else the profile country. Never converts amounts.
  const _CUR_BY_COUNTRY = { france: 'EUR', fr: 'EUR', germany: 'EUR', de: 'EUR', spain: 'EUR', es: 'EUR', italy: 'EUR', it: 'EUR', belgium: 'EUR', netherlands: 'EUR', portugal: 'EUR', ireland: 'EUR', austria: 'EUR',
    india: 'INR', in: 'INR', 'united states': 'USD', usa: 'USD', us: 'USD', 'united kingdom': 'GBP', uk: 'GBP', gb: 'GBP', canada: 'CAD', ca: 'CAD', switzerland: 'CHF', ch: 'CHF', australia: 'AUD', au: 'AUD' };
  const _CUR_BY_DIAL = { '+33': 'EUR', '+49': 'EUR', '+34': 'EUR', '+39': 'EUR', '+32': 'EUR', '+31': 'EUR', '+351': 'EUR', '+353': 'EUR', '+43': 'EUR', '+91': 'INR', '+44': 'GBP', '+41': 'CHF', '+61': 'AUD' };
  // v2.5.93: start-date questions ("What is your earliest starting date?", mm/dd/yyyy
  // artdeco-date field) got "January 2022" from the AI. Answer = today + notice period
  // (min 2 weeks), formatted for the field.
  const START_DATE_RE = /earliest.{0,20}start|start(ing)?\s*date|when.{0,20}can.{0,10}you.{0,10}(start|join|begin)|available\s+to\s+start|availability\s+date|date.{0,15}d[ée]but|d[ée]but.{0,15}(poste|contrat|mission)|disponible.{0,20}partir|partir\s+de\s+quand|partir\s+de\s+quelle\s+date|quelle\s+date.{0,40}disponible|date.{0,30}seriez.{0,15}disponible|date.{0,15}disponibilit|fecha.{0,15}(inicio|incorporaci)|eintrittsdatum|startdatum|data.{0,15}inizio/i;
  function isDateField(input) {
    if (!input) return false;
    if (input.type === 'date') return true;
    const s = [input.placeholder, input.getAttribute && input.getAttribute('aria-label'), input.className, input.name, input.id].join(' ');
    return /\b(mm|dd|jj)\s*[\/.-]\s*(dd|mm|jj)\s*[\/.-]\s*(yyyy|aaaa|yy|aa)\b|yyyy-mm-dd|artdeco-date|datepicker|date-picker/i.test(s);
  }
  function startDateAnswer(question, config, input, now) {
    const today = now ? new Date(now) : new Date();
    const raw = String((config && config.noticePeriod) || '1').toLowerCase();
    const n = parseFloat(raw.replace(',', '.'));
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (!isFinite(n)) d.setMonth(d.getMonth() + 1);
    else if (/week|semaine|semana|woche|settiman/.test(raw)) d.setDate(d.getDate() + Math.round(n * 7));
    else if (/day|jour|d[ií]a|tag|giorn/.test(raw)) d.setDate(d.getDate() + Math.round(n));
    else d.setMonth(d.getMonth() + Math.round(n));
    const min = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14);
    if (d < min) d.setTime(min.getTime());
    const p = (x) => String(x).padStart(2, '0');
    const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const hint = input ? [input.placeholder, input.getAttribute && input.getAttribute('aria-label'), input.className].join(' ') : '';
    if ((input && input.type === 'date') || /yyyy-mm-dd/i.test(hint)) return iso;
    if (/\bmm\s*[\/.-]\s*dd\b/i.test(hint)) return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
    if (/\b(dd|jj)\s*[\/.-]\s*mm\b/i.test(hint)) return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
    const fr = /[àâçéèêëîïôûù]|\b(date|quand|partir|début|vous|poste)\b/i.test(String(question)) && !/\b(what|when|your|the)\b/i.test(String(question));
    return fr ? `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}` : `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
  }

  // v2.5.98: notice period as words, in the question's language ("1 month" / "1 mois"); a bare
  // number setting means months (popup hint). Numeric fields keep the bare number (caller).
  function noticePeriodText(question, config) {
    const rawValue = String((config && config.noticePeriod) || '1').trim();
    const fr = /[àâçéèêîôûù]|\b(préavis|preavis|disponib|quand|mois|vous|votre)\b/i.test(String(question || ''));
    if (/^\d+([.,]\d+)?$/.test(rawValue)) {
      const one = parseFloat(rawValue.replace(',', '.')) <= 1;
      return fr ? `${rawValue} mois` : `${rawValue} ${one ? 'month' : 'months'}`;
    }
    if (!fr) return rawValue;
    let v = rawValue.replace(/\bmonths?\b/i, 'mois').replace(/\bweeks?\b/i, 'semaines').replace(/\bdays?\b/i, 'jours').replace(/\bimmediately\b/i, 'immédiatement');
    if (/^1 semaines$/.test(v)) v = '1 semaine';
    if (/^1 jours$/.test(v)) v = '1 jour';
    return v;
  }

  function salaryAnswer(question, config, input) {
    const raw = String((config && config.expectedSalary) || '').trim();
    if (!raw) return '';
    const q = String(question || '');
    if (/[a-z€$£₹]/i.test(raw)) return raw; // user typed their own format ("55k EUR")
    const numericOnly = input && (input.type === 'number' || input.getAttribute('inputmode') === 'numeric' || input.getAttribute('inputmode') === 'decimal');
    const asksCurrency = /\b(includ\w*|incl\.?|with|along with|and|plus|mention\w*|indiqu\w*|pr[ée]cis\w*|avec|y|con|specify\w*)\s+(the\s+|la\s+|votre\s+|your\s+|a\s+)?(currency|devise|moneda|w[äa]hrung)|\bcurrency\s*(and|&|\+)|\(\s*(amount|montant)\s*(and|et|\+)\s*(currency|devise)\s*\)/i.test(q);
    if (numericOnly || !asksCurrency) return raw;
    const inQ = (q.match(/\b(EUR|USD|INR|GBP|CAD|CHF|AUD)\b/i) || [])[1] || (/€/.test(q) ? 'EUR' : /₹/.test(q) ? 'INR' : /£/.test(q) ? 'GBP' : /\$/.test(q) ? 'USD' : '');
    const country = String((config && config.country) || '').toLowerCase().trim();
    const cur = (inQ && inQ.toUpperCase()) || _CUR_BY_COUNTRY[country] || _CUR_BY_DIAL[String((config && config.phoneCountryCode) || '').trim()] || '';
    return cur ? `${raw} ${cur}` : raw;
  }

  // ─── Fill text inputs ─────────────────────────────────────────────────
  async function fillTextInputs(modal, config) {
    const textInputs = modal.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input:not([type])');
    for (const input of textInputs) {
      if (input.value) continue;

      const label = getFieldLabel(input, modal).toLowerCase();
      const inputType = (input.type || '').toLowerCase();

      // GUARD 1: Never fill free-text PII into numeric fields. A long help
      // text mentioning "email" on a number input previously caused us to
      // write gmail addresses into 7-digit ID fields (seen on Workable).
      if (inputType === 'number') {
        // Only honor very specific numeric intents below.
        if (label.match(/experience|years|expérience|années|años|jahre|anni|esperienza/)) {
          const y = yearsForQuestion(getFieldQuestion(input, modal), config);
          const v = (y.basis === 'total' && !y.years) ? (config.yearsOfExperience || '2') : String(y.years);
          u().fill(input, v);
          u().log(`Years exp: ${v} (${y.basis})`);
        } else if (label.match(/salary|compensation|remuneration|salaire|rémunération|prétention|pretention|sueldo|salario|gehalt|stipendio|pay.*expect|expectation.*pay/) && config.expectedSalary) {
          u().fill(input, config.expectedSalary);
          u().log(`Salary filled: ${config.expectedSalary}`);
        }
        // Otherwise leave the numeric input alone — we have no safe default.
        continue;
      }

      // GUARD 2: Very long label (> 150 chars) means the field likely has
      // a long help block. Keyword fuzzy-matching gets false positives
      // ("...use your work email..." on a Unique-ID field). We require the
      // HTML-level short signals (aria-label / placeholder / autocomplete /
      // type attribute) to be present instead.
      const shortSignal = (
        (input.getAttribute('aria-label') || '') + ' ' +
        (input.getAttribute('placeholder') || '') + ' ' +
        (input.getAttribute('autocomplete') || '') + ' ' +
        (input.getAttribute('name') || '')
      ).toLowerCase().trim();
      const haystack = label.length > 150 && shortSignal ? shortSignal : label;

      // v2.5.88: profile URLs are deterministic (they used to need the AI, which is
      // Premium-only → free users' applications with a required "LinkedIn Profile"
      // field were discarded, live 2026-09-26 15:00). Decided on the visible question.
      const urlKind = profileUrlKind(getFieldQuestion(input, modal));
      if (urlKind) {
        const v = profileUrlValue(urlKind, config, modal);
        if (v) { u().fill(input, v); u().log(`${urlKind} URL filled: ${v}`); continue; }
      }

      // Years of experience (EN/FR/ES/DE/IT)
      if (haystack.match(/experience|years|expérience|années|años|jahre|anni|esperienza/)) {
        // v2.5.89: years for the skill the question names, not the global total
        // (0 when the skill is nowhere in the CV — never a made-up number).
        const y = yearsForQuestion(getFieldQuestion(input, modal), config);
        const v = (y.basis === 'total' && !y.years) ? (config.yearsOfExperience || '2') : String(y.years);
        u().fill(input, v);
        u().log(`Years exp: ${v} (${y.basis})`);
      }
      // v2.5.92: day rate / TJM (live: the AI typed "0"). Annual expected salary / 218 working
      // days, rounded to 10 — never 0. No numeric salary → left to the AI/user flow.
      else if (haystack.match(/day rate|daily rate|rate per day|\btjm\b|taux journalier|tarif journalier/)) {
        const annual = parseInt(String(config.expectedSalary || '').replace(/[^\d]/g, ''), 10);
        if (annual >= 5000) {
          const rate = String(Math.round(annual / 218 / 10) * 10);
          u().fill(input, rate);
          u().log(`Day rate filled: ${rate} (expected salary ${annual} / 218 days)`);
        }
      }
      // Salary / Compensation / Prétentions salariales
      else if (haystack.match(/salary|compensation|remuneration|salaire|rémunération|prétention|pretention|sueldo|salario|gehalt|stipendio|pay.*expect|expectation.*pay/)) {
        if (config.expectedSalary) {
          // v2.5.89: plain number by default; "+ currency" only when the question asks for it.
          const sal = salaryAnswer(getFieldQuestion(input, modal), config, input);
          u().fill(input, sal);
          u().log(`Salary filled: ${sal}`);
        }
      }
      // Notice period / Préavis / "When can you start"
      // Match broad availability patterns across languages:
      //   FR: "préavis", "disponible", "disponibilité", "quand seriez-vous
      //       disponible", "combien de mois", "à partir de quand"
      //   EN: "notice period", "availability", "when can you start", "how
      //       soon can you start", "earliest start", "start date"
      //   ES: "disponibilidad", "cuándo puede empezar", "preaviso"
      //   DE: "kündigungsfrist", "verfügbarkeit", "wann können sie anfangen"
      //   IT: "preavviso", "disponibilità", "quando può iniziare"
      else if (haystack.match(/notice.*period|préavis|preavviso|preaviso|kündigungsfrist|kundigungsfrist|disponibilit|disponible|disponibil|availability|verfügbarkeit|verfugbarkeit|when.*can.*you.*start|how.*soon.*can.*you.*start|earliest.*start|start.*date|quand.*disponible|seriez.*disponible|partir.*de.*quand|combien.*de.*mois|cuando.*puede.*empezar|cuándo.*puede.*empezar|cuando.*puede|wann.*können.*sie.*anfangen|wann.*konnen.*sie.*anfangen|quando.*può.*iniziare|quando.*puo.*iniziare|date.*début|début.*poste|disponibilità/)) {
        // Default value: '1' (raw number, no unit). When the field expects a
        // number (input.type=number, inputmode=numeric, or label says "(mois)"
        // / "(months)" / "(meses)" hint), strip any trailing month/mois/etc.
        // suffix from the configured value so we don't fill "1 month" into a
        // numeric field. Fixes the "AI called repeatedly because the field
        // can't accept '1 month'" bug.
        const rawValue = (config.noticePeriod || '1').toString().trim();
        const fieldIsNumeric = input.type === 'number' || input.getAttribute('inputmode') === 'numeric'
          || /\(\s*(mois|months?|meses|monate|mesi|weeks?|semaines?)\s*\)|how many|combien|notice/i.test(haystack);
        if (isDateField(input) || (!fieldIsNumeric && START_DATE_RE.test(haystack))) {
          const sd = startDateAnswer(getFieldQuestion(input, modal), config, input);
          u().fill(input, sd);
          u().log(`Start date filled: ${sd}`);
        } else {
        // v2.5.98: a bare number only when the FIELD wants one (numeric input, LinkedIn
        // "-numeric" id, "(months)" unit in the label, "how many months / combien de mois").
        // Free text "What is your notice period?" got "1" for a "1 month" setting (live 2026-10-03).
        const labelExpectsNumber =
          input.type === 'number' ||
          input.getAttribute('inputmode') === 'numeric' ||
          /numeric/i.test(input.id || '') ||
          /\(\s*(en\s+|in\s+)?(mois|months?|meses|monate|mesi)\s*\)/i.test(haystack) ||
          /how many (months|weeks)|number of (months|weeks)|combien de (mois|semaines)|nombre de (mois|semaines)|in (months|weeks)\b|en (mois|semaines)\b|cu[aá]ntos meses|wie viele monate|quanti mesi/i.test(haystack);
        const unitless = rawValue.replace(/\s*(mois|months?|meses|monate|mesi)\s*$/i, '').trim();
        const noticePeriod = labelExpectsNumber ? (unitless || '1') : noticePeriodText(haystack, config);
        u().fill(input, noticePeriod);
        u().log(`Notice period filled: ${noticePeriod}`);
        }
      }
      // Email — use word-boundary and run on short-signal-or-truncated
      // haystack to avoid false positives on long help text like
      // "You must use your work email when completing the field above".
      else if (haystack.match(/\b(e-?mail|courriel|correo|e.?post|posta elettronica)\b/)) {
        u().fill(input, config.email);
      }
      // First name
      else if (haystack.match(/\b(first.*name|given.*name|prénom|prenom|nombre|vorname|nome)\b/)) {
        u().fill(input, config.firstName);
      }
      // Last name — specific patterns first, then plain "nom" as a FR
      // fallback (many French forms label the last-name field simply "Nom").
      // Guards:
      //   - exclude "prénom" (contains 'nom' as substring)
      //   - exclude disambiguators ("nom d'entreprise", "nom complet",
      //     "nom de société", "nom de rue", etc.)
      else if (
        haystack.match(/\b(last.*name|surname|family.*name|nom.*famille|apellido|nachname|cognome)\b/) ||
        (/\bnom\b/.test(haystack)
          && !/prénom|prenom/i.test(haystack)
          && !/(entreprise|complet|complète|complete|soci[ée]t[ée]|company|full|domaine|produit|utilisateur|projet|fichier|user|file|project|document|rue|avenue|city|ville)/i.test(haystack))
      ) {
        u().fill(input, config.lastName);
      }
      // Phone
      else if (haystack.match(/\b(phone|téléphone|telefono|telefon|mobile|portable|cell|móvil|cellulare)\b/)) {
        u().fill(input, config.phone);
        u().log(`Phone filled: ${config.phone}`);
      }
      // City/Location with autocomplete
      else if (haystack.match(/\b(city|ville|ciudad|stadt|città|location|localisation|ubicación|standort|address.level2)\b/)) {
        u().fill(input, config.city || '');
        u().log(`Location filled: ${config.city}`);
        await handleLocationAutocomplete(input);
      }
      // Fallback: autocomplete attribute
      else {
        const ac = (input.getAttribute('autocomplete') || '').toLowerCase().trim();
        if (ac === 'given-name' && config.firstName) {
          u().fill(input, config.firstName);
        } else if (ac === 'family-name' && config.lastName) {
          u().fill(input, config.lastName);
        } else if (ac === 'email' && config.email) {
          u().fill(input, config.email);
        } else if (ac === 'tel' && config.phone) {
          u().fill(input, config.phone);
        } else if (ac === 'address-level2' && config.city) {
          u().fill(input, config.city);
          await handleLocationAutocomplete(input);
        }
        // Fallback: input type
        else if (input.type === 'email' && config.email) {
          u().fill(input, config.email);
        } else if (input.type === 'tel' && config.phone) {
          u().fill(input, config.phone);
        }
        // Final fallback: no label/type pattern matched → ask the AI.
        // Restored from v2.1.0 (dropped in v2.2 refactor). Covers date,
        // availability, salary, custom employer questions, etc.
        else if (label && isDateField(input) && START_DATE_RE.test(getFieldQuestion(input, modal))) {
          const sd = startDateAnswer(getFieldQuestion(input, modal), config, input);
          u().fill(input, sd);
          u().log(`Start date filled: ${sd}`);
        }
        else if (label && window.EAM && window.EAM.aiForm) {
          const question = getFieldQuestion(input, modal);
          const aiAnswer = await window.EAM.aiForm.askAI(question, config, input.type);
          if (aiAnswer) {
            const labelLower = label.toLowerCase();
            const isNumericField = input.type === 'number'
              || input.getAttribute('inputmode') === 'numeric'
              || (input.getAttribute('pattern') || '').includes('\\d')
              || labelLower.match(/combien|how many|how much|nombre|number|heures|hours|salary|salaire|année|years|mois|months|percent|pourcentage|budget|quantity|quantité/);
            let value = aiAnswer;
            if (isNumericField) {
              const num = aiAnswer.match(/[\d]+\.?[\d]*/);
              value = num ? num[0] : aiAnswer;
              u().log(`AI numeric cleanup: "${value}"`);
            }
            u().fill(input, value);
            u().log(`AI filled: "${label.substring(0, 40)}" → "${String(value).substring(0, 40)}"`);
          } else {
            u().log(`Unknown field: "${label.substring(0, 60)}" (AI returned nothing)`);
            // Track consecutive unanswerable fields per-job. Engine reads
            // this and discards after 3 fails — prevents the "10 step loop
            // calling AI on every iteration" trap when user is logged-out
            // or premium-blocked AND the field has no built-in pattern.
            u()._unknownFieldFails = (u()._unknownFieldFails || 0) + 1;
          }
        } else if (label) {
          u().log(`Unknown field: "${label.substring(0, 60)}" (AI module unavailable)`);
          u()._unknownFieldFails = (u()._unknownFieldFails || 0) + 1;
        }
      }
    }
  }

  // ─── Textareas — AI-powered for open-ended questions ──────────────────
  async function fillTextareas(modal, config) {
    const textareas = modal.querySelectorAll('textarea');
    for (const ta of textareas) {
      if (ta.value && ta.value.trim().length > 5) continue;
      if (ta.offsetParent === null || ta.disabled || ta.readOnly) continue;
      const label = getFieldLabel(ta, modal);
      if (!label) continue;
      if (!window.EAM || !window.EAM.aiForm) {
        u().log(`Textarea skipped (AI unavailable): "${label.substring(0, 50)}"`);
        continue;
      }
      // v2.5.98: deterministic answers before the AI (live 2026-10-04, multi-line LinkedIn fields):
      // "How many years of Service Delivery Management experience…" → AI "3" (not in the CV);
      // "What is your notice period…" → a 3-sentence AI paragraph.
      const tq = getFieldQuestion(ta, modal);
      const tql = String(tq || '').toLowerCase();
      // v2.5.100: not when the same field also asks for a description ("… et quelles sont vos
      // réalisations majeures ?" got a bare "1" — WINAMAX, live 2026-10-04): the AI writes it.
      const asksMore = /r[ée]alisations?|achievements?|accomplishments?|describe|d[ée]cri(vez|re)|quelles? sont|what (are|were)|tell us|expliquez|explain|examples?|exemples?/i.test(tql);
      if (!asksMore && /how many years|combien d.ann[ée]es|nombre d.ann[ée]es|years of .{0,60}experience|ann[ée]es d.exp[ée]rience/i.test(tql)) {
        const y = yearsForQuestion(tq, config);
        const v = (y.basis === 'total' && !y.years) ? String(config.yearsOfExperience || '0') : String(y.years);
        u().fill(ta, v); u().log(`Years exp (textarea): ${v} (${y.basis})`); continue;
      }
      if (/notice period|pr[ée]avis|preaviso|preavviso|k[üu]ndigungsfrist/i.test(tql) && config.noticePeriod && !START_DATE_RE.test(tql)) {
        const v = noticePeriodText(tq, config);
        u().fill(ta, v); u().log(`Notice period (textarea): ${v}`); continue;
      }
      const answer = await window.EAM.aiForm.askAI(tq, config, 'textarea');
      if (answer) {
        u().fill(ta, answer);
        u().log(`AI textarea: "${label.substring(0, 40)}" → "${answer.substring(0, 50)}"`);
      } else {
        u().log(`Textarea not filled: "${label.substring(0, 50)}"`);
      }
    }
  }

  // ─── Location autocomplete ────────────────────────────────────────────
  async function handleLocationAutocomplete(input) {
    await u().wait(1000);
    let dropdown = null;
    const dropdownSelectors = [
      '[role="listbox"]',
      '.basic-typeahead__selectable',
      '.artdeco-typeahead__results',
      '.artdeco-dropdown__content-inner',
      'ul[role="listbox"]',
      '.typeahead-results'
    ];
    for (const selector of dropdownSelectors) {
      dropdown = document.querySelector(selector);
      if (dropdown && dropdown.offsetParent !== null) break;
    }
    if (dropdown) {
      const optionSelectors = [
        '[role="option"]:first-child',
        'li:first-child',
        '.basic-typeahead__selectable-item:first-child'
      ];
      let firstOption = null;
      for (const selector of optionSelectors) {
        firstOption = dropdown.querySelector(selector);
        if (firstOption) break;
      }
      if (firstOption) {
        firstOption.click();
        u().log(`Location autocomplete: ${firstOption.textContent.substring(0, 30)}`);
        await u().wait(500);
      }
    } else {
      u().log('Using keyboard fallback for location');
      input.focus();
      await u().wait(300);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
      await u().wait(500);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      await u().wait(300);
    }
  }

  // ─── File/Resume inputs ───────────────────────────────────────────────
  // v2.5.100: the stored résumé is uploaded at most ONCE per job (Théo 2026-10-04: a CV
  // re-uploaded on every step / retry piles duplicate résumés into the user's LinkedIn
  // documents). Key = LinkedIn job id when the URL has one, else title|company.
  function resumeJobKey() {
    try {
      const m = location.href.match(/currentJobId=(\d+)|\/jobs\/view\/(\d+)/);
      if (m) return 'id:' + (m[1] || m[2]);
      const j = u().currentJobInfo;
      if (j && (j.title || j.company)) return 'job:' + j.title + '|' + j.company;
    } catch (_) {}
    return 'url:' + location.pathname;
  }
  async function fillResumeInputs(modal) {
    const state = u();
    let resumeAlreadySelected = false;
    const jobKey = resumeJobKey();
    // Already uploaded for this job, or our stored file already shown in the form (an earlier
    // step) → the résumé is never uploaded again; a cover-letter field is still handled.
    const resumeDone = () => window.__eamResumeUploadedFor === jobKey
      || !!(state.resumeFileName && (modal.textContent || '').includes(state.resumeFileName));
    if (resumeDone()) state.log('Résumé already in this application — not uploading it again');

    // EARLY EXIT for LinkedIn: if the Easy Apply modal already shows an
    // attached resume (LinkedIn auto-attaches the user's default), do not
    // re-upload — that creates the duplicate-attachment bug multiple users
    // have reported ("its uploading the resume again and again into linkedin
    // rather than reusing the existing one"). LinkedIn renders the existing
    // resume as a CARD with a filename like "Theo_resume.pdf" plus a
    // "Replace" / "Update" / "Change" button next to it.
    const isLinkedIn = location.hostname.includes('linkedin.com');
    if (isLinkedIn) {
      // Look for an existing resume attachment marker. LinkedIn uses several
      // class names across UI versions, so match defensively:
      //   - Filename text ending in .pdf/.docx/.doc visible in the modal
      //   - A "Replace" / "Update" / "Change" button next to a resume label
      //   - data-test-document-upload-item present (LinkedIn 2024+)
      //   - Card with aria-selected="true" or class containing "selected"
      const modalText = (modal.textContent || '').toLowerCase();
      const hasFilenameInModal = /\.(pdf|docx|doc)\b/i.test(modal.textContent || '');
      const hasReplaceBtn = !!modal.querySelector(
        'button[aria-label*="Replace" i], button[aria-label*="Update" i], ' +
        'button[aria-label*="Change" i], button[aria-label*="Remplacer" i]'
      );
      const hasUploadedCard = !!modal.querySelector(
        '[data-test-document-upload-item], ' +
        '.jobs-document-upload-redesign-card--selected, ' +
        '[class*="resume-card"][class*="selected"], ' +
        '[class*="document-upload"][aria-selected="true"], ' +
        '[class*="ResumeCard"]'
      );
      // Need either (a) explicit "selected" state or (b) filename + Replace btn
      // together (proof an existing resume is shown). Just having .pdf text
      // alone could match the JD itself, so we require corroboration.
      if (hasUploadedCard || (hasFilenameInModal && hasReplaceBtn)) {
        state.log('LinkedIn: existing resume already attached, skipping upload');
        return;
      }
    }

    // STEP 1: Try to select existing/previously uploaded resume
    const resumeSelectors = [
      'input[type="radio"][name*="resume"]',
      'input[type="radio"][name*="cv"]',
      'input[type="radio"][id*="resume"]',
      'input[type="radio"][id*="document"]',
      '[data-test-document-upload-item]',
      '.jobs-document-upload-redesign-card',
      '.jobs-document-upload__container',
      '.document-upload-item',
      '[class*="resume-card"]',
      '[class*="document-card"]',
      // Newer LinkedIn 2025+ selectors
      '[class*="ResumeCard"]',
      'div[aria-label*="resume" i][role="radiogroup"] [role="radio"]',
      'div[class*="document-upload"] li'
    ];

    for (const selector of resumeSelectors) {
      const resumeOptions = modal.querySelectorAll(selector);
      if (resumeOptions.length > 0) {
        for (const option of resumeOptions) {
          if (option.offsetParent !== null) {
            if (option.type === 'radio') {
              if (!option.checked) {
                const label = modal.querySelector(`label[for="${option.id}"]`);
                if (label) {
                  label.click();
                  state.log(`Selected existing resume: ${label.textContent.substring(0, 40)}`);
                } else {
                  option.click();
                  state.log('Selected existing resume (radio)');
                }
                resumeAlreadySelected = true;
                await state.wait(500);
                break;
              } else {
                state.log('Resume already selected');
                resumeAlreadySelected = true;
                break;
              }
            } else {
              const isSelected = option.classList.contains('selected') ||
                                option.getAttribute('aria-selected') === 'true' ||
                                option.querySelector('input[type="radio"]:checked');
              if (!isSelected) {
                option.click();
                state.log('Selected existing resume card');
                resumeAlreadySelected = true;
                await state.wait(500);
                break;
              } else {
                state.log('Resume card already selected');
                resumeAlreadySelected = true;
                break;
              }
            }
          }
        }
        if (resumeAlreadySelected) break;
      }
    }

    // STEP 2: Upload resume OR cover letter into the appropriate input.
    if (!resumeAlreadySelected && state.resumeFile && state.resumeFileName && state.resumeFileType) {
      const S = window.EAM && window.EAM.JobBoardStrings;
      const fileInputs = modal.querySelectorAll('input[type="file"]');
      for (const fileInput of fileInputs) {
        if (fileInput.files && fileInput.files.length > 0) continue;

        const labelText = getFieldLabel(fileInput, modal).toLowerCase();

        // Detect cover letter FIRST (more specific than "resume"/"cv" — the
        // word "cv" alone would also match "cv letter" etc., so order matters).
        const isCoverLetter = S && S.matchText(labelText, 'cover_letter');
        const isResume = S ? S.matchText(labelText, 'resume') : /resume|cv|curriculum|vitae/.test(labelText);
        // Generic "upload" hint without resume/cover context — previously we'd
        // upload resume here. Now we require an explicit resume signal.
        const isGenericUpload = !isCoverLetter && !isResume && /upload.*document/.test(labelText);

        if (isCoverLetter) {
          if (state.coverLetterFile && state.coverLetterFileName && state.coverLetterFileType) {
            state.log(`Cover letter field: uploading cover letter — ${labelText.substring(0, 60)}`);
            const file = state.base64ToFile(state.coverLetterFile, state.coverLetterFileName, state.coverLetterFileType);
            if (file) {
              const ok = await state.fillFileInput(fileInput, file);
              if (ok) { state.log('Cover letter uploaded'); await state.wait(500); }
            }
          } else {
            state.log(`Cover letter field detected but no cover letter on file — skipping (NOT uploading resume)`);
          }
          continue;
        }

        if (isResume) {
          if (resumeDone()) continue;
          state.log(`Resume field: uploading resume — ${labelText.substring(0, 60)}`);
          const file = state.base64ToFile(state.resumeFile, state.resumeFileName, state.resumeFileType);
          if (file) {
            const ok = await state.fillFileInput(fileInput, file);
            if (ok) { window.__eamResumeUploadedFor = jobKey; state.log('Resume uploaded successfully'); await state.wait(500); }
          }
          continue;
        }

        if (isGenericUpload && !resumeDone()) {
          // Ambiguous — prefer resume but log clearly so we can diagnose.
          state.log(`Generic upload field (no clear resume/cover label): uploading resume — ${labelText.substring(0, 60)}`);
          const file = state.base64ToFile(state.resumeFile, state.resumeFileName, state.resumeFileType);
          if (file) {
            const ok = await state.fillFileInput(fileInput, file);
            if (ok) { window.__eamResumeUploadedFor = jobKey; await state.wait(500); }
          }
        }
        // Otherwise: unknown file input (e.g. portfolio, transcript) — leave alone.
      }
    }
  }

  // v2.5.87: country questions → profile country (never the first option).
  const COUNTRY_NAMES = {
    FR: ['france'], US: ['united states', 'united states of america', 'usa', 'états-unis', 'etats-unis'], IN: ['india', 'inde'],
    GB: ['united kingdom', 'uk', 'royaume-uni', 'great britain'], UK: ['united kingdom', 'uk', 'royaume-uni', 'great britain'],
    DE: ['germany', 'allemagne', 'deutschland'], ES: ['spain', 'espagne', 'españa'], IT: ['italy', 'italie', 'italia'],
    BE: ['belgium', 'belgique'], CH: ['switzerland', 'suisse'], CA: ['canada'], NL: ['netherlands', 'pays-bas'],
    PT: ['portugal'], IE: ['ireland', 'irlande'], LU: ['luxembourg'], MA: ['morocco', 'maroc'], PK: ['pakistan'],
    AE: ['united arab emirates', 'émirats arabes unis'], SG: ['singapore', 'singapour'], AU: ['australia', 'australie'],
  };
  function isCountryQuestion(label) {
    return /\b(country|countries|pays|país|paese|land|nationality|nationalit[ée]|citizenship|citoyennet[ée])\b/i.test(String(label || ''));
  }
  function looksLikeCountryList(texts) {
    const t = texts.map(x => String(x || '').trim().toLowerCase());
    return t.length > 30 && t.includes('afghanistan') && (t.includes('france') || t.includes('albania'));
  }
  function findCountryOption(options, textOf, config) {
    const raw = String((config && config.country) || '').trim();
    if (!raw) return null;
    const names = COUNTRY_NAMES[raw.toUpperCase()] || [raw.toLowerCase()];
    const norm = s => String(s || '').trim().toLowerCase();
    return options.find(o => names.includes(norm(textOf(o)))) ||
      options.find(o => names.some(n => n.length > 3 && norm(textOf(o)).startsWith(n))) || null;
  }

  // v2.5.87: shared with ai-form (single source of truth for the opt-in regex).
  function isMarketingOptInLabel(label) {
    try { return !!(window.EAM && window.EAM.aiForm && window.EAM.aiForm.isMarketingOptIn && window.EAM.aiForm.isMarketingOptIn(label)); }
    catch (_) { return false; }
  }

  // v2.5.92: self-declaration questions (conflict of interest, current/former employee of a
  // named group, relationship with staff, prior interview, criminal record…). The generic
  // Yes default declared Théo a Booking Holdings employee + ex-Deloitte on a live Agoda form
  // (2026-09-27). The default for these is always the negative answer.
  const SELF_DECLARATION_RE = /\b(presently|currently|previously|formerly|ever)\b.{0,40}\b(employed|associated|affiliated)\b|\b(presently|currently|previously|formerly|ever)\b.{0,20}\bwork(ed|ing)?\s+(for|at)\b|\b(current|former)\s*(\/\s*(an\s+)?)?(ex[- ])?employee\b|\bex[- ]employee\b|\brelationship with\b|\brelated to (a|an|any)\b|\b(relatives?|family members?)\b.{0,60}\b(work|employ)|\bassociated with\b.{0,60}\b(entit|compan|subsidiar|firm|group)|\baffiliated with\b|conflict of interest|\b(previously|already|before)\b.{0,30}\b(applied|interviewed)\b|\binterview process\b.{0,80}\b(past|within|last)\b|\bapplied\b.{0,40}\b(before|previously|in the past)\b|\b(convicted|criminal record|felony|misdemeanou?r)\b|\bnon-?compete\b|government official|politically exposed|d[ée]j[àa] (postul|travaill)|actuellement (employ|salari)|ancien (salari|employ)|lien de parent|conflit d.int[ée]r[êe]t/i;
  function isSelfDeclarationQuestion(text) { return SELF_DECLARATION_RE.test(String(text || '')); }
  const NEGATIVE_OPTION_RE = /^(no|non|nein)\b|\b(i am not|i'm not|i have not|i haven't|have never|never|not (a|an|currently)|none)\b|^je (ne|n')/i;

  // ─── Checkboxes ───────────────────────────────────────────────────────
  async function fillCheckboxes(modal, config) {
    // Pass 1: standalone consent/GDPR checkboxes — auto-check.
    const checkboxes = modal.querySelectorAll('input[type="checkbox"]');
    for (const checkbox of checkboxes) {
      if (checkbox.id === 'follow-company-checkbox') continue;
      const checkboxLabel = modal.querySelector(`label[for="${checkbox.id}"]`);
      const labelText = checkboxLabel ? checkboxLabel.textContent.toLowerCase() : '';
      // v2.5.87 (Théo 2026-09-25): marketing / contact opt-ins stay UNCHECKED
      // (and a pre-checked one is unticked) — unless the box is required to
      // submit, in which case it is ticked so the application doesn't fail.
      if (isMarketingOptInLabel(labelText)) {
        const required = checkbox.required || checkbox.getAttribute('aria-required') === 'true' || /\*\s*$|\brequired\b|obligatoire/i.test(labelText);
        if (required && !checkbox.checked) {
          checkboxLabel ? checkboxLabel.click() : checkbox.click();
          u().log(`Checkbox opt-in REQUIRED → checked: ${labelText.substring(0, 50)}`);
        } else if (!required && checkbox.checked) {
          checkboxLabel ? checkboxLabel.click() : checkbox.click();
          u().log(`Checkbox opt-in → unchecked: ${labelText.substring(0, 50)}`);
        } else {
          u().log(`Checkbox opt-in left ${checkbox.checked ? 'checked (required)' : 'unchecked'}: ${labelText.substring(0, 50)}`);
        }
        await u().wait(200);
        continue;
      }
      if (labelText.match(/consent|agree|terms|conditions|policy|privacy|accept|j'accepte|j'autorise|consentement/)) {
        if (!checkbox.checked) {
          checkboxLabel ? checkboxLabel.click() : checkbox.click();
          u().log(`Checkbox: ${labelText.substring(0, 40)}`);
          await u().wait(300);
        }
      }
    }

    // Pass 2 (v2.5.86): multi-select checkbox groups ("select all that apply").
    // Mirrors the radio-group AI pattern at line ~782. Groups 2+ checkboxes
    // living in the same fieldset with a common question label + fires
    // askAI(fieldType='checkbox', options=[...]). Expects JSON array back
    // per ai-form.js isMultiChoice branch. Falls back to no-op if AI fails
    // — never clicks blindly, unlike the radio fallback which picks the
    // first option (a wrong multi-select is a worse honesty problem than
    // an empty one).
    if (!window.EAM?.aiForm || !config) return;
    const fieldsets = modal.querySelectorAll('fieldset, [role="group"]');
    for (const fs of fieldsets) {
      const cbs = Array.from(fs.querySelectorAll('input[type="checkbox"]'));
      if (cbs.length < 2) continue;
      // Skip if already partially answered — respect user selection.
      if (cbs.some(c => c.checked)) continue;
      // Skip if the fieldset only holds consent/GDPR checkboxes.
      const groupText = (fs.textContent || '').toLowerCase();
      if (!/\b(select all|check all|all that apply|choose all|pick all|which of the following.*apply)\b/i.test(groupText)) continue;

      const questionLabel = fs.querySelector('legend, [class*="label"]');
      const question = (questionLabel ? questionLabel.textContent : groupText.split('\n')[0]).trim();
      const optionLabels = cbs.map(c => {
        const lbl = fs.querySelector(`label[for="${c.id}"]`);
        return (lbl ? lbl.textContent : (c.value || '')).trim();
      }).filter(Boolean);
      if (optionLabels.length < 2) continue;

      try {
        const aiPick = await window.EAM.aiForm.askAI(question, config, 'checkbox', optionLabels);
        // Response is a JSON array in isMultiChoice mode. Parse defensively —
        // strip code fences, trim, then JSON.parse.
        const cleaned = String(aiPick || '').trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
        let picks;
        try { picks = JSON.parse(cleaned); } catch { picks = null; }
        if (!Array.isArray(picks) || picks.length === 0) {
          u().log(`Multi-checkbox AI: no picks for "${question.substring(0, 40)}"`);
          continue;
        }
        const pickNorm = new Set(picks.map(p => String(p || '').trim().toLowerCase()));
        let clicked = 0;
        for (const c of cbs) {
          const lbl = fs.querySelector(`label[for="${c.id}"]`);
          const txt = (lbl ? lbl.textContent : (c.value || '')).trim().toLowerCase();
          if (!txt) continue;
          const hit = pickNorm.has(txt) || [...pickNorm].some(p => p && (txt.includes(p) || p.includes(txt)));
          if (hit && !c.checked) {
            (lbl || c).click();
            clicked++;
            await u().wait(200);
          }
        }
        u().log(`Multi-checkbox AI: ${clicked}/${picks.length} on "${question.substring(0, 30)}"`);
      } catch (e) {
        u().log(`Multi-checkbox AI failed: ${e.message}`);
      }
    }
  }

  // ─── Gender option matching (multilingual) ───────────────────────────
  // Maps a canonical gender value (stored in user profile) to regexes that
  // match the corresponding option label across languages.
  const GENDER_LABEL_PATTERNS = {
    male: /\b(male|man|homme|hombre|varón|varon|masculino|mann|m[äa]nnlich|uomo|maschio)\b/i,
    female: /\b(female|woman|femme|mujer|femenino|frau|weiblich|donna|femmina)\b/i,
    non_binary: /\b(non[- ]binary|non[- ]binaire|no[- ]binario|nicht[- ]bin[äa]r|non[- ]binario|genderqueer|enby)\b/i,
    other: /\b(other|autre|otro|andere|altro)\b/i,
    prefer_not_to_say: /(prefer.*not|décline|decline|preferir.*no|mieux.*pas.*dire|no contestar|keine angabe|preferisco non)/i,
  };

  function matchGenderOption(optionText, canonical) {
    const pattern = GENDER_LABEL_PATTERNS[canonical];
    return pattern ? pattern.test(optionText) : false;
  }

  // Parse a range from a radio label and return {min,max,inclusive}.
  // Handles: "Moins de 2 ans", "Entre 3 et 5 ans", "Plus de 9 ans",
  // "Less than 2 years", "3-5 years", "6 to 8 years", "9+ years",
  // "Über 9 Jahre", "Menos de 2 años", etc.
  function parseYearsRange(label) {
    const t = (label || '').toLowerCase().trim();
    // "less than N", "moins de N", "menos de N", "unter N", "meno di N"
    let m = t.match(/(?:less\s+than|moins\s+de|menos\s+de|unter|weniger\s+als|meno\s+di)\s+(\d+)/i);
    if (m) return { min: 0, max: parseInt(m[1], 10) - 1 };
    // "more than N", "plus de N", "más de N", "mehr als N", "N+", "over N"
    // "plus de N" is treated as ≥N (inclusive) — French UI convention.
    // If we used N+1 a user with exactly N years would miss the bucket.
    m = t.match(/(?:more\s+than|plus\s+de|m[áa]s\s+de|mehr\s+als|über|ueber|piu\s+di|oltre|over)\s+(\d+)/i);
    if (m) return { min: parseInt(m[1], 10), max: 999 };
    m = t.match(/(\d+)\s*\+/);
    if (m) return { min: parseInt(m[1], 10), max: 999 };
    // "between N and M", "entre N et M", "entre N y M", "zwischen N und M"
    m = t.match(/(?:between|entre|zwischen|tra|fra)\s+(\d+)\s+(?:and|et|y|und|e)\s+(\d+)/i);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    // "N-M years/ans"
    m = t.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    // "N to M"
    m = t.match(/(\d+)\s+(?:to|à|a)\s+(\d+)/i);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    // "N years" (exact)
    m = t.match(/^(\d+)\s+(?:years?|ans?|années?|jahr|jahre|anni|años)$/i);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
    return null;
  }

  function fillYearsRangeRadio(fieldset, radioInputs, cvYears) {
    // Score each radio by whether cvYears falls inside its parsed range
    let bestRadio = null;
    let bestScore = -1;
    for (const radio of radioInputs) {
      const label = _radioLabel(fieldset, radio);
      const text = label ? label.textContent : (radio.value || '');
      const range = parseYearsRange(text);
      if (!range) continue;
      // Score: 100 if inside range, else negative distance
      let score;
      if (cvYears >= range.min && cvYears <= range.max) score = 100;
      else score = -Math.min(Math.abs(cvYears - range.min), Math.abs(cvYears - range.max));
      if (score > bestScore) { bestScore = score; bestRadio = radio; }
    }
    if (bestRadio && !bestRadio.checked) {
      const lbl = _radioLabel(fieldset, bestRadio);
      lbl ? lbl.click() : bestRadio.click();
      u().log(`Radio YoE ${cvYears}y → ${(lbl?.textContent || bestRadio.value || '').trim().slice(0, 30)}`);
      return true;
    }
    return false;
  }

  function fillGenderRadio(fieldset, radioInputs, canonicalGender) {
    // Empty canonical means user picked "Prefer not to say" or didn't set it
    // — we honor that by NOT auto-filling (leave unanswered).
    if (!canonicalGender) {
      u().log('Gender question: user has no gender set — leaving blank');
      return true; // signal "handled" so caller doesn't fall back to Yes/first
    }
    for (const radio of radioInputs) {
      const label = _radioLabel(fieldset, radio);
      const text = label ? label.textContent.trim() : (radio.value || '');
      if (matchGenderOption(text, canonicalGender)) {
        if (!radio.checked) {
          label ? label.click() : radio.click();
          u().log(`Gender: selected "${text.substring(0, 30)}" for ${canonicalGender}`);
        }
        return true;
      }
    }
    u().log(`Gender: no matching option for "${canonicalGender}" — leaving blank`);
    return true; // don't fall back to Yes/first — wrong answer is worse than blank
  }

  // Language-level radio (English / French / Spanish + A1..C2 or Basic
  // /Intermediate/Fluent/Native). Reads user's declared level for that
  // language from config.languages, maps to closest option. If no match,
  // picks the "safe middle" (Professional > Fluent > Advanced > B2 >
  // Intermediate > middle-of-scale) instead of falling back to first
  // option (A1) which the yes/no path would otherwise select.
  // Théo repro 2026-09-17: bot ticked A1 every language question.
  function _detectLanguageInQuestion(questionText) {
    const q = questionText.toLowerCase();
    const map = [
      { rx: /\benglish\b|\banglais\b|\bingl[eé]s\b|\binglese\b/i,        canonical: 'english',    aliases: ['english','anglais','inglés','ingles','inglese'] },
      { rx: /\bfrench\b|\bfran[çc]ais\b|\bfranc[eé]s\b|\bfrancese\b/i,   canonical: 'french',     aliases: ['french','français','francais','francés','francese'] },
      { rx: /\bspanish\b|\bespagnol\b|\bespa[nñ]ol\b|\bspagnolo\b/i,     canonical: 'spanish',    aliases: ['spanish','espagnol','español','espanol','spagnolo'] },
      { rx: /\bgerman\b|\ballemand\b|\balem[aá]n\b|\btedesco\b/i,        canonical: 'german',     aliases: ['german','allemand','alemán','aleman','tedesco','deutsch'] },
      { rx: /\bitalian\b|\bitalien\b|\bitaliano\b/i,                     canonical: 'italian',    aliases: ['italian','italien','italiano'] },
      { rx: /\bchinese\b|\bchinois\b|\bmandarin\b|\b中文\b|\bchino\b/i,   canonical: 'chinese',    aliases: ['chinese','chinois','mandarin','chino','中文'] },
      { rx: /\barabic\b|\barabe\b|\b[áa]rabe\b/i,                        canonical: 'arabic',     aliases: ['arabic','arabe','árabe'] },
      { rx: /\bportuguese\b|\bportugu[eê]s\b/i,                          canonical: 'portuguese', aliases: ['portuguese','português','portugues'] },
      { rx: /\bdutch\b|\bn[ée]erlandais\b|\bnederlands\b/i,              canonical: 'dutch',      aliases: ['dutch','néerlandais','nederlands','hollandais'] },
      { rx: /\brussian\b|\brusse\b|\bruso\b/i,                           canonical: 'russian',    aliases: ['russian','russe','ruso','russo'] },
      { rx: /\bjapanese\b|\bjaponais\b/i,                                canonical: 'japanese',   aliases: ['japanese','japonais','日本語'] },
      { rx: /\bhindi\b/i,                                                canonical: 'hindi',      aliases: ['hindi'] },
    ];
    for (const m of map) if (m.rx.test(q)) return m;
    return null;
  }
  function _userLevelRank(rawLevel) {
    // Higher = better. 0 = unknown. Regexes intentionally OMIT trailing \b
    // so word roots match plural / feminine / suffixed forms (bilingu-e,
    // maternell-e, avanc-é, natif → nativa, etc.). Order matters: check
    // highest-rank patterns first so "bilingue" doesn't match a lower tier.
    const s = String(rawLevel || '').toLowerCase();
    if (!s) return 0;
    if (/(native|natif|nativa?|nativo|maternell|muttersprache|langue maternelle|c2)/.test(s)) return 6;
    if (/(bilingu|c1|proficient|maitrise|maîtrise)/.test(s))                                  return 5;
    if (/(fluent|courant|fluid|fli[eè]ssend|b2|upper[-\s]?intermediate)/.test(s))             return 4;
    if (/(professional|professionnel|advanced|avanc[eé]|avanzado|conversational)/.test(s))    return 4;
    if (/(intermediate|interm[eé]diaire|intermedio|b1)/.test(s))                              return 3;
    if (/(a2|elementary|[eé]l[eé]mentaire|elemental|basic|basique|b[aá]sico|d[eé]butant|beginner|principiante)/.test(s)) return 2;
    if (/(a1|notions)/.test(s))                                                               return 1;
    return 0;
  }
  function _optionLevelRank(text) {
    const s = String(text || '').toLowerCase();
    if (/(c2|native|natif|nativa?|nativo|maternell|proficient user)/.test(s))                 return 6;
    if (/(c1|bilingu|maitrise|maîtrise|expert)/.test(s))                                      return 5;
    if (/(b2|fluent|courant|fluid|upper[-\s]?intermediate|professional working|full professional)/.test(s)) return 4;
    if (/(professional|professionnel|professionnelle|advanced|avanc[eé]|avanzado|conversational|op[ée]rationnel)/.test(s)) return 4;
    if (/(b1|intermediate|interm[eé]diaire|intermedio)/.test(s))                              return 3;
    if (/(a2|elementary|[eé]l[eé]mentaire|basic|basique|b[aá]sico|limited working|scolaire)/.test(s)) return 2;
    if (/(a1|beginner|d[eé]butant|principiante|notions|none|no knowledge|aucun|introduct|initiation|novice)/.test(s))    return 1;
    return 0;
  }
  // v2.5.97: language-level <select> / listbox — same ranking as the radios. Live
  // 2026-10-03 (julhiet sterwen, SmartRecruiters, submitted): "Quel est votre niveau
  // d'anglais ?" options Introductif/… matched none of the native/fluent/professional
  // words and fell through to the blind options[1] = "Introductif" for a Fluent user.
  // Returns the option to pick, or null (leave unanswered — never blind).
  function pickLanguageLevelOption(options, getText, questionText, userLanguages) {
    const lang = _detectLanguageInQuestion(String(questionText || '').toLowerCase());
    let userLevelRaw = '';
    if (lang && Array.isArray(userLanguages)) {
      for (const L of userLanguages) {
        const nm = (typeof L === 'string' ? L : (L && L.name) || '').toLowerCase();
        if (nm && lang.aliases.some(a => nm.includes(a))) { userLevelRaw = typeof L === 'string' ? L : (L && L.level) || ''; break; }
      }
    }
    let targetRank = _userLevelRank(userLevelRaw);
    if (targetRank === 0) targetRank = 4;
    let best = null, bestScore = Infinity;
    for (const o of options) {
      const rank = _optionLevelRank(getText(o));
      if (rank === 0) continue;
      const score = Math.abs(rank - targetRank) + (rank >= targetRank ? -0.1 : 0.1);
      if (score < bestScore) { bestScore = score; best = o; }
    }
    u().log(`Lang select ${lang ? lang.canonical : '?'} (user="${userLevelRaw}" rank=${targetRank}) → ${best ? '"' + String(getText(best)).trim().slice(0, 30) + '"' : 'left unanswered (no ranked option)'}`);
    return best;
  }

  // v2.5.97: a radio's label — label[for=id], else the wrapping <label>, else a label in the
  // radio's own wrapper. Native <dialog> forms (live 2026-10-03, DIMATIS) did not match the
  // for= lookup → "Oui/Non" groups read as unlabeled and got the blind first option.
  // v2.5.100: native-dialog radios (live 2026-10-04, Talink /jobs/search-results/) have an EMPTY
  // <label for> and the option text ("Yes" / "No") in a sibling <p> → the text comes from the
  // smallest container holding only this radio; the click still goes to the real label.
  function _radioOptionText(radio) {
    let n = radio.parentElement;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) {
      if (n.querySelectorAll('input[type="radio"]').length > 1) break;
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    return '';
  }
  function _radioLabel(scope, radio) {
    if (!radio) return null;
    try { if (radio.id) { const l = scope.querySelector('label[for="' + CSS.escape(radio.id) + '"]') || document.querySelector('label[for="' + CSS.escape(radio.id) + '"]');
      if (l && !(l.textContent || '').trim()) { const t = _radioOptionText(radio); if (t) return { textContent: t, click: () => l.click() }; }
      if (l) return l; } } catch (_) {}
    const wrap = radio.closest && radio.closest('label'); if (wrap) return wrap;
    const p = radio.parentElement; const sib = p && p.querySelector('label');
    if (sib) {
      // A sibling label that does not control the radio: clicking it would do nothing →
      // same text, but the click goes to the radio itself.
      if (sib.control === radio) return sib;
      return { textContent: sib.textContent, click: () => radio.click() };
    }
    return null;
  }
  function fillLanguageLevelRadio(fieldset, radioInputs, questionText, userLanguages) {
    const q = questionText.toLowerCase();
    const lang = _detectLanguageInQuestion(q);
    // Find user's level for this language (if any). Language entry can be a
    // string ("Français — natif") or {name, level}.
    let userLevelRaw = '';
    if (lang && Array.isArray(userLanguages)) {
      for (const L of userLanguages) {
        const nm = (typeof L === 'string' ? L : (L && L.name) || '').toLowerCase();
        if (!nm) continue;
        if (lang.aliases.some(a => nm.includes(a))) {
          userLevelRaw = typeof L === 'string' ? L : (L && L.level) || '';
          break;
        }
      }
    }
    let targetRank = _userLevelRank(userLevelRaw);
    // Default rank when profile has no matching language: professional (4).
    // Never pick 1 (A1) — recruiters use language-level filters to reject.
    if (targetRank === 0) targetRank = 4;
    let bestRadio = null;
    let bestDelta = Infinity;
    for (const radio of radioInputs) {
      const label = _radioLabel(fieldset, radio);
      const text = (label ? label.textContent : (radio.value || '')).trim();
      const rank = _optionLevelRank(text);
      if (rank === 0) continue;
      const delta = Math.abs(rank - targetRank);
      // Prefer equal-or-higher (round up) when a tie exists — better to
      // claim slightly higher than lower on language.
      const tiebreak = rank >= targetRank ? -0.1 : 0.1;
      const score = delta + tiebreak;
      if (score < bestDelta) { bestDelta = score; bestRadio = radio; }
    }
    if (bestRadio && !bestRadio.checked) {
      const lbl = _radioLabel(fieldset, bestRadio);
      lbl ? lbl.click() : bestRadio.click();
      const chosen = (lbl?.textContent || bestRadio.value || '').trim().slice(0, 30);
      u().log(`Lang ${lang ? lang.canonical : '?'} (user="${userLevelRaw}" rank=${targetRank}) → ${chosen}`);
      return true;
    }
    return false;
  }

  // ─── Radio buttons ────────────────────────────────────────────────────
  async function fillRadioButtons(modal, config) {
    // Legacy LinkedIn has data-test-form-builder-... on the fieldset.
    // The Apr 2026 /jobs/search-results/ shadow-DOM modal drops it and
    // uses plain <fieldset>, so accept any fieldset with ≥2 radios. We
    // also handle the case where radios are siblings without a wrapping
    // <fieldset> at all (some consent forms render <div role="radiogroup">).
    const seen = new Set();
    const radioGroups = [];
    for (const fs of modal.querySelectorAll('fieldset[data-test-form-builder-radio-button-form-component]')) {
      seen.add(fs); radioGroups.push(fs);
    }
    for (const fs of modal.querySelectorAll('fieldset, [role="radiogroup"]')) {
      if (seen.has(fs)) continue;
      if (fs.querySelectorAll('input[type="radio"]').length < 2) continue;
      seen.add(fs); radioGroups.push(fs);
    }
    // Last-resort: radios that aren't wrapped in any fieldset/radiogroup at
    // all. The Apr 2026 LinkedIn shadow-DOM modal does this — consent
    // radios sit as bare siblings inside the form. Group them by `name`
    // attribute (radio-group invariant) and synthesise a wrapping element
    // by walking up to the closest container that holds all radios in the
    // group (typically a <div> 2-3 levels up).
    const ungrouped = [...modal.querySelectorAll('input[type="radio"]')].filter(r => {
      // skip if already inside a captured group
      for (const g of seen) { if (g.contains(r)) return false; }
      return true;
    });
    const byName = {};
    for (const r of ungrouped) {
      const k = r.name || '__unnamed__';
      (byName[k] = byName[k] || []).push(r);
    }
    for (const [name, rs] of Object.entries(byName)) {
      if (rs.length < 2) continue; // not a group (single yes-only consent)
      // Find the closest common ancestor that contains all radios
      let synthFieldset = rs[0].parentElement;
      while (synthFieldset && rs.some(r => !synthFieldset.contains(r))) {
        synthFieldset = synthFieldset.parentElement;
      }
      if (!synthFieldset) synthFieldset = rs[0].parentElement || modal;
      // Walk up one more level so we capture the question text in the
      // surrounding `<p>` or heading sibling (radios are usually
      // grandchildren of the question container).
      if (synthFieldset.parentElement) synthFieldset = synthFieldset.parentElement;
      seen.add(synthFieldset);
      radioGroups.push(synthFieldset);
    }
    for (const fieldset of radioGroups) {
      // Question text — LinkedIn legacy uses <legend>, new shadow design
      // uses <p> or <span> siblings. Fall through several locations,
      // ending with the fieldset's full textContent so we never miss the
      // semantic context (e.g. consent-text questions).
      let questionLabel = fieldset.querySelector('legend, span[class*="title"], p[class*="title"], h3, h4');
      let questionText = (questionLabel ? questionLabel.textContent : fieldset.textContent || '').toLowerCase();
      let questionRaw = ""; // v2.5.100: the question as written (for the AI), when found outside a label
      const radioInputs = fieldset.querySelectorAll('input[type="radio"]');
      // v2.5.97: native <dialog> forms (/jobs/search-results/) put the question OUTSIDE the
      // radio group — the group's text was only its options ("ouinon"), so cache / AI / rules
      // never saw "Pouvez-vous commencer immédiatement ?" and the blind first option "Oui"
      // was submitted (DIMATIS, live 2026-10-03; the cached answer was "Non").
      try {
        const optTxt = Array.from(radioInputs).map(r => { const l = _radioLabel(fieldset, r); return ((l ? l.textContent : r.value) || '').trim(); }).filter(Boolean);
        const strip = (s) => { let t = String(s || ''); for (const o of optTxt) t = t.split(o).join(' '); return t.replace(/\s+/g, ' ').trim(); };
        // v2.5.100: the same native dialog carries the question in each radio's aria-label
        // ("Avez-vous déjà travaillé sur des projets monétique … ?") — the group text was
        // only "Yes No" → blind first option "Yes" (Talink, live 2026-10-04, discarded).
        const ariaQ = ((radioInputs[0] && radioInputs[0].getAttribute('aria-label')) || '').trim();
        if (!questionLabel && strip(ariaQ).length >= 8 && Array.from(radioInputs).every(r => (r.getAttribute('aria-label') || '').trim() === ariaQ)) {
          questionRaw = strip(ariaQ);
          questionText = (strip(ariaQ) + ' ' + optTxt.join(' ')).toLowerCase();
        } else if (!questionLabel && strip(fieldset.textContent).length < 4) {
          let q = '';
          const lb = fieldset.getAttribute && fieldset.getAttribute('aria-labelledby');
          if (lb) q = lb.split(/\s+/).map(id => (modal.querySelector(`#${CSS.escape(id)}`) || document.getElementById(id))?.textContent || '').join(' ');
          if (!strip(q)) q = (fieldset.getAttribute && fieldset.getAttribute('aria-label')) || '';
          for (let a = fieldset.parentElement, d = 0; !strip(q) && a && a !== modal && d < 4; a = a.parentElement, d++) {
            const t = strip(a.textContent);
            if (t.length >= 4 && t.length < 400) q = t;
          }
          if (strip(q)) { questionRaw = strip(q); questionText = (strip(q) + ' ' + optTxt.join(' ')).toLowerCase(); }
        }
      } catch (_) {}
      let answered = false;

      // Handle gender questions first — EEO self-identification sections on
      // Workday / Greenhouse / Lever. Only fills if user set a gender; if
      // "prefer not to say" (empty), we decline to answer below.
      if (/\b(gender|sex|genre|sexe|género|genero|geschlecht|genere)\b/i.test(questionText)) {
        if (fillGenderRadio(fieldset, radioInputs, config.gender)) continue;
      }

      // Years-of-experience questions (Indeed smartapply, Greenhouse, etc.)
      // Match user's yearsOfExperience to the right range option.
      // Detects EN + FR + ES + DE + IT phrasing.
      if (/\b(years? of|ans?\s+d[\'e]|années?|jahre|anni|años)\b.*(experience|exp[ée]rience|erfahrung|esperienza|experiencia)|how many years|combien.*ann[ée]e/i.test(questionText)
          || /\b(experience|exp[ée]rience)\b.*\b(years?|ans?|années?)\b/i.test(questionText)) {
        // v2.5.89: skill-specific years (0 when the skill is not in the CV), not the global total.
        const y = yearsForQuestion(questionLabel ? questionLabel.textContent : questionText, config);
        const known = y.basis !== 'total' || y.years > 0;
        if (known && fillYearsRangeRadio(fieldset, radioInputs, y.years)) { u().log(`Radio years basis: ${y.basis}`); continue; }
      }

      // Language-level radios (English/French/Spanish + level/niveau + CEFR
      // scale A1-C2 or Basic/Intermediate/Fluent/Native). Théo repro
      // 2026-09-17: bot was picking A1 (first option) via the yes/no
      // fallback. Look up the user's declared level for THAT language in
      // config.languages, then map to the closest radio option label.
      // Fallback when profile has no matching language: pick the "safe
      // middle" answer — Professional > Fluent > B2 > Intermediate — so we
      // never send a random A1 for someone who forgot to fill in a level.
      // v2.5.100: a level word alone is not a language question — "Quel est votre niveau de
      // compréhension de la tech ?" got the language "safe middle" (Avancé) in the gate. A
      // language must be named, or the options must be a language scale (A1–C2, natif, courant…).
      const _langScaleOpts = (() => { try { return Array.from(radioInputs).filter(r => { const l = _radioLabel(fieldset, r); return /^\s*(a1|a2|b1|b2|c1|c2|native|natif|maternelle|bilingu|fluent|courant|interm[ée]diaire|intermediate|beginner|d[ée]butant|basic|notions)/i.test((l ? l.textContent : r.value) || ''); }).length >= 2; } catch (_) { return false; } })();
      if ((/\b(level|niveau|proficiency|proficien[cç]y|nivel|livello|niveau de langue)\b/i.test(questionText) && (_detectLanguageInQuestion(questionText) || _langScaleOpts))
          || /\b(english|anglais|inglés|inglese|french|fran[çc]ais|francés|francese|spanish|espagnol|español|spagnolo|german|allemand|alemán|tedesco|italian|italien|italiano|chinese|chinois|mandarin|arabic|arabe|árabe|russian|russe|ruso|portuguese|portugu[eê]s|dutch|n[ée]erlandais|nederlands|japanese|japonais|hindi)\b.*\b(level|niveau|proficien|nivel|livello)\b/i.test(questionText)) {
        if (fillLanguageLevelRadio(fieldset, radioInputs, questionText, config.languages || [])) continue;
      }

      // v2.5.92: never overwrite a group that already has an answer (LinkedIn's saved
      // answer, the AI pick, or our previous pass on a re-run of the same step).
      if (Array.from(radioInputs).some(r => r.checked)) continue;

      // v2.5.100: question text that is only the options ("ouinon", "yesno") → never the Yes
      // default or the first option: left unanswered, the application is skipped.
      {
        let rest0 = ' ' + String(questionText || '').toLowerCase() + ' ';
        for (const r of radioInputs) { const l = _radioLabel(fieldset, r); for (const t of [l && l.textContent, r.value]) { const s = String(t || '').trim().toLowerCase(); if (s) rest0 = rest0.split(s).join(' '); } }
        rest0 = rest0.replace(/[^a-zà-ÿ]+/gi, '').replace(/(oui|non|yes|no|sí|si|ja|nein)/g, '');
        if (rest0.length < 4) {
          u().log(`Radio left unanswered (question text unreadable: "${questionText.substring(0, 30)}")`);
          u()._unknownFieldFails = (u()._unknownFieldFails || 0) + 3;
          continue;
        }
      }
      let desiredAnswer = 'yes';
      const isOptIn = isMarketingOptInLabel(questionText);
      const isSelfDecl = isSelfDeclarationQuestion(questionText);
      if (isOptIn) {
        desiredAnswer = 'no'; // v2.5.87: marketing / SMS opt-in → No, never the Yes default
      } else if (isSelfDecl) {
        desiredAnswer = 'no';
      } else if (questionText.match(/visa|sponsor|sponsorship/i) && config.visaSponsorship) {
        desiredAnswer = config.visaSponsorship;
      } else if (questionText.match(/author|legal.*work|permit.*work|eligib.*work|right.*work|autoris[ée]\(?e?\)?\s+[àa]\s+travailler|permis de travail|droit de travailler/i) && config.legallyAuthorized) {
        desiredAnswer = config.legallyAuthorized;
      } else if (questionText.match(/relocat|move.*locat|willing.*move/i) && config.willingToRelocate) {
        desiredAnswer = config.willingToRelocate;
      } else if (workLocationAnswer(questionText, config)) {
        // v2.5.98: "This job is on site, are you willing to work in Saudi Arabia?" got the Yes
        // default for a Paris candidate with relocate = no (live 2026-10-04, discarded at review).
        desiredAnswer = workLocationAnswer(questionText, config);
      } else if (minYearsQuestionAnswer(questionText, config)) {
        // v2.5.98: "Justifiez-vous d'au moins 3 ans d'expérience dans l'utilisation de l'outil
        // mentionné dans l'annonce ?" got the Yes default (MERITIS, live 2026-10-04, discarded).
        desiredAnswer = minYearsQuestionAnswer(questionText, config);
      } else if (experienceQuestionAnswer(questionText, config)) {
        // v2.5.98: "Do you have professional experience in the Airline/Aviation industry?" got
        // the Yes default with nothing in the CV (live 2026-10-04, discarded at review).
        desiredAnswer = experienceQuestionAnswer(questionText, config);
      } else if (questionText.match(/security.*clearance|clearance/i)) {
        desiredAnswer = 'no';
      } else if (questionText.match(/commencer\s+imm[ée]diatement|disponible\s+imm[ée]diatement|start\s+immediately|available\s+immediately|immediate(ly)?\s+(start|available|availability)|join\s+immediately|empezar\s+inmediatamente|sofort\s+(beginnen|verf[üu]gbar)/i)) {
        // v2.5.97: "Pouvez-vous commencer immédiatement ?" follows the notice period (live
        // 2026-10-03 DIMATIS: blind "Oui" with a 1-month notice). Notice 0 / immediate → yes.
        const np = String(config.noticePeriod || '').toLowerCase().trim();
        desiredAnswer = (!np || /^0\b|^(none|aucun|imm[ée]diat|immediate)/.test(np)) ? 'yes' : 'no';
      } else if (questionText.match(/driver.*license|driving.*license|valid.*license/i) && config.driversLicense) {
        desiredAnswer = config.driversLicense;
      }

      for (const radio of radioInputs) {
        const radioLabel = _radioLabel(fieldset, radio);
        const radioText = radioLabel ? radioLabel.textContent.trim().toLowerCase() : '';
        const isYes = radioText.match(/^(yes|oui|sí|si|ja|y)$/);
        const isNo = radioText.match(/^(no|non|nein|n)$/);
        if ((desiredAnswer === 'yes' && isYes) || (desiredAnswer === 'no' && isNo)) {
          if (!radio.checked) {
            radioLabel ? radioLabel.click() : radio.click();
            u().log(`Radio ${desiredAnswer}: ${questionText.substring(0, 30)}`);
          }
          answered = true; // already on the wanted answer counts too (no Yes-default flip)
          break;
        }
      }

      if (!answered && isSelfDecl) {
        // Non-"No" wording ("I am not…", "Never"): pick the negative option, else leave it.
        for (const radio of radioInputs) {
          const lbl = _radioLabel(fieldset, radio);
          const t = (lbl ? lbl.textContent : radio.value || '').trim();
          if (NEGATIVE_OPTION_RE.test(t)) { lbl ? lbl.click() : radio.click(); u().log(`Radio self-declaration → "${t.substring(0, 30)}"`); answered = true; break; }
        }
        if (!answered) { u().log(`Radio self-declaration left unanswered: ${questionText.substring(0, 40)}`); continue; }
      }

      if (!answered && !isOptIn) {
        for (const radio of radioInputs) {
          const radioLabel = _radioLabel(fieldset, radio);
          const radioText = radioLabel ? radioLabel.textContent.trim().toLowerCase() : '';
          if (radioText.match(/^(yes|oui|sí|si|ja|y)$/)) {
            if (!radio.checked) {
              radioLabel ? radioLabel.click() : radio.click();
              u().log(`Radio Yes (default): ${questionText.substring(0, 30)}`);
              answered = true;
            }
            break;
          }
        }
      }

      if (!answered && radioInputs.length > 0) {
        // 2026-09-18 (task #880 — Théo repro on Theodo application):
        // the yes/no fallback found no "yes" so we used to click the FIRST
        // option blindly. When the question is multi-choice like "How did
        // you hear about us?" (10 real options: LinkedIn / Google / Friend
        // / etc.), first-radio was semantically wrong. If ext AI is
        // available AND we have real option labels, ask the model to pick
        // the best matching one from the actual choices.
        const optionLabels = [];
        for (const r of radioInputs) {
          const lbl = _radioLabel(fieldset, r);
          const txt = lbl ? lbl.textContent.trim() : (r.value || '').trim();
          if (txt) optionLabels.push(txt);
        }
        let clicked = false;
        try {
          if (window.EAM && window.EAM.aiForm && optionLabels.length >= 2) {
            const cleanQ = (questionLabel ? questionLabel.textContent : '').trim();
            const q = cleanQ && cleanQ.length > 4 ? cleanQ : (questionRaw || fieldset.textContent.trim().split('\n')[0]);
            const aiPick = await window.EAM.aiForm.askAI(q, config, 'radio', optionLabels);
            const pickNorm = String(aiPick || '').trim().toLowerCase();
            if (pickNorm && pickNorm !== 'skip') {
              // Exact-label match, then contains, then loose word overlap
              let match = null;
              for (const r of radioInputs) {
                const lbl = _radioLabel(fieldset, r);
                const txt = (lbl ? lbl.textContent : (r.value || '')).trim().toLowerCase();
                if (txt === pickNorm) { match = { r, lbl }; break; }
              }
              if (!match) {
                for (const r of radioInputs) {
                  const lbl = _radioLabel(fieldset, r);
                  const txt = (lbl ? lbl.textContent : (r.value || '')).trim().toLowerCase();
                  if (txt && (txt.includes(pickNorm) || pickNorm.includes(txt))) { match = { r, lbl }; break; }
                }
              }
              if (match && !match.r.checked) {
                match.lbl ? match.lbl.click() : match.r.click();
                u().log(`Radio AI-pick: "${pickNorm.substring(0, 30)}" on "${questionText.substring(0, 30)}"`);
                clicked = true;
              }
            }
          }
        } catch (e) {
          u().log(`Radio AI-pick failed: ${e.message}`);
        }
        // Last-resort default: click the first option (previous behaviour).
        // Only when AI didn't pick — avoids leaving required-radios empty
        // which blocks the Continue button.
        // v2.5.98: never when the question itself could not be read (live 2026-10-04, MERITIS on
        // /jobs/search-results/: question text "ouinon" → blind "Oui", the step never advanced and
        // the form stayed open for 10 steps). Left unanswered → LinkedIn's validation → discarded.
        let qReadable = true;
        try {
          let rest = ' ' + String(questionText || '').toLowerCase() + ' ';
          for (const r of radioInputs) { const l = _radioLabel(fieldset, r); for (const t of [l && l.textContent, r.value]) { const s = String(t || '').trim().toLowerCase(); if (s) rest = rest.split(s).join(' '); } }
          rest = rest.replace(/\b(oui|non|yes|no|si|sí|ja|nein)\b/g, ' ').replace(/[^a-zà-ÿ]+/gi, '');
          // v2.5.100: glued option words ("yesno", "ouinon") are not a question either.
          qReadable = rest.replace(/(oui|non|yes|no|sí|si|ja|nein)/g, '').length >= 4;
        } catch (_) {}
        if (!clicked && !qReadable && !radioInputs[0].checked) {
          u().log(`Radio left unanswered (question text unreadable: "${questionText.substring(0, 30)}")`);
          u()._unknownFieldFails = (u()._unknownFieldFails || 0) + 3; // cannot decide safely → skip this application
        } else if (!clicked && !radioInputs[0].checked && !isOptIn) {
          const firstLabel = _radioLabel(fieldset, radioInputs[0]);
          firstLabel ? firstLabel.click() : radioInputs[0].click();
          u().log(`Radio first option (fallback): ${questionText.substring(0, 30)}`);
        }
      }
    }
  }

  // ─── Native <select> dropdowns ────────────────────────────────────────
  // v2.5.101 (live 2026-10-05): "Quel est votre niveau d'études ?" went out as "Bac" for a Master's
  // profile (a stale LinkedIn saved answer, pre-filled). Education level = highest CV degree; a
  // pre-filled LOWER level is corrected, a matching/higher one is left alone.
  const _EDU_Q = /(niveau\s+d.?[ée]tudes|niveau\s+de\s+(dipl[oô]me|formation)|dipl[oô]me\s+le\s+plus|plus\s+haut\s+dipl[oô]me|highest\s+(level\s+of\s+)?(education|degree|qualification)|education(al)?\s+level|level\s+of\s+education|nivel\s+(de\s+)?estudios|nivel\s+educativo)/i;
  function eduRank(text) {
    const t = _deaccent(String(text || '')).toLowerCase();
    if (/\b(doctorat|doctorate|phd|ph\.d|doctor)\b|bac\s*\+\s*8/.test(t)) return 8;
    if (/bac\s*\+\s*5|\bmaster|\bmba\b|\bmsc\b|\bm\.?s\.?c?\b|\bm2\b|ingenieur|engineer(ing)?\s+degree|grande\s+ecole|\bdea\b|\bdess\b|maestr[ií]a/.test(t)) return 5;
    if (/bac\s*\+\s*4|\bmaitrise\b|\bm1\b/.test(t)) return 4;
    if (/bac\s*\+\s*3|\blicence\b|\bbachelor|\bbsc\b|\bb\.?a\.?\b|\bba\b|\bbs\b|licenciatura|grado/.test(t)) return 3;
    if (/bac\s*\+\s*2|\bbts\b|\bdut\b|\bdeug\b|associate|\bhnd\b/.test(t)) return 2;
    if (/\bbac\b|baccalaureat|high\s*school|lycee|secondary|a[- ]levels?|bachillerato/.test(t)) return 1;
    return null;
  }
  function cvEduRank(config) {
    const edu = config && config.cvProfile && Array.isArray(config.cvProfile.education) ? config.cvProfile.education : [];
    let best = null;
    for (const e of edu) {
      const r = eduRank([e.degree, e.field, e.title].filter(Boolean).join(' '));
      if (r != null && (best == null || r > best)) best = r;
    }
    return best;
  }
  function fixEducationSelect(select, labelText, config) {
    if (!_EDU_Q.test(labelText)) return false;
    const target = cvEduRank(config);
    if (target == null) return false;
    const options = Array.from(select.options).filter(o => o.index > 0);
    let best = null, bestR = -1;
    for (const o of options) { const r = eduRank(o.text); if (r != null && r <= target && r > bestR) { best = o; bestR = r; } }
    if (!best) return false;
    const cur = select.selectedIndex > 0 ? eduRank(select.options[select.selectedIndex].text) : null;
    if (cur != null && cur === bestR) return true;   // pre-filled answer already at the CV level (higher or lower is corrected: never claim a degree the CV doesn't show)
    select.value = best.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    u().log(`Education level → "${best.text.trim()}" (CV level ${target}${cur != null ? ', corrected pre-filled level ' + cur : ''})`);
    return true;
  }

  async function fillSelectDropdowns(modal, config) {
    const selects = modal.querySelectorAll('select');
    for (const select of selects) {
      const labelText = getFieldLabel(select, modal).toLowerCase();
      if (fixEducationSelect(select, labelText, config)) continue;
      if (select.selectedIndex > 0) continue;

      const options = Array.from(select.options);
      let selectedOption = null;

      // Gender dropdown (EEO self-id on Workday/Greenhouse/etc.)
      if (/\b(gender|sex|genre|sexe|género|genero|geschlecht|genere)\b/i.test(labelText)) {
        const canonical = config && config.gender;
        if (canonical) {
          selectedOption = options.find(opt => matchGenderOption(opt.text, canonical));
        }
        // If user has no gender set OR no matching option, leave blank — never
        // guess. An auto-selected wrong gender is worse than an unanswered one.
        if (!selectedOption) {
          u().log(`Gender dropdown: leaving unanswered (user gender="${canonical || ''}", ${options.length} options)`);
          continue;
        }
      } else if ((isCountryQuestion(labelText) && options.length > 5) || looksLikeCountryList(options.map(o => o.text))) {
        // v2.5.87: country dropdowns use the profile country. Live bug 2026-09-25 00:44
        // (Agoda form): the options[1] fallback submitted "Afghanistan".
        selectedOption = findCountryOption(options, o => o.text, config);
        u().log(`Country select → ${selectedOption ? '"' + selectedOption.text.trim() + '"' : 'left unanswered (profile country not in list)'}: ${labelText.substring(0, 40)}`);
        if (!selectedOption) continue;
      } else if (/(how many years|years? of|combien d.ann|ann[ée]es? d.exp|años de experiencia)/i.test(labelText)
                 && options.filter(o => parseYearsRange(o.text)).length >= 2) {
        // v2.5.89: years-range dropdown ("0-1 / 2-4 / 5+") — pick the bucket for the
        // skill actually asked. Used to fall through to the blind options[1].
        const y = yearsForQuestion(getFieldQuestion(select, modal) || labelText, config);
        let best = null, bestScore = -Infinity;
        for (const o of options) {
          const r = parseYearsRange(o.text); if (!r) continue;
          const sc = (y.years >= r.min && y.years <= r.max) ? 100 : -Math.min(Math.abs(y.years - r.min), Math.abs(y.years - r.max));
          if (sc > bestScore) { bestScore = sc; best = o; }
        }
        selectedOption = best;
        u().log(`Years select → "${best ? best.text.trim() : '-'}" (${y.years}y, ${y.basis})`);
        if (!selectedOption) continue;
      } else if (labelText.match(/proficiency|level.*english|level.*french|level.*spanish|level.*german|niveau.*anglais|niveau.*français|nivel.*inglés|(english|anglais|french|fran[çc]ais|spanish|espagnol|german|allemand|italian|italien).*(level|niveau|proficien)|niveau.*(langue|espagnol|allemand|italien)/)) {
        // v2.5.97: ranked against the user's level for that language; never the blind options[1].
        selectedOption = pickLanguageLevelOption(options, o => o.text, getFieldQuestion(select, modal) || labelText, config.languages || []);
        if (!selectedOption) continue;
      } else if (labelText.match(/english|anglais|language|langue|french|français|spanish|español|german|deutsch/)) {
        selectedOption = options.find(opt => opt.text.toLowerCase().match(/native|bilingual|fluent|courant|professionnel|bilingue/));
      }

      // Yes/No question selects — applied AFTER gender + language checks so
      // the more specific intents have priority. Same matching the radio-
      // button handler uses (visa, work-authorization, relocate, license,
      // security-clearance). Test-autofill on /test-autofill flagged this
      // gap on 2026-06-29 — previously the dropdown fell through to the
      // "pick options[1]" fallback, which always selected Yes even when
      // the user's profile said No (e.g. visaSponsorship: 'no').
      if (!selectedOption) {
        const isYesNo = options.length >= 2 && options.length <= 4 &&
          options.some(o => /^(yes|oui|sí|si|ja)$/i.test(o.text.trim())) &&
          options.some(o => /^(no|non|nein)$/i.test(o.text.trim()));
        if (isYesNo) {
          let desired = null;
          if (isMarketingOptInLabel(labelText)) desired = 'no'; // v2.5.87: opt-ins → No
          else if (labelText.match(/visa|sponsor|sponsorship/i)) desired = config.visaSponsorship;
          else if (labelText.match(/legal.*auth|legally.*auth|author.*work|permit.*work|eligib.*work|right.*work|authoris.*work/i)) desired = config.legallyAuthorized;
          else if (labelText.match(/relocat|move.*locat|willing.*move|willing.*relocate/i)) desired = config.willingToRelocate;
          else if (labelText.match(/driver.*license|driving.*license|valid.*license|permis.*conduire/i)) desired = config.driversLicense;
          else if (labelText.match(/security.*clearance|clearance/i)) desired = 'no';
          if (desired) {
            const want = desired.toString().toLowerCase().trim();
            const yesRe = /^(yes|oui|sí|si|ja)$/i;
            const noRe = /^(no|non|nein)$/i;
            selectedOption = options.find(o => want === 'yes' ? yesRe.test(o.text.trim()) : noRe.test(o.text.trim()));
            if (selectedOption) {
              u().log(`Yes/No select (${desired}): ${labelText.substring(0, 30)}`);
            }
          }
        }
      }

      // v2.5.92: self-declaration selects ("Yes, I am a current/ex-employee of Deloitte…")
      // take the negative option or stay unanswered — never the blind options[1].
      if (!selectedOption && isSelfDeclarationQuestion(getFieldQuestion(select, modal) || labelText)) {
        selectedOption = options.slice(1).find(o => NEGATIVE_OPTION_RE.test(o.text.trim()));
        u().log(`Self-declaration select → ${selectedOption ? '"' + selectedOption.text.trim().substring(0, 40) + '"' : 'left unanswered'}: ${labelText.substring(0, 40)}`);
        if (!selectedOption) continue;
      }
      // v2.5.87: opt-in selects never fall back to options[1] (often "Yes").
      if (!selectedOption && isMarketingOptInLabel(labelText)) {
        selectedOption = options.find(o => /^(no|non|nein)\b|do not|don'?t|decline|opt[- ]?out|ne (souhaite|veux) pas/i.test(o.text.trim()));
        u().log(`Opt-in select → ${selectedOption ? '"' + selectedOption.text.trim() + '"' : 'left unanswered (no "No" option)'}: ${labelText.substring(0, 40)}`);
        if (!selectedOption) continue;
      }
      // v2.5.87: never blind-pick in a long list (countries, cities, schools…) —
      // an unanswered required field skips the job, a wrong answer is submitted.
      if (!selectedOption && options.length > 30) {
        u().log(`Long select (${options.length} options) left unanswered: ${labelText.substring(0, 40)}`);
        continue;
      }
      if (!selectedOption && options.length > 1) {
        selectedOption = options[1];
      }
      if (selectedOption) {
        select.value = selectedOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // ─── Custom LinkedIn dropdowns ────────────────────────────────────────
  async function fillCustomDropdowns(modal) {
    const customDropdowns = modal.querySelectorAll('button[aria-haspopup="listbox"], button.artdeco-dropdown__trigger');
    for (const dropdown of customDropdowns) {
      let questionText = '';
      questionText += ' ' + (dropdown.getAttribute('aria-label') || '');
      questionText += ' ' + (dropdown.textContent || '');
      const dropdownId = dropdown.getAttribute('id');
      if (dropdownId) {
        const labelEl = modal.querySelector(`label[for="${dropdownId}"]`);
        if (labelEl) questionText += ' ' + labelEl.textContent;
      }
      const parentDiv = dropdown.closest('div[class*="form-component"]');
      if (parentDiv) {
        const label = parentDiv.querySelector('label, legend, span[class*="label"]');
        if (label) questionText += ' ' + label.textContent;
      }
      const question = questionText.toLowerCase();

      dropdown.click();
      await u().wait(500);

      const listbox = document.querySelector('[role="listbox"]');
      if (listbox) {
        const options = Array.from(listbox.querySelectorAll('[role="option"]'));
        if (options.length > 0) {
          let selectedOption = null;

          if (question.match(/proficiency|level.*english|level.*french|level.*spanish|niveau.*anglais|nivel.*inglés|(english|anglais|french|fran[çc]ais|spanish|espagnol|german|allemand|italian|italien).*(level|niveau|proficien)|niveau.*(langue|espagnol|allemand|italien)/)) {
            // v2.5.97: ranked against the user's level; never the blind first option.
            const _cfg = (window.EAM && window.EAM.utils && window.EAM.utils.config) || {};
            selectedOption = pickLanguageLevelOption(options, o => o.textContent, question, _cfg.languages || []);
            if (!selectedOption) { document.body.click(); continue; }
          }
          // v2.5.87: country list → profile country, never the first option ("Afghanistan").
          if (!selectedOption && ((isCountryQuestion(question) && options.length > 5) || looksLikeCountryList(options.map(o => o.textContent)))) {
            selectedOption = findCountryOption(options, o => o.textContent, window.EAM && window.EAM.utils && window.EAM.utils.config);
            if (!selectedOption) { u().log(`Country dropdown left unanswered: ${question.trim().substring(0, 40)}`); document.body.click(); continue; }
          }
          if (!selectedOption && options.length > 30) { u().log(`Long dropdown (${options.length}) left unanswered: ${question.trim().substring(0, 40)}`); document.body.click(); continue; }
          // v2.5.87: opt-in dropdown → the "No"-like option, never the first one.
          if (!selectedOption && isMarketingOptInLabel(question)) {
            selectedOption = options.find(opt => /^(no|non|nein)\b|do not|don'?t|decline|opt[- ]?out|ne (souhaite|veux) pas/i.test(opt.textContent.trim()));
            if (!selectedOption) { u().log(`Opt-in dropdown left unanswered (no "No" option): ${question.trim().substring(0, 40)}`); document.body.click(); continue; }
          }
          if (!selectedOption) {
            selectedOption = options.find(opt =>
              !opt.textContent.toLowerCase().includes('select') &&
              !opt.textContent.toLowerCase().includes('choose') &&
              !opt.textContent.toLowerCase().includes('choisir')
            );
          }
          if (selectedOption) {
            selectedOption.click();
            u().log(`Dropdown custom: ${selectedOption.textContent.substring(0, 30)}`);
            await u().wait(300);
          }
        }
      }
    }
  }

  // ─── Master fill function ─────────────────────────────────────────────
  async function fillFormStep(modal, config) {
    await fillTextInputs(modal, config);
    await fillResumeInputs(modal);
    await fillCheckboxes(modal, config);
    await fillRadioButtons(modal, config);
    await fillSelectDropdowns(modal, config);
    await fillCustomDropdowns(modal);
    await fillTextareas(modal, config);
  }

  // ─── Export ───────────────────────────────────────────────────────────
  window.EAM.FormFiller = {
    isSelfDeclarationQuestion,
    NEGATIVE_OPTION_RE,
    fillFormStep,
    fillTextInputs,
    fillResumeInputs,
    fillCheckboxes,
    fillRadioButtons,
    fillSelectDropdowns,
    fillCustomDropdowns,
    fillTextareas,
    getFieldLabel,
    getFieldQuestion,
    profileUrlKind,
    yearsQuestionSkill,
    yearsForQuestion,
    salaryAnswer,
    START_DATE_RE,
    isDateField,
    startDateAnswer,
    pickLanguageLevelOption
  };
})();
