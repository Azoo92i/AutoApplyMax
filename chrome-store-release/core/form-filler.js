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
    // v2.5.113: an instruction placeholder ("Enter city or location" on LinkedIn's "Location (city)*" typeahead) is
    // not the question — the visible question (and its required "*") comes from the ancestor text below.
    const _ph = clean(input.getAttribute('placeholder'));
    const _phIsHint = /^(enter|type|search|select|choose|start typing|e\.g\.?|ex\.?|saisi|tape|recherch|s[ée]lectionn)/i.test(_ph);
    if (!q && !_phIsHint) q = _ph;
    // v2.5.109 (telemetry 2026-10-12): native <dialog> fields have an EMPTY <label for> and the question in a
    // <p>/<span> of an ancestor — the fallback below returned id / urn junk ("r 1s", "linkedin profile single
    // line text form component formelement urn li jo…") to the AI and to form_skip_detail. Nearest ancestor
    // text that holds only this field (radio / checkbox group = one field), minus option and error texts.
    if (!q) {
      try {
        const own = input.type === 'radio' || input.type === 'checkbox' ? (input.name ? `input[name="${CSS.escape(input.name)}"]` : null) : null;
        for (let n = input.parentElement, k = 0; n && n !== modal && k < 7; n = n.parentElement, k++) {
          const ctl = Array.from(n.querySelectorAll('input:not([type="hidden"]), select, textarea'));
          if (ctl.some(c => c !== input && !(own && c.matches(own)))) break;
          const parts = Array.from(n.querySelectorAll('p, span, legend, label, h3, h4, div'))
            .filter(e => !e.children.length && !e.closest('label[for]'))
            .map(e => clean(e.textContent)).filter(t => t && t.length < 300 && !/^(this field is required|ce champ est (obligatoire|requis)|required|\d+\s*\/\s*\d+.*characters?|yes|no|oui|non)$/i.test(t));
          if (parts.length) { q = parts[0]; break; }
        }
      } catch (_) {}
    }
    if (!q && _ph) q = _ph;
    if (q) return q;
    // Last resort: attribute soup without the id / urn noise.
    return clean(getFieldLabel(input, modal)
      .replace(/\b[a-z_-]*single[\s_-]*line[\s_-]*text[\s\S]*$/i, '')
      .replace(/\burn[\s:]+li[\s:][\s\S]*$/i, '')
      .replace(/(^|\s)r\s+[0-9a-z]{1,5}(?=\s|$)/gi, ' '));
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
  // v2.5.108: the applicant's own public profile URL from their LinkedIn session (/voyager/api/me →
  // miniProfile.publicIdentifier). Only on linkedin.com, cached per page. Never a link read from the
  // page (the "Meet the hiring team" card links to the recruiter's profile).
  let _ownLiPromise = null;
  function ownLinkedInUrl() {
    if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return Promise.resolve('');
    if (_ownLiPromise) return _ownLiPromise;
    _ownLiPromise = (async () => {
      try {
        const tok = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1];
        if (!tok) return '';
        const res = await fetch('/voyager/api/me', { credentials: 'include', headers: { 'csrf-token': tok, accept: 'application/vnd.linkedin.normalized+json+2.1' } });
        if (!res.ok) return '';
        const j = await res.json();
        const mp = (j.included || []).find(o => o && o.publicIdentifier && /MiniProfile/i.test(o.$type || ''));
        return mp ? `https://www.linkedin.com/in/${encodeURIComponent(mp.publicIdentifier)}/` : '';
      } catch (_) { return ''; }
    })();
    return _ownLiPromise;
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
        // v2.5.106 (live 2026-10-10): "Compétences en gestion de projet" / "Activités de coordination" → 0 —
        // the generic head word is not the skill.
        s = s.replace(/^(?:comp[ée]tences?\s+(?:en|de|d['’]|du|des)\s*|activit[ée]s?\s+(?:de|d['’]|du|des)\s*|connaissances?\s+(?:en|de|d['’]|du|des)\s*|ma[îi]trise\s+(?:de|d['’]|du|des)\s*|skills?\s+in\s+|knowledge\s+of\s+|expertise\s+(?:in|en)\s+)/i, '').trim();
        // v2.5.107 (live 2026-10-11): "How many years of Other experience…" → skill "Other" → 0, and a
        // pre-filled 2 was LOWERED to 0. "Other" / "autre" names no skill → total experience.
        if (/^(?:other|others|any other|autres?|otras?|otros?|andere)$/i.test(s)) return '';
        // v2.5.111 (premium alert 2026-10-13): "Experience in Years" / "Relevant Experience in Years" → skill
        // "Years" → 0. A time unit is not a skill → total experience.
        s = s.replace(/\(?\b(?:in\s+|en\s+)?(?:years?|yrs?|ans|ann[ée]es?|months?|mois)\b\)?/gi, '').replace(/\s+/g, ' ').trim();
        if (/^(?:relevant|total|overall|overal|professional|work)?$/i.test(s)) return '';
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
    // v2.5.105 (live 2026-10-09): LinkedIn skill "Responsables de projet" → 0 for a CV listing Project Management.
    ['responsables de projet', 'project management'], ['responsable de projet', 'project management'],
    ['responsables de projet', 'chef de projet'], ['responsable de projet', 'chef de projet'],
    ['chefs de projet', 'project management'], ['chefs de projet', 'chef de projet'],
    // v2.5.106 (live 2026-10-10): "Agents d'intelligence artificielle" → 0 for a CV with AI / LLM solutions;
    // "Conseil en management" / "Stratégie IT" → 0 for a strategy consultant.
    ['agents d intelligence artificielle', 'ai'], ['intelligence artificielle', 'ai'], ['agents ia', 'ai'], ['ai agents', 'ai'],
    ['agents d intelligence artificielle', 'llm'], ['ai agents', 'llm'], ['ia generative', 'ai'], ['generative ai', 'ai'],
    ['conseil en management', 'consulting'], ['conseil en strategie', 'strategy'], ['management consulting', 'consulting'],
    ['strategie it', 'strategy'], ['strategie digitale', 'digital strategy'], ['strategie', 'strategy'],
    ['transformation numerique', 'digital'], ['transformation digitale', 'digital'],
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
    // v2.5.109 (live 2026-10-12): "Analyse des données" → 0 — the synonym key is "analyse de donnees";
    // FR articles (des / du / de la / d') are folded to "de" before the synonym lookup.
    const s0 = _norm(skill).trim();
    const sDe = (' ' + s0 + ' ').replace(/ (?:des|du|de la|de l|d) /g, ' de ').trim();
    for (const s of sDe !== s0 ? [s0, sDe] : [s0]) {
      for (const [a, b] of _SKILL_SYNONYMS) {
        if (s.includes(a) && _mentionsOne(text, s.replace(a, b))) return true;
        if (s.includes(b) && _mentionsOne(text, s.replace(b, a))) return true;
      }
    }
    return false;
  }
  // v2.5.113 (user report 2026-10-15, free US user, 7 years on the dashboard: "it puts 0 years of experience for
  // everything"): the total came ONLY from the extension's own "Years of experience" setting, which onboarding never
  // fills — empty → 0 total, and with no / an empty CV copy every skill question was 0 too. Total = the setting when
  // > 0, else the dashboard profile (years_of_experience, loaded at Start as config.accountYears), else the CV's
  // yearsOfExperience, else the span of the dated CV roles. 0 only when nothing at all says otherwise.
  function _numYears(v) { const m = String(v == null ? '' : v).match(/\d+(?:[.,]\d+)?/); return m ? Math.floor(parseFloat(m[0].replace(',', '.'))) : 0; }
  function cvSpanYears(cv) {
    const rs = (((cv && cv.experience) || []).filter(Boolean)).map(e => { try { return _entryRangeClean(e); } catch (_) { return null; } }).filter(Boolean).sort((a, b) => a[0] - b[0]);
    let months = 0, cur = null;
    for (const r of rs) { if (!cur || r[0] > cur[1] + 1) { if (cur) months += cur[1] - cur[0] + 1; cur = r.slice(); } else cur[1] = Math.max(cur[1], r[1]); }
    if (cur) months += cur[1] - cur[0] + 1;
    const y = Math.floor(months / 12);
    return y === 0 && months >= 6 ? 1 : y;
  }
  function totalYears(config) {
    const set = _numYears(config && config.yearsOfExperience); if (set > 0) return set;
    const acc = _numYears(config && config.accountYears); if (acc > 0) return acc;
    const cv = (config && config.cvProfile) || {};
    const cvY = _numYears(cv.yearsOfExperience); if (cvY > 0) return cvY;
    return cvSpanYears(cv);
  }
  // ─── v2.5.115: SECTOR / INDUSTRY years ("Combien d'années d'expérience avez-vous dans le secteur de l'assurance ?",
  // "years in the banking industry", "dans ce secteur (Assurances)") ────────────────────────────────────────────────
  // Théo 2026-10-16: answer like the real user, from the CV — the years of the roles whose company / title /
  // description show that sector; 0 when the sector appears nowhere (truthful). Live 2.5.114 gate: La Banque Postale
  // "années dans ce secteur (Assurances)" = 3 (total, via the 2.5.113 skill toggle) for a CV with no insurance role.
  // Tech / skill questions ("years with Python") are NOT sector questions and keep the 2.5.113 total-years rule.
  // words = matched anywhere in a role's text; cos = company names, matched in the role's company field only.
  const _SECTORS = [
    { key: 'insurance', q: /\b(assurances?|insurances?|insurer|assureurs?|r[ée]assurance|reinsurance|bancassurance|mutuelles?|insurtech|pr[ée]voyance)\b/i,
      words: /\b(assurances?|insurances?|insurer|assureurs?|reassurance|reinsurance|bancassurance|mutuelles?|insurtech|prevoyance|courtier en assurance|insurance broker|actuari\w*|sinistres?|claims? handl\w*|underwrit\w*|souscription)\b/i,
      cos: /\b(axa|allianz|generali|cnp|maif|macif|groupama|ag2r|covea|aviva|swiss ?re|scor|malakoff|harmonie|matmut|gmf|mma|hiscox|chubb|aig|metlife|prudential|lic|bajaj allianz|hdfc life|icici lombard|icici prudential|sbi life|max life|tata aia|zurich|ageas|mapfre|aon|marsh|gras savoye|verlingue|predica|sogecap|suravenir|cardif)\b/i },
    { key: 'banking', q: /\b(banques?|bancaires?|banks?|banking|banker|banquiers?)\b/i,
      words: /\b(banques?|bancaires?|banks?|banking|banker|banquiers?|investment bank\w*|retail banking|corporate banking|credit risk|risque de credit|agence bancaire)\b/i,
      cos: /\b(bnp|paribas|societe generale|credit agricole|lcl|bpce|natixis|caisse d.epargne|banque populaire|credit mutuel|cic|hsbc|banque postale|boursorama|barclays|j\.?p\.? ?morgan|goldman sachs|morgan stanley|citi(bank|group)?|deutsche bank|ubs|credit suisse|santander|ing|hdfc bank|icici bank|sbi|state bank|axis bank|kotak|yes bank|bank of america|wells fargo|lazard|rothschild|oddo|amundi|lyxor)\b/i },
    { key: 'financial services', q: /\b(services financiers|financial services|finance|financi[eè]re?s?|asset management|gestion d.actifs|fintech|investment management|capital markets|march[ée]s financiers)\b/i, union: ['insurance', 'banking'],
      words: /\b(financial services|services financiers|asset management|gestion d.actifs|fintech|private equity|capital[- ]investissement|hedge funds?|fonds d.investissement|investment fund|capital markets|marches financiers|wealth management|gestion de patrimoine|brokerage|securities)\b/i, cos: /\b(blackrock|vanguard|fidelity|amundi|axa im|natixis im|tikehau|ardian|eurazeo|kkr|blackstone|carlyle|euronext|visa|mastercard|paypal|stripe|revolut|qonto|lydia)\b/i },
    { key: 'retail', q: /\b(retail|commerce de d[ée]tail|grande distribution|distribution|retailers?|distributeurs?|e-?commerce|magasins?|stores?)\b/i,
      words: /\b(retail|retailers?|commerce de detail|grande distribution|distribution|distributeurs?|e-?commerce|magasins?|stores?|boutiques?|supermarch\w*|hypermarch\w*|point de vente|points de vente|merchandising)\b/i,
      cos: /\b(carrefour|auchan|leclerc|intermarche|casino|monoprix|franprix|fnac|darty|decathlon|ikea|zara|inditex|h&m|walmart|target|lidl|aldi|sephora|galeries lafayette|printemps|leroy merlin|boulanger|cdiscount|reliance retail|dmart|big bazaar|flipkart|tesco|costco|kroger)\b/i },
    { key: 'luxury', q: /\b(luxe|luxury|haut de gamme)\b/i, words: /\b(luxe|luxury|haute couture|maroquinerie|joaillerie|jewel+ery|premium brands?)\b/i,
      cos: /\b(lvmh|kering|hermes|chanel|dior|louis vuitton|cartier|richemont|gucci|prada|saint laurent|balenciaga|tiffany|rolex|l.oreal luxe)\b/i },
    { key: 'healthcare', q: /\b(sant[ée]|health\s?care|healthcare|health|m[ée]dical|medical|pharma\w*|biotech\w*|hospitali\w*|h[ôo]pitaux?|hospitals?|life sciences|sciences de la vie|dispositifs? m[ée]dicaux|medtech)\b/i,
      words: /\b(sante|health\s?care|healthcare|medical|medic\w*|pharma\w*|biotech\w*|hopitaux|hopital|hospitals?|clinique|clinic\w*|life sciences|sciences de la vie|laboratoires?|dispositifs? medicaux|medtech|patients?)\b/i,
      cos: /\b(sanofi|servier|pfizer|novartis|roche|astrazeneca|gsk|merck|bayer|ipsen|biogen|medtronic|siemens healthineers|philips healthcare|ap-hp|aphp|doctolib|apollo hospitals|sun pharma|cipla|dr\.? reddy)\b/i },
    { key: 'automotive', q: /\b(automobiles?|automotive|auto(mobile)? industry|constructeurs? automobiles?)\b/i, words: /\b(automobiles?|automotive|vehicules?|vehicles?|equipementiers?|car manufacturer)\b/i,
      cos: /\b(renault|stellantis|psa|peugeot|citroen|toyota|volkswagen|tesla|valeo|faurecia|forvia|michelin|bmw|mercedes|daimler|ford|general motors|tata motors|mahindra|maruti|hyundai|plastic omnium|opmobility)\b/i },
    { key: 'energy', q: /\b([ée]nergies?|energy|utilities|oil|gas|p[ée]trol\w*|nucl[ée]aire|nuclear|[ée]lectricit[ée]|power|renewables?|renouvelables?)\b/i,
      words: /\b(energies?|energy|utilities|oil and gas|oil & gas|petrol\w*|nucleaire|nuclear|electricite|electricity|renewables?|renouvelables?|photovolta\w*|eolien\w*|wind power|solar)\b/i,
      cos: /\b(edf|engie|totalenergies|total energies|shell|bp|enedis|rte|grdf|orano|framatome|veolia|suez|exxon|chevron|reliance industries|ongc|ntpc|adani green|iberdrola|enel|eni|equinor)\b/i },
    { key: 'telecom', q: /\b(t[ée]l[ée]coms?|telecommunications?|t[ée]l[ée]communications?)\b/i, words: /\b(telecoms?|telecommunications?|operateurs? telecom|mobile operator|network operator)\b/i,
      cos: /\b(orange|sfr|bouygues telecom|free mobile|iliad|vodafone|airtel|bharti|jio|verizon|at&t|t-mobile|deutsche telekom|telefonica|nokia|ericsson)\b/i },
    { key: 'real estate', q: /\b(immobili\w*|real estate|property|proptech|fonci[eè]re?s?)\b/i, words: /\b(immobili\w*|real estate|property management|proptech|foncieres?|promoteurs? immobiliers?|promotion immobiliere|gestion locative)\b/i,
      cos: /\b(nexity|kaufman ?& ?broad|bouygues immobilier|icade|gecina|unibail|klepierre|foncia|century 21|orpi|cbre|jll|cushman|knight frank|savills|dlf|godrej properties)\b/i },
    { key: 'public sector', q: /\b(secteur public|public sector|fonction publique|administrations? publiques?|government|gouvernement|collectivit[ée]s?)\b/i,
      words: /\b(secteur public|public sector|fonction publique|administrations? publiques?|government|gouvernement|collectivites?|ministeres?|ministry|prefectures?|mairies?|city council|public administration)\b/i, cos: /$^/ },
    { key: 'manufacturing', q: /\b(industrie manufacturi[eè]re|manufacturing|manufacturi\w*|industriel(le)?s?|production industrielle|usines?|factory|factories|a[ée]ronautique|aerospace|a[ée]rospatial\w*|d[ée]fense)\b/i,
      words: /\b(manufacturing|manufacturi\w*|industriel(le)?s?|industrie|usines?|factory|factories|production line|ligne de production|aeronautique|aerospace|aerospatial\w*|defense|chimie|chemicals?|metallurg\w*|siderurg\w*)\b/i,
      cos: /\b(airbus|safran|thales|dassault|naval group|mbda|alstom|saint-gobain|schneider electric|legrand|arkema|air liquide|michelin|siemens|bosch|ge|general electric|abb|tata steel|larsen|l&t|bhel)\b/i },
    { key: 'consulting', q: /\b(conseil|consulting|cabinets? de conseil|consultancy|advisory)\b/i, words: /\b(conseil|consulting|consultants?|consultancy|advisory|cabinet de conseil)\b/i,
      cos: /\b(accenture|capgemini|deloitte|pwc|kpmg|ey|ernst ?& ?young|mckinsey|bcg|boston consulting|bain|wavestone|sia partners|kea|roland berger|oliver wyman|alten|sopra steria|atos|cgi|tcs|infosys|wipro|cognizant|hcl|talan|migso|onepoint|devoteam)\b/i },
    { key: 'it', q: /^(it|i\.t\.|ict|tic|tech|technology|technologies|high[- ]tech|software|logiciels?|saas|informatique|num[ée]rique|digital|esn|ssii|technologies? de l.information|information technology|web)$/i, it: true },
    { key: 'events', q: /\b([ée]v[ée]nementiel\w*|events?|[ée]v[ée]nements?|event management|festivals?)\b/i,
      words: /\b(evenementiel\w*|event management|event agency|agence evenementielle|events? (company|agency|organi[sz]\w*)|festivals?|soirees?|nightlife|salons? professionnels?|trade shows?)\b/i, cos: /\b(gl events|comexposium|reed expo|live nation|viparis)\b/i },
    { key: 'hospitality', q: /\b(h[ôo]tellerie|hospitality|restauration|restaurants?|tourisme|tourism|travel|voyages?|loisirs|leisure)\b/i,
      words: /\b(hotellerie|hospitality|hotels?|restauration|restaurants?|tourisme|tourism|travel agency|agence de voyages?|loisirs|leisure)\b/i,
      cos: /\b(accor|marriott|hilton|ihg|hyatt|club med|sodexo|elior|compass group|airbnb|booking|expedia|pierre ?& ?vacances|taj hotels|oyo|makemytrip)\b/i },
    { key: 'logistics', q: /\b(logistiques?|logistics|supply chain|transports?|transportation|shipping|fret|freight|maritime)\b/i, words: /\b(logistiques?|logistics|supply chain|transports?|transportation|shipping|fret|freight|entrepots?|warehous\w*|maritime|last mile)\b/i,
      cos: /\b(cma cgm|maersk|dhl|fedex|ups|geodis|kuehne|db schenker|bollore|xpo|la poste|chronopost|sncf|ratp|air france|delhivery|blue dart)\b/i },
    { key: 'media', q: /\b(m[ée]dias?|media|entertainment|divertissement|presse|press|publishing|[ée]dition|audiovisuel|broadcast\w*|publicit[ée]|advertising|ad-?tech)\b/i,
      words: /\b(medias?|media|entertainment|divertissement|presse|press|publishing|edition|audiovisuel|broadcast\w*|publicite|advertising|ad-?tech|agence de communication|communication agency)\b/i,
      cos: /\b(tf1|m6|canal\+?|france televisions|radio france|publicis|havas|wpp|omnicom|dentsu|vivendi|lagardere|netflix|disney|warner|universal|spotify|deezer|ubisoft)\b/i },
    { key: 'education', q: /\b([ée]ducation|education|enseignement|edtech|formation|training|acad[ée]mique|academic|universit\w*|[ée]coles?|schools?)\b/i,
      words: /\b(education|enseignement|edtech|formation|training|academique|academic|universit\w*|ecoles?|schools?|teach\w*|enseignant\w*|professeur\w*|tutor\w*)\b/i, cos: /\b(openclassrooms|coursera|udemy|byju|unacademy|pearson)\b/i },
    { key: 'fmcg', q: /\b(fmcg|cpg|grande consommation|biens de consommation|consumer goods|agro-?alimentaire|food|alimentaire|beverages?|boissons?)\b/i,
      words: /\b(fmcg|cpg|grande consommation|biens de consommation|consumer goods|agro-?alimentaire|food|alimentaire|beverages?|boissons?)\b/i,
      cos: /\b(danone|nestle|unilever|procter|p&g|l.oreal|pernod ricard|coca-cola|pepsico|lactalis|bel|bonduelle|mars|mondelez|kraft|heineken|ab inbev|hul|itc|britannia|dabur)\b/i },
    { key: 'construction', q: /\b(btp|construction|b[âa]timent|travaux publics|civil engineering|g[ée]nie civil|infrastructures?)\b/i, words: /\b(btp|construction|batiment|travaux publics|civil engineering|genie civil|chantiers?|infrastructures?)\b/i,
      cos: /\b(vinci|bouygues construction|eiffage|spie|colas|nge|fayat|larsen|l&t|skanska|bechtel)\b/i },
  ];
  const _STRICT_SECTOR_SUBJECT = /^(banking|banque|banques|bank|banks|insurance|assurances?|bancassurance|reinsurance|reassurance|retail|retail banking|commerce de detail|grande distribution|real estate|immobilier|pharma|pharmaceuticals?|pharmaceutique|healthcare|health care|sante|automotive|automobile|telecoms?|telecommunications?|hospitality|hotellerie|fmcg|cpg|luxury|luxe|aerospace|aeronautique|oil (and|&) gas|petrole|e-?commerce|public sector|secteur public|fonction publique|logistics|logistique|manufacturing|asset management|gestion d.actifs|financial services|services financiers|fintech|insurtech|biotech|medtech|edtech|proptech)$/;
  function _sectorDef(phrase) {
    const p = _deaccent(String(phrase || '')).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
    if (!p) return null;
    for (const d of _SECTORS) { if (d.it ? d.q.test(p) : d.q.test(p)) return d; }
    // v2.5.115 (live dry run 2026-10-16, Oliver Wyman): LinkedIn cut the sector name — "… dans ce secteur (Serv experience
    // do you currently have?" — a cut word (≥ 4 letters) that starts a sector name still names that sector.
    if (/^[a-z]{4,}$/.test(p)) {
      const hit = _SECTOR_NAMES.find(([name]) => name.startsWith(p));
      if (hit) return _SECTORS.find(x => x.key === hit[1]) || null;
    }
    return null;
  }
  const _SECTOR_NAMES = [['assurances', 'insurance'], ['insurance', 'insurance'], ['banque', 'banking'], ['bancaire', 'banking'], ['banking', 'banking'],
    ['services financiers', 'financial services'], ['financial services', 'financial services'], ['retail', 'retail'], ['distribution', 'retail'],
    ['pharmaceutique', 'healthcare'], ['pharmaceutical', 'healthcare'], ['sante', 'healthcare'], ['healthcare', 'healthcare'], ['automobile', 'automotive'],
    ['automotive', 'automotive'], ['energie', 'energy'], ['energy', 'energy'], ['telecommunications', 'telecom'], ['immobilier', 'real estate'],
    ['industrie manufacturiere', 'manufacturing'], ['manufacturing', 'manufacturing'], ['aeronautique', 'manufacturing'], ['aerospace', 'manufacturing'],
    ['hotellerie', 'hospitality'], ['hospitality', 'hospitality'], ['logistique', 'logistics'], ['logistics', 'logistics'], ['luxe', 'luxury'], ['luxury', 'luxury']];
  // The sector(s) a years question names, or null when it is not a sector question. "ce secteur" alone (sector
  // not named) → null (the caller keeps its generic rule).
  function sectorOfYearsQuestion(question) {
    const q = String(question || '').replace(/\s+/g, ' ').replace(/[*]+/g, '').trim();
    const qd = _deaccent(q).replace(/[’]/g, "'");
    let phrase = '';
    let m;
    if ((m = qd.match(/\b(?:secteurs?|sectors?|industries|industry|industrie|branche|domaine)\b[^()]{0,25}\(([^()]{2,80})\)/i))) phrase = m[1];
    // Unclosed parenthesis (LinkedIn mixes the employer's FR text into its EN template: "How many years of 'expérience
    // avez-vous dans ce secteur (Serv experience do you currently have?") → the words before the template tail.
    else if ((m = qd.match(/\b(?:secteurs?|sectors?|industries|industry|industrie|branche|domaine)\b[^()]{0,25}\(([^()?]{2,80})/i))) phrase = m[1].replace(/\s+(?:experience|exp[ée]rience|years?|ann[ée]es?)\b.*$/i, '');
    else if ((m = qd.match(/\b(?:secteurs?|industrie|branche)\s+(?:de\s+l'|de\s+la\s+|du\s+|des\s+|de\s+|d')?([^?.;:()]{2,60})/i)) && !/^(ce|cet|cette|ces|this|that|the|your|votre|vos|similaire|similar|concern\w*|vise|cible|experience|d'experience|d'activite)\b/i.test(m[1].trim())) phrase = m[1];
    else if ((m = qd.match(/\b(?:in|within|across)\s+(?:the\s+|an?\s+)?([^?.;:()]{2,60}?)\s+(?:industry|industries|sector|sectors|space|vertical|domain)\b/i))) phrase = m[1];
    else if ((m = qd.match(/\bof\s+(?:the\s+)?([a-z&/,\- ]{2,40}?)\s+(?:industry|sector)\s+experience\b/i))) phrase = m[1];
    else if ((m = qd.match(/\bdans\s+l'industrie\s+([^?.;:()]{2,50})/i))) phrase = m[1];
    phrase = phrase.split(/,\s*(?:combien|how|quel|what|depuis|since|pendant)\b/i)[0]
      .replace(/\b(do you have|avez[- ]vous|have you|au total|in total)\b.*$/i, '').replace(/^(the|la|le|les|l')\s+/i, '').trim();
    if (!phrase) {
      // No sector word: the named subject itself may be a sector ("years of experience in banking", "en banque").
      // Only unambiguous sector nouns, and only when EVERY named part is one ("Power BI", "finance", "training",
      // "consulting" are skills / functions → the skill rules).
      const s = yearsQuestionSkill(q);
      if (!s) return null;
      const alts = s.split(/\s*(?:\/|,|\bor\b|\bou\b|&|\band\b|\bet\b)\s*/i).map(x => x.replace(/^(the|le|la|les|l'|l’)\s*/i, '').trim()).filter(x => x.length >= 2);
      if (!alts.length || alts.some(a => !_STRICT_SECTOR_SUBJECT.test(_deaccent(a).toLowerCase()))) return null;
      return alts;
    }
    if (/^(ce|cet|cette|ces|this|that|same|similar|your|votre|similaire)$/i.test(phrase)) return null;
    return phrase.split(/\s*(?:\/|,|\bor\b|\bou\b|&|\band\b|\bet\b)\s*/i).map(x => x.trim()).filter(x => x.length >= 2);
  }
  function _yearsForSector(sectors, config, total) {
    const label = sectors.join(' / ');
    const cv = config && config.cvProfile;
    if (!cv || !Array.isArray(cv.experience) || !cv.experience.length) return { years: total, basis: `total (sector "${label}", no CV profile synced)`, skill: label, sector: true };
    const ranges = []; const roles = [];
    let undated = false;
    for (const e of cv.experience.filter(Boolean)) {
      const company = _deaccent(String(e.company || '')).toLowerCase();
      const txt = _deaccent([e.title, e.role, e.position, e.company, e.description, e.industry, ...(Array.isArray(e.bullets) ? e.bullets : []), ...(Array.isArray(e.achievements) ? e.achievements : [])].filter(Boolean).join(' ')).toLowerCase();
      let hit = false;
      for (const s of sectors) {
        const d = _sectorDef(s);
        const defs = d ? [d].concat((d.union || []).map(k => _SECTORS.find(x => x.key === k))) : [];
        if (d && d.it) hit = _IT_EVIDENCE.test(txt);
        else if (defs.length) hit = defs.some(x => x.words.test(txt) || x.cos.test(company));
        else hit = _mentions(txt, s); // unknown sector name: plain word match in the role
        if (hit) break;
      }
      if (!hit) continue;
      roles.push(String(e.title || e.role || e.company || '').slice(0, 40));
      const r = _entryRangeClean(e); if (r) ranges.push(r); else undated = true;
    }
    if (ranges.length) {
      ranges.sort((a, b) => a[0] - b[0]);
      let months = 0, cur = null;
      for (const r of ranges) { if (!cur || r[0] > cur[1] + 1) { if (cur) months += cur[1] - cur[0] + 1; cur = r.slice(); } else cur[1] = Math.max(cur[1], r[1]); }
      if (cur) months += cur[1] - cur[0] + 1;
      // v2.5.116: a sector the CV shows counts at least 1 year (Théo 2026-10-16: "≥ 1 if mentioned").
      let y = Math.max(1, Math.floor(months / 12));
      if (total > 0) y = Math.min(y, total);
      return { years: y, basis: `CV experience mentioning sector "${label}" (${roles.join(', ')}; ${months} months)`, skill: label, sector: true };
    }
    if (undated) return { years: Math.min(total || 1, 1), basis: `sector "${label}" listed in the CV without dated experience`, skill: label, sector: true };
    // v2.5.116 (Théo 2026-10-16: "année si pas dans le CV mettre années générales d'expérience"): a sector the CV
    // never shows → the TOTAL years of experience (2.5.115 answered 0). La Banque Postale "secteur (Assurances)" → 3.
    return { years: total, basis: `sector "${label}" not in the CV → total years`, skill: label, sector: true };
  }

  // v2.5.116 years policy (Théo 2026-10-16), for tool / tech / skill AND sector questions:
  //  - the item is in the CV → the years of the matching roles, at least 1, capped at the total;
  //  - the item is NOT in the CV → the user's TOTAL years of experience (2.5.89–2.5.115 answered 0);
  //  - toggle "Answer skill-specific experience questions with my total years" (default ON) → total for skills.
  // LinkedIn-saved values are only ever RAISED to this figure, never lowered (fillTextInputs).
  function yearsForQuestion(question, config) {
    const r = _yearsForQuestionRaw(question, config);
    if (!r || !r.skill || r.sector) return r;
    const total = totalYears(config);
    if (/not in the CV/.test(r.basis) && !(r.years > 0)) return { ...r, years: total, basis: `"${r.skill}" not in the CV → total years` };
    if (r.years === 0 && /CV experience mentioning|listed in the CV|tech roles/.test(r.basis)) return { ...r, years: 1, basis: r.basis + ' (≥ 1: in the CV)' };
    return r;
  }
  function _yearsForQuestionRaw(question, config) {
    const total = totalYears(config);
    // v2.5.115: a sector / industry question is answered from the CV roles in that sector (before the skill toggle).
    try {
      const sectors = sectorOfYearsQuestion(question);
      if (sectors && sectors.length) return _yearsForSector(sectors, config, total);
    } catch (_) {}
    const skill = yearsQuestionSkill(question);
    if (!skill) return { years: total, basis: 'total' };
    // v2.5.113 (Théo 2026-10-15, user report "0 years for every tech-stack question"): with the popup toggle
    // "Answer skill-specific experience questions with my total years" (default ON, set by the engine at Start), any
    // "years of experience with X" question gets the TOTAL years — whether X is in the CV or not (Oui-rule spirit).
    // Toggle OFF → the per-skill estimate below.
    if (config && config.skillYearsAsTotal === true && total > 0) return { years: total, basis: 'total years (skill question — setting "answer with my total years")', skill };
    // v2.5.113: "Large Language Models (LLM)" → 0 for a CV naming "LLM agents": the acronym and the long form are
    // each tried, the best-supported one answers.
    const pm = String(skill).match(/^(.*?)\s*\(([^()]{2,40})\)\s*(.*)$/);
    if (pm) {
      const alts = [(pm[1] + ' ' + pm[3]).trim(), pm[2].trim()].filter(s => s.length >= 2);
      let best = null;
      for (const a of alts) { const r = _yearsForNamedSkill(a, config, total); if (!best || r.years > best.years) best = r; }
      if (best) return { ...best, skill };
    }
    return _yearsForNamedSkill(skill, config, total);
  }
  function _yearsForNamedSkill(skill, config, total) {
    // v2.5.104: a LANGUAGE the user speaks ("Depuis combien d'années utilisez-vous Anglais ?" → 0,
    // live 2026-10-08, discarded) = the whole professional experience. Languages from the settings
    // or the CV; a language the user doesn't list stays on the normal path (→ 0).
    try {
      const LANG = /^(anglais|english|fran[cç]ais|french|espagnol|spanish|espa[nñ]ol|allemand|german|deutsch|italien|italian|portugais|portuguese|chinois|chinese|mandarin|arabe|arabic|hindi|russe|russian|japonais|japanese|n[ée]erlandais|dutch|cor[ée]en|korean)$/i;
      const sk = String(skill || '').trim();
      if (LANG.test(sk)) {
        const pool = [].concat(config && config.languages || [], config && config.cvProfile && config.cvProfile.languages || [])
          .map(l => typeof l === 'string' ? l : ((l && (l.name || l.language)) || '')).join(' | ');
        const base = _deaccent(sk).toLowerCase().slice(0, 4);
        const ALIAS = { angl: 'engl', engl: 'angl', fran: 'fren', fren: 'fran', espa: 'span', span: 'espa', alle: 'germ', germ: 'alle', ital: 'ital', port: 'port' };
        const p = _deaccent(pool).toLowerCase();
        if (p && (p.includes(base) || (ALIAS[base] && p.includes(ALIAS[base])))) {
          return { years: total, basis: `language "${sk}" in your profile → total experience`, skill };
        }
      }
    } catch (_) {}
    // v2.5.98: soft skills ("Sens de l'écoute", "Sens de l'organisation", "Leadership"…) follow the
    // total experience — "0 years of listening skills" (live 2026-10-04, discarded) is not credible.
    if (/^(sens\s+(de\s+l.|du\s+|des\s+)?\S+|esprit\s+(d.|de\s+)\S+|capacit[ée]\s+d.\S+|communication|leadership|teamwork|team\s*work|travail\s+en\s+[ée]quipe|organisation|organization|rigueur|autonomie|autonomy|adaptabilit[ée]|adaptability|curiosit[ée]|cr[ée]ativit[ée]|creativity|problem[- ]solving|r[ée]solution\s+de\s+probl[èe]mes|[ée]coute(\s+active)?|active\s+listening|listening|gestion\s+du\s+temps|time\s+management|relationnel|interpersonal\s+skills|soft\s+skills|savoir[- ]être|empathie|empathy|proactivit[ée]|initiative|esprit\s+critique|critical\s+thinking|coordination|reporting|pr[ée]sentation|presentations?|n[ée]gociation|negotiation|gestion\s+des\s+parties\s+prenantes|stakeholder\s+management|(?:microsoft|ms)\s+office|office\s+365|microsoft\s+365|suite\s+office|pack\s+office|(?:microsoft\s+|ms\s+)?(?:word|powerpoint|outlook|excel)|google\s+workspace|g\s*suite)$/i.test(skill.trim())) {
      // v2.5.106: office suite / coordination / reporting are part of any professional job ("Microsoft
      // Office" → 0 for a consultant, live 2026-10-10) → total experience, like the soft skills.
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
    const r0 = _yearsForSkill(skill, config, total);
    // v2.5.109 (live 2026-10-12, Webologix): "Agile Project Management" → 0 (and a saved 2 LOWERED to 0) for a
    // CV with "Agile/Scrum" in Skills and a dated "Project Management Lead" role. A multi-word skill not found as
    // one block is split in two; when BOTH halves are in the CV, the best-supported half answers.
    const words = String(skill).trim().split(/\s+/);
    if (r0.years === 0 && words.length >= 2 && words.length <= 5) {
      const cv = (config && config.cvProfile) || {};
      const all = [].concat(cv.skills || [], cv.summary || '', ...(cv.experience || []).map(e => [e.title, e.role, e.company, e.description, ...(Array.isArray(e.bullets) ? e.bullets : [])].filter(Boolean).join(' ')))
        .map(s => typeof s === 'string' ? s : ((s && s.name) || '')).join(' | ');
      const meaningful = (p) => _tokens(p).filter(w => w.length >= 3).length > 0;
      let best = null;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
        if (!meaningful(a) || !meaningful(b) || !_mentions(all, a) || !_mentions(all, b)) continue;
        for (const p of [a, b]) { const r = _yearsForSkill(p, config, total); if (r.years > 0 && (!best || r.years > best.years)) best = { ...r, skill, basis: `"${a}" + "${b}" both in the CV — ${r.basis}` }; }
      }
      if (best) return best;
    }
    return r0;
  }
  // v2.5.104: a broad IT DOMAIN is not a keyword. Live 2026-10-08: "Combien d'années d'expérience
  // avez-vous en tant que Technologies de l'information ?" → 0 for a profile building web platforms,
  // automated workflows and AI/API solutions (discarded). Any role with technical evidence counts.
  const _IT_DOMAIN = /^(it|i\.t\.|ict|tic|information technology|technologies? de l.information|technologies? de l information|informatique|syst[eè]mes? d.information|si|dsi|tech|technology|technologie|digital|num[ée]rique|transformation (digitale|num[ée]rique)|digital transformation)$/i;
  const _IT_EVIDENCE = /\b(web|software|logiciels?|applications?|api|apis|ai|ia|llm|llms|data|donn[ée]es|digital|num[ée]rique|platforms?|plateformes?|cloud|erp|crm|saas|automat\w*|workflows?|informatique|syst[eè]mes? d.information|d[ée]velopp\w*|developer|developpeur|dev|it|si|dsi|cybers\w*|r[ée]seaux?|network\w*|database\w*|sql|python|javascript|office 365|microsoft 365|sharepoint|salesforce|sap)\b/i;
  // v2.5.109: technical skill names / technical role evidence (see the listed-skill rule below).
  const _TECH_SKILL = /[+#]|\.(js|net)\b|\b(python|java|javascript|typescript|js|ts|sql|nosql|mysql|postgres\w*|mongo\w*|redis|oracle\s+db|django|flask|fastapi|spring(\s*boot)?|hibernate|node(\.?js)?|express|react(\.?js)?|angular\w*|vue(\.?js)?|next\.?js|svelte|html5?|css3?|sass|php|laravel|ruby|rails|golang|go\s+lang|rust|kotlin|swift|scala|perl|c\s*sharp|dotnet|\.net|asp\.net|aws|azure|gcp|google\s+cloud|docker|kubernetes|k8s|terraform|ansible|jenkins|ci\/?cd|git|github|gitlab|linux|unix|bash|shell|powershell|kafka|rabbitmq|spark|hadoop|airflow|pandas|numpy|tensorflow|pytorch|scikit|machine\s+learning|deep\s+learning|nlp|llms?|genai|generative\s+ai|langchain|langgraph|openai|rest(ful)?(\s+apis?)?|graphql|grpc|microservices?|apis?|selenium|cypress|jest|junit|pytest|devops|sre|etl|power\s*bi|tableau|snowflake|databricks|bigquery|elasticsearch|salesforce|sap|servicenow|matlab|r\s+programming|c|c\+\+)\b/i;
  const _TECH_ROLE = /\b(software|developer|developpeur|development|engineer|engineering|ingenieur|programmer|devops|sre|data\s+(scientist|engineer|analyst)|full[- ]?stack|back[- ]?end|front[- ]?end|web\s+developer|architect|qa|sdet|tester|machine\s+learning|ml\s+engineer|ai\s+engineer|cloud|it\s+(consultant|analyst|support)|technical\s+lead|tech\s+lead|microservices?|apis?|database|codebase)\b/i;
  function _yearsForSkill(skill, config, total) {
    const cv = config && config.cvProfile;
    if (!cv || !Array.isArray(cv.experience)) return { years: total, basis: 'total (no CV profile synced)', skill };
    const ranges = [];
    let mentionedInExp = false;
    const isItDomain = _IT_DOMAIN.test(String(skill || '').trim().replace(/[’']/g, "'"));
    for (const e of cv.experience) {
      const txt = [e.title, e.role, e.position, e.company, e.description, ...(Array.isArray(e.bullets) ? e.bullets : []), ...(Array.isArray(e.achievements) ? e.achievements : [])].filter(Boolean).join(' ');
      if (!(isItDomain ? _IT_EVIDENCE.test(_deaccent(txt)) || _IT_EVIDENCE.test(txt) : _mentions(txt, skill))) continue;
      mentionedInExp = true;
      const r = _entryRange(e); if (r) ranges.push(r);
    }
    const _merge = (rs) => {
      rs.sort((a, b) => a[0] - b[0]);
      let months = 0, cur = null;
      for (const r of rs) { if (!cur || r[0] > cur[1] + 1) { if (cur) months += cur[1] - cur[0] + 1; cur = r.slice(); } else cur[1] = Math.max(cur[1], r[1]); }
      if (cur) months += cur[1] - cur[0] + 1;
      let y = Math.floor(months / 12); if (y === 0 && months >= 6) y = 1;
      if (total) y = Math.min(y, total);
      return { y, months };
    };
    // v2.5.109 (premium user mail 2026-10-12 "the experience field is always wrong"): a senior developer
    // (CV: Python, Java, Spring Boot, MySQL… in Skills, 2.7 years as "Senior Software Developer" whose
    // bullets don't repeat each language) was answered 1 year (or 0 for MySQL, named only in a 3-month
    // internship) — and his own LinkedIn-saved answers were LOWERED to that. A TECHNICAL skill listed in
    // the CV skills / summary of a candidate whose dated roles are technical = the years of those
    // technical roles (capped at the total). Non-technical skills or roles keep the previous rules.
    const inSkills = (Array.isArray(cv.skills) && cv.skills.some(s => _mentions(typeof s === 'string' ? s : (s && s.name) || '', skill))) || _mentions(cv.summary || '', skill);
    let tech = null;
    if (inSkills && _TECH_SKILL.test(String(skill || ''))) {
      const tr = [];
      for (const e of cv.experience) {
        const txt = [e.title, e.role, e.position, e.description, ...(Array.isArray(e.bullets) ? e.bullets : [])].filter(Boolean).join(' ');
        if (!_TECH_ROLE.test(_deaccent(txt))) continue;
        const r = _entryRange(e); if (r) tr.push(r);
      }
      // Never above the total the user declared (Smart Profile / extension settings) — Théo 2026-10-12.
      if (tr.length) { const t = _merge(tr); const yy = total > 0 ? Math.min(t.y, total) : t.y; if (yy >= 1) tech = { years: yy, basis: `"${skill}" in your CV skills, years of your tech roles (${t.months} months${total > 0 && t.y > total ? `, capped at your ${total} declared years` : ''})`, skill }; }
    }
    if (ranges.length) {
      const d = _merge(ranges);
      if (tech && tech.years > d.y) return tech;
      return { years: d.y, basis: `CV experience mentioning "${skill}" (${d.months} months)`, skill };
    }
    if (tech) return tech;
    const listed = mentionedInExp || inSkills;
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
      // (2026-10-08, Théo: yes/no questions default to "Oui" — tool-mastery questions such as
      // "Maîtrisez-vous Primavera P6 ?" are NOT decided from the CV.)
    ];
    let subj = '';
    for (const re of pats) { const m = q.match(re); if (m) { subj = m[1]; break; } }
    if (!subj) return null;
    subj = subj.split(/[?.;:]/)[0]
      // v2.5.104: drop the purpose clause ("Primavera P6 pour construire et suivre des plannings").
      .replace(/\s+(pour|afin\s+d[e']|in\s+order\s+to|to\s+(build|create|manage|track|run|support))\b.*$/i, '')
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
    const total = totalYears(config);
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
  // Work-mode willingness ("Accepteriez-vous de travailler à distance / sur site ?", "Are you comfortable
  // working on-site / in a hybrid setting?", "OK with remote work?"). Input is de-accented.
  const _WORK_MODE_Q = /\b(?:travailler|travail|work(?:ing)?|teletravail|teletravailler)\b[^?]{0,25}\b(?:a\s+distance|en\s+distanciel|distanciel|sur\s+site|en\s+presentiel|presentiel|en\s+hybride|hybride|on[- ]?site|in[- ]office|remote(?:ly)?|from\s+home|hybrid)\b|\bteletravail\b|\b(?:remote|on[- ]?site|hybrid)\s+(?:work|working|role|position|basis|setting|environment)\b/i;
  function workLocationAnswer(questionText, config) {
    const q = _deaccent(String(questionText || '')).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
    const m = q.match(/\b(?:willing|able|open|prepared|ready|happy|comfortable|available)\s+to\s+(?:work|be\s+based|live|relocate|commute|move|travel)\s+(?:on[- ]?site\s+)?(?:in|to|at|from|near)\s+([^?.,;]+)/)
      || q.match(/\b(?:are\s+you|you\s+are)\s+(?:currently\s+)?(?:based|located|living|residing)\s+(?:in|near|within)\s+([^?.,;]+)/)
      || q.match(/\b(?:pret|prete|dispose|disposee|d'accord|accepteriez[- ]vous|acceptez[- ]vous|souhaitez[- ]vous)[^?]{0,25}?\b(?:travailler|vous\s+installer|demenager|vous\s+deplacer|vivre)\s+(?:a|en|au|aux|sur|dans)\s+([^?.,;]+)/)
      || q.match(/\b(?:residez|habitez|etes)[- ]vous\s+(?:actuellement\s+)?(?:base\s+|basee\s+|situe\s+|situee\s+)?(?:a|en|au|aux|dans)\s+([^?.,;]+)/)
      // v2.5.112 (Gridware, live 2026-10-13): option-style statements "I'm local to the San Francisco Bay Area".
      || q.match(/\b(?:(?:i'?m|i\s+am)\s+(?:currently\s+)?(?:local|based|located|living|residing)\s+(?:to|in|near|within)|i\s+(?:currently\s+)?live\s+(?:in|near|within))\s+([^?.,;]+)/);
    if (!m) return null;
    const place = m[1].replace(/\b(the|la|le|les|l')\b/g, ' ').replace(/\s+/g, ' ').trim();
    const home = new Set();
    const city = _deaccent(String((config && config.city) || '')).toLowerCase().trim();
    if (city) home.add(city);
    // v2.5.112: "San Francisco, CA" must match "the San Francisco Bay Area" → the city itself, without state / country.
    if (city && city.includes(',')) { const c0 = city.split(',')[0].trim(); if (c0.length >= 3) home.add(c0); }
    const cc = _deaccent(String((config && config.country) || '')).toLowerCase().trim();
    if (cc) { home.add(cc); (_HOME_BY_COUNTRY[cc] || []).forEach(x => home.add(x)); for (const [k, v] of Object.entries(_HOME_BY_COUNTRY)) if (v.includes(cc)) v.concat(k).forEach(x => home.add(x)); }
    if (city === 'paris') _HOME_BY_COUNTRY.fr.forEach(x => home.add(x));
    const P = ' ' + place.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    const homeHit = [...home].some(h => h.length >= 2 && P.includes(' ' + h.replace(/[^a-z0-9]+/g, ' ').trim() + ' '));
    if (!homeHit && (!place || /\b(office|site|hybrid|hybride|remote|distance|distanciel|domicile|presentiel|home|team|environment|shift|shifts|weekend|night|nuit|bureau|bureaux|locaux|poste|teletravail|client|clients|fast[- ]paced|startup|this|that|location|area|region|city|ville|country|pays)\b/.test(place) && !/[A-Z]/.test(m[1]))) {
      // "the office", "on site", "this location": not a named place → not ours to decide
      if (!/\b(paris|france|india|dubai|saudi|riyadh|london|uae|qatar|doha|singapore|germany|spain|italy|usa|canada|san francisco|bay area|new york|seattle|boston|austin|chicago|los angeles|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai)\b/.test(place)) return null;
    }
    if (homeHit) return 'yes';
    if (/\b(based|located|living|residing|residez|habitez|etes|local)\b/.test(q)) return 'no';
    const rel = String((config && config.willingToRelocate) || '').toLowerCase();
    return rel === 'yes' ? 'yes' : 'no';
  }

  // ─── v2.5.89: salary answer shaped by the question ──────────────────────
  // Plain number by default (LinkedIn validates most salary fields as numbers).
  // Currency appended only when the question explicitly asks for it; the question's
  // own currency wins, else the profile country. Never converts amounts.
  const _CUR_BY_COUNTRY = { france: 'EUR', fr: 'EUR', germany: 'EUR', de: 'EUR', spain: 'EUR', es: 'EUR', italy: 'EUR', it: 'EUR', belgium: 'EUR', netherlands: 'EUR', portugal: 'EUR', ireland: 'EUR', austria: 'EUR',
    india: 'INR', in: 'INR', 'united states': 'USD', usa: 'USD', us: 'USD', 'united kingdom': 'GBP', uk: 'GBP', gb: 'GBP', canada: 'CAD', ca: 'CAD', switzerland: 'CHF', ch: 'CHF', australia: 'AUD', au: 'AUD',
    egypt: 'EGP', eg: 'EGP', 'united arab emirates': 'AED', uae: 'AED', ae: 'AED', 'saudi arabia': 'SAR', sa: 'SAR', qatar: 'QAR', qa: 'QAR', singapore: 'SGD', sg: 'SGD', malaysia: 'MYR', my: 'MYR', philippines: 'PHP', ph: 'PHP', pakistan: 'PKR', pk: 'PKR', bangladesh: 'BDT', bd: 'BDT', 'sri lanka': 'LKR', lk: 'LKR', nepal: 'NPR', np: 'NPR', nigeria: 'NGN', ng: 'NGN', kenya: 'KES', ke: 'KES', 'south africa': 'ZAR', za: 'ZAR', morocco: 'MAD', ma: 'MAD', tunisia: 'TND', tn: 'TND', turkey: 'TRY', tr: 'TRY', poland: 'PLN', pl: 'PLN', brazil: 'BRL', br: 'BRL', mexico: 'MXN', mx: 'MXN', japan: 'JPY', jp: 'JPY' };
  const _CUR_BY_DIAL = { '+33': 'EUR', '+49': 'EUR', '+34': 'EUR', '+39': 'EUR', '+32': 'EUR', '+31': 'EUR', '+351': 'EUR', '+353': 'EUR', '+43': 'EUR', '+91': 'INR', '+44': 'GBP', '+41': 'CHF', '+61': 'AUD',
    '+20': 'EGP', '+971': 'AED', '+966': 'SAR', '+974': 'QAR', '+65': 'SGD', '+60': 'MYR', '+63': 'PHP', '+92': 'PKR', '+880': 'BDT', '+94': 'LKR', '+977': 'NPR', '+234': 'NGN', '+254': 'KES', '+27': 'ZAR', '+212': 'MAD', '+216': 'TND', '+90': 'TRY', '+48': 'PLN', '+55': 'BRL', '+52': 'MXN', '+81': 'JPY' };
  // v2.5.93: start-date questions ("What is your earliest starting date?", mm/dd/yyyy
  // artdeco-date field) got "January 2022" from the AI. Answer = today + notice period
  // (min 2 weeks), formatted for the field.
  const START_DATE_RE = /earliest.{0,20}start|start(ing)?\s*date|when.{0,20}can.{0,10}you.{0,10}(start|join|begin)|available\s+to\s+start|availability\s+date|date.{0,15}d[ée]but|d[ée]but.{0,15}(poste|contrat|mission)|disponible.{0,20}partir|partir\s+de\s+quand|partir\s+de\s+quelle\s+date|quelle\s+date.{0,40}disponible|date.{0,30}seriez.{0,15}disponible|date.{0,15}disponibilit|fecha.{0,15}(inicio|incorporaci)|eintrittsdatum|startdatum|data.{0,15}inizio|quand.{0,40}disponible|disponible\s+pour\s+(commencer|d[ée]marrer|d[ée]buter)|quand.{0,40}(commencer|d[ée]buter|d[ée]marrer)|when.{0,20}(are|would|will)\s+you\s+(be\s+)?available/i;
  // v2.5.114 (live gate 2026-10-15, Artimon / Tech Riders): LinkedIn's native-dialog date picker is
  // <input data-testid="date-picker-input" lang="en-US"> (+ "Embedded calendar" button) — no placeholder, so it was not
  // seen as a date field and "Quand seriez-vous disponible ?*" got the notice text → "This field is required" → skipped.
  function isDateField(input) {
    if (!input) return false;
    if (input.type === 'date') return true;
    const s = [input.placeholder, input.getAttribute && input.getAttribute('aria-label'), input.className, input.name, input.id, input.getAttribute && input.getAttribute('data-testid')].join(' ');
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
    // v2.5.114: the native-dialog date picker declares its locale (lang="en-US" → MM/DD/YYYY), whatever the question's language.
    const lang = String((input && input.getAttribute && input.getAttribute('lang')) || '');
    if (/^en-us$/i.test(lang)) return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
    if (/^(fr|en-gb|es|it|de|pt|nl)/i.test(lang)) return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
    // v2.5.112 (premium IN user, "Earliest start date? Required" → "Please enter a valid answer"): "date" is English
    // too — only French words switch to DD/MM/YYYY.
    const fr = /[àâçéèêëîïôûù]|\b(quand|partir|début|debut|vous|poste|disponible)\b/i.test(String(question)) && !/\b(what|when|your|the|earliest|start)\b/i.test(String(question));
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

  // ─── v2.5.109: pay questions (Indian CTC conventions) ───────────────────
  // Ops alert 2026-10-12 + user mail ("the salary field is going wrong"): "Expected CTC", "desired pay
  // rate in LPA", "Current CTC in INR" never matched the salary pattern (no "salary" word) → AI / empty.
  // Rules: EXPECTED pay = the profile's expected salary, converted to the unit the question asks
  // (LPA / lakhs, per month) — never another currency. CURRENT / last-drawn pay is not in the profile →
  // never answered (not with the expectation, not by the AI): the application is skipped.
  // v2.5.112 (telemetry 2026-10-13, free IN user): "What is your ECTC?" (expected CTC) / "CCTC" (current CTC)
  // matched nothing → skipped although the expected salary is set.
  const _PAY_Q = /\b[ec]?ctc\b|cost\s+to\s+(the\s+)?company|\bsalary\b|\bsalaire\b|\bcompensation\b|\bremuneration\b|r[ée]mun[ée]ration|pr[ée]tentions?\s+salariales?|\bpay\s*(rate|range|expectation|package)?\b|\bpackage\b|\blpa\b|\bwages?\b|\bsueldo\b|\bsalario\b|\bgehalt\b|\bstipendio\b/i;
  const _CURRENT_PAY_Q = /\bcctc\b|\b(current|present|existing|last[\s-]+drawn|actual|todays?|now)\b[^?.]{0,30}\b(ctc|salary|compensation|pay|package|remuneration|earnings|lpa)\b|\b(ctc|salary|package)\b[^?.]{0,15}\b(current(ly)?|presently|drawn)\b|\bisyour\s+current\b|salaire\s+actuel|r[ée]mun[ée]ration\s+actuelle|sueldo\s+actual|salario\s+actual|aktuelles\s+gehalt/i;
  const _EXPECTED_PAY_Q = /\bectc\b|\b(expected|expectations?|expecting|desired|target|asking|anticipated|wish(ed)?)\b[^?.]{0,30}\b(ctc|salary|compensation|pay|package|remuneration|lpa)\b|\b(ctc|salary|pay|compensation)\b[^?.]{0,25}\b(expect\w*|desired|looking\s+for)\b|pr[ée]tentions?|salaire\s+(souhait|attendu|vis[ée])|r[ée]mun[ée]ration\s+(souhait|attendue)|pay\s+expectation/i;
  // "Current Variable Compensation", "variable pay", "bonus amount" — but not "CTC (including fixed and variable)" /
  // "(Fixed + Variable)", which ask for the total.
  const _VARIABLE_PAY_RE = /\b(variable|bonus|incentives?|commission)\s+(pay|compensation|component|ctc|salary|amount|portion|part)\b|^\s*(what\s+is\s+your\s+)?(current\s+|expected\s+|annual\s+)?(variable|bonus)\s*\??\s*\*?\s*$/i;
  const _VARIABLE_PAY_Q = { test: (q) => _VARIABLE_PAY_RE.test(String(q || '')) && !/\b(fixed|base|total|including|incl|inclusive|excluding|excl|plus|and)\b|\+/i.test(String(q || '')) };
  function isPayQuestion(q) { return _PAY_Q.test(String(q || '')); }
  function _isNumericInput(el) {
    return !!el && (el.type === 'number' || /^(numeric|decimal)$/.test(el.getAttribute('inputmode') || '') || /numeric/i.test(el.id || ''));
  }
  // "Have you …? / Do you …? / Are you …?" — not a count, an amount, a duration or pay.
  function _isYesNoNumericQ(q) {
    const s = String(q || '').trim();
    if (!/^(have|has|had|do|does|did|are|is|was|were|can|could|will|would|should)\s+(you|your)\b/i.test(s)) return false;
    return !/how\s+(many|much|long|soon)|\b(what|which|when|notice|joiner|joining|join)\b|\b(years?|yrs?|months?|weeks?|days?|hours?|number|amount|count|percent(age)?|%|salary|ctc|lpa|compensation|pay|rate|budget|score|rating|gpa|cgpa|age|size|level)\b/i.test(s);
  }
  function isCurrentPayQuestion(q) { const s = String(q || ''); return _CURRENT_PAY_Q.test(s) && !_EXPECTED_PAY_Q.test(s); }
  // "700000", "7 LPA", "7.5 lakhs", "55k", "55000 EUR", "1.2 cr" → { amount (yearly), cur, monthly }
  function parsePayAmount(raw) {
    const s = String(raw || '').toLowerCase().replace(/,/g, '').trim();
    const m = s.match(/(\d+(?:\.\d+)?)/); if (!m) return null;
    let n = parseFloat(m[1]);
    if (/\blpa\b|lakhs?|lacs?\b|\d\s*l\b/.test(s)) n *= 1e5;
    else if (/crores?|\bcr\b/.test(s)) n *= 1e7;
    else if (/\d\s*k\b|\bk\b/.test(s)) n *= 1e3;
    else if (/\d\s*m\b|million/.test(s)) n *= 1e6;
    const cur = (s.match(/\b(eur|usd|inr|gbp|cad|chf|aud)\b/) || [])[1] || (/€/.test(s) ? 'eur' : /₹|lpa|lakh|lac|crore/.test(s) ? 'inr' : /£/.test(s) ? 'gbp' : /\$/.test(s) ? 'usd' : '');
    const monthly = /per\s*month|\/\s*month|monthly|\bpm\b|par\s+mois|mensuel/.test(s);
    return { amount: n, cur: cur.toUpperCase(), monthly };
  }
  function _salaryBand(q, amount) {
    const K = (n, unit) => { const v = parseFloat(String(n).replace(',', '.')); return /k|ke|k€/i.test(unit || '') || v < 1000 ? v * 1000 : v; };
    const bands = [];
    const re = /(?:^|[\s(])(\d)\s*[-–).]\s*(?:de\s+|from\s+|entre\s+|between\s+)?(\d+(?:[.,]\d+)?)\s*(k€|ke|k|000\s*€?)?\s*(?:à|a|-|–|to|et|and)\s*(\d+(?:[.,]\d+)?)\s*(k€|ke|k|000\s*€?)?/gi;
    let m; while ((m = re.exec(q))) bands.push({ n: m[1], lo: K(m[2], m[3] || m[5]), hi: K(m[4], m[5]), label: m[0].trim().replace(/^\(/, '') });
    const top = q.match(/(?:^|[\s(])(\d)\s*[-–).]\s*(?:plus de|more than|over|au-dessus de|\+\s*de|above)\s*(\d+(?:[.,]\d+)?)\s*(k€|ke|k)?/i);
    if (top) bands.push({ n: top[1], lo: K(top[2], top[3]), hi: Infinity, label: top[0].trim().replace(/^\(/, '') });
    if (bands.length < 2) return '';
    bands.sort((a, b) => a.lo - b.lo);
    const hit = bands.find(b => amount >= b.lo && amount <= b.hi) || (amount < bands[0].lo ? bands[0] : bands[bands.length - 1]);
    return hit.label;
  }
  // v2.5.114: one pay-band option → { lo, hi } (yearly amount), else null. "- 40k", "< 40 k€", "Moins de 40k",
  // "40 - 45k", "40k-45k", "40 000 € - 45 000 €", "+ 90k", "90k+", "Plus de 90k", "> 90 000".
  function _payOptionRange(text, ctx) {
    const t = _deaccent(String(text || '')).toLowerCase().replace(/(\d)[\s  .](?=\d{3}\b)/g, '$1').trim();
    // durations ("1 à 2 ans", "3 months") and monthly bands are not yearly pay bands
    if (!/\d/.test(t) || /\d\s*(ans?|years?|yrs?|annees?|months?|mois|days?|jours?)\b|par\s+mois|per\s+month|\/\s*(mois|month)|mensuel|monthly/.test(t)) return null;
    const lakh = /\blpa\b|lakhs?|\blacs?\b/.test(t + ' ' + _deaccent(String(ctx || '')).toLowerCase());
    const unitK = /\d\s*(k|ke|k€|keur)\b|\d\s*k$/.test(t);
    const num = (s) => { let v = parseFloat(String(s).replace(',', '.')); if (lakh && v < 1000) v *= 1e5; else if (unitK || v < 1000) v *= 1000; return v; };
    let m = t.match(/^(?:-|<|moins\s+de|less\s+than|under|below|jusqu.?a|up\s+to)\s*(\d+(?:[.,]\d+)?)/);
    if (m) return { lo: 0, hi: num(m[1]) };
    m = t.match(/^(?:\+|>|plus\s+de|more\s+than|over|above|au-dessus\s+de)\s*(\d+(?:[.,]\d+)?)/) || t.match(/^(\d+(?:[.,]\d+)?)\s*(?:k|ke|k€|keur|€|eur)?\s*(?:\+|et\s+plus|and\s+(?:above|more)|or\s+more)/);
    if (m) return { lo: num(m[1]), hi: Infinity };
    m = t.match(/^(?:de\s+|from\s+|entre\s+|between\s+)?(\d+(?:[.,]\d+)?)\s*(?:k|ke|k€|keur|€|eur)?\s*(?:-|–|a|to|et|and)\s*(\d+(?:[.,]\d+)?)/);
    if (m) { const lo = num(m[1]), hi = num(m[2]); return hi > lo ? { lo, hi } : null; }
    return null;
  }
  // The band option holding the user's expectation (current pay → the currentSalary setting), or null.
  function _payBandOption(options, question, config) {
    if (/par\s+mois|per\s+month|monthly|mensuel/i.test(String(question || ''))) return null; // monthly bands: not handled → unanswered
    const ranged = options.map(o => ({ o, r: _payOptionRange(o.text, question) })).filter(x => x.r);
    if (ranged.length < 2) return null;
    if (_VARIABLE_PAY_Q.test(question)) return null;
    const isCur = isCurrentPayQuestion(question);
    const raw = String((config && (isCur ? config.currentSalary : config.expectedSalary)) || '').trim();
    if (!raw || !salaryAnswer(question, config, null)) return null; // same currency / unit guards as text fields
    const p = parsePayAmount(raw); if (!p || !(p.amount > 0)) return null;
    const a = p.monthly ? p.amount * 12 : p.amount;
    const hit = ranged.find(x => a >= x.r.lo && a < x.r.hi) || ranged.find(x => a >= x.r.lo && a <= x.r.hi);
    if (hit) return hit.o;
    const sorted = ranged.slice().sort((x, y) => x.r.lo - y.r.lo);
    return a < sorted[0].r.lo ? sorted[0].o : sorted[sorted.length - 1].o;
  }
  function salaryAnswer(question, config, input) {
    const q = String(question || '');
    // v2.5.109: current / last-drawn pay is not the expectation — never answered from it.
    // v2.5.111 (IN forms: "What is your current CTC?" required → job skipped): the optional "Current salary /
    // CTC" setting answers it; empty setting → still never guessed.
    const isCur = isCurrentPayQuestion(q);
    // v2.5.113 (premium IN user 2026-10-14): "Current Variable Compensation" got the whole CTC. The variable /
    // bonus / incentive PART alone is in no setting → never answered (a fixed / base / in-hand question keeps the
    // salary setting, as before).
    if (_VARIABLE_PAY_Q.test(q)) return '';
    const raw = String((config && (isCur ? config.currentSalary : config.expectedSalary)) || '').trim();
    if (!raw) return '';
    // 2.5.122: a fresher's current CTC is 0 (typed by the user in To complete / Preferences) → "0" in any unit.
    if (isCur && /^0+$/.test(raw)) return '0';
    const p = parsePayAmount(raw);
    const country = String(profileCountry(config) || '').toLowerCase().trim();
    const userCur = (p && p.cur) || _CUR_BY_COUNTRY[country] || _CUR_BY_DIAL['+' + String((config && config.phoneCountryCode) || '').replace(/[^\d]/g, '')] || '';
    const qCur = ((q.match(/\b(EUR|USD|INR|GBP|CAD|CHF|AUD)\b/i) || [])[1] || (/€/.test(q) ? 'EUR' : /₹|\blpa\b|lakhs?|\blacs?\b/i.test(q) ? 'INR' : /£/.test(q) ? 'GBP' : /\$/.test(q) ? 'USD' : '')).toUpperCase();
    // v2.5.113 (premium IN user 2026-10-14, Egypt job): "What is your Current salary? (EGP)" got the rupee amount.
    // A currency outside the EUR/USD/GBP/CAD/CHF/AUD/INR set, different from the user's → never converted, left empty.
    const qOther = (q.match(/\b(EGP|AED|SAR|QAR|KWD|OMR|BHD|JOD|SGD|MYR|PHP|PKR|BDT|LKR|NPR|IDR|THB|VND|KRW|JPY|CNY|RMB|HKD|TWD|NZD|ZAR|NGN|KES|GHS|MAD|TND|TRY|ILS|PLN|CZK|HUF|RON|BGN|SEK|NOK|DKK|BRL|MXN|ARS|CLP|COP|PEN|UAH|RUB)\b/) || [])[1];
    if (p && qOther && qOther !== String(userCur || '').toUpperCase()) return '';
    // Rupees vs another currency → we have no amount in that currency (never converted): 700000 INR
    // written as "700000 USD / month" would be absurd. (EUR↔USD-like pairs keep the 2.5.89 rule: the
    // number as is, labelled with the question's currency — Théo's earlier call, test kept.)
    // v2.5.113: same for a user whose own currency is outside the EUR/USD-like set (EGP, AED, PKR…).
    if (p && qCur && userCur && qCur !== userCur && (qCur === 'INR' || userCur === 'INR' || !/^(EUR|USD|GBP|CAD|CHF|AUD)$/.test(userCur))) return '';
    const fieldNumeric = !!(input && (input.type === 'number' || input.getAttribute('inputmode') === 'numeric' || input.getAttribute('inputmode') === 'decimal' || /numeric/i.test(input.id || '')));
    // v2.5.110 (live 2026-10-12, Crédit Agricole PF&M): "Quelles sont vos prétentions salariales ? 1- 60 à 75ke
    // 2- 75 à 90ke 3- 90 à 110ke 4- Plus de 110ke" got "55000". Numbered bands in the question → the band that
    // holds the expectation (below the first → the first, above the last → the last).
    const band = p && !fieldNumeric ? _salaryBand(q, p.amount) : '';
    if (band) return band;
    const fmt = (x) => String(Math.round(x * 100) / 100);
    if (p && /\blpa\b|\blakhs?\b|\blacs?\b|\bin\s+lakh/i.test(q)) {
      // "Expected CTC (LPA)": 700000 → 7 ; a value already in lakhs ("7") stays 7.
      const lakhs = p.amount >= 1e4 ? p.amount / 1e5 : p.amount;
      return fmt(lakhs);
    }
    if (p && /per\s+month|monthly|\/\s*month|par\s+mois|mensuel|al\s+mes|pro\s+monat/i.test(q) && !p.monthly && p.amount >= 1e4) {
      return String(Math.round(p.amount / 12));
    }
    // "7 LPA" typed in the settings, numeric field → the plain amount (700000).
    if (p && fieldNumeric && /[a-z€$£₹]/i.test(raw)) return String(Math.round(p.amount));
    if (/[a-z€$£₹]/i.test(raw)) return raw; // user typed their own format ("55k EUR")
    const numericOnly = input && (input.type === 'number' || input.getAttribute('inputmode') === 'numeric' || input.getAttribute('inputmode') === 'decimal');
    const asksCurrency = /\b(includ\w*|incl\.?|with|along with|and|plus|mention\w*|indiqu\w*|pr[ée]cis\w*|avec|y|con|specify\w*)\s+(the\s+|la\s+|votre\s+|your\s+|a\s+)?(currency|devise|moneda|w[äa]hrung)|\bcurrency\s*(and|&|\+)|\(\s*(amount|montant)\s*(and|et|\+)\s*(currency|devise)\s*\)/i.test(q);
    if (numericOnly || !asksCurrency) return raw;
    const cur = qCur || userCur;
    return cur ? `${raw} ${cur}` : raw;
  }

  // ─── Fill text inputs ─────────────────────────────────────────────────
  async function fillTextInputs(modal, config) {
    const textInputs = modal.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input:not([type])');
    for (const input of textInputs) {
      if (input.closest && input.closest('[data-eam-exp]')) continue; // v2.5.112: work-experience entry (fillExperienceForms)
      if (input.value) {
        // Pre-filled "years of X" (LinkedIn saved answer). History: 2.5.104–2.5.115 LOWERED a saved figure above the
        // CV-backed one ("ServiceNow ?" 2 → 0) and only raised a saved 0 / CV-dated figures.
        // v2.5.116 (Théo 2026-10-16): never lowered; raised to the policy answer (yearsForQuestion) whenever lower —
        // a saved 0 for any years question, a saved non-zero figure for an EXPERIENCE question.
        try {
          const lab = getFieldLabel(input, modal).toLowerCase();
          const cur = String(input.value).trim();
          if (/^\d{1,2}$/.test(cur) && lab.match(/experience|years|expérience|années|años|jahre|anni|esperienza/)) {
            const fq = getFieldQuestion(input, modal);
            const y = yearsForQuestion(fq, config);
            const isExp = /experien|exp[ée]rience|erfahrung|esperienza/i.test(lab + ' ' + fq);
            if (y && y.years > 0 && Number(cur) < y.years && (Number(cur) === 0 || isExp || y.skill)) {
              u().fill(input, String(y.years));
              u().log(`Years exp: raised pre-filled ${cur} → ${y.years} (${y.basis})`);
            }
          }
        } catch (_) {}
        continue;
      }

      const label = getFieldLabel(input, modal).toLowerCase();
      const inputType = (input.type || '').toLowerCase();

      // v2.5.113 (premium IN user 2026-10-15): "Have you launched a product from 0→1?" as a NUMERIC field
      // ("Enter a decimal number larger than 0.0") — a yes/no question asked as a number: Yes = 1 (Théo's Oui rule).
      if (_isNumericInput(input) && _isYesNoNumericQ(getFieldQuestion(input, modal))) {
        u().fill(input, '1'); u().log(`Yes/no question in a numeric field → 1 ("${getFieldQuestion(input, modal).slice(0, 50)}")`); continue;
      }

      // GUARD 1: Never fill free-text PII into numeric fields. A long help
      // text mentioning "email" on a number input previously caused us to
      // write gmail addresses into 7-digit ID fields (seen on Workable).
      if (inputType === 'number') {
        // Only honor very specific numeric intents below.
        if (label.match(/experience|years|expérience|années|años|jahre|anni|esperienza/)) {
          const y = yearsForQuestion(getFieldQuestion(input, modal), config);
          const v = (y.basis === 'total' && !y.years) ? String(totalYears(config) || config.yearsOfExperience || '2') : String(y.years);
          u().fill(input, v);
          u().log(`Years exp: ${v} (${y.basis})`);
        } else if (isPayQuestion(getFieldQuestion(input, modal)) || label.match(/salary|compensation|remuneration|salaire|rémunération|prétention|pretention|sueldo|salario|gehalt|stipendio|pay.*expect|expectation.*pay|\bctc\b/)) {
          // v2.5.109: same pay rules as text fields (expected → converted; current → never answered).
          _fillPay(input, getFieldQuestion(input, modal), config);
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
        let v = profileUrlValue(urlKind, config, modal);
        // v2.5.108 (premium user 2026-10-12, single-page Easy Apply: no /in/ link in the form):
        // the applicant's own profile from their LinkedIn session; a website field with no
        // website gets the LinkedIn profile (better than an empty required field).
        if (!v && (urlKind === 'LinkedIn' || urlKind === 'Website')) v = await ownLinkedInUrl();
        if (v) { u().fill(input, v); u().log(`${urlKind} URL filled: ${v}`); continue; }
      }
      {
        const fq = getFieldQuestion(input, modal);
        // v2.5.108: "How did you hear about this job?" as FREE TEXT (radios/selects were handled) → LinkedIn.
        if (_SOURCE_Q.test(fq)) { u().fill(input, 'LinkedIn'); u().log('Source question (text) → LinkedIn'); continue; }
        // v2.5.108: follow-up detail of a yes/no ("If yes, please identify the person / vendor…"). The
        // self-declaration answer is No → nothing to declare.
        if (_IF_YES_FOLLOWUP_Q.test(fq)) { u().fill(input, 'N/A'); u().log(`Follow-up "${fq.slice(0, 40)}" → N/A`); continue; }
        // v2.5.112 (telemetry 2026-10-13): deterministic answers that used to need the AI (Premium only) or were
        // filled with the wrong value.
        const det = deterministicTextAnswer(fq, config, input, modal);
        if (det != null) {
          if (det) { u().fill(input, det); u().log(`"${fq.slice(0, 40)}" → ${det.slice(0, 50)}`); }
          else {
            _noteUnknownField(fq, input, modal); // counts only when the form requires it
            if (_POSTAL_Q.test(fq) && _isRequiredField(input, modal)) _noteMissingSetting('postalCode');
          }
          continue;
        }
        // v2.5.109: conditional self-declaration detail ("If you have previously worked at LinkedIn or
        // Microsoft, please provide your last date…") — the self-declaration answer is No → N/A.
        if (_PREVIOUSLY_FOLLOWUP_Q.test(fq)) { u().fill(input, 'N/A'); u().log(`Conditional follow-up "${fq.slice(0, 40)}" → N/A`); continue; }
        // v2.5.109: "Others (Please Specify)" — N/A unless the choice right before it is "Other".
        if (_OTHER_SPECIFY_Q.test(fq)) {
          if (!_parentChoiceIsOther(input, modal)) { u().fill(input, 'N/A'); u().log(`"${fq.slice(0, 40)}" (the choice above is not "Other") → N/A`); continue; }
          u().log(`"${fq.slice(0, 40)}": "Other" is selected above → answered normally`);
        }
        // v2.5.109: date of birth — only from the profile; never invented (no DOB field exists today).
        if (_DOB_Q.test(fq)) {
          const dob = _formatDobFor(profileDateOfBirth(config), input, fq);
          if (dob) { u().fill(input, dob); u().log('Date of birth filled from your settings'); continue; }
          u().log(`Date of birth "${fq.slice(0, 40)}": not in your profile — never guessed`);
          _noteUnknownField(fq, input, modal);
          if (_isRequiredField(input, modal)) { u()._unknownFieldFails = Math.max(3, u()._unknownFieldFails || 0); _noteMissingSetting('dateOfBirth'); } // required → skip now, not after 10 steps
          continue;
        }
        // v2.5.109: pay questions (CTC / salary / LPA), before the years pattern and the AI.
        if (isPayQuestion(fq) && !/how\s+many\s+years|years?\s+of\s+(experience|exp)/i.test(fq)) { _fillPay(input, fq, config); continue; }
        // v2.5.109: "Current company / organisation / employer" and "Current designation / title" →
        // the latest CV role (they went to the AI — Premium only — and stayed empty on Free).
        const cur = currentRoleAnswer(fq, config);
        if (cur) { u().fill(input, cur); u().log(`Current role field "${fq.slice(0, 40)}" → ${cur}`); continue; }
      }

      // Years of experience (EN/FR/ES/DE/IT)
      // v2.5.112 (premium IN alert): "What is your overal year of exp?" matched nothing → AI / empty.
      if (haystack.match(/experience|years|expérience|années|años|jahre|anni|esperienza|\b(year|yr)s?\s+of\s+exp\b|\btotal\s+exp\b|\bexp\s*\(?\s*(in\s+)?(years?|yrs?)\b/)) {
        // v2.5.89: years for the skill the question names, not the global total
        // (0 when the skill is nowhere in the CV — never a made-up number).
        const y = yearsForQuestion(getFieldQuestion(input, modal), config);
        const v = (y.basis === 'total' && !y.years) ? String(totalYears(config) || config.yearsOfExperience || '2') : String(y.years);
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
      // v2.5.109 (ops alert 2026-10-12): "How soon can you join?", "Are you an Immediate Joiner, What is
      // your Notice?" (Indian forms) went to the AI and failed "Enter a decimal number larger than 0.0".
      else if (haystack.match(/notice.*period|how.*soon.*(can|could|would).*\bjoin|when.*can.*you.*join|immediate.?joiner|your\s+notice\b|notice\s*\?|préavis|preavviso|preaviso|kündigungsfrist|kundigungsfrist|disponibilit|disponible|disponibil|availability|verfügbarkeit|verfugbarkeit|when.*can.*you.*start|how.*soon.*(can|could|would).*(start|join|begin)|earliest.*start|start.*date|quand.*disponible|seriez.*disponible|partir.*de.*quand|combien.*de.*mois|cuando.*puede.*empezar|cuándo.*puede.*empezar|cuando.*puede|wann.*können.*sie.*anfangen|wann.*konnen.*sie.*anfangen|quando.*può.*iniziare|quando.*puo.*iniziare|date.*début|début.*poste|disponibilità/)) {
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
        // v2.5.104: the number is converted to the unit the question asks. Live 2026-10-08:
        // "Quelle est la durée de votre préavis en jours ?" got "1" for a "1 month" setting.
        const askDays = /\b(en|in)\s+(jours|days|d[ií]as|tagen|giorni)\b|\(\s*(jours|days|d[ií]as|tage|giorni)\s*\)|combien de jours|how many days|nombre de jours|number\s+of\s+days|\bno\.?\s+of\s+days|\bdays\s*\)/i.test(haystack); // v2.5.113: "Notice Period (number of days)" got "2 months"
        const askWeeks = /\b(en|in)\s+(semaines|weeks|semanas|wochen|settimane)\b|\(\s*(semaines|weeks)\s*\)|combien de semaines|how many weeks|nombre de semaines/i.test(haystack);
        let noticeNum = unitless || '1';
        // v2.5.109: a numeric field never gets "2 weeks" / "Immediate" (LinkedIn: "Enter a decimal number").
        // Bare number = months (popup hint): weeks / days converted, immediate → 0.
        if (!/^\d+([.,]\d+)?$/.test(noticeNum)) {
          const rl = rawValue.toLowerCase();
          const mm = rl.match(/(\d+(?:[.,]\d+)?)\s*([a-zíéèà]*)/);
          if (/imm[ée]diat|immediate|none|aucun|serving/.test(rl) && !mm) noticeNum = '0';
          else if (mm) { const n = parseFloat(mm[1].replace(',', '.')); const un = mm[2] || ''; noticeNum = String(/jour|day|d[ií]a|tag/.test(un) ? Math.round(n / 30 * 10) / 10 : /semaine|week|semana|woche/.test(un) ? Math.round(n / 4.345 * 10) / 10 : n); }
          else noticeNum = '1';
        }
        if (askDays || askWeeks) {
          const m = rawValue.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(jours?|days?|d[ií]as?|tage?n?|semaines?|weeks?|semanas?|wochen|mois|months?|meses|monate|mesi)?/);
          let days = 0;
          if (/imm[ée]diat|immediate|none|aucun|^0\b/.test(rawValue.toLowerCase())) days = 0;
          else if (m) {
            const n = parseFloat(m[1].replace(',', '.'));
            const unit = m[2] || 'month';
            days = /jour|day|d[ií]a|tag/.test(unit) ? n : /semaine|week|semana|woche/.test(unit) ? n * 7 : n * 30;
          }
          noticeNum = String(askDays ? Math.round(days) : Math.round(days / 7));
        }
        const noticePeriod = (labelExpectsNumber || askDays || askWeeks) ? noticeNum : noticePeriodText(haystack, config);
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
        if (isTypeaheadInput(input)) {
          // v2.5.113: LinkedIn location typeahead — a suggestion must be picked (free text is refused).
          if (!(await fillLocationTypeahead(input, config, modal))) _noteUnknownField(getFieldQuestion(input, modal) || 'Location (city)', input, modal);
          continue;
        }
        // v2.5.119: extension city empty → the dashboard / CV city (telemetry 2026-10-17: required "City" left empty).
        const cityVal = String(config.city || ((config.cityAlternates || [])[0]) || '').trim();
        if (!cityVal) { _noteUnknownField(getFieldQuestion(input, modal) || 'City', input, modal); continue; }
        u().fill(input, cityVal);
        u().log(`Location filled: ${cityVal}`);
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
          let aiAnswer = await window.EAM.aiForm.askAI(question, config, input.type);
          const isNumericField = input.type === 'number'
            || input.getAttribute('inputmode') === 'numeric'
            || (input.getAttribute('pattern') || '').includes('\\d')
            || label.toLowerCase().match(/combien|how many|how much|nombre|number|heures|hours|salary|salaire|année|years|mois|months|percent|pourcentage|budget|quantity|quantité/);
          // v2.5.119 (dry-run gate 2026-10-17: "Sur combien de projets Sage X3 avez-vous travaillé ?" got "Yes" → the step
          // never validated → 10-step skip): a count / number question with no digit in the answer = no answer.
          if (aiAnswer && isNumericField && !/\d/.test(String(aiAnswer))) { u().log(`AI answer "${String(aiAnswer).slice(0, 20)}" has no number for a numeric question — numeric fallback`); aiAnswer = ''; }
          if (aiAnswer) {
            let value = aiAnswer;
            if (isNumericField) {
              const num = aiAnswer.match(/[\d]+\.?[\d]*/);
              value = num ? num[0] : aiAnswer;
              u().log(`AI numeric cleanup: "${value}"`);
            }
            u().fill(input, value);
            u().log(`AI filled: "${label.substring(0, 40)}" → "${String(value).substring(0, 40)}"`);
          } else {
            // v2.5.105: a numeric question the AI left empty ("How many …", "Number of …")
            // gets the CV-backed years / 0 instead of failing the whole application.
            const _q = getFieldQuestion(input, modal) || label;
            const _numeric = input.type === 'number' || input.getAttribute('inputmode') === 'numeric'
              || /\b(how many|how much|number of|combien|nombre de|cuántos|wie viele|years|années|años|jahre)\b/i.test(_q);
            if (_numeric) {
              // years → the CV-backed value; any other count (team size, budget, projects) the data
              // doesn't state → 0, the smallest truthful answer (never a mid-range guess).
              const isYears = /\b(years?|yrs?|années?|ans|años|jahre?n?|anni)\b/i.test(_q);
              const y = isYears ? yearsForQuestion(_q, config) : null;
              const v = y && isFinite(y.years) ? y.years : 0;
              u().fill(input, String(v));
              u().log(`Numeric fallback (AI empty): "${label.substring(0, 50)}" → ${v} (${y ? y.basis : 'default'})`);
            } else {
              u().log(`Unknown field: "${label.substring(0, 60)}" (AI returned nothing)`);
              _noteUnknownField(getFieldQuestion(input, modal) || label, input, modal);
            }
          }
        } else if (label) {
          u().log(`Unknown field: "${label.substring(0, 60)}" (AI module unavailable)`);
          _noteUnknownField(getFieldQuestion(input, modal) || label, input, modal);
        }
      }
    }
  }

  // ─── Textareas — AI-powered for open-ended questions ──────────────────
  async function fillTextareas(modal, config) {
    const textareas = modal.querySelectorAll('textarea');
    for (const ta of textareas) {
      if (ta.closest && ta.closest('[data-eam-exp]')) continue;
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
        const v = (y.basis === 'total' && !y.years) ? String(totalYears(config) || config.yearsOfExperience || '0') : String(y.years);
        u().fill(ta, v); u().log(`Years exp (textarea): ${v} (${y.basis})`); continue;
      }
      if (/notice period|pr[ée]avis|preaviso|preavviso|k[üu]ndigungsfrist/i.test(tql) && config.noticePeriod && !START_DATE_RE.test(tql)) {
        const v = noticePeriodText(tq, config);
        u().fill(ta, v); u().log(`Notice period (textarea): ${v}`); continue;
      }
      // v2.5.108: same deterministic answers as single-line fields (source / "If yes…" follow-up).
      if (_SOURCE_Q.test(tq)) { u().fill(ta, 'LinkedIn'); u().log('Source question (textarea) → LinkedIn'); continue; }
      if (_IF_YES_FOLLOWUP_Q.test(tq)) { u().fill(ta, 'N/A'); u().log(`Follow-up (textarea) → N/A`); continue; }
      // v2.5.112 (dry-run gate, Advancio): "Please add your LinkedIn profile (URL or direct link)*" as a TEXTAREA.
      {
        const uk = profileUrlKind(tq);
        if (uk) {
          let v = profileUrlValue(uk, config, modal);
          if (!v && (uk === 'LinkedIn' || uk === 'Website')) v = await ownLinkedInUrl();
          if (v) { u().fill(ta, v); u().log(`${uk} URL (textarea): ${v}`); continue; }
        }
      }
      {
        const det = deterministicTextAnswer(tq, config, ta, modal, true);
        if (det != null) { if (det) { u().fill(ta, det); u().log(`Textarea "${tq.slice(0, 40)}" → ${det.slice(0, 50)}`); } else _noteUnknownField(tq, ta, modal); continue; }
      }
      // v2.5.109: same rules as single-line fields.
      if (_PREVIOUSLY_FOLLOWUP_Q.test(tq)) { u().fill(ta, 'N/A'); u().log('Conditional follow-up (textarea) → N/A'); continue; }
      if (_OTHER_SPECIFY_Q.test(tq) && !_parentChoiceIsOther(ta, modal)) { u().fill(ta, 'N/A'); u().log('"Other, please specify" (textarea, "Other" not selected) → N/A'); continue; }
      if (isPayQuestion(tq) && tq.length < 160 && !/how\s+many\s+years|years?\s+of\s+(experience|exp)/i.test(tq)) { _fillPay(ta, tq, config); continue; }
      const answer = await window.EAM.aiForm.askAI(tq, config, 'textarea');
      if (answer) {
        u().fill(ta, answer);
        u().log(`AI textarea: "${label.substring(0, 40)}" → "${answer.substring(0, 50)}"`);
      } else {
        u().log(`Textarea not filled: "${label.substring(0, 50)}"`);
      }
    }
  }

  // ─── v2.5.113: LinkedIn location TYPEAHEAD ("Location (city)*", placeholder "Enter city or location") ──
  // Ops alert 2026-10-14 (premium IN user: "City" / "Location (city)" → "Please enter a valid answer"; free US user:
  // "Enter city or location" → "This field is required"). Live DOM 2026-10-15: <input data-testid="typeahead-input"
  // aria-autocomplete="list" aria-owns="typeahead-results-…">, suggestions in a floating-ui portal inside the dialog:
  // [role=listbox] > [role=option] > [role=button] > p. Free text is refused — a value only counts once an option is
  // picked. The full "Pittsburgh, USA" matched nothing → query the city alone, pick the first suggestion that names
  // it (best: "City, Region, Country" with the profile's country; "Greater X Area" only when nothing better).
  function isTypeaheadInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const ac = String(el.getAttribute('aria-autocomplete') || '').toLowerCase();
    return ac === 'list' || ac === 'both' || el.getAttribute('data-testid') === 'typeahead-input' || el.getAttribute('role') === 'combobox';
  }
  const _CITY_ALIASES = { bangalore: 'bengaluru', bengaluru: 'bangalore', bombay: 'mumbai', mumbai: 'bombay', madras: 'chennai', chennai: 'madras', calcutta: 'kolkata', kolkata: 'calcutta', gurgaon: 'gurugram', gurugram: 'gurgaon', 'new york city': 'new york', nyc: 'new york' };
  const _normLoc = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  function pickLocationOption(texts, city, config) {
    const parts = String(city || '').split(',').map(_normLoc).filter(Boolean);
    const c0 = parts[0]; if (!c0) return -1;
    const names = [c0, _CITY_ALIASES[c0]].filter(Boolean);
    const country = _normLoc(profileCountryName(config) || '');
    const extra = parts.slice(1).concat(country ? [country] : []).map(x => x.replace(/^(usa|us|u\.s\.a?\.?)$/, 'united states').replace(/^(uk|u\.k\.)$/, 'united kingdom'));
    let best = -1, bestScore = -1;
    texts.forEach((t, i) => {
      const n = _normLoc(t);
      const hit = names.find(nm => n === nm || n.startsWith(nm + ',') || n.startsWith(nm + ' ') || n.includes(' ' + nm + ',') || n.includes(nm));
      if (!hit) return;
      let sc = 1;
      if (n.startsWith(hit + ',')) sc += 3;
      if (extra.some(x => x && n.includes(x))) sc += 2;
      if (/\b(greater|area|region|metropolitan|metro)\b/.test(n)) sc -= 1;
      if (sc > bestScore) { bestScore = sc; best = i; }
    });
    return best;
  }
  function _typeaheadListbox(input, modal) {
    const ids = [input.getAttribute('aria-owns'), input.getAttribute('aria-controls')].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
    const roots = [input.getRootNode && input.getRootNode(), modal, document].filter(Boolean);
    for (const id of ids) for (const r of roots) { try { const lb = r.getElementById ? r.getElementById(id) : r.querySelector('#' + CSS.escape(id)); if (lb) return lb; } catch (_) {} }
    const dlg = input.closest('dialog, [role="dialog"]') || modal;
    return (dlg && dlg.querySelector('[role="listbox"]')) || null;
  }
  // v2.5.119 (telemetry 2026-10-17: "Location (city)" → "Please enter a valid answer" 7×, extension city "Hanumant Colony
  // Tilpat" matched no LinkedIn suggestion while the CV says "Faridabad, India"): the extension city first, then the
  // dashboard / CV cities (config.cityAlternates) — always a REAL city of the user, picked from LinkedIn's suggestions.
  async function fillLocationTypeahead(input, config, modal) {
    const cands = [];
    for (const c of [config && config.city].concat((config && config.cityAlternates) || [])) {
      const v = String(c || '').trim();
      if (v && !cands.some(x => _normLoc(x.split(',')[0]) === _normLoc(v.split(',')[0]))) cands.push(v);
    }
    if (!cands.length) { u().log('Location typeahead: no city in your profile — left empty'); return false; }
    for (const c of cands) {
      if (await _fillLocationTypeaheadOnce(input, Object.assign({}, config, { city: c }), modal)) return true;
    }
    try { u().fill(input, ''); } catch (_) {}
    return false;
  }
  async function _fillLocationTypeaheadOnce(input, config, modal) {
    const st = u();
    const city = String((config && config.city) || '').trim();
    const query = city.split(',')[0].trim();
    if (!query) return false;
    try { input.focus(); } catch (_) {}
    st.fill(input, '');
    await st.wait(250);
    st.fill(input, query);
    let opts = [], idx = -1;
    for (let k = 0; k < 25 && idx < 0; k++) {
      await st.wait(200);
      const lb = _typeaheadListbox(input, modal);
      opts = lb ? Array.from(lb.querySelectorAll('[role="option"]')) : [];
      idx = opts.length ? pickLocationOption(opts.map(o => o.textContent || ''), city, config) : -1;
    }
    if (idx < 0) { st.log(`Location typeahead: no suggestion matching "${query}" (${opts.length} shown) — not guessed`); return false; }
    const opt = opts[idx];
    const txt = String(opt.textContent || '').replace(/\s+/g, ' ').trim();
    (opt.querySelector('[role="button"]') || opt).click();
    await st.wait(500);
    const ok = _normLoc(input.value).includes(_normLoc(txt).split(',')[0]) || _normLoc(input.value) === _normLoc(txt);
    st.log(`Location typeahead: "${query}" → ${txt}${ok ? '' : ' (not confirmed by the field)'}`);
    return ok;
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
        // v2.5.109 (ops alert 2026-10-12: "Please upload an acceptable document format (JPG, JPEG, GIF,
        // PNG)"): an input that only accepts images (photo) never gets the PDF/DOC resume.
        {
          const acc = String(fileInput.getAttribute('accept') || '').toLowerCase().trim();
          if (acc && !/pdf|doc|\*\/\*|application\//.test(acc) && /image|\.(jpe?g|png|gif|webp|heic)/.test(acc)) {
            state.log(`Image-only file field (${acc.slice(0, 40)}) — not uploading the resume`);
            continue;
          }
        }

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
  // v2.5.119 (telemetry 2026-10-17, KR / CA users: "Phone country code*" + "Country*" left empty): one table for
  // country names (EN/FR/local) and dial codes. Built into COUNTRY_NAMES (cc → names) and _DIAL_TO_CC (dial → cc).
  const _COUNTRIES = [
    ['FR', '33', 'france'], ['US', '1', 'united states', 'united states of america', 'usa', 'états-unis', 'etats-unis'], ['IN', '91', 'india', 'inde'],
    ['GB', '44', 'united kingdom', 'uk', 'royaume-uni', 'great britain'], ['DE', '49', 'germany', 'allemagne', 'deutschland'], ['ES', '34', 'spain', 'espagne', 'españa'],
    ['IT', '39', 'italy', 'italie', 'italia'], ['BE', '32', 'belgium', 'belgique'], ['CH', '41', 'switzerland', 'suisse'], ['CA', '1', 'canada'], ['NL', '31', 'netherlands', 'pays-bas', 'nederland', 'the netherlands'],
    ['PT', '351', 'portugal'], ['IE', '353', 'ireland', 'irlande'], ['LU', '352', 'luxembourg'], ['MA', '212', 'morocco', 'maroc'], ['PK', '92', 'pakistan'],
    ['AE', '971', 'united arab emirates', 'émirats arabes unis', 'uae'], ['SG', '65', 'singapore', 'singapour'], ['AU', '61', 'australia', 'australie'],
    ['KR', '82', 'south korea', 'korea, republic of', 'republic of korea', 'korea', 'corée du sud', 'korea (south)'], ['JP', '81', 'japan', 'japon'], ['CN', '86', 'china', 'chine'],
    ['HK', '852', 'hong kong'], ['TW', '886', 'taiwan'], ['BR', '55', 'brazil', 'brésil', 'brasil'], ['MX', '52', 'mexico', 'mexique', 'méxico'], ['AR', '54', 'argentina', 'argentine'],
    ['CO', '57', 'colombia', 'colombie'], ['CL', '56', 'chile', 'chili'], ['PE', '51', 'peru', 'pérou'], ['ZA', '27', 'south africa', 'afrique du sud'], ['NG', '234', 'nigeria'],
    ['KE', '254', 'kenya'], ['EG', '20', 'egypt', 'égypte'], ['SA', '966', 'saudi arabia', 'arabie saoudite'], ['QA', '974', 'qatar'], ['KW', '965', 'kuwait', 'koweït'],
    ['TR', '90', 'turkey', 'türkiye', 'turquie'], ['PL', '48', 'poland', 'pologne', 'polska'], ['SE', '46', 'sweden', 'suède'], ['NO', '47', 'norway', 'norvège'], ['DK', '45', 'denmark', 'danemark'],
    ['FI', '358', 'finland', 'finlande'], ['AT', '43', 'austria', 'autriche'], ['GR', '30', 'greece', 'grèce'], ['RO', '40', 'romania', 'roumanie'], ['CZ', '420', 'czech republic', 'czechia', 'république tchèque'],
    ['HU', '36', 'hungary', 'hongrie'], ['UA', '380', 'ukraine'], ['IL', '972', 'israel', 'israël'], ['PH', '63', 'philippines'], ['MY', '60', 'malaysia', 'malaisie'],
    ['ID', '62', 'indonesia', 'indonésie'], ['TH', '66', 'thailand', 'thaïlande'], ['VN', '84', 'vietnam', 'viet nam'], ['BD', '880', 'bangladesh'], ['LK', '94', 'sri lanka'],
    ['NP', '977', 'nepal', 'népal'], ['NZ', '64', 'new zealand', 'nouvelle-zélande'], ['TN', '216', 'tunisia', 'tunisie'], ['DZ', '213', 'algeria', 'algérie'], ['SN', '221', 'senegal', 'sénégal'],
    ['CI', '225', "côte d'ivoire", 'ivory coast', "cote d'ivoire"],
  ];
  const COUNTRY_NAMES = {};
  const _CC_DIAL = {};
  for (const [cc, dial, ...names] of _COUNTRIES) { COUNTRY_NAMES[cc] = names; _CC_DIAL[cc] = dial; }
  COUNTRY_NAMES.UK = COUNTRY_NAMES.GB; _CC_DIAL.UK = '44';
  function isCountryQuestion(label) {
    return /\b(country|countries|pays|país|paese|land|nationality|nationalit[ée]|citizenship|citoyennet[ée])\b/i.test(String(label || ''));
  }
  function looksLikeCountryList(texts) {
    const t = texts.map(x => String(x || '').trim().toLowerCase());
    return t.length > 30 && t.includes('afghanistan') && (t.includes('france') || t.includes('albania'));
  }
  // v2.5.109 (ops alert 2026-10-12, premium IN user): auto-apply reads `country` from chrome.storage.sync,
  // where it is often absent (the popup derives it from the dial code only for its own autofill) →
  // "Country" / "Phone country code" selects left empty → "Please make a selection" → 10-step loop.
  // Fallback: the profile's dial code, the phone's +prefix, then a country named in the city field.
  const _DIAL_TO_CC = {};
  for (const [cc, dial] of _COUNTRIES) if (!_DIAL_TO_CC[dial]) _DIAL_TO_CC[dial] = cc; // '1' → US (first)
  function profileCountry(config) {
    const c = String((config && config.country) || '').trim();
    if (c) return c;
    const dial = String((config && config.phoneCountryCode) || '').replace(/[^\d]/g, '');
    if (_DIAL_TO_CC[dial]) return _DIAL_TO_CC[dial];
    const ph = String((config && config.phone) || '').trim();
    if (/^(\+|00)/.test(ph)) {
      const d = ph.replace(/^(\+|00)/, '').replace(/[^\d]/g, '');
      for (const len of [3, 2, 1]) if (_DIAL_TO_CC[d.slice(0, len)]) return _DIAL_TO_CC[d.slice(0, len)];
    }
    // v2.5.119: + the dashboard / CV city when the extension city is empty or names no country ("Seoul, Korea").
    for (const cityRaw of [config && config.city].concat((config && config.cityAlternates) || [])) {
      const city = _deaccent(String(cityRaw || '')).toLowerCase();
      if (city) for (const [cc, names] of Object.entries(COUNTRY_NAMES)) { if (names.some(n => n.length > 3 && new RegExp('\\b' + _deaccent(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(city))) return cc; }
    }
    return '';
  }
  // ISO code of a profile country given as a code or a name ("FR", "France", "south korea") — '' when unknown.
  function countryCode(raw) {
    const r = String(raw || '').trim(); if (!r) return '';
    if (COUNTRY_NAMES[r.toUpperCase()]) return r.toUpperCase() === 'UK' ? 'GB' : r.toUpperCase();
    const n = _deaccent(r).toLowerCase();
    for (const [cc, names] of Object.entries(COUNTRY_NAMES)) if (names.some(x => _deaccent(x).toLowerCase() === n)) return cc === 'UK' ? 'GB' : cc;
    return '';
  }
  // v2.5.119: "Phone country code" options read "South Korea (+82)" / "+82" / "Korea, Republic of (+82)": the name
  // (without the dial part) or, failing that, the dial code (the user's phoneCountryCode, else the country's code).
  function findCountryOption(options, textOf, config) {
    const raw = profileCountry(config);
    const cc = countryCode(raw);
    const names = (cc && COUNTRY_NAMES[cc]) || (raw ? [_deaccent(raw).toLowerCase()] : []);
    const norm = s => _deaccent(String(s || '')).replace(/\(\s*\+?\s*\d[\d\s-]*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const nn = names.map(x => _deaccent(x).toLowerCase());
    const byName = options.find(o => nn.includes(norm(textOf(o)))) || options.find(o => nn.some(n => n.length > 3 && norm(textOf(o)).startsWith(n))) || null;
    if (byName) return byName;
    const dial = String((config && config.phoneCountryCode) || '').replace(/[^\d]/g, '') || (cc && _CC_DIAL[cc]) || '';
    if (!dial) return null;
    const dialRe = new RegExp('(^|[^\\d])\\+\\s*' + dial + '(?!\\d)');
    const hits = options.filter(o => dialRe.test(String(textOf(o) || '')));
    if (hits.length === 1) return hits[0];
    return hits.find(o => nn.some(n => norm(textOf(o)).includes(n))) || (hits.length && !cc ? null : hits[0]) || null;
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
  const SELF_DECLARATION_RE = /\b(presently|currently|previously|formerly|ever)\b.{0,40}\b(employed|associated|affiliated)\b|\b(presently|currently|previously|formerly|ever)\b.{0,20}\bwork(ed|ing)?\s+(for|at)\s+(?!(a|an|any|some|startups?|companies|organi[sz]ations|clients|customers|agencies|firms|teams|projects|large|small|big|global|international|multinational|fast[- ]growing)\b)|\b(current|former)\s*(\/\s*(an\s+)?)?(ex[- ])?employee\b|\bex[- ]employee\b|\brelationship with\b|\brelated to (a|an|any)\b|\b(relatives?|family members?)\b.{0,60}\b(work|employ)|\bassociated with\b.{0,60}\b(entit|compan|subsidiar|firm|group)|\baffiliated with\b|conflict of interest|\b(previously|already|before)\b.{0,30}\b(applied|interviewed)\b|\binterview process\b.{0,80}\b(past|within|last)\b|\bapplied\b.{0,40}\b(before|previously|in the past)\b|\b(convicted|criminal record|felony|misdemeanou?r)\b|\bnon-?compete\b|government official|politically exposed|d[ée]j[àa] postul|d[ée]j[àa] travaill[ée]e?s?\s+(pour|chez|au\s+sein\s+d|avec\s+nous|dans\s+(notre|nos|cette|ce\s+groupe|l.entreprise|la\s+soci[ée]t[ée]|le\s+groupe))(?!\s+(une?|des|d.autres)\b)|actuellement (employ|salari)|ancien (salari|employ)|lien de parent|conflit d.int[ée]r[êe]t|(?<!how\s)\bwere\s+you\s+referred\b|\bwas\s+this\s+a\s+referral\b|\breferred\s+by\s+(an?\s+|one\s+of\s+our\s+)?(current\s+)?(employee|staff|team\s+member|member\s+of)|\bemployee\s+referral\b|\bhave\s+you\s+been\s+referred\b|avez[- ]vous\s+[ée]t[ée]\s+(recommand|coopt|parrain)/i;
  function isSelfDeclarationQuestion(text) { return SELF_DECLARATION_RE.test(String(text || '')); }

  // ─── v2.5.116: the "Oui" rule for yes/no questions (Théo 2026-10-16) ─────
  // Yes/no screening questions lean YES. "No" stays possible ONLY for the questions below — disqualifying if
  // answered Yes, or decided by a setting / a fact the user gave (deterministic rules answer those). Returns the
  // reason, '' = the question is answered Yes whatever the AI or a cached answer said.
  // Live 2026-10-16 (KYC): "Avez-vous déjà travaillé sur des projets de Transformation RH et/ou conduite du
  // changement ?" → "Non" although "Conduite du Changement" is in Théo's CV skills.
  const _NO_ALLOWED = [
    // conflict of interest, current / former employee, relatives, prior application / interview, criminal record, non-compete, PEP
    ['self-declaration', (q) => SELF_DECLARATION_RE.test(q)],
    ['marketing opt-in', (q) => isMarketingOptInLabel(q)],
    ['adjustments / accommodations', (q) => _ADJUSTMENTS_Q.test(q)],
    ['sponsorship / visa (setting)', (q) => /sponsor|\bvisa\b|parrainage/i.test(q)],
    ['work authorisation (setting)', (q) => /authori[sz]|legal(ly)?\s.{0,20}work|eligib\w*\s.{0,20}work|right\s+to\s+work|work\s+permit|permis\s+de\s+travail|autoris[ée]|droit\s+de\s+travailler|titre\s+de\s+s[ée]jour|citizen|citoyen|nationalit/i.test(q)],
    ['relocation / place (setting)', (q) => /relocat|d[ée]m[ée]nag|willing\s+to\s+move|move\s+to|based\s+in|located\s+in|live\s+in|\breside|r[ée]sidez|habitez|vivez/i.test(q)],
    ['start date / notice (setting)', (q) => /imm[ée]diate|immediately|imm[ée]diatement|notice\s+period|pr[ée]avis|start\s+(date|on|by)|join\s+(by|on|within)/i.test(q)],
    ['driving licence (setting)', (q) => /driv\w*.{0,10}licen[cs]e|licen[cs]e.{0,10}driv|permis\s+(de\s+conduire|b)\b/i.test(q)],
    ['security clearance', (q) => /clearance|habilitation\s+(secret|d[ée]fense|confidentiel)/i.test(q)],
    ['self-identification (EEO)', (q) => /disabilit|disabled|handicap|\bveteran|ancien\s+combattant|\bgender\b|\bgenre\b|\bsexe\b|ethnic|\brace\b|pregnan|enceinte|religio|sexual\s+orientation|lgbt|transgender/i.test(q)],
    ['student / internship status', (q) => /\bstudents?\b|[ée]tudiant|enrolled|inscrit\s+(dans|en|à)|stage\s+de\s+fin|fin\s+d.[ée]tudes|internship|stagiaire|alternan|apprenti/i.test(q)],
    ['needs / requirements', (q) => /\b(?:do|will|would)\s+you\s+(?:now\s+or\s+in\s+the\s+future\s+)?(?:require|need)\b|\bavez[- ]vous\s+besoin\b|n[ée]cessitez[- ]vous/i.test(q)],
    ['age', (q) => /under\s+(the\s+age\s+of\s+)?1[68]|moins\s+de\s+1[68]\s+ans|\bminor\b|\bmineur/i.test(q)],
    ['dismissal / legal history', (q) => /dismiss|\bterminated\b|\bfired\b|licenci|bankrupt|faillite|pending\s+charges|charges\s+pending|lawsuit|litig|\bdrugs?\b|sanctions?\b/i.test(q)],
    // 2.5.122 (Théo 2026-10-19): 'spoken language' removed — "Do you speak Arabic?" follows the Oui rule (Yes); level
    // questions for a language the CV does not list get the lowest level instead (_languageTarget).
    ['pay', (q) => /salary|salaire|\bctc\b|compensation|r[ée]mun[ée]ration|\blpa\b/i.test(q)],
  ];
  function yesNoNoAllowedReason(question) {
    const q = String(question || '').replace(/\s+/g, ' ').trim();
    if (!q) return 'empty question';
    for (const [why, test] of _NO_ALLOWED) { try { if (test(q)) return why; } catch (_) {} }
    return '';
  }

  // ─── 2.5.126 (Théo 2026-10-23): "Forcer oui si pas d'IA (sauf si on sait que non) et IA choisi le oui non" ───
  // No-AI path: Oui stays the default, EXCEPT when the CV shows the answer is No. knownNoFromProfile(q, config) returns
  // the reason when a FACT question (a named school / school type, a specific degree, a named past employer) is not in
  // the candidate's CV, '' otherwise (no data = unknown = Oui). Same lists as the server
  // (ai-generate/form-answer-truth.ts). Live gate 2026-10-23 (Powerdot): "classe préparatoire ?", "top grande école
  // d'ingénieur ?", "Did you attend CentraleSupélec, Polytechnique, Mines…?" → Yes for a DUT GEA + ICN profile.
  const _deacc = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');
  const _ENG_EV = /ingenieur|engineer|polytechni|centrale|supelec|\bmines\b|ponts|supaero|isae|ensta|ensae|telecom|insa\b|\butc\b|arts et metiers|\bens\b|ecole normale|epita|epitech|esiee|isep|efrei|esilv/;
  const _TOP_EV = /polytechni|centrale|supelec|\bmines\b|ponts|\bens\b|ecole normale|\bhec\b|essec|escp|edhec|em ?lyon|sciences ?po|insead|harvard|stanford|\bmit\b|oxford|cambridge|\blse\b|wharton|yale|princeton|berkeley|columbia|\biit\b|\biim\b/;
  const _SCHOOL_TERMS = [
    [/classes?\s+pr[ée]paratoires?|\bpr[ée]pas?\b|\bcpge\b|prep(aratory)?\s+class/i, /prepa|cpge|classes? preparatoires?|\b(mpsi|pcsi|ptsi|bcpst|ecg|hypokhagne|khagne)\b|preparatory class/],
    [/[ée]coles?\s+d.ing[ée]nieurs?|engineering\s+school|dipl[oô]me\s+d.ing[ée]nieur|titre\s+d.ing[ée]nieur/i, _ENG_EV],
    [/grandes?\s+[ée]coles?/i, new RegExp(_ENG_EV.source + '|' + _TOP_EV.source + '|grande ecole|skema|neoma|kedge|audencia|\\bicn\\b|business school|ecole (superieure )?de commerce')],
    [/ivy\s+league/i, /harvard|yale|princeton|columbia|brown university|cornell|dartmouth|upenn|university of pennsylvania|wharton/],
    [/russell\s+group/i, /oxford|cambridge|imperial college|\blse\b|london school of economics|\bucl\b|king.s college|edinburgh|manchester|bristol|warwick|durham|glasgow|leeds|nottingham|southampton|birmingham|exeter|york|newcastle|cardiff|queen mary/],
    [/\biit\b|indian institutes?\s+of\s+technology/i, /\biit\b|indian institute of technology/],
    [/\biim\b|indian institutes?\s+of\s+management/i, /\biim\b|indian institute of management/],
    [/top[- ](tier|ranked)\s+(universit|school|college|business school)|top\s+\d+\s+(universit|school|business school|college)|t[oô]p\s+[ée]cole/i, _TOP_EV],
  ];
  const _NAMED_SCHOOLS = [[/polytechnique/i, /polytechnique/], [/centrale|sup[ée]lec/i, /centrale|supelec/], [/\bmines\b/i, /\bmines\b/], [/\bponts\b/i, /ponts/],
    [/supa[ée]ro|\bisae\b/i, /supaero|isae/], [/\bhec\b/i, /\bhec\b/], [/\bessec\b/i, /essec/], [/\bescp\b/i, /escp/], [/\bedhec\b/i, /edhec/], [/sciences\s?po/i, /sciences ?po/],
    [/harvard/i, /harvard/], [/stanford/i, /stanford/], [/oxford/i, /oxford/], [/cambridge/i, /cambridge/], [/insead/i, /insead/], [/wharton/i, /wharton/]];
  const _SPECIFIC_DEGREES = [[/\bph\.?\s?d\b|\bdoctora(te|t)\b|\bdphil\b/i, /\bph\.? ?d\b|doctora|dphil/], [/\bmba\b/i, /\bmba\b|master of business administration/],
    [/\bcpa\b|\bacca\b|\bcfa\b|chartered accountant|expert[- ]comptable/i, /\bcpa\b|\bacca\b|\bcfa\b|chartered accountant|expert[- ]comptable/]];
  const _EDU_VERB = /\b(attend|attended|study|studied|graduate[sd]?|alumn|enrolled|admitted|degree|dipl[oô]m|int[ée]gr|fait|suivi|[ée]tudi|issu|sorti|went\s+to|school|[ée]cole|universit|college|titulaire)/i;
  const _EMPLOYER_Q = /\b(?:worked|been\s+employed|employed|interned)\s+(?:at|for|by)\s+((?:[A-Z][\w&.'’-]*)(?:\s+(?:[A-Z][\w&.'’-]*|&|de|of|and))*)|travaill[ée]e?s?\s+(?:chez|pour)\s+((?:[A-Z][\w&.'’-]*)(?:\s+(?:[A-Z][\w&.'’-]*|&|de|du|des))*)/;
  function knownNoFromProfile(question, config) {
    const q = String(question || '').replace(/\s+/g, ' ').trim().replace(/(pr[ée]paratoires?|pr[ée]pas?)\s+aux\s+grandes\s+[ée]coles/ig, '$1');
    if (!q) return '';
    const cv = (config && config.cvProfile) || {};
    const eduArr = Array.isArray(cv.education) ? cv.education : [];
    const edu = _deacc(eduArr.map(e => [e && e.degree, e && e.school, e && e.institution, e && e.field].filter(Boolean).join(' ')).join('\n'));
    const tests = [];
    for (const [rx, ev] of _SCHOOL_TERMS) if (rx.test(q)) tests.push(ev);
    if (_EDU_VERB.test(q)) for (const [rx, ev] of _NAMED_SCHOOLS) if (rx.test(q)) tests.push(ev);
    for (const [rx, ev] of _SPECIFIC_DEGREES) if (rx.test(q)) tests.push(ev);
    if (tests.length) {
      if (!edu.trim()) return ''; // no education data: unknown → Oui
      if (/ing[ée]nieur|engineering/i.test(q) && !_ENG_EV.test(edu)) return 'education fact: no engineering school in the CV';
      return tests.some(ev => ev.test(edu)) ? '' : 'education fact: not in the CV';
    }
    const m = q.match(_EMPLOYER_Q);
    if (m) {
      const org = _deacc(m[1] || m[2] || '').trim();
      const exp = _deacc((Array.isArray(cv.experience) ? cv.experience : []).map(e => (e && e.company) || '').join('\n') + '\n' + ((config && config.currentCompany) || ''));
      if (org && !/^(a|an|any|the|our|this|une?|des|notre|nos|cette)\b/.test(org) && exp.trim()) {
        const names = org.split(/\s*(?:,|\bor\b|\bou\b|\/)\s*/).filter(s => s.length >= 2);
        if (names.length && !names.some(n => exp.includes(n) || exp.includes(n.split(' ')[0]))) return 'named employer: not in the CV';
      }
    }
    return '';
  }
  // Yes / No option labels ("Yes", "Oui", "Sí", "Ja", "Sim", "Yes, I have…" / "No", "Non", "Nein", "Não").
  const YES_OPTION_RE = /^(yes|oui|s[ií]|ja|sim)\b/i;
  const NO_OPTION_STRICT_RE = /^(no|non|nein|n[ãa]o)\b/i;
  function isYesNoOptions(options) {
    const o = (options || []).map(x => String(x || '').trim()).filter(Boolean);
    return o.length >= 2 && o.length <= 4 && o.some(x => YES_OPTION_RE.test(x)) && o.some(x => NO_OPTION_STRICT_RE.test(x));
  }
  const NEGATIVE_OPTION_RE = /^(no|non|nein)\b|\b(i am not|i'm not|i have not|i haven't|have never|never|not (a|an|currently)|none)\b|^je (ne|n')/i;

  // ─── Checkboxes ───────────────────────────────────────────────────────
  // v2.5.109 (live 2026-10-12, Homa / Workable questions in the native <dialog>): the required "Personal data
  // consent" box has an EMPTY <label for> and its text in a sibling <p> → read as '' → never ticked → the job
  // looped to step_limit. Fallbacks: aria-label / aria-labelledby, then the smallest container holding only
  // this checkbox.
  function _checkboxText(cb, modal) {
    let t = '';
    try {
      const lab = cb.id ? modal.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null;
      t = String((lab && lab.textContent) || (cb.closest && cb.closest('label') && cb.closest('label').textContent) || cb.getAttribute('aria-label') || '').trim();
      if (!t) t = String(cb.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => ((document.getElementById(id) || {}).textContent || '')).join(' ').trim();
      for (let n = cb.parentElement, k = 0; !t && n && n !== modal && k < 4; n = n.parentElement, k++) {
        if (n.querySelectorAll('input[type="checkbox"]').length === 1) t = String(n.textContent || '').trim();
      }
      // A bare "Yes" / "I agree" box under a question (Shift Technology: "…has my consent to collect, store, and
      // process my data…" + one "Yes" checkbox) → the question carries the meaning.
      if (t.length < 25) {
        for (let n = cb.parentElement, k = 0; n && n !== modal && k < 8; n = n.parentElement, k++) {
          if (n.querySelectorAll('input[type="checkbox"]').length !== 1) break;
          const all = String(n.textContent || '').replace(/this field is required|ce champ est (obligatoire|requis)/ig, '').replace(/\s+/g, ' ').trim();
          if (all.length >= t.length + 15) { t = all; break; }
        }
      }
    } catch (_) {}
    return t.replace(/\s+/g, ' ').toLowerCase();
  }
  async function fillCheckboxes(modal, config) {
    // Pass 1: standalone consent/GDPR checkboxes — auto-check.
    const checkboxes = modal.querySelectorAll('input[type="checkbox"]');
    for (const checkbox of checkboxes) {
      if (checkbox.id === 'follow-company-checkbox') continue;
      if (checkbox.closest && checkbox.closest('[data-eam-exp]')) continue;
      const checkboxLabel = modal.querySelector(`label[for="${checkbox.id}"]`);
      const labelText = _checkboxText(checkbox, modal);
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
      // v2.5.112 (premium IN alerts "Yes: This field is required"): a REQUIRED question answered by one bare "Yes"
      // checkbox ("Are you comfortable working from our office 5 days a week?* [ ] Yes") → Théo's Oui rule; never a
      // self-declaration (opt-ins were handled above).
      const ownTxt = _checkboxOptionText(checkbox, modal);
      if (/^(yes|oui|s[ií]|ja)$/i.test(ownTxt) && !checkbox.checked && /\*/.test(labelText) && !isSelfDeclarationQuestion(labelText)
          && Array.from((checkbox.closest('fieldset, [role="group"]') || checkbox.parentElement || modal).querySelectorAll('input[type="checkbox"]')).length === 1) {
        checkboxLabel ? checkboxLabel.click() : checkbox.click();
        if (!checkbox.checked) checkbox.click();
        u().log(`Required "Yes" checkbox ticked: ${labelText.substring(0, 60)}`);
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

    // Pass 2 (v2.5.86, generalised v2.5.112): checkbox GROUPS with nothing ticked.
    // v2.5.112 (telemetry 2026-10-13, native <dialog> forms): required groups such as "What office setting are you
    // comfortable and willing to work in?* Onsite / Hybrid / Remote", "Are you currently located in the San Francisco
    // Bay Area or open to relocating?* I'm local… / I'm not local but open to relocating / …" and "Candidate Skills*"
    // were never touched (only "select all that apply" groups were) → "This field is required" → job skipped.
    // Decided in order: work mode (all modes = Théo's Oui rule), location / relocation statements (profile city +
    // relocation setting), then Premium AI (multi-choice) or, on Free, the options the CV names. Never a blind tick.
    if (!config) return;
    const groups = Array.from(modal.querySelectorAll('fieldset, [role="group"]')).filter(fs => fs.querySelectorAll('input[type="checkbox"]').length >= 2 && !fs.closest('[data-eam-exp]'));
    for (const fs of groups) {
      const cbs = Array.from(fs.querySelectorAll('input[type="checkbox"]')).filter(c => c.id !== 'follow-company-checkbox');
      if (cbs.length < 2 || cbs.some(c => c.checked)) continue;
      const optionLabels = cbs.map(c => _checkboxOptionText(c, fs));
      const question = _checkboxGroupQuestion(fs, modal, optionLabels);
      const groupText = (fs.textContent || '').toLowerCase();
      const selectAll = /\b(select all|check all|all that apply|choose all|pick all|which of the following.*apply)\b/i.test(question + ' ' + groupText);
      const required = /\*\s*$/.test(question) || fs.getAttribute('aria-required') === 'true' || cbs.some(c => c.required || c.getAttribute('aria-required') === 'true');
      if (!selectAll && !required) continue;
      if (optionLabels.filter(Boolean).length < 2) continue;
      if (isMarketingOptInLabel(question)) { u().log(`Checkbox group opt-in left unticked: ${question.slice(0, 40)}`); continue; }
      const picks = await checkboxGroupPicks(question, optionLabels, config);
      let clicked = 0;
      for (const i of picks) {
        const c = cbs[i]; if (!c || c.checked) continue;
        const lbl = c.id ? fs.querySelector(`label[for="${CSS.escape(c.id)}"]`) : null;
        (lbl || c).click();
        if (!c.checked) c.click();
        clicked++;
        await u().wait(150);
      }
      if (clicked) u().log(`Checkbox group "${question.slice(0, 50)}" → ${picks.map(i => optionLabels[i]).join(' | ').slice(0, 80)}`);
      else if (required) { u().log(`Checkbox group left unanswered (nothing safe to tick): ${question.slice(0, 50)}`); _noteUnknownField(question.replace(/\*\s*$/, '')); }
    }
  }
  // Option text of a checkbox in a group: its label, else the smallest container holding only this checkbox.
  function _checkboxOptionText(c, scope) {
    try {
      const l = c.id ? scope.querySelector(`label[for="${CSS.escape(c.id)}"]`) : null;
      let t = String((l && l.textContent) || (c.closest('label') && c.closest('label').textContent) || c.getAttribute('aria-label') || '').trim();
      for (let n = c.parentElement, k = 0; !t && n && n !== scope && k < 4; n = n.parentElement, k++) {
        if (n.querySelectorAll('input[type="checkbox"]').length === 1) t = String(n.textContent || '').trim();
      }
      if (!t && c.value && c.value !== 'on') t = c.value;
      return t.replace(/\s+/g, ' ').trim();
    } catch (_) { return ''; }
  }
  // The group's question: legend / aria-label(ledby) / the <p> right before the fieldset (native dialog).
  function _checkboxGroupQuestion(fs, modal, optionLabels) {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    let q = clean((fs.querySelector('legend') || {}).textContent) || clean(fs.getAttribute('aria-label'));
    if (!q) { const lb = fs.getAttribute('aria-labelledby'); if (lb) q = clean(lb.split(/\s+/).map(id => ((modal.querySelector('#' + CSS.escape(id)) || document.getElementById(id)) || {}).textContent || '').join(' ')); }
    for (let sib = fs.previousElementSibling, k = 0; !q && sib && k < 3; sib = sib.previousElementSibling, k++) { const t = clean(sib.textContent); if (t && t.length < 400) q = t; }
    if (!q && fs.parentElement) { const p = fs.parentElement.querySelector('p, label, h3, h4, span'); if (p && !fs.contains(p)) q = clean(p.textContent); }
    if (!q) { let t = clean(fs.textContent); for (const o of optionLabels) if (o) t = t.split(o).join(' '); q = clean(t); }
    return q;
  }
  // v2.5.119: availability slots ("Monday AM", "Tuesday Day Shift", "Wednesday (Open)", "Weekends", "Mornings", "Lundi matin").
  const _WEEKDAY_RE = /\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?s?\b|\bweek\s*(days?|ends?)\b|\blundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|\bweek-?end\b|\blunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo\b/i;
  const _UNAVAILABLE_OPT = /\b(not\s+available|unavailable|no\s+availability|none|non\s+disponible|indisponible)\b/i;
  const _AVAILABILITY_Q = /\b(availability|available\s+(to\s+work|shifts?|days?|hours?)|which\s+(days|shifts)|what\s+(days|shifts|hours)|shifts?\s+(are\s+you|can\s+you|available)|disponibilit[ée]s?|jours\s+disponibles|horaires?)\b/i;
  function isAvailabilitySlot(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 60) return false;
    return _WEEKDAY_RE.test(t) || (/^(mornings?|afternoons?|evenings?|nights?|overnights?|weekends?|weekdays?|days?|day\s*shift|night\s*shift|swing\s*shift|any\s*time|anytime|open\s+availability|flexible)$/i.test(t));
  }
  const _MODE_OPT = /^(fully\s+)?(on[- ]?site|onsite|in[- ]?office|office|hybrid|remote|work\s+from\s+home|wfh|t[ée]l[ée]travail|pr[ée]sentiel|hybride|distanciel)\b/i;
  // Indices of the options to tick for a checkbox group (see fillCheckboxes pass 2).
  async function checkboxGroupPicks(question, opts, config) {
    const q = String(question || '');
    const idx = (pred) => opts.map((o, i) => pred(String(o || '')) ? i : -1).filter(i => i >= 0);
    // 1. work mode willingness → every mode offered (Théo 2026-10-08: work-mode questions are "Oui").
    const modeOpts = idx(o => _MODE_OPT.test(o.trim()));
    if (modeOpts.length >= 2 && (modeOpts.length === opts.filter(Boolean).length || _WORK_MODE_Q.test(_deaccent(q)) || /office\s+setting|work(ing)?\s+(arrangement|setting|model|mode|environment|style)|work\s+location\s+(type|preference)/i.test(q))) {
      return modeOpts;
    }
    // 2. "I'm local to X" / "not local but open to relocating" / "not local and not open to relocating".
    const norm = (o) => _deaccent(o).toLowerCase().replace(/[’‘]/g, "'");
    if (opts.some(o => /\b(local|located|based|live)\b/i.test(o)) && opts.some(o => /relocat/i.test(o))) {
      const NEG = /\bnot\b|n't|\bno\b|unwilling|unable/;
      const local = idx(o => /\b(local|located|based|live)\b/.test(norm(o)) && !NEG.test(norm(o)));
      const isLocal = local.some(i => workLocationAnswer(opts[i], config) === 'yes') || workLocationAnswer(q, config) === 'yes';
      if (isLocal && local.length) return [local[0]];
      const rel = String((config && config.willingToRelocate) || 'yes').toLowerCase() !== 'no';
      const openRel = idx(o => /relocat/.test(norm(o)) && !/not\s+(open|willing)|unwilling|\bno\b|n't/.test(norm(o).replace(/^.*?\bbut\b/, '')));
      const closed = idx(o => /not\s+(open|willing)|unwilling/.test(norm(o)));
      if (rel && openRel.length) return [openRel[0]];
      if (!rel && closed.length) return [closed[0]];
      return [];
    }
    // 1b. v2.5.119 (telemetry 2026-10-17, restaurant / retail forms): availability grids — "What is your availability?*"
    //     with "Monday AM / Monday PM / …", "Monday Day Shift / Monday Night Shift", "Monday (Open)" → every slot
    //     (Théo's Oui rule: available). Never an "unavailable / not available" option.
    const _isSlot = (o) => isAvailabilitySlot(o);
    const slotOpts = idx(o => _isSlot(o) && !_UNAVAILABLE_OPT.test(o));
    if (slotOpts.length >= 2 && (slotOpts.length >= Math.ceil(opts.filter(Boolean).length * 0.6) || _AVAILABILITY_Q.test(q))) return slotOpts;
    // 2b. highest education level (Advancio "High School (A2) / Bachelors (B1) / Masters (C2) / PHD (C1)") → the
    //     option at the highest CV degree level (never above it).
    if (_EDU_Q.test(q) || /highest\s+(level\s+of\s+)?(education|degree)|education\s+level/i.test(q)) {
      const be = _bestEducation(config);
      const beR = be ? (eduRank([be.degree, be.field].join(' ')) || (/universit|college|institut|polytechn|[ée]cole|school\s+of|business\s+school/i.test(String(be.school || '')) ? 3 : 0)) : 0;
      const target = Math.max(cvEduRank(config) || 0, beR) || null;
      if (target != null) {
        let bi = -1, br = -1;
        opts.forEach((o, i) => { const rr = eduRank(String(o).replace(/\([A-C][12]\)/g, '')); if (rr != null && rr <= target && rr > br) { br = rr; bi = i; } });
        if (bi >= 0) return [bi];
      }
      return [];
    }
    // 3. Premium: AI multi-choice; Free (AI blocked / empty): the options the CV itself names.
    try {
      if (window.EAM && window.EAM.aiForm && window.EAM.aiForm.askAI) {
        const aq = /select all|all that apply/i.test(q) ? q : q.replace(/\*\s*$/, '') + ' (select all that apply)';
        const raw = String(await window.EAM.aiForm.askAI(aq, config, 'checkbox', opts.filter(Boolean)) || '').trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
        let arr = null; try { arr = JSON.parse(raw); } catch (_) { arr = null; }
        if (Array.isArray(arr) && arr.length) {
          const P = arr.map(x => String(x || '').trim().toLowerCase()).filter(Boolean);
          const hit = idx(o => { const t = o.trim().toLowerCase(); return t && (P.includes(t) || P.some(p => p.length >= 3 && (t.includes(p) || p.includes(t)))); });
          if (hit.length) return hit;
        }
      }
    } catch (_) {}
    const cv = (config && config.cvProfile) || {};
    const cvText = [].concat(cv.skills || [], cv.summary || '', ...(cv.experience || []).map(e => [e.title, e.role, e.position].filter(Boolean).join(' ')))
      .map(s => typeof s === 'string' ? s : ((s && s.name) || '')).join(' | ');
    if (!cvText.trim()) return [];
    return idx(o => !_isOtherOption(o) && _sigTokens(o).length > 0 && _mentions(cvText, o));
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
    // v2.5.110: settings store "male"; a capitalised / spaced value ("Male", "Non binary") used to match nothing.
    const pattern = GENDER_LABEL_PATTERNS[canonical] || GENDER_LABEL_PATTERNS[String(canonical || '').trim().toLowerCase().replace(/[\s-]+/g, '_')];
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

  // v2.5.108: no trailing \b — LinkedIn renders "Gender" + a "Required" span as "GenderRequired", which
  // missed the gender path and the generic radio default ticked the FIRST option ("Male").
  const _GENDER_Q_RE = /\b(gender|genre\b|sexe?\b|g[ée]nero|geschlecht|genere\b)/i;
  // v2.5.114 (live gate 2026-10-15, TeamWork Corporate via SmartRecruiters): "Vous êtes / You are ?*" with options
  // "Femme / Female · Homme / Male · Non-binaire · Ne se prononce pas" — no gender word in the question → the select
  // fell through to the blind first option and declared Théo "Female". A choice whose options are a female AND a male
  // answer IS a gender question, whatever its wording.
  function _isGenderChoice(question, optionTexts) {
    if (_GENDER_Q_RE.test(String(question || ''))) return true;
    const opts = (optionTexts || []).map(t => String(t || '').trim()).filter(Boolean);
    if (opts.length < 2 || opts.length > 8) return false;
    return opts.some(t => GENDER_LABEL_PATTERNS.female.test(t)) && opts.some(t => GENDER_LABEL_PATTERNS.male.test(t) && !GENDER_LABEL_PATTERNS.female.test(t));
  }
  const _GENDER_DECLINE_RE =/(not\s+declared|not\s+disclosed|not\s+specified|unspecified|prefer\s+not|don.?t\s+wish|do\s+not\s+wish|decline|not\s+to\s+(say|disclose|answer|self[- ]identify)|rather\s+not|ne\s+(souhaite|pr[ée]f[èe]re|veux)\s+pas|pr[ée]f[èe]re\s+ne\s+pas|non\s+communiqu|ne\s+se\s+prononce\s+pas|no\s+(deseo|quiero)|prefiero\s+no|keine\s+angabe|möchte\s+.{0,20}nicht)/i;
  function fillGenderRadio(fieldset, radioInputs, canonicalGender) {
    // Empty canonical means user picked "Prefer not to say" or didn't set it.
    // v2.5.108 (premium user 2026-10-12: 15 jobs lost, required "Gender" left blank → step loop):
    // pick the explicit "I don't wish to answer" option when the form offers one — that IS the
    // user's answer, never a guessed gender. No such option → leave blank as before.
    if (!canonicalGender) {
      for (const radio of radioInputs) {
        const label = _radioLabel(fieldset, radio);
        const text = label ? label.textContent.trim() : (radio.value || '');
        if (_GENDER_DECLINE_RE.test(text)) {
          if (!radio.checked) { label ? label.click() : radio.click(); }
          u().log(`Gender: no gender set → "${text.substring(0, 40)}"`);
          return true;
        }
      }
      u().log('Gender question: user has no gender set and no "prefer not to say" option — leaving blank');
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
    if (/(professional|professionnel|advanced|avanc[eé]|avanzado)/.test(s))                   return 4;
    // v2.5.106: "conversational" is below professional / fluent (a Fluent user got "Conversational", live 2026-10-10).
    if (/(intermediate|interm[eé]diaire|intermedio|b1|conversational|conversationnel)/.test(s)) return 3;
    if (/(a2|elementary|[eé]l[eé]mentaire|elemental|basic|basique|b[aá]sico|d[eé]butant|beginner|principiante)/.test(s)) return 2;
    if (/(a1|notions)/.test(s))                                                               return 1;
    return 0;
  }
  function _optionLevelRank(text) {
    const s = String(text || '').toLowerCase();
    if (/(c2|native|natif|nativa?|nativo|maternell|proficient user)/.test(s))                 return 6;
    if (/(c1|bilingu|maitrise|maîtrise|expert)/.test(s))                                      return 5;
    if (/(b2|fluent|courant|fluid|upper[-\s]?intermediate|professional working|full professional)/.test(s)) return 4;
    if (/(professional|professionnel|professionnelle|advanced|avanc[eé]|avanzado|op[ée]rationnel)/.test(s)) return 4;
    if (/(b1|intermediate|interm[eé]diaire|intermedio|conversational|conversationnel)/.test(s)) return 3;
    if (/(a2|elementary|[eé]l[eé]mentaire|basic|basique|b[aá]sico|limited working|scolaire)/.test(s)) return 2;
    if (/(a1|beginner|d[eé]butant|principiante|notions|none|no knowledge|aucun|introduct|initiation|novice)/.test(s))    return 1;
    return 0;
  }
  // v2.5.97: language-level <select> / listbox — same ranking as the radios. Live
  // 2026-10-03 (julhiet sterwen, SmartRecruiters, submitted): "Quel est votre niveau
  // d'anglais ?" options Introductif/… matched none of the native/fluent/professional
  // words and fell through to the blind options[1] = "Introductif" for a Fluent user.
  // Returns the option to pick, or null (leave unanswered — never blind).
  // 2.5.122 (Théo 2026-10-19): a level question for a language the CV does NOT list ("What is your proficiency
  // level in Arabic?", CV = French / English) got "Professional" — an invented claim. Now: the LOWEST non-zero level
  // the form offers (A1 / Beginner / Elementary / Basic…, never "None", never above Intermediate); if the form has
  // none, the question stays unanswered (required → the job goes to "To complete"). The yes/no form ("Do you speak
  // Arabic?") follows the Oui rule instead (Yes) — 'spoken language' is no longer a No-allowed reason.
  // When the CV lists no language at all, English and the main language of the user's country keep the old
  // default (Professional) — an empty languages section does not mean the user speaks neither.
  const _ZERO_LEVEL_RE = /^\s*(none|no(ne)?\s+knowledge|no\s+proficiency|not\s+applicable|n\/a|aucun(e)?|aucune\s+connaissance|pas\s+de\s+connaissance|ninguno|ninguna|nenhum(a)?|keine|nessuna|0)\s*$|\b(no knowledge|aucune connaissance|sin conocimiento|nenhum conhecimento|keine kenntnisse)\b/i;
  const _COUNTRY_LANG = { fr: 'french', france: 'french', be: 'french', belgium: 'french', belgique: 'french', lu: 'french', luxembourg: 'french', mc: 'french', monaco: 'french', ch: 'french', switzerland: 'french', suisse: 'french',
    es: 'spanish', spain: 'spanish', espana: 'spanish', mx: 'spanish', mexico: 'spanish', ar: 'spanish', argentina: 'spanish', co: 'spanish', colombia: 'spanish', cl: 'spanish', chile: 'spanish', pe: 'spanish', peru: 'spanish',
    de: 'german', germany: 'german', deutschland: 'german', at: 'german', austria: 'german', it: 'italian', italy: 'italian', italia: 'italian', pt: 'portuguese', portugal: 'portuguese', br: 'portuguese', brazil: 'portuguese', brasil: 'portuguese',
    nl: 'dutch', netherlands: 'dutch', in: 'hindi', india: 'hindi', cn: 'chinese', china: 'chinese', jp: 'japanese', japan: 'japanese', ru: 'russian', russia: 'russian', sa: 'arabic', 'saudi arabia': 'arabic', ae: 'arabic', 'united arab emirates': 'arabic', eg: 'arabic', egypt: 'arabic', ma: 'french', morocco: 'french', tn: 'french', tunisia: 'french', dz: 'french', algeria: 'french' };
  // → { lang, raw, listed, mode: 'listed' | 'lowest' | 'default', targetRank }
  function _languageTarget(questionText, userLanguages, country) {
    const lang = _detectLanguageInQuestion(String(questionText || '').toLowerCase());
    const list = Array.isArray(userLanguages) ? userLanguages.filter(L => (typeof L === 'string' ? L : (L && L.name) || '').trim()) : [];
    let raw = '', listed = false;
    if (lang) for (const L of list) {
      const nm = (typeof L === 'string' ? L : (L && L.name) || '').toLowerCase();
      if (nm && lang.aliases.some(a => nm.includes(a))) { listed = true; raw = typeof L === 'string' ? L : (L && L.level) || ''; break; }
    }
    if (listed) { const r = _userLevelRank(raw); return { lang, raw, listed, mode: 'listed', targetRank: r || 4 }; }
    if (!lang) return { lang, raw, listed, mode: 'default', targetRank: 4 }; // language not named in the question: unchanged
    if (!list.length) {
      const c = String(country || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
      if (lang.canonical === 'english' || (_COUNTRY_LANG[c] && _COUNTRY_LANG[c] === lang.canonical)) return { lang, raw, listed, mode: 'default', targetRank: 4 };
    }
    return { lang, raw, listed, mode: 'lowest', targetRank: 1 };
  }
  // Lowest non-zero level among the options (rank 1..3, "None" excluded) — null when the form offers none.
  function _lowestLevelOption(options, getText) {
    let best = null, bestRank = Infinity;
    for (const o of options) {
      const t = String(getText(o) || '').trim();
      if (!t || _ZERO_LEVEL_RE.test(t)) continue;
      const rank = _optionLevelRank(t);
      if (rank < 1 || rank > 3) continue;
      if (rank < bestRank) { bestRank = rank; best = o; }
    }
    return best;
  }
  function pickLanguageLevelOption(options, getText, questionText, userLanguages, country) {
    const tg = _languageTarget(questionText, userLanguages, country);
    const lang = tg.lang; const userLevelRaw = tg.raw; const targetRank = tg.targetRank;
    let best = null, bestScore = Infinity;
    if (tg.mode === 'lowest') best = _lowestLevelOption(options, getText);
    else for (const o of options) {
      const rank = _optionLevelRank(getText(o));
      if (rank === 0) continue;
      const score = Math.abs(rank - targetRank) + (rank >= targetRank ? -0.1 : 0.1);
      if (score < bestScore) { bestScore = score; best = o; }
    }
    u().log(`Lang select ${lang ? lang.canonical : '?'} (${tg.mode === 'lowest' ? 'not in the CV → lowest level' : 'user="' + userLevelRaw + '" rank=' + targetRank}) → ${best ? '"' + String(getText(best)).trim().slice(0, 30) + '"' : 'left unanswered (no ranked option)'}`);
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
  // v2.5.112 (telemetry 2026-10-13, "Only W2*"): a radio without a value attribute has value "on" — stripping the
  // option texts also cut "on" out of "Only" → "ly w2" → "question unreadable" → the job was skipped.
  function _radioVal(r) { const v = String((r && r.value) || ''); return v === 'on' && !(r.hasAttribute && r.hasAttribute('value')) ? '' : v; }
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
  function fillLanguageLevelRadio(fieldset, radioInputs, questionText, userLanguages, country) {
    // Language entry can be a string ("Français — natif") or {name, level}. 2.5.122: a language the CV does not list
    // → the lowest non-zero level (see _languageTarget); none offered → left unanswered on purpose (returns true).
    const tg = _languageTarget(questionText, userLanguages, country);
    const lang = tg.lang; const userLevelRaw = tg.raw; const targetRank = tg.targetRank;
    if (tg.mode === 'lowest') {
      // An answer LinkedIn already shows (the user's own saved answer) is kept.
      if (Array.from(radioInputs).some(r => r.checked)) { u().log(`Lang ${lang.canonical} not in the CV — pre-filled answer kept`); return true; }
      const low =_lowestLevelOption(Array.from(radioInputs), (r) => { const l = _radioLabel(fieldset, r); return (l ? l.textContent : (r.value || '')).trim(); });
      if (!low) { u().log(`Lang ${lang.canonical} not in the CV and no beginner-level option → left unanswered (never claims a level)`); return true; }
      if (!low.checked) { const l = _radioLabel(fieldset, low); l ? l.click() : low.click(); }
      u().log(`Lang ${lang.canonical} not in the CV → lowest level "${String((_radioLabel(fieldset, low) || {}).textContent || low.value || '').trim().slice(0, 30)}"`);
      return true;
    }
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
    // v2.5.114 (live gate 2026-10-15, Tech Riders via JOIN): "Êtes-vous d'accord avec les CGU et la Politique de
    // confidentialité de JOIN ? *" = a radiogroup with ONE option "Oui" (empty <label for>, text in a sibling <p>).
    // Groups need ≥ 2 radios, so it was never ticked → "This field is required" → job skipped. A single affirmative
    // option under a terms / privacy / data-processing question is the required consent: ticked (never an opt-in).
    try {
      const singles = new Map();
      for (const r of modal.querySelectorAll('input[type="radio"]')) { const k = r.name || r.id || Math.random(); singles.set(k, (singles.get(k) || []).concat(r)); }
      for (const rs of singles.values()) {
        if (rs.length !== 1 || rs[0].checked) continue;
        const r = rs[0];
        const box = (r.closest && r.closest('fieldset, [role="radiogroup"]')) || r.parentElement;
        if (box && box.querySelectorAll('input[type="radio"]').length !== 1) continue;
        const lab = _radioLabel(box || modal, r);
        const opt = String((lab && lab.textContent) || '').replace(/\s+/g, ' ').trim();
        const ctx = String(((box && box.parentElement) || box || modal).textContent || '').replace(/\s+/g, ' ').trim();
        if (!/^(oui|yes|j.accepte|je suis d.accord|i agree|i accept|agree|accept|d.accord|s[ií]|ja)\b/i.test(opt)) continue;
        if (!/\b(cgu|cgv|conditions|terms|privacy|confidentialit|consent|donn[ée]es\s+personnelles|data\s+(protection|processing|privacy)|gdpr|rgpd|politique)\b/i.test(ctx)) continue;
        if (isMarketingOptInLabel(ctx)) continue;
        (lab && lab.click ? lab : r).click();
        if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
        u().log(`Consent radio (single option "${opt.slice(0, 20)}") ticked: ${ctx.slice(0, 60)}`);
      }
    } catch (_) {}
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
        const optTxt = Array.from(radioInputs).map(r => { const l = _radioLabel(fieldset, r); return ((l ? l.textContent : _radioVal(r)) || '').trim(); }).filter(Boolean);
        const strip = (s) => { let t = String(s || ''); for (const o of optTxt) t = t.split(o).join(' '); return t.replace(/\s+/g, ' ').trim(); };
        // v2.5.100: the same native dialog carries the question in each radio's aria-label
        // ("Avez-vous déjà travaillé sur des projets monétique … ?") — the group text was
        // only "Yes No" → blind first option "Yes" (Talink, live 2026-10-04, discarded).
        const ariaQ = ((radioInputs[0] && radioInputs[0].getAttribute('aria-label')) || '').trim();
        if (!questionLabel && strip(ariaQ).replace(/[^a-zà-ÿ0-9]/gi, '').length >= 4 && Array.from(radioInputs).every(r => (r.getAttribute('aria-label') || '').trim() === ariaQ)) {
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
      if (_isGenderChoice(questionText, Array.from(radioInputs).map(r => { const l = _radioLabel(fieldset, r); return (l ? l.textContent : r.value) || ''; }))) {
        if (fillGenderRadio(fieldset, radioInputs, config.gender)) {
          // v2.5.112: a required gender question left blank (no gender in the settings, no "prefer not to say") → popup hint.
          if (!Array.from(radioInputs).some(x => x.checked) && /\*/.test(questionText)) _noteMissingSetting('gender');
          continue;
        }
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
        if (fillLanguageLevelRadio(fieldset, radioInputs, questionText, config.languages || (config.cvProfile && config.cvProfile.languages) || [], config.country)) continue;
      }

      // v2.5.104: "How did you hear about us?" radios → LinkedIn (also over a saved answer).
      if (_SOURCE_Q.test(questionText)) {
        const rs = Array.from(radioInputs);
        const labs = rs.map(r => { const l = _radioLabel(fieldset, r); return ((l ? l.textContent : r.value) || '').trim(); });
        const pick = pickSourceOption(labs);
        if (pick >= 0) {
          if (!rs[pick].checked) { const l = _radioLabel(fieldset, rs[pick]); (l || rs[pick]).click(); if (!rs[pick].checked) { rs[pick].checked = true; rs[pick].dispatchEvent(new Event('change', { bubbles: true })); } u().log(`Source question → "${labs[pick]}"`); }
          continue;
        }
      }
      // v2.5.92: never overwrite a group that already has an answer (LinkedIn's saved
      // answer, the AI pick, or our previous pass on a re-run of the same step).
      // v2.5.104 exception: a yes/no FACT from the user's settings beats a stale LinkedIn saved
      // answer. Live 2026-10-08 DIMATIS: "Pouvez-vous commencer immédiatement ?" pre-filled "Oui"
      // with a 1-month notice period (discarded at review) — the 2.5.97 rule never ran.
      if (Array.from(radioInputs).some(r => r.checked)) {
        try {
          let fact = null;
          if (/commencer\s+imm[ée]diatement|disponible\s+imm[ée]diatement|start\s+immediately|available\s+immediately|immediate(ly)?\s+(start|available|availability)|join\s+immediately/i.test(questionText)) {
            const np = String(config.noticePeriod || '').toLowerCase().trim();
            fact = (!np || /^0\b|^(none|aucun|imm[ée]diat|immediate)/.test(np)) ? 'yes' : 'no';
          } else if (/visa|sponsor/i.test(questionText) && config.visaSponsorship) fact = config.visaSponsorship;
          else if (/legal.*work|authori[sz]ed\s+to\s+work|right\s+to\s+work|autoris[ée]\(?e?\)?\s+[àa]\s+travailler|permis de travail|droit de travailler/i.test(questionText) && config.legallyAuthorized) fact = config.legallyAuthorized;
          else if (/relocat|d[ée]m[ée]nag/i.test(questionText) && config.willingToRelocate) fact = config.willingToRelocate;
          else if (/driv(er|ing).{0,3}licen[cs]e|permis (de conduire|b)\b/i.test(questionText) && config.driversLicense) fact = config.driversLicense;
          // 2.5.126 (Théo 2026-10-23): a school / degree / employer the CV does not show → a saved "Oui" becomes "Non".
          else if (knownNoFromProfile(((questionLabel ? questionLabel.textContent : '') || questionRaw || questionText), config)) fact = 'known-no';
          else if (educationQuestionAnswer(questionText, config)) fact = educationQuestionAnswer(questionText, config);
          // v2.5.116 (Oui rule): a saved "Non" (an older AI answer LinkedIn remembers) on a capability / experience
          // question is corrected to "Oui" — never for a question where No is legitimate.
          else if (String((questionLabel ? questionLabel.textContent : '') || questionRaw || '').replace(/\b(oui|non|yes|no|si|sí|ja|nein)\b/gi, '').replace(/[^a-zà-ÿ]+/gi, '').length >= 8
                   && !yesNoNoAllowedReason(((questionLabel ? questionLabel.textContent : '') || questionRaw))) fact = 'yes';
          fact = String(fact || '').toLowerCase();
          // Théo 2026-10-08: yes/no default is "Oui" — a pre-filled answer is only ever corrected
          // TOWARDS "Oui" (e.g. a stale "Non" to "autorisé à travailler" / "niveau d'études requis").
          if (fact === 'yes' || fact === 'known-no') {
            const want = fact === 'yes' ? /^(yes|oui|sí|si|ja|y)$/ : /^(no|non|nein|n)$/;
            const checked = Array.from(radioInputs).find(r => r.checked);
            const lab = (r) => { const l = _radioLabel(fieldset, r); return ((l ? l.textContent : r.value) || '').trim().toLowerCase(); };
            if (checked && !want.test(lab(checked))) {
              const target = Array.from(radioInputs).find(r => want.test(lab(r)));
              if (target) {
                u().log(`Corrected pre-filled answer "${lab(checked)}" → "${lab(target)}" from your settings (${questionText.substring(0, 60)})`);
                const l = _radioLabel(fieldset, target);
                (l || target).click();
                if (!target.checked) { target.checked = true; target.dispatchEvent(new Event('change', { bubbles: true })); }
              }
            }
          }
        } catch (_) {}
        continue;
      }

      // v2.5.100: question text that is only the options ("ouinon", "yesno") → never the Yes
      // default or the first option: left unanswered, the application is skipped.
      {
        let rest0 = ' ' + String(questionText || '').toLowerCase() + ' ';
        for (const r of radioInputs) { const l = _radioLabel(fieldset, r); for (const t of [l && l.textContent, _radioVal(r)]) { const s = String(t || '').trim().toLowerCase(); if (s) rest0 = rest0.split(s).join(' '); } }
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
      } else if (_ADJUSTMENTS_Q.test(questionText)) {
        // v2.5.112: "Do you require any reasonable adjustments / accommodations…?" — the user declared no need.
        desiredAnswer = 'no';
      } else if (knownNoFromProfile(((questionLabel ? questionLabel.textContent : '') || questionRaw || questionText), config)) {
        // 2.5.126 (Théo 2026-10-23): "Forcer oui … sauf si on sait que non" — a school / school type / degree / employer
        // the CV does not show (Powerdot: prépa, grande école d'ingénieur, Centrale/Polytechnique → were "Yes").
        desiredAnswer = 'no';
        u().log(`Radio no (${knownNoFromProfile(((questionLabel ? questionLabel.textContent : '') || questionRaw || questionText), config)}): ${questionText.substring(0, 50)}`);
      } else if (questionText.match(/visa|sponsor|sponsorship/i) && config.visaSponsorship) {
        desiredAnswer = config.visaSponsorship;
      } else if (questionText.match(/author|legal.*work|permit.*work|eligib.*work|right.*work|autoris[ée]\(?e?\)?\s+[àa]\s+travailler|permis de travail|droit de travailler/i) && config.legallyAuthorized) {
        desiredAnswer = config.legallyAuthorized;
      } else if (questionText.match(/relocat|move.*locat|willing.*move/i) && config.willingToRelocate) {
        desiredAnswer = config.willingToRelocate;
      } else if (_WORK_MODE_Q.test(_deaccent(questionText))) {
        // v2.5.106 (live 2026-10-10): "Accepteriez-vous de travailler à distance ?" → Non ("distance" read as a
        // place, relocate = no) and "… sur site ?" → Non (premium AI). A work-MODE willingness question
        // (remote / on site / hybrid / telework) is Théo's default Oui — never a relocation question.
        desiredAnswer = 'yes';
      } else if (workLocationAnswer(questionText, config)) {
        // v2.5.98: "This job is on site, are you willing to work in Saudi Arabia?" got the Yes
        // default for a Paris candidate with relocate = no (live 2026-10-04, discarded at review).
        desiredAnswer = workLocationAnswer(questionText, config);
      } else if (minYearsQuestionAnswer(questionText, config)) {
        // v2.5.98: "Justifiez-vous d'au moins 3 ans d'expérience dans l'utilisation de l'outil
        // mentionné dans l'annonce ?" got the Yes default (MERITIS, live 2026-10-04, discarded).
        // v2.5.109 (live 2026-10-12 MERITIS, discarded): this still answered "Non". Théo's 2026-10-08 rule wins —
        // a years / degree screening question is never turned into "Non" from the CV: always Oui.
        desiredAnswer = 'yes';
      } else if (educationQuestionAnswer(questionText, config)) {
        desiredAnswer = 'yes';
      } else if (questionText.match(/security.*clearance|clearance/i)) {
        desiredAnswer = 'no';
      } else if (questionText.match(/commencer\s+imm[ée]diatement|disponible\s+imm[ée]diatement|start\s+immediately|available\s+immediately|immediate(ly)?\s+(start|available|availability)|join\s+immediately|empezar\s+inmediatamente|sofort\s+(beginnen|verf[üu]gbar)/i)) {
        // v2.5.97: "Pouvez-vous commencer immédiatement ?" follows the notice period (live
        // 2026-10-03 DIMATIS: blind "Oui" with a 1-month notice). Notice 0 / immediate → yes.
        const np = String(config.noticePeriod || '').toLowerCase().trim();
        desiredAnswer = (!np || /^0\b|^(none|aucun|imm[ée]diat|immediate)/.test(np)) ? 'yes' : 'no';
      } else if (questionText.match(/driver.*license|driving.*license|valid.*license/i) && config.driversLicense) {
        desiredAnswer = config.driversLicense;
      } else if (questionText.match(/commut|(?:vous\s+)?d[ée]placer\s+(?:vers|jusqu|sur)\s|trajet|reliably\s+(?:travel|get)\s+to/i)) {
        // v2.5.105 (live 2026-10-09, Econocom Moissy-Cramayel): "Êtes-vous prêt(e) à vous déplacer vers ce
        // lieu de travail ?" went to the premium AI → "Non". No named place (a named one is handled by
        // workLocationAnswer above) and the job already passed the location filter → Théo's default Oui.
        desiredAnswer = 'yes';
      } else {
        // Théo 2026-10-08 rule: yes/no defaults to "Oui" unless a SPECIFIC answer exists (settings
        // above: visa, work authorisation, relocation / location, notice period, licence, years,
        // degree, opt-in, self-declaration, clearance). On PREMIUM the AI decides these generic
        // questions from the CV (e.g. "experience in the Airline industry?"); FREE keeps "Oui".
        // (The 2.5.98 CV-based "No" for experience questions is replaced by this.)
        try {
          // v2.5.105: never hang on the plan read (promise-style get without callback / dead context) —
          // treat as FREE after 3 s (Oui default, no AI call).
          const free = await new Promise(res => {
            const done = r => res(!!r && r.plan === 'free' && !r.isPremium);
            const tm = setTimeout(() => res(true), 3000);
            try { const p = chrome.storage.local.get(['plan', 'isPremium'], r => { clearTimeout(tm); done(r); }); if (p && typeof p.then === 'function') p.then(r => { clearTimeout(tm); done(r); }, () => { clearTimeout(tm); res(true); }); } catch (_) { clearTimeout(tm); res(true); }
          });
          if (!free && window.EAM && window.EAM.aiForm && window.EAM.aiForm.askAI) {
            const labs = Array.from(radioInputs).map(r => { const l = _radioLabel(fieldset, r); return ((l ? l.textContent : r.value) || '').trim(); }).filter(Boolean);
            const cleanQ = ((questionLabel ? questionLabel.textContent : '') || questionRaw || '').trim() || questionText;
            const pick = String(await window.EAM.aiForm.askAI(cleanQ, config, 'radio', labs) || '').trim().toLowerCase();
            // 2.5.126 (Théo 2026-10-23, "IA choisi le oui non"): the AI's Yes / No stands — the 2.5.116 overrule of an
            // AI "No" is gone. No usable pick ("skip", error) → the Oui default.
            if (NO_OPTION_STRICT_RE.test(pick) || pick === 'n') desiredAnswer = 'no';
            else if (YES_OPTION_RE.test(pick) || pick === 'y') desiredAnswer = 'yes';
            u().log(`Radio AI (premium): "${cleanQ.substring(0, 50)}" → ${pick || '(none)'} → ${desiredAnswer}`);
          }
        } catch (_) {}
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
          for (const r of radioInputs) { const l = _radioLabel(fieldset, r); for (const t of [l && l.textContent, _radioVal(r)]) { const s = String(t || '').trim().toLowerCase(); if (s) rest = rest.split(s).join(' '); } }
          rest = rest.replace(/\b(oui|non|yes|no|si|sí|ja|nein)\b/g, ' ').replace(/[^a-zà-ÿ]+/gi, '');
          // v2.5.100: glued option words ("yesno", "ouinon") are not a question either.
          qReadable = rest.replace(/(oui|non|yes|no|sí|si|ja|nein)/g, '').length >= 4;
        } catch (_) {}
        if (!clicked && isCurrentPayQuestion(questionRaw || questionText)) {
          u().log(`Current pay radios left unanswered (not in your profile): ${questionText.substring(0, 40)}`);
        } else if (!clicked && !qReadable && !radioInputs[0].checked) {
          u().log(`Radio left unanswered (question text unreadable: "${questionText.substring(0, 30)}")`);
          u()._unknownFieldFails = (u()._unknownFieldFails || 0) + 3; // cannot decide safely → skip this application
        } else if (!clicked && !Array.from(radioInputs).some(r => r.checked) && !isOptIn) {
          // v2.5.109: the blind fallback never picks "Other" (it opens an "Others (please specify)" field).
          const _txt = (r) => { const l = _radioLabel(fieldset, r); return ((l ? l.textContent : r.value) || '').trim(); };
          const first = Array.from(radioInputs).find(r => !_isOtherOption(_txt(r))) || radioInputs[0];
          const firstLabel = _radioLabel(fieldset, first);
          firstLabel ? firstLabel.click() : first.click();
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
  // v2.5.104: "How did you hear about us?" / "Comment avez-vous connu …?" → LinkedIn (the bot only
  // applies from LinkedIn), else a job board / internet / other option. Never a referral, event,
  // school or employee recommendation the user never had.
  // v2.5.112: "From where did you first learn about …" (Third Bridge) got the blind first option ("Handshake").
  const _SOURCE_Q = /how\s+did\s+you\s+(first\s+)?(hear|find|learn|come\s+across)|where\s+did\s+you\s+(first\s+)?(hear|find|see|learn)|from\s+where\s+did\s+you|how\s+were\s+you\s+referred|comment\s+avez[- ]vous\s+(connu|entendu|trouv[ée]|d[ée]couvert|eu\s+connaissance)|o[uù]\s+avez[- ]vous\s+(vu|trouv[ée]|entendu)|source\s+(de\s+(la\s+)?candidature|of\s+(application|candidature))|c[oó]mo\s+(te\s+)?(conociste|enteraste)|wie\s+haben\s+sie\s+von/i;
  // ─── v2.5.109 helpers (ops alert 2026-10-12, premium IN users) ─────────
  const _PREVIOUSLY_FOLLOWUP_Q = /^\s*if\s+you\s+(have\s+)?(previously|ever|formerly|already|have\s+ever|were\s+(previously|ever|formerly))\b/i;
  const _OTHER_SPECIFY_Q = /^\s*(if\s+)?(others?|other\s+option|autres?|otros?|otras?|andere|altro|altri)\b[^?]{0,30}\b(specify|sp[ée]cifi|pr[ée]cis|especifi|angeben|specifica|mention|describe|details?)|^\s*if\s+other\b|^\s*si\s+autre\b|^\s*(please\s+)?specify\s+(if\s+)?other\b|^\s*if\s+you\s+(selected|chose|picked|answered|ticked)\s+['"‘’“”]?other\b/i;
  // v2.5.112: "If 'YES', when?" (quoted) missed the 2.5.108 follow-up rule.
  const _IF_YES_FOLLOWUP_Q = /^\s*(if\s+['"‘’“”]?(yes|so)\b|if\s+applicable|si\s+['"‘’“”]?oui\b|si\s+c.est\s+le\s+cas|le\s+cas\s+[ée]ch[ée]ant|en\s+caso\s+afirmativo|falls\s+ja)/i;
  // v2.5.112: right-to-work / visa detail follow-ups ("If your right to work in the UK is time-limited, please provide
  // the expiry date of your current visa", "Following on from the question above, please share details of your Right
  // to Work… visa expiry dates etc. (if needed)") — got the profile city (the label holds "location"). Authorised +
  // no sponsorship needed → N/A.
  const _RTW_FOLLOWUP_Q = /^\s*if\s+(your|you)\b[^?]{0,80}\b(time[- ]limited|limited\s+leave|visa|sponsor\w*|work\s+permit|expir\w*)|\b(share|provide|give|enter)\b[^?]{0,30}\bdetails?\b[^?]{0,30}\b(right\s+to\s+work|visa|work\s+permit|immigration)/i;
  // v2.5.112: identity / logistics answers that are never personal facts to invent.
  const _REFERENCES_Q = /^\s*(professional\s+)?(references?|referees?)\b|\b(names?|details?)\s+(and|&)\s+contact\s+(information|details)\b[^?]{0,40}\breferen|\bplease\s+(enter|provide|list)\b[^?]{0,30}\breferen/i;
  const _ADJUSTMENTS_Q = /reasonable\s+adjustments?|\badjustments?\s+(or|and|\/)\s+(support|accommodations?)|\baccommodations?\b[^?]{0,80}\b(recruitment|interview|application|hiring|selection|assessment)|\b(require|need)\b[^?]{0,40}\b(adjustments?|accommodations?)\b|am[ée]nagements?\s+(raisonnables?|particuliers?|sp[ée]cifiques?)/i;
  const _COUNTRY_TEXT_Q = /^\s*(your\s+)?(country(\s+of\s+(residence|citizenship))?|country\s*\/\s*region|pays(\s+de\s+r[ée]sidence)?|pa[ií]s|land)\s*\*?\s*$/i;
  const _EDU_TEXT_Q = /^\s*(your\s+)?(education|highest\s+(level\s+of\s+)?(education|degree|qualification)|degree|qualifications?|formation|dipl[oô]me|niveau\s+d.?[ée]tudes)\s*\*?\s*$/i;
  const _SCHOOL_Q = /\b(which|what)\s+(university|college|school|institution|universit[ée]|[ée]cole)\b|\b(university|college|school|institution)\s+(name|attended)\b|\bname\s+of\s+(the\s+|your\s+)?(university|college|school|institution)\b|^\s*(university|college|school|[ée]cole|universit[ée])\s*\*?\s*$/i;
  const _STUDY_FIELD_Q = /field\s+of\s+study|\bmajor\b|\bdiscipline\b|subject\s+of\s+(your\s+)?degree|degree\s+subject|domaine\s+d.?[ée]tudes|fili[èe]re/i;
  const _ENGLISH_LEVEL_TEXT_Q = /^\s*(english|anglais)\s*(level|proficiency|niveau)\b|\b(level|niveau)\s+(of|d.)\s*(english|anglais)\b|\benglish\s+(language\s+)?(level|proficiency)\b/i;
  function _titleCase(s) { return String(s || '').replace(/\b([a-zà-ÿ])/g, (m) => m.toUpperCase()); }
  // Profile country as a display name ("UK" → "United Kingdom", "IN" → "India"); "" when unknown.
  function profileCountryName(config) {
    const raw = String(profileCountry(config) || '').trim();
    if (!raw) return '';
    const names = COUNTRY_NAMES[raw.toUpperCase()];
    return names ? (names[0].length <= 3 ? names[0].toUpperCase() : _titleCase(names[0])) : raw;
  }
  // Highest CV degree ("M.S. Business Analytics, California State University") — '' without education data.
  function _bestEducation(config) {
    const edu = (config && config.cvProfile && Array.isArray(config.cvProfile.education) ? config.cvProfile.education : []).filter(e => e && (e.degree || e.school));
    if (!edu.length) return null;
    // A degree whose level is not spelled out ("Business Management, University of East London") is at least a
    // bachelor when the school is a university — it must not lose to "A-Levels".
    const rk = (e) => eduRank([e.degree, e.field].join(' ')) || (/universit|college|institut|polytechn|[ée]cole|school\s+of|business\s+school/i.test(String(e.school || '')) ? 3 : 0);
    let best = edu[0], br = rk(best);
    for (const e of edu) { const r = rk(e); if (r > br) { best = e; br = r; } }
    return best;
  }
  function educationTextAnswer(config) {
    const e = _bestEducation(config); if (!e) return '';
    const deg = String(e.degree || '').trim(), sch = String(e.school || '').split(',')[0].trim();
    return [deg + (e.field && !deg.toLowerCase().includes(String(e.field).toLowerCase()) ? ' in ' + e.field : ''), sch].filter(Boolean).join(', ').slice(0, 200);
  }
  // The school the user attends / attended most recently (first education entry = most recent in the CV).
  function schoolAnswer(config) {
    const edu = (config && config.cvProfile && Array.isArray(config.cvProfile.education) ? config.cvProfile.education : []).filter(e => e && e.school);
    return edu.length ? String(edu[0].school).trim() : '';
  }
  function _sigTokens(s) {
    return _norm(s).trim().split(' ').filter(w => w.length >= 3 && !/^(the|and|of|for|in|at|de|des|du|la|le|les|university|universite|universidad|college|school|ecole|institute|institut|department|faculty|campus|degree|bachelor|master|bsc|msc|honours|hons|with|class|upper|lower|division|second|first)$/.test(w));
  }
  // Option of a school list matching the CV school ("University of East London" ⊂ "East London, University of").
  function _schoolOption(options, textOf, school) {
    if (!school) return null;
    const n = (s) => _norm(s).trim();
    const sN = n(school.split(',')[0]);
    let hit = options.find(o => n(textOf(o)) === sN) || options.find(o => { const t = n(textOf(o)); return t.length > 6 && (t.includes(sN) || sN.includes(t)); });
    if (hit) return hit;
    const st = _sigTokens(school.split(',')[0]);
    if (!st.length) return null;
    let best = null, bs = 0;
    for (const o of options) { const ot = _sigTokens(textOf(o)); if (!ot.length) continue; const common = ot.filter(w => st.includes(w)).length; const sc = common / Math.max(ot.length, st.length); if (common >= 1 && sc > bs) { bs = sc; best = o; } }
    return bs >= 0.99 || (bs >= 0.66 && st.length >= 2) ? best : null;
  }
  // Field-of-study option best matching the CV degree / field ("Business Management" → "Business & Management").
  function _studyFieldOption(options, textOf, config) {
    const e = _bestEducation(config); if (!e) return null;
    const st = _sigTokens([e.field, e.degree].filter(Boolean).join(' '));
    if (!st.length) return null;
    let best = null, bs = 0;
    for (const o of options) { const ot = _sigTokens(textOf(o)); const common = ot.filter(w => st.some(s => s === w || (w.length >= 5 && s.startsWith(w.slice(0, 5))))).length; if (common > bs) { bs = common; best = o; } }
    return bs >= 1 ? best : null;
  }
  // The user's English level as text ("Native", "C1") — "Fluent" when the profile has none (same default rank as radios).
  function englishLevelText(config) {
    const langs = [].concat((config && config.languages) || [], (config && config.cvProfile && config.cvProfile.languages) || []);
    for (const L of langs) {
      const nm = (typeof L === 'string' ? L : (L && (L.name || L.language)) || '').toLowerCase();
      if (/english|anglais|ingl[eé]s/.test(nm)) {
        const r = _userLevelRank(typeof L === 'string' ? L : (L.level || L.proficiency || ''));
        if (r >= 6) return 'Native'; if (r === 5) return 'Bilingual / C1'; if (r === 4) return 'Fluent'; if (r === 3) return 'Intermediate'; if (r === 2) return 'Basic';
        return 'Fluent';
      }
    }
    return 'Fluent';
  }
  function postalCodeValue(config) {
    const cv = (config && config.cvProfile) || {};
    return String((config && (config.postalCode || config.zipCode)) || cv.postalCode || cv.zip || cv.zipCode || '').trim();
  }
  // v2.5.119: "Postal Code (example K1A 0T6)*" (Canadian form, telemetry 2026-10-17) — a trailing hint in brackets.
  const _POSTAL_Q = /^\s*(?:your\s+)?(postal(\s+code)?|zip(\s*\/?\s*postal)?(\s*code)?|post\s*code|code\s+postal|c[oó]digo\s+postal|plz|postleitzahl|pin\s*code)\s*(\([^)]{0,60}\))?\s*\*?\s*$/i;
  // v2.5.119 (telemetry 2026-10-17): "Were you referred to work at LOCAL, and if so, by whom?*" (required text) →
  // "No" (a referral that never happened is never invented). Same for "Was this a referral? If yes, please specify…".
  const _REFERRAL_TEXT_Q = /(?<!how\s)\bwere\s+you\s+referred\b|\bwas\s+this\s+a\s+referral\b|\b(referred|referral)\b[^?]{0,60}\b(by\s+whom|who\s+referred|whom|employee\s+name|name\s+of\s+(the\s+)?(employee|referr))|\bemployee\s+referral\b|\bhave\s+you\s+been\s+referred\b|\breferral\s+(name|source)\s*\*?\s*$|avez[- ]vous\s+[ée]t[ée]\s+(recommand|coopt|parrain)|qui\s+vous\s+a\s+(recommand|coopt|parrain)/i;
  // "Province (two characters, ON for Ontario)*", "State*", "State / Province" as free text → the region of the profile city.
  const _REGION_TEXT_Q = /^\s*(?:your\s+|current\s+)?(state|province|region|r[ée]gion|territory)(\s*\/\s*(province|state|region|territory))?\s*(\*?\s*$|\([^)]{0,70}\)\s*\*?\s*$)/i;
  // "Major / Field of study*", "Education Field of Study*" → the field of the best CV degree.
  const _STUDY_FIELD_TEXT_Q = /^\s*(?:education\s+|your\s+)?(major(\s*\/\s*field\s+of\s+study)?|field\s+of\s+study(\s*\/\s*major)?|area\s+of\s+study|discipline|specialization|specialisation|domaine\s+d.?[ée]tudes|fili[èe]re)\s*\*?\s*$/i;
  // The subject of a degree: "B.A., History" → History, "Master in Management" → Management, "MBA/PGDM, HR/IR" → HR/IR.
  function studyFieldAnswer(config) {
    const e = _bestEducation(config); if (!e) return '';
    const f = String(e.field || e.major || e.fieldOfStudy || '').trim();
    if (f) return f.slice(0, 100);
    const deg = String(e.degree || '').replace(/\s+/g, ' ').trim();
    const m = deg.match(/,\s*(.+)$/) || deg.match(/\b(?:in|of|en|de|in the field of)\s+(.+)$/i);
    const v = (m ? m[1] : deg).trim();
    return /[a-z]/i.test(v) ? v.slice(0, 100) : '';
  }
  // Start / end year of an education entry ("2018 – 2021", "2019", startYear / endYear).
  function educationYears(e) {
    if (!e) return null;
    const ys = String([e.startYear, e.endYear].filter(Boolean).join(' - ') || e.year || e.dates || e.duration || '').match(/(19|20)\d\d/g) || [];
    if (!ys.length) return null;
    const n = ys.map(Number);
    return { from: n.length > 1 ? Math.min(...n) : null, to: Math.max(...n) };
  }
  // v2.5.112: one place for the deterministic free-text answers. string = fill it; '' = decided to leave it empty
  // (the caller counts it only when the form requires it); null = not ours → normal flow (patterns / AI).
  function deterministicTextAnswer(q, config, el, modal, isTextarea) {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (_REFERENCES_Q.test(s) && s.length < 200) return 'Available upon request';
    // v2.5.112 (dry-run gate, Advancio page 5): a bare required "Comments*" box.
    if (/^\s*(additional\s+|other\s+|any\s+)?(comments?|remarks?|notes?|anything\s+else(\s+we\s+should\s+know)?\??)\s*\*?\s*$/i.test(s)) return 'No additional comments.';
    if (/^\s*(commentaires?|remarques?)(\s+(additionnels?|suppl[ée]mentaires?))?\s*\*?\s*$/i.test(s)) return 'Aucun commentaire.';
    if (_ADJUSTMENTS_Q.test(s) && s.length < 300) return 'No';
    if (_RTW_FOLLOWUP_Q.test(s)) {
      const auth = String((config && config.legallyAuthorized) || 'yes').toLowerCase(), visa = String((config && config.visaSponsorship) || 'no').toLowerCase();
      return auth !== 'no' && visa !== 'yes' ? 'N/A' : null;
    }
    // v2.5.112 (dry-run gate 2026-10-13, Advancio): required textareas answered from the settings.
    if (isTextarea && /^\s*(estimated\s+)?(time\s+to\s+start(\s+work)?|when\s+can\s+you\s+(start|join)\b[^?]{0,20}\??|how\s+soon\s+can\s+you\s+(start|join)\b[^?]{0,20}\??|availability(\s+to\s+start)?)\s*\*?\s*$/i.test(s)) return noticePeriodText(s, config);
    if (/place\s+of\s+residence|where\s+(do\s+you\s+(currently\s+)?live|are\s+you\s+(currently\s+)?(located|based))|^\s*current\s+(location|city)\b|\b(city\s+and\s+state|state\s+and\s+city|city,\s*state)\b/i.test(s) && s.length < 120) return String((config && config.city) || '').trim();
    if (/\bwork\s+restrictions?\b|\brestrictions?\b[^?]{0,30}\b(aware|work|employment)\b/i.test(s) && s.length < 160) return String((config && config.visaSponsorship) || 'no').toLowerCase() === 'yes' ? null : 'No';
    // v2.5.119: referral questions as text → "No" ("Non" on a French question). Never a made-up referrer.
    if (_REFERRAL_TEXT_Q.test(s) && s.length < 260) return /[àâçéèêîôûù]|\b(vous|avez|qui|par)\b/i.test(s) ? 'Non' : 'No';
    // v2.5.119: "How soon would you be able to start if presented with a job offer?" → the notice period setting.
    if (/^\s*how\s+soon\b[^?]{0,60}\b(start|join|begin|be\s+available)\b/i.test(s) && s.length < 160 && !(el && (el.type === 'number' || /numeric/i.test(el.id || '') || el.getAttribute && el.getAttribute('inputmode') === 'numeric'))) return noticePeriodText(s, config);
    if (isTextarea) return null;
    // v2.5.113 (premium IN user 2026-10-14/15, résumé step): required "Headline" left empty → "Please enter a valid
    // answer". The CV headline, else the latest role title (never invented).
    if (/^\s*(your\s+|profile\s+|professional\s+)?headline\s*\*?\s*$/i.test(s)) {
      const cv = (config && config.cvProfile) || {};
      // v2.5.115 (Théo 2026-10-16): the most recent / current role, not the first CV entry (his first entry is an
      // event co-founder role that ended in 2024; his current one is listed last).
      const e = latestCvRole(cv) || {};
      const h = String(cv.headline || cv.title || e.title || e.role || e.position || (config && config.currentTitle) || '').split(/\s+\|\s+/)[0].replace(/\s+/g, ' ').trim();
      return h ? h.slice(0, 200) : null;
    }
    if (_COUNTRY_TEXT_Q.test(s)) return profileCountryName(config);
    if (_POSTAL_Q.test(s)) return postalCodeValue(config); // never invented: '' without a postal code in the settings / CV
    if (_ENGLISH_LEVEL_TEXT_Q.test(s) && s.length < 80) return englishLevelText(config);
    if (_EDU_TEXT_Q.test(s)) return educationTextAnswer(config) || null;
    // v2.5.119 (telemetry 2026-10-17, 7 skips): "Major / Field of study*" — from the CV degree; no education → '' (left).
    if (_STUDY_FIELD_TEXT_Q.test(s)) return studyFieldAnswer(config);
    // v2.5.119: "Province (two characters, ON for Ontario)*" / "State*" → the region of the profile city (code when the
    // question asks for two letters / an abbreviation); unknown city → '' (never guessed).
    if (_REGION_TEXT_Q.test(s) && !/statement|united\s+states/i.test(s)) {
      const reg = regionForCity(config && config.city);
      if (!reg) return '';
      return /two\s+(characters|letters)|2\s+(characters|letters)|abbreviat|code\b|\(\s*[A-Z]{2}\s/i.test(s) && reg.code ? reg.code : reg.name;
    }
    if (_SCHOOL_Q.test(s) && s.length < 160) return schoolAnswer(config) || null;
    return null;
  }
  const _DOB_Q = /date\s+of\s+birth|\bd\.?o\.?b\b|birth\s*date|\bbirthday\b|date\s+de\s+naissance|fecha\s+de\s+nacimiento|geburtsdatum|data\s+di\s+nascita/i;
  const _OTHER_OPT_RE = /^\s*(others?|other\s*\(|autres?|otros?|otras?|andere|altro|altri)\b/i;
  function _isOtherOption(text) { return _OTHER_OPT_RE.test(String(text || '')); }
  function _isRequiredField(el, modal) {
    if (!el) return false;
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    try {
      if (/\*/.test(getFieldLabel(el, modal || document)) || /\*\s*$/.test(String(el.getAttribute('aria-label') || ''))) return true;
      // v2.5.113: native <dialog> question "<p>Location (city)*</p>" in an ancestor holding only this field.
      for (let n = el.parentElement, k = 0; n && n !== modal && k < 6; n = n.parentElement, k++) {
        if (Array.from(n.querySelectorAll('input:not([type="hidden"]), select, textarea')).some(c => c !== el && !(el.name && c.name === el.name))) break;
        if (Array.from(n.querySelectorAll('p, span, label, legend')).some(e => !e.children.length && /\*\s*$/.test(String(e.textContent || '').trim()))) return true;
      }
      return false;
    } catch (_) { return false; }
  }
  // The profile has no date-of-birth field today (popup, user_profiles, cv_data) — read defensively in
  // case one is added; otherwise '' (the field is never guessed).
  function profileDateOfBirth(config) {
    const cv = (config && config.cvProfile) || {};
    return String((config && (config.dateOfBirth || config.dob || config.birthDate)) || cv.dateOfBirth || cv.dob || cv.birthDate || '').trim();
  }
  // v2.5.111: the optional popup "Date of birth" (stored yyyy-mm-dd) in the field's format: native date input →
  // ISO; mm/dd hint → US; otherwise DD/MM/YYYY (IN / FR / UK forms). Unparseable → as typed.
  function _formatDobFor(raw, input, question) {
    const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(raw || '').trim();
    const hint = input ? [input.placeholder, input.getAttribute && input.getAttribute('aria-label'), question].join(' ') : String(question || '');
    if ((input && input.type === 'date') || /yyyy-mm-dd/i.test(hint)) return `${m[1]}-${m[2]}-${m[3]}`;
    if (/\bmm\s*[\/.-]\s*dd\b/i.test(hint)) return `${m[2]}/${m[3]}/${m[1]}`;
    return `${m[3]}/${m[2]}/${m[1]}`;
  }
  // The choice (select / radio / checkbox) right before `input` in the form: is "Other" selected?
  function _parentChoiceIsOther(input, modal) {
    try {
      const all = Array.from(modal.querySelectorAll('input, select, textarea'));
      const idx = all.indexOf(input);
      let seenChoice = 0;
      for (let i = idx - 1; i >= 0 && idx - i <= 25 && seenChoice < 1; i--) {
        const el = all[i];
        if (el.tagName === 'SELECT') {
          seenChoice++;
          const o = el.options[el.selectedIndex];
          if (o && el.selectedIndex > 0 && _isOtherOption(o.text)) return true;
        } else if (el.type === 'radio' || el.type === 'checkbox') {
          const grp = el.name ? Array.from(modal.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)) : [el];
          seenChoice++;
          for (const r of grp) {
            if (!r.checked) continue;
            const l = modal.querySelector(`label[for="${CSS.escape(r.id || '')}"]`);
            const t = (l && l.textContent) || r.getAttribute('aria-label') || r.value || '';
            if (_isOtherOption(t)) return true;
          }
          i = Math.min(i, all.indexOf(grp[0])); // skip the rest of this group
        }
      }
    } catch (_) {}
    return false;
  }
  // "Current company / organisation / employer" → latest CV role's company; "Current designation /
  // job title / role" → its title. Only when that role is ongoing (Present / no end date).
  function currentRoleAnswer(question, config) {
    const q = String(question || '').replace(/\s+/g, ' ').trim();
    const isCo = /^(?:what\s+is\s+)?(?:your\s+)?(?:current|present)\s+(?:company|organi[sz]ation|employer|firm|company\s+name|organi[sz]ation\s+name|employer\s+name)\s*[?:*]?\s*$/i.test(q)
      || /^(?:name\s+of\s+)?(?:your\s+)?current\s+(?:company|organi[sz]ation|employer)\b.{0,20}$/i.test(q) || /^entreprise\s+actuelle\b|^employeur\s+actuel\b/i.test(q);
    const isTi = /^(?:what\s+is\s+)?(?:your\s+)?(?:current|present)\s+(?:designation|job\s+title|title|role|position)\s*[?:*]?\s*$/i.test(q) || /^(?:poste|intitul[ée]\s+de\s+poste|fonction)\s+actuel(?:le)?\b/i.test(q);
    if (!isCo && !isTi) return '';
    // v2.5.115: the most recent role (CVs listed oldest-first used to answer with their first entry).
    const e = latestCvRole((config && config.cvProfile) || {});
    if (e) {
      const end = String(e.endDate || e.end || e.to || '');
      const dur = String(e.duration || e.dates || e.period || '');
      const ongoing = /present|current|now\b|today|aujourd|actuel|en cours|ongoing|actualidad|heute/i.test(end + ' ' + (dur.split(/\s*(?:–|—|-|to|à|au|until)\s+/i).pop() || '')) || (!end && (e.startDate || e.start) && !/\d{4}.*\d{4}/.test(dur));
      if (!ongoing) return '';
      return String((isCo ? e.company : (e.title || e.role || e.position)) || '').split(/\s+\|\s+/)[0].trim();
    }
    return String((isCo ? config && config.currentCompany : config && config.currentTitle) || '').trim();
  }
  function _fillPay(input, q, config) {
    const st = u();
    const req = _isRequiredField(input);
    if (_VARIABLE_PAY_Q.test(q)) {
      st.log(`Variable pay "${String(q).slice(0, 50)}": in no setting — never guessed, left empty`);
      _noteUnknownField(q, input);
      if (req) st._unknownFieldFails = Math.max(3, st._unknownFieldFails || 0);
      return;
    }
    if (isCurrentPayQuestion(q) && !String((config && config.currentSalary) || '').trim()) {
      st.log(`Current pay "${String(q).slice(0, 50)}": not in your settings — never guessed, left empty`);
      _noteUnknownField(q, input);
      if (req) { st._unknownFieldFails = Math.max(3, st._unknownFieldFails || 0); _noteMissingSetting('currentSalary'); } // required → skip this application now
      return;
    }
    const sal = salaryAnswer(q, config, input);
    if (sal) { st.fill(input, sal); st.log(`Salary filled: ${sal} ("${String(q).slice(0, 40)}")`); return; }
    st.log(`Pay question "${String(q).slice(0, 50)}": no expected salary in your settings for it (or another currency) — left empty`);
    _noteUnknownField(q, input);
    if (req) { st._unknownFieldFails = Math.max(3, st._unknownFieldFails || 0); if (!String((config && config.expectedSalary) || '').trim()) _noteMissingSetting('expectedSalary'); }
  }
  // v2.5.112: a REQUIRED question skipped because a setting is empty (expected / current salary, postal code) —
  // counted per application so the popup can say "N jobs asked your expected salary — add it in Preferences".
  function _noteMissingSetting(key) {
    const st = u(); st._missingSettings = st._missingSettings || [];
    if (!st._missingSettings.includes(key)) st._missingSettings.push(key);
  }

  // v2.5.112: notice period in days — from the setting (bare number = months, empty = 1 month) or an option label.
  function noticeDays(raw, isOption) {
    const t = _deaccent(String(raw || '')).toLowerCase().trim();
    if (!t) return isOption ? null : 30;
    if (/immediate|immediat|serving|no\s+notice|^0\b|none|aucun/.test(t)) return 0;
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:-\s*\d+\s*)?(days?|jours?|weeks?|semaines?|months?|mois)?/);
    if (!m) return isOption ? null : 30;
    const n = parseFloat(m[1].replace(',', '.'));
    const unit = m[2] || (isOption ? '' : 'month');
    let d = /day|jour/.test(unit) ? n : /week|semaine/.test(unit) ? n * 7 : /month|mois/.test(unit) ? n * 30 : (isOption ? (n > 12 ? n : n * 30) : n * 30);
    if (/more\s+than|plus\s+de|above|over|\+/.test(t)) d += 1;
    return d;
  }
  const _US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };
  // { name, code } of the state / region of the profile city, or null. "City, ST" (US) → the state; LinkedIn
  // "City, Region, Country" → Region; known cities (ai-form map) otherwise.
  // v2.5.119 (Canadian user, "Province (two characters, ON for Ontario)*"): Canadian provinces + main cities.
  const _CA_PROV = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' };
  const _CA_CITY_PROV = { toronto: 'ON', ottawa: 'ON', mississauga: 'ON', brampton: 'ON', hamilton: 'ON', london: null, waterloo: 'ON', kitchener: 'ON', montreal: 'QC', 'montréal': 'QC', quebec: 'QC', laval: 'QC', gatineau: 'QC', vancouver: 'BC', surrey: 'BC', burnaby: 'BC', victoria: 'BC', richmond: 'BC', calgary: 'AB', edmonton: 'AB', winnipeg: 'MB', regina: 'SK', saskatoon: 'SK', halifax: 'NS', 'st. john\'s': 'NL', fredericton: 'NB', moncton: 'NB', charlottetown: 'PE' };
  function regionForCity(city) {
    const parts = String(city || '').split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2 && /^[A-Z]{2}$/.test(parts[1]) && _US_STATES[parts[1]]) return { name: _US_STATES[parts[1]], code: parts[1] };
    if (parts.length >= 2) { const full = Object.entries(_US_STATES).find(([, v]) => v.toLowerCase() === parts[1].toLowerCase()); if (full) return { name: full[1], code: full[0] }; }
    if (parts.length >= 2) {
      const p1 = _deaccent(parts[1]).toLowerCase();
      const ca = Object.entries(_CA_PROV).find(([k, v]) => _deaccent(v).toLowerCase() === p1 || (k === parts[1].toUpperCase() && /^[A-Z]{2}$/.test(parts[1]) && /canada/i.test(parts.slice(2).join(' '))));
      if (ca) return { name: ca[1], code: ca[0] };
    }
    {
      const c0 = String(parts[0] || '').toLowerCase();
      const isCa = /canada/i.test(String(city || ''));
      const code = _CA_CITY_PROV[c0];
      if (code && (isCa || !['london', 'richmond', 'victoria', 'hamilton', 'waterloo', 'surrey', 'kitchener'].includes(c0))) return { name: _CA_PROV[code], code };
    }
    try { const r = window.EAM && window.EAM.aiForm && window.EAM.aiForm.regionForCity ? window.EAM.aiForm.regionForCity(city) : ''; if (r) { const code = Object.keys(_US_STATES).find(k => _US_STATES[k] === r) || ''; return { name: r, code }; } } catch (_) {}
    return null;
  }
  // The "If you selected 'Other', please specify" text field right after `choice` → value.
  function _fillOtherSpecifyAfter(choice, modal, value) {
    if (!value) return;
    try {
      const all = Array.from(modal.querySelectorAll('input[type="text"], input:not([type]), textarea'));
      const next = all.find(i => (choice.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING) && _OTHER_SPECIFY_Q.test(getFieldQuestion(i, modal)));
      if (next) { u().fill(next, String(value).slice(0, 200)); u().log(`"Other — please specify" → ${String(value).slice(0, 50)}`); }
    } catch (_) {}
  }
  function pickSourceOption(texts) {
    const norm = texts.map(t => _deaccent(String(t || '')).toLowerCase().trim());
    const order = [/linkedin/, /job\s*board|jobboard|site\s+(d.?)?emploi|job\s+site|career\s+site|site\s+carriere|annonce|job\s+(posting|ad)|offre\s+d.?emploi/, /internet|online|en\s+ligne|web|google|search\s+engine|moteur/, /^(other|autre|autres|otro|sonstige)s?\b/];
    for (const re of order) { const i = norm.findIndex(t => re.test(t)); if (i >= 0) return i; }
    return -1;
  }

  // v2.5.104: yes/no "required degree" questions. Live 2026-10-08 (Tata Consultancy Services):
  // "Avez-vous le niveau d'études requis : Maîtrise ?" → "Non" for a profile with several Master's
  // (discarded). Required level read from the question, compared with the highest CV degree.
  const _EDU_YN_Q = /(niveau\s+d.?[ée]tudes\s+requis|dipl[oô]me\s+requis|formation\s+requise|avez[- ]vous\s+(un|une|le|la|l.)\s*(dipl[oô]me|titre|niveau)|[êe]tes[- ]vous\s+(titulaire|dipl[oô]m[ée])|do\s+you\s+(have|hold)\s+(an?\s+|the\s+)?.{0,40}(degree|diploma|bachelor|master|qualification)|have\s+you\s+(completed|obtained|earned)\s+.{0,40}(degree|bachelor|master)|required\s+(level\s+of\s+)?(education|degree))/i;
  function educationQuestionAnswer(questionText, config) {
    const q = String(questionText || '');
    if (!_EDU_YN_Q.test(q)) return null;
    const need = eduRank(q);
    const have = cvEduRank(config);
    if (need == null || have == null) return null;
    // Théo 2026-10-08: yes/no questions default to "Oui" — this rule only ever turns an answer
    // INTO "Oui" (CV degree ≥ required), it never answers "Non".
    return have >= need ? 'yes' : null;
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
      if (select.closest && select.closest('[data-eam-exp]')) continue;
      const labelText = getFieldLabel(select, modal).toLowerCase();
      if (fixEducationSelect(select, labelText, config)) continue;
      // v2.5.104: "How did you hear about X?" = where the user found the job: LinkedIn. Live
      // 2026-10-08 (ATEXIS): "Employee recommendation" went out — a referral that never happened.
      // Also corrects a pre-filled (saved) answer.
      const selQ = (() => { try { return getFieldQuestion(select, modal) || ''; } catch (_) { return ''; } })();
      if (_SOURCE_Q.test(labelText) || _SOURCE_Q.test(selQ)) {
        const opts = Array.from(select.options).filter(o => o.index > 0 || (o.value && o.text.trim()));
        const pick = pickSourceOption(opts.map(o => o.text));
        if (pick >= 0) {
          const o = opts[pick];
          if (select.value !== o.value) {
            select.value = o.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            u().log(`Source question → "${o.text.trim()}"`);
          }
          continue;
        }
      }
      if (select.selectedIndex > 0) {
        // v2.5.119 (dry-run gate 2026-10-17, Kickmaker: a LinkedIn-saved "Non" to "Avez-vous suivi le développement d'un
        // produit de la conception jusqu'à l'industrialisation ?" went to the review step): the Oui rule also covers a
        // PRE-FILLED yes/no select — a saved "No" becomes "Yes" unless No is legitimate (yesNoNoAllowedReason).
        try {
          const cur = select.options[select.selectedIndex];
          const yn = Array.from(select.options).filter(o => o.index > 0).map(o => o.text.trim());
          const q = selQ || labelText;
          const kn = isYesNoOptions(yn) ? knownNoFromProfile(q, config) : '';
          if (cur && NO_OPTION_STRICT_RE.test(cur.text.trim()) && isYesNoOptions(yn) && !kn && !yesNoNoAllowedReason(q) && !isSelfDeclarationQuestion(q) && !isMarketingOptInLabel(q)) {
            const yes = Array.from(select.options).find(o => o.index > 0 && YES_OPTION_RE.test(o.text.trim()));
            if (yes) { select.value = yes.value; select.dispatchEvent(new Event('change', { bubbles: true })); u().log(`Saved "No" → "${yes.text.trim()}" (Oui rule): ${q.slice(0, 50)}`); }
          } else if (cur && YES_OPTION_RE.test(cur.text.trim()) && kn) {
            // 2.5.126: a saved "Yes" to a school / degree / employer the CV does not show → "No"
            const no = Array.from(select.options).find(o => o.index > 0 && NO_OPTION_STRICT_RE.test(o.text.trim()));
            if (no) { select.value = no.value; select.dispatchEvent(new Event('change', { bubbles: true })); u().log(`Saved "Yes" → "${no.text.trim()}" (${kn}): ${q.slice(0, 50)}`); }
          }
        } catch (_) {}
        continue;
      }

      const options = Array.from(select.options);
      let selectedOption = null;

      // v2.5.112 (telemetry 2026-10-13, UK graduate): "Which university are you currently attending…?" (300+ schools)
      // was left unanswered (long list) and "Please specify the field of study" got the blind first option. The CV
      // school / field decides; not in the list → "Other" (+ the "If you selected 'Other', please specify" field).
      if (_SCHOOL_Q.test(selQ) || _STUDY_FIELD_Q.test(selQ)) {
        const real = options.filter(o => o.index > 0 && o.value !== '');
        const isSchool = _SCHOOL_Q.test(selQ);
        const school = schoolAnswer(config);
        let pick = isSchool ? _schoolOption(real, o => o.text, school) : _studyFieldOption(real, o => o.text, config);
        let viaOther = false;
        if (!pick && (isSchool ? school : _bestEducation(config))) { pick = real.find(o => _isOtherOption(o.text)) || null; viaOther = !!pick; }
        if (pick) {
          select.value = pick.value; select.dispatchEvent(new Event('change', { bubbles: true }));
          u().log(`${isSchool ? 'School' : 'Field of study'} select → "${pick.text.trim()}"${viaOther ? ' (not in the list)' : ''}`);
          if (viaOther) _fillOtherSpecifyAfter(select, modal, isSchool ? school : educationTextAnswer(config));
          continue;
        }
        if (isSchool || _bestEducation(config)) { u().log(`${isSchool ? 'School' : 'Field of study'} select left unanswered (CV value not in the list): ${selQ.slice(0, 50)}`); continue; }
      }

      // v2.5.112: state / province list ("Please indicate which state you are currently residing in.*", 50 states →
      // long-list guard) ← the profile city ("Albuquerque, NM", "Paris, Île-de-France, France", "Bengaluru").
      if (/\b(state|province|region|r[ée]gion|county|territory)\b/i.test(selQ) && !/statement|united\s+states/i.test(selQ)) {
        const reg = regionForCity(config && config.city);
        const real = options.filter(o => o.index > 0 && o.value !== '');
        const n = (t) => _deaccent(String(t || '')).toLowerCase().trim();
        const pick = reg && (real.find(o => n(o.text) === n(reg.name)) || (reg.code && real.find(o => n(o.text) === n(reg.code) || n(o.value) === n(reg.code))));
        if (pick) { select.value = pick.value; select.dispatchEvent(new Event('change', { bubbles: true })); u().log(`State select → "${pick.text.trim()}" (from your city)`); continue; }
      }
      // v2.5.112: notice-period select ("Immediate / 15 days / 30 days / 60 days / 90 days") → the option closest to the
      // notice setting (empty setting = 1 month, the same default as text fields) — was the blind first option.
      // v2.5.114 (live gate 2026-10-15, SMCP): "A partir de quand seriez-vous disponible pour commencer ?" (Immédiatement /
      // D'ici 1 mois / D'ici 2 mois / Autre) was not seen as a notice question → blind first option "Immédiatement" with
      // a 1-month notice. Availability wording (FR/EN) takes the same path when ≥ 2 options read as delays.
      const _availQ = /notice|pr[ée]avis|how\s+soon.{0,20}(join|start)|when\s+(can|could|would)\s+you\s+(join|start|be\s+available)|joining\s+time|availability|available\s+to\s+(start|join)|disponib|partir\s+de\s+quand|quand.{0,40}(commencer|d[ée]buter|rejoindre)/i;
      if (/notice|pr[ée]avis|how\s+soon.{0,20}(join|start)|when\s+can\s+you\s+(join|start)|joining\s+time/i.test(selQ)
          || (_availQ.test(selQ || labelText) && options.filter(o => noticeDays(o.text, true) != null).length >= 2)) {
        const want = noticeDays(config && config.noticePeriod);
        let best = null, bd = Infinity;
        for (const o of options) { if (o.index === 0 && !o.value) continue; const d = noticeDays(o.text, true); if (d == null) continue; const dd = Math.abs(d - want); if (dd < bd) { bd = dd; best = o; } }
        if (best) { select.value = best.value; select.dispatchEvent(new Event('change', { bubbles: true })); u().log(`Notice select → "${best.text.trim()}" (notice ${want} days)`); continue; }
      }
      // v2.5.114 (live gate 2026-10-15, SMCP): "Quelles sont vos prétentions salariales annuelles en brut ?" with bands
      // (- 40k / 40 - 45k / … / + 90k) got the blind first option "- 40k" with a 55000 expectation. Pay bands → the band
      // holding the expectation; no usable amount → left unanswered (never a blind band).
      if (isPayQuestion(selQ || labelText) || options.filter(o => _payOptionRange(o.text)).length >= 3 && /salair|salar|pay|ctc|r[ée]mun|package|pr[ée]tention|compens/i.test(selQ || labelText)) {
        const q = selQ || labelText;
        const pick = _payBandOption(options.filter(o => !(o.index === 0 && (!o.value || /select|s[ée]lectionn/i.test(o.text)))), q, config);
        if (pick) { select.value = pick.value; select.dispatchEvent(new Event('change', { bubbles: true })); u().log(`Salary band select → "${pick.text.trim()}"`); continue; }
        if (options.filter(o => _payOptionRange(o.text)).length >= 2) { u().log(`Salary band select left unanswered (no matching expectation in your settings): ${q.slice(0, 50)}`); if (!isCurrentPayQuestion(q) && !String((config && config.expectedSalary) || '').trim()) _noteMissingSetting('expectedSalary'); continue; }
      }
      // v2.5.119 (telemetry 2026-10-17: "Dates attended" → "Please enter a valid answer"): education YEAR selects outside an
      // entry form → the CV degree years (two selects in the same block = from / to; one = graduation year). No CV
      // years → left unanswered (never a guessed year).
      if (_isYearSelect(select) && /attend|graduat|education|[ée]tudes|school|universit|degree|dipl[oô]m|class\s+of|promotion/i.test(selQ + ' ' + labelText + ' ' + String((select.closest('fieldset, [role="group"], .fb-dash-form-element, [data-test-form-element]') || {}).textContent || '').slice(0, 300))) {
        const yrs = educationYears(_bestEducation(config));
        if (yrs) {
          const box = select.closest('fieldset, [role="group"]') || select.parentElement && select.parentElement.parentElement || modal;
          const ys = Array.from(box.querySelectorAll('select')).filter(_isYearSelect);
          const isFrom = ys.length >= 2 && ys[0] === select && !/\b(to|end|until|graduat|fin|au)\b/i.test(selQ);
          const want = isFrom ? yrs.from : yrs.to;
          if (want && _setSelect(select, want)) { u().log(`Education year select "${(selQ || labelText).slice(0, 40)}" → ${want}`); continue; }
        }
        u().log(`Education year select left unanswered (no year in your CV): ${(selQ || labelText).slice(0, 40)}`);
        continue;
      }
      // v2.5.119 (telemetry 2026-10-17): per-day availability selects ("Monday Day Shift*", "Monday (Open)*") → the
      // option saying available / open / any time (Oui rule); options that only list hours are left unanswered.
      if ((isAvailabilitySlot(selQ || labelText) || _AVAILABILITY_Q.test(selQ || labelText)) && !_availQ.test(selQ || labelText)) {
        const real = options.filter(o => o.index > 0 || (o.value && o.text.trim()));
        const pick = real.find(o => /\b(available|availability|yes|oui|s[ií]|open|any\s*time|anytime|all\s*day|full\s*(day|time)|flexible|disponible)\b/i.test(o.text) && !_UNAVAILABLE_OPT.test(o.text) && !/^\s*(no|non)\b/i.test(o.text));
        if (pick) { select.value = pick.value; select.dispatchEvent(new Event('change', { bubbles: true })); u().log(`Availability select "${(selQ || labelText).slice(0, 40)}" → "${pick.text.trim()}"`); continue; }
      }
      // Gender dropdown (EEO self-id on Workday/Greenhouse/etc.)
      if (_isGenderChoice(labelText, Array.from(select.options).map(o => o.text))) {
        const canonical = config && config.gender;
        if (canonical) {
          selectedOption = options.find(opt => matchGenderOption(opt.text, canonical));
        } else {
          // v2.5.108: no gender set → the form's own "prefer not to say" option, never a guess.
          selectedOption = options.find(opt => _GENDER_DECLINE_RE.test(opt.text || ''));
        }
        // If user has no gender set OR no matching option, leave blank — never
        // guess. An auto-selected wrong gender is worse than an unanswered one.
        if (!selectedOption) {
          u().log(`Gender dropdown: leaving unanswered (user gender="${canonical || ''}", ${options.length} options)`);
          if (!canonical && _isRequiredField(select, modal)) _noteMissingSetting('gender');
          continue;
        }
      } else if ((isCountryQuestion(labelText) && (options.length > 5 || /country\s*code|indicatif/i.test(labelText))) || looksLikeCountryList(options.map(o => o.text))) {
        // v2.5.87: country dropdowns use the profile country. Live bug 2026-09-25 00:44
        // (Agoda form): the options[1] fallback submitted "Afghanistan".
        selectedOption = findCountryOption(options, o => o.text, config);
        u().log(`Country select → ${selectedOption ? '"' + selectedOption.text.trim() + '"' : 'left unanswered (profile country not in list)'}: ${labelText.substring(0, 40)}`);
        if (!selectedOption) continue;
      } else if (/(how many years|years? of|combien d.ann|ann[ée]es? d.exp|años de experiencia)/i.test(labelText + " " + selQ) // v2.5.113: native-dialog question is in a <p> (selQ)
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
      } else if (/\b(niveau|level|proficiency|nivel|livello)\b/i.test(labelText + ' ' + selQ) && !_detectLanguageInQuestion(labelText + ' ' + selQ)
                 && options.filter(o => _optionLevelRank(o.text) > 0).length >= 3) {
        // v2.5.119 (dry-run gate 2026-10-17, SmartRecruiters via LinkedIn: "Veuillez saisir une langue que vous parlez:
        // French" then "Choisissez votre niveau." got the blind first option "Débutant" for a native speaker): the
        // language is the one written in the field right before → ranked like any language-level question; no
        // language found → left unanswered (never blind).
        let langQ = '';
        try {
          const all = Array.from(modal.querySelectorAll('input[type="text"], input:not([type]), select'));
          const at = all.indexOf(select);
          for (let i = at - 1; i >= 0 && i >= at - 3 && !langQ; i--) {
            const el = all[i];
            const v = el.tagName === 'SELECT' ? (el.selectedIndex > 0 ? el.options[el.selectedIndex].text : '') : el.value;
            if (_detectLanguageInQuestion(String(v || ''))) langQ = String(v);
          }
        } catch (_) {}
        selectedOption = langQ ? pickLanguageLevelOption(options, o => o.text, langQ + ' ' + (selQ || labelText), config.languages || (config.cvProfile && config.cvProfile.languages) || [], config.country) : null;
        if (!selectedOption) { u().log(`Language level select left unanswered (language unknown): ${(selQ || labelText).slice(0, 40)}`); continue; }
      } else if (labelText.match(/proficiency|level.*english|level.*french|level.*spanish|level.*german|niveau.*anglais|niveau.*français|nivel.*inglés|(english|anglais|french|fran[çc]ais|spanish|espagnol|german|allemand|italian|italien).*(level|niveau|proficien)|niveau.*(langue|espagnol|allemand|italien)/)) {
        // v2.5.97: ranked against the user's level for that language; never the blind options[1].
        selectedOption = pickLanguageLevelOption(options, o => o.text, getFieldQuestion(select, modal) || labelText, config.languages || (config.cvProfile && config.cvProfile.languages) || [], config.country);
        if (!selectedOption) continue;
      } else if (labelText.match(/english|anglais|language|langue|french|français|spanish|español|german|deutsch/)) {
        // 2.5.122: a named language with a level scale goes through the same rule (a language the CV does not list
        // never gets "Native" / "Fluent"); otherwise the old pick.
        const _lq = getFieldQuestion(select, modal) || labelText;
        if (_detectLanguageInQuestion(_lq) && options.filter(o => _optionLevelRank(o.text) > 0).length >= 2) {
          selectedOption = pickLanguageLevelOption(options, o => o.text, _lq, config.languages || (config.cvProfile && config.cvProfile.languages) || [], config.country);
          if (!selectedOption) continue;
        } else selectedOption = options.find(opt => opt.text.toLowerCase().match(/native|bilingual|fluent|courant|professionnel|bilingue/));
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
          else if (_ADJUSTMENTS_Q.test(getFieldQuestion(select, modal) || labelText)) desired = 'no';
          else if (/commencer\s+imm[ée]diatement|disponible\s+imm[ée]diatement|start\s+immediately|available\s+immediately|immediate(ly)?\s+(start|available|availability)|join\s+immediately/i.test(getFieldQuestion(select, modal) || labelText)) {
            // v2.5.116: same notice-period rule as the radios (was the blind options[1]).
            const np = String(config.noticePeriod || '').toLowerCase().trim();
            desired = (!np || /^0\b|^(none|aucun|imm[ée]diat|immediate)/.test(np)) ? 'yes' : 'no';
          } else if (knownNoFromProfile(getFieldQuestion(select, modal) || labelText, config)) {
            desired = 'no'; // 2.5.126: school / degree / employer the CV does not show
          } else if (!yesNoNoAllowedReason(getFieldQuestion(select, modal) || labelText)) {
            // v2.5.116 (Théo 2026-10-16, Oui rule): any other yes/no select → "Yes" (was options[1] — "Non" when
            // the form lists Non before Oui).
            desired = 'yes';
          }
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
      if (!selectedOption && isCurrentPayQuestion(getFieldQuestion(select, modal) || labelText)) {
        u().log(`Current pay select left unanswered (not in your profile): ${labelText.substring(0, 40)}`);
        continue;
      }
      if (!selectedOption && options.length > 1) {
        // v2.5.109: the blind fallback never picks "Other" (it opens an "Others (please specify)" field).
        selectedOption = _isOtherOption(options[1].text) ? (options.slice(2).find(o => !_isOtherOption(o.text)) || options[1]) : options[1];
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
            selectedOption = pickLanguageLevelOption(options, o => o.textContent, question, _cfg.languages || (_cfg.cvProfile && _cfg.cvProfile.languages) || [], _cfg.country);
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
            const _real = options.filter(opt =>
              !opt.textContent.toLowerCase().includes('select') &&
              !opt.textContent.toLowerCase().includes('choose') &&
              !opt.textContent.toLowerCase().includes('choisir')
            );
            // v2.5.109: never "Other" as the blind pick.
            selectedOption = _real.find(opt => !_isOtherOption(opt.textContent)) || _real[0];
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

  // ─── v2.5.112: LinkedIn "Work experience" step ──────────────────────────
  // Telemetry 2026-10-13 (premium US + free UK, ~14 skips): the native-dialog Easy Apply step "Work experience"
  // (buttons "Delete experience" / "Add work experience") opens an EMPTY entry form when the applicant's LinkedIn
  // profile has no position: "Your title*", "Company", From month* / year* (selects), "I currently work here", To
  // month / year, "City", "Description". Before: title went to the AI (empty on Free), the month selects got the
  // blind first option ("January"), the year selects (60+ options) were left empty → "This field is required" ×3.
  // Now each open entry form is filled from a CV experience entry (title, company, real dates, ongoing → "I currently
  // work here", location, bullets); an entry the cards already show is never added twice. No dated CV entry → an
  // EMPTY form is removed ("Delete experience") — never invented dates.
  function _isMonthSelect(sel) {
    const o = Array.from(sel.options).filter(x => x.value !== '');
    if (o.length !== 12) return false;
    return o.every((x, i) => +x.value === i + 1) || o.every((x, i) => _MONTHS[_deaccent(x.text).toLowerCase().replace(/[^a-z]/g, '')] === i);
  }
  function _isYearSelect(sel) {
    const o = Array.from(sel.options).filter(x => x.value !== '');
    return o.length >= 8 && o.every(x => /^(19|20)\d\d$/.test(String(x.value).trim()) || /^(19|20)\d\d$/.test(String(x.text).trim()));
  }
  function experienceEntryForms(modal) {
    const out = [];
    for (const sel of modal.querySelectorAll('select')) {
      if (!_isMonthSelect(sel) || out.some(f => f.contains(sel))) continue;
      let found = null;
      for (let n = sel.parentElement, k = 0; n && n !== modal && k < 10; n = n.parentElement, k++) {
        const months = Array.from(n.querySelectorAll('select')).filter(_isMonthSelect).length;
        if (months > 2) break; // reached the list of several entries
        if (months >= 1 && n.querySelector('input[type="text"], input:not([type])') && Array.from(n.querySelectorAll('select')).some(_isYearSelect)) { found = n; break; }
      }
      if (found) out.push(found);
    }
    return out;
  }
  const _EXP_TITLE_Q = /title|titre|intitul|poste|cargo|t[ií]tulo|position|job|role|berufsbezeichnung/i;
  const _EXP_COMPANY_Q = /company|employer|entreprise|soci[ée]t[ée]|empresa|unternehmen|azienda|organi[sz]ation|firm/i;
  const _EXP_CITY_Q = /city|ville|ciudad|stadt|citt[aà]|location|lieu|localisation/i;
  function _entryOngoing(e) {
    const end = String(e.endDate || e.end || e.to || '');
    const dur = String(e.duration || e.dates || e.period || '').split(/\s*\|\s*/)[0];
    if (/present|current|now\b|today|aujourd|actuel|en cours|ongoing|actualidad|heute/i.test(end)) return true;
    if (end) return false;
    const parts = dur.split(/\s*(?:–|—|-|to|à|au|until)\s+/i);
    return parts.length < 2 ? !!(e.startDate || e.start) : /present|current|now\b|today|aujourd|actuel|en cours|ongoing|actualidad|heute/i.test(parts[parts.length - 1]);
  }
  // v2.5.115: the most recent CV role — ongoing roles first (Present / no end date), then the latest end date, then
  // the latest start; undated roles keep their CV order after the dated ones. null when the CV has no role.
  function latestCvRole(cv) {
    const exp = (((cv && cv.experience) || [])).filter(e => e && String(e.title || e.role || e.position || e.company || '').trim());
    if (!exp.length) return null;
    const scored = exp.map((e, i) => {
      let r = null; try { r = _entryRangeClean(e); } catch (_) {}
      let ongoing = false; try { ongoing = _entryOngoing(e); } catch (_) {}
      return { e, i, ongoing, end: r ? r[1] : -1, start: r ? r[0] : -1 };
    });
    scored.sort((a, b) => (b.ongoing - a.ongoing) || (b.end - a.end) || (b.start - a.start) || (a.i - b.i));
    return scored[0].e;
  }
  function _entryRangeClean(e) {
    // duration strings may carry "| City | Client" (cv-gen 2026-10-09) → dates only.
    const e2 = Object.assign({}, e);
    for (const k of ['duration', 'dates', 'period', 'date']) if (e2[k]) e2[k] = String(e2[k]).split(/\s*\|\s*/)[0];
    return _entryRange(e2);
  }
  function _entryLocation(e) {
    const loc = String(e.location || e.city || '').trim();
    if (loc) return loc;
    const parts = String(e.duration || '').split(/\s*\|\s*/);
    return parts.length >= 2 && /[a-z]/i.test(parts[1]) && !/\d{4}/.test(parts[1]) ? parts[1].trim() : '';
  }
  function _entryDescription(e) {
    const b = Array.isArray(e.bullets) ? e.bullets : Array.isArray(e.achievements) ? e.achievements : Array.isArray(e.description) ? e.description : [];
    const lines = b.map(x => String(typeof x === 'string' ? x : (x && x.text) || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const txt = lines.length ? lines.map(l => '• ' + l.replace(/^[•\-*]\s*/, '')).join('\n') : (typeof e.description === 'string' ? e.description.trim() : '');
    return txt.slice(0, 1990);
  }
  function _setSelect(sel, value) {
    const v = String(value);
    const opt = Array.from(sel.options).find(o => String(o.value) === v || String(o.text).trim() === v);
    if (!opt) return false;
    if (sel.value === opt.value) return true;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  async function fillExperienceForms(modal, config) {
    const forms = experienceEntryForms(modal);
    if (!forms.length) return 0;
    const cv = (config && config.cvProfile) || {};
    const entries = (Array.isArray(cv.experience) ? cv.experience : []).filter(e => e && String(e.title || e.role || e.position || '').trim() && _entryRangeClean(e));
    const nrm = (s) => _norm(s).trim();
    // Text shown OUTSIDE the open forms = entries LinkedIn already lists as cards (text nodes joined with spaces:
    // "<p>Your title</p><p>Data Engineer</p>" must not read "titledata engineer").
    const parts = [];
    try {
      const w = document.createTreeWalker(modal, NodeFilter.SHOW_TEXT);
      for (let tn = w.nextNode(); tn; tn = w.nextNode()) { if (!forms.some(f => f.contains(tn))) parts.push(tn.nodeValue); }
    } catch (_) {}
    const cardsText = ' ' + nrm(parts.join(' ')) + ' ';
    const used = new Set();
    let done = 0;
    for (const form of forms) {
      form.setAttribute('data-eam-exp', '1');
      const texts = Array.from(form.querySelectorAll('input[type="text"], input:not([type])'));
      const q = (el) => (el.getAttribute('aria-label') || getFieldQuestion(el, modal) || '');
      // v2.5.119 (telemetry 2026-10-17: "Major / Field of study", "Dates attended" → "Please enter a valid answer"): an
      // EDUCATION entry (school / degree / major + dates) has the same month + year selects — never fill it with a job.
      if (texts.some(el => _EDU_ENTRY_Q.test(q(el))) && !texts.some(el => /\b(company|employer|entreprise|job\s+title)\b/i.test(q(el)))) {
        try { if (await fillEducationEntry(form, modal, config, q)) done++; } catch (e) { u().log('Education entry fill error: ' + (e && e.message)); }
        continue;
      }
      let title = texts.find(el => _EXP_TITLE_Q.test(q(el)) && !_EXP_COMPANY_Q.test(q(el)));
      let company = texts.find(el => el !== title && _EXP_COMPANY_Q.test(q(el)));
      let city = texts.find(el => el !== title && el !== company && _EXP_CITY_Q.test(q(el)));
      const rest = texts.filter(el => el !== title && el !== company && el !== city);
      if (!title) title = rest.shift(); if (!company) company = rest.shift();
      const sels = Array.from(form.querySelectorAll('select'));
      const months = sels.filter(_isMonthSelect), years = sels.filter(_isYearSelect);
      const cur = Array.from(form.querySelectorAll('input[type="checkbox"]'))[0] || null;
      const desc = form.querySelector('textarea');
      // The entry's own buttons ("Delete experience", header "Save") sit next to the fields block: look up to 2 levels
      // above it while that level still holds only this entry (<= 2 month selects, no "Add work experience").
      let scopeEl = form;
      for (let k = 0; k < 2; k++) {
        const par = scopeEl.parentElement;
        if (!par || par === modal || Array.from(par.querySelectorAll('select')).filter(_isMonthSelect).length > 2) break;
        if (Array.from(par.querySelectorAll('button')).some(b => /add\s+(work\s+)?experience|ajouter\s+une\s+exp/i.test(b.textContent || ''))) break;
        scopeEl = par;
      }
      const del = Array.from(scopeEl.querySelectorAll('button')).find(b => /delete|remove|supprimer|retirer|eliminar|borrar|l[öo]schen|elimina/i.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')));
      const titleVal = String((title && title.value) || '').trim(), compVal = String((company && company.value) || '').trim();
      const fromSet = !!(months[0] && months[0].value && years[0] && years[0].value);
      // Which CV entry: the one this form already names, else the next CV role not shown as a card.
      let e = null;
      if (titleVal || compVal) {
        e = entries.find(x => !used.has(x) && ((titleVal && nrm(x.title || x.role || x.position) === nrm(titleVal)) || (compVal && x.company && nrm(x.company) === nrm(compVal))));
      } else {
        e = entries.find(x => !used.has(x) && !(cardsText.includes(' ' + nrm(x.title || x.role || x.position) + ' ') && (!x.company || cardsText.includes(' ' + nrm(x.company) + ' '))));
      }
      if (!e) {
        if (!titleVal && !compVal && !fromSet && del) {
          del.click();
          u().log(`Work experience: no dated CV role left to add — empty entry removed (never invented)`);
          await u().wait(600);
          done++;
        } else {
          u().log(`Work experience entry "${titleVal || compVal || '(empty)'}": no matching dated CV role — left as is`);
          if (!titleVal || !fromSet) _noteUnknownField('Work experience: ' + (titleVal || 'title / dates'));
        }
        continue;
      }
      used.add(e);
      const r = _entryRangeClean(e);
      const ongoing = _entryOngoing(e);
      const t = String(e.title || e.role || e.position).trim().slice(0, 200);
      if (title && !titleVal) u().fill(title, t);
      if (company && !compVal && e.company) u().fill(company, String(e.company).trim().slice(0, 200));
      if (!fromSet && r) {
        if (months[0]) _setSelect(months[0], (r[0] % 12) + 1);
        if (years[0]) _setSelect(years[0], Math.floor(r[0] / 12));
      }
      if (ongoing) {
        if (cur && !cur.checked) { const l = cur.id ? form.querySelector(`label[for="${CSS.escape(cur.id)}"]`) : null; (l || cur).click(); if (!cur.checked) cur.click(); await u().wait(400); }
      } else if (r) {
        const ms = Array.from(form.querySelectorAll('select')).filter(_isMonthSelect), ys = Array.from(form.querySelectorAll('select')).filter(_isYearSelect);
        if (ms[1] && !ms[1].value) _setSelect(ms[1], (r[1] % 12) + 1);
        if (ys[1] && !ys[1].value) _setSelect(ys[1], Math.floor(r[1] / 12));
      }
      const loc = _entryLocation(e);
      if (city && !String(city.value || '').trim() && loc) u().fill(city, loc.slice(0, 100));
      const d = _entryDescription(e);
      if (desc && !String(desc.value || '').trim() && d) u().fill(desc, d);
      u().log(`Work experience entry filled from your CV: ${t}${e.company ? ' @ ' + e.company : ''} (${ongoing ? 'current role' : 'past role'})`);
      // The entry form has its own "Save" (header) on some layouts — commit it so Next validates the saved card.
      const save = Array.from(scopeEl.querySelectorAll('button')).find(b => /^(save|enregistrer|guardar|speichern|salva)$/i.test((b.textContent || '').trim()));
      if (save) { save.click(); u().log('Work experience entry saved'); await u().wait(800); }
      done++;
    }
    return done;
  }

  // v2.5.119: one education entry (LinkedIn "Education" step) ← the best CV degree: school, degree, major / field of
  // study, city (CV location only) and the year selects ("Dates attended"). Months only when the CV states them —
  // never an invented month. Fields already filled are kept.
  const _EDU_ENTRY_Q = /\b(school|university|college|institution|degree|major|field\s+of\s+study|[ée]cole|universit[ée]|dipl[oô]me|[ée]tablissement|discipline)\b/i;
  async function fillEducationEntry(form, modal, config, q) {
    const e = _bestEducation(config);
    if (!e) { u().log('Education entry: no education in your CV — left as is'); _noteUnknownField('Education: school / dates'); return false; }
    const texts = Array.from(form.querySelectorAll('input[type="text"], input:not([type])'));
    const school = String(e.school || '').split(',')[0].trim();
    const degree = String(e.degree || '').split(',')[0].trim();
    const major = studyFieldAnswer(config);
    const loc = String(e.location || '').trim() || (String(e.school || '').split(',').slice(1).join(',').trim());
    let n = 0;
    for (const el of texts) {
      if (String(el.value || '').trim()) continue;
      const lab = q(el);
      let v = '';
      if (/\b(major|field\s+of\s+study|discipline|specializ|specialis|domaine|fili[èe]re)\b/i.test(lab)) v = major;
      else if (/\b(school|university|college|institution|[ée]cole|universit[ée]|[ée]tablissement)\b/i.test(lab)) v = school;
      else if (/\b(degree|dipl[oô]me|qualification)\b/i.test(lab)) v = degree;
      else if (/\b(city|ville|location|lieu)\b/i.test(lab)) v = loc;
      if (!v) continue;
      if (isTypeaheadInput(el)) await _typeaheadPick(el, v, modal); else u().fill(el, v.slice(0, 200));
      n++;
    }
    const yrs = educationYears(e);
    const sels = Array.from(form.querySelectorAll('select'));
    const years = sels.filter(_isYearSelect);
    if (yrs && years.length) {
      if (years.length >= 2) {
        if (yrs.from && !years[0].value) _setSelect(years[0], yrs.from);
        if (!years[1].value) _setSelect(years[1], yrs.to);
      } else if (!years[0].value) _setSelect(years[0], yrs.to);
      n++;
    }
    u().log(`Education entry filled from your CV: ${degree || major}${school ? ' — ' + school : ''}${yrs ? ' (' + (yrs.from ? yrs.from + '–' : '') + yrs.to + ')' : ''}`);
    const save = Array.from(form.querySelectorAll('button')).find(b => /^(save|enregistrer|guardar|speichern|salva)$/i.test((b.textContent || '').trim()));
    if (save) { save.click(); await u().wait(800); }
    return n > 0;
  }
  // A typeahead (school / major) — type the value and pick the suggestion that names it; none → the typed text stays.
  async function _typeaheadPick(input, value, modal) {
    const st = u();
    try { input.focus(); } catch (_) {}
    st.fill(input, value);
    const want = _normLoc(value);
    for (let k = 0; k < 15; k++) {
      await st.wait(200);
      const lb = _typeaheadListbox(input, modal);
      const opts = lb ? Array.from(lb.querySelectorAll('[role="option"]')) : [];
      const hit = opts.find(o => _normLoc(o.textContent) === want) || opts.find(o => _normLoc(o.textContent).startsWith(want)) || opts.find(o => _normLoc(o.textContent).includes(want));
      if (hit) { (hit.querySelector('[role="button"]') || hit).click(); await st.wait(300); return true; }
      if (opts.length && k > 6) break;
    }
    return false;
  }

  // ─── Master fill function ─────────────────────────────────────────────
  async function fillFormStep(modal, config) {
    try { await fillExperienceForms(modal, config); } catch (e) { u().log('Work experience fill error: ' + (e && e.message)); }
    await fillTextInputs(modal, config);
    await fillResumeInputs(modal);
    await fillCheckboxes(modal, config);
    await fillRadioButtons(modal, config);
    await fillSelectDropdowns(modal, config);
    await fillCustomDropdowns(modal);
    await fillTextareas(modal, config);
  }

  // v2.5.105: the form step is re-filled on every loop iteration, so ONE unanswerable field
  // used to count 3 times and discard the application by itself. Count each label once per
  // application (engine resets _unknownFieldLabels per job) and keep the labels for telemetry.
  // v2.5.112 (telemetry 2026-10-13: "Postal code" + "Country" + "Facebook", none required, discarded a UK
  // application by themselves): with the field at hand, only a REQUIRED field counts — an optional field left
  // empty never blocks LinkedIn's Next button.
  function _noteUnknownField(label, el, modal) {
    const st = u();
    if (el && !_isRequiredField(el, modal)) { st.log(`Optional field left empty: "${String(label || '').trim().slice(0, 60)}"`); return; }
    const key = String(label || '').trim().toLowerCase().slice(0, 120);
    st._unknownFieldLabels = st._unknownFieldLabels || [];
    if (key && st._unknownFieldLabels.map(s => s.toLowerCase()).includes(key)) return;
    st._unknownFieldLabels.push(String(label || '').trim().slice(0, 120));
    st._unknownFieldFails = (st._unknownFieldFails || 0) + 1;
  }

  // ─── v2.5.105: repair LinkedIn validation errors before giving up ──────
  // Premium review 2026-10-09 ("when any different question is asked it just skips the
  // application"): one wrong-format answer = a red validation message = the whole application was
  // discarded. Read each visible error, find its field and fix what the message asks for, once.
  // Returns { fixed, details:[{msg,label}] } — details feed the form_skip_detail telemetry.
  const _ERR_SEL = '[role="alert"], .artdeco-inline-feedback--error, .fb-form-element-label__error';
  const _FIELD_SEL = '[data-test-form-element], .jobs-easy-apply-form-element, .fb-dash-form-element, fieldset, [class*="form-element"], .artdeco-text-input--container, [componentkey^="easyApplyFieldFocus"]';
  const _YES_RE = /^(yes|oui|sí|si|ja|sim|evet)$/i;
  // v2.5.109 (ops alert 2026-10-12): a FIELD error, not a toast. [role=alert] also carries toasts
  // ("Resume uploaded successfully", "Job moved to In progress…") → keywords there; the inline error
  // classes are errors whatever the wording ("Enter a whole number larger than 100", "Please make a
  // selection" were missed by the old keyword list → no repair, 10-step loop).
  const _FIELD_ERR_TXT = /please enter|valid answer|required|must be|invalid|make a selection|select an option|enter a\b|whole number|decimal number|larger than|greater than|smaller than|less than|between \d|characters or (fewer|less)|acceptable (document|file)|file format|too long|too short|veuillez|requis|obligatoire|saisi(ssez|r)|s[ée]lectionn|nombre entier|nombre d[ée]cimal|sup[ée]rieur [àa]|introduce|ingrese|obligatorio|erforderlich|bitte/i;
  const _NOT_FIELD_ERR = /n.avons pas pu envoyer votre candidature|(couldn.?t|could not|unable to|were unable to) (submit|send) your application|limit daily|daily submissions|easy apply limit|fast pace|temporarily paused|uploaded successfully|moved to in progress|answers? (have been|were) saved|enregistr[ée]es?\b|application (was )?sent|candidature envoy/i;
  const _errField = new WeakMap(); // native error element → its field
  function _shown(e) { return !!e && e.offsetParent !== null && !!String(e.textContent || '').trim(); }
  function fieldErrorElements(modal) {
    if (!modal) return [];
    const out = [];
    for (const e of modal.querySelectorAll(_ERR_SEL)) {
      if (!_shown(e)) continue;
      const t = String(e.textContent || '');
      if (_NOT_FIELD_ERR.test(t)) continue;
      const inlineCls = e.matches('.artdeco-inline-feedback--error, .fb-form-element-label__error');
      if (!inlineCls && !_FIELD_ERR_TXT.test(t)) continue;
      // an inline error nested in an [role=alert] wrapper: keep only one of the two
      if (out.some(o => o.contains(e) || e.contains(o))) continue;
      out.push(e);
    }
    // Native <dialog> (SDUI) forms: fields reference their error via aria-errormessage / aria-describedby
    // ("error-message-<id>") and/or carry aria-invalid="true".
    for (const f of modal.querySelectorAll('input, select, textarea, fieldset, [role="radiogroup"]')) {
      const ids = ((f.getAttribute('aria-errormessage') || '') + ' ' + (f.getAttribute('aria-describedby') || '')).split(/\s+/).filter(Boolean);
      const invalid = f.getAttribute('aria-invalid') === 'true';
      let hit = null;
      for (const id of ids) {
        let el = null; try { el = modal.querySelector('#' + CSS.escape(id)) || document.getElementById(id); } catch (_) {}
        if (!el || !_shown(el)) continue;
        const txt = String(el.textContent || '');
        if (_NOT_FIELD_ERR.test(txt)) continue;
        // an "…error…" id, or aria-invalid + an error-like message (not the "0 of 20 characters" helper)
        if (/error/i.test(id) || (invalid && _FIELD_ERR_TXT.test(txt))) { hit = el; break; }
      }
      if (hit && !out.some(o => o === hit || o.contains(hit) || hit.contains(o))) { _errField.set(hit, f); out.push(hit); }
    }
    // v2.5.109 (live 2026-10-12): Workable / SmartRecruiters questions in the native <dialog> show a bare
    // "<p>This field is required</p>" under the field — no error class, role, id or aria link, and no
    // aria-invalid on checkboxes / textareas → 4 jobs clicked Review 10× with 0 error seen (step_limit).
    // v2.5.126 (telemetry 2.5.120: 168 step_limit skips / 25 users in 7 days on the page before Review with errs=[] inv=0;
    // in 14 days native-dialog skips never reported one number / format message while legacy forms reported hundreds):
    // the native <dialog> shows EVERY field message as a bare text under the field, not only "This field is required".
    // "Enter a decimal number larger than 0.0", "Enter a whole number between 0 and 99" and translations that keep the
    // English "whole" / "decimal" token were invisible → no repair, Review clicked 10× (fixture SDUI_CTC / SDUI_NUM).
    for (const p of modal.querySelectorAll('p, span, div')) {
      if (p.children.length) continue;
      const t = String(p.textContent || '').trim();
      if (!t || t.length > 140 || !_shown(p)) continue;
      const req = t.length <= 80 && _REQ_MSG.test(t);
      if (!req && !_isFormatErrMsg(t, p)) continue;
      if (out.some(o => o === p || o.contains(p) || p.contains(o))) continue;
      let f = null;
      if (req) { for (let n = p.parentElement, k = 0; n && n !== modal && !f && k < 4; n = n.parentElement, k++) f = n.querySelector('input:not([type="hidden"]), select, textarea'); }
      else { f = _nearField(p, modal); if (!f) continue; } // a format message always sits under its own field
      if (f) _errField.set(p, f);
      out.push(p);
    }
    // v2.5.126: any OTHER text LinkedIn added under a field while Next / Review left the page unchanged (armed by the
    // engine only from the 2nd click on the same page) — whatever its wording or language.
    if (_clickSnap && _clickSnap.armed) {
      for (const { el, f } of newTextsAfterClick(modal)) {
        if (out.some(o => o === el || o.contains(el) || el.contains(o))) continue;
        _errField.set(el, f); out.push(el);
      }
    }
    return out;
  }
  // Number / format validation message — never a question (no "?" / "*" ending), never in a label / legend / button.
  const _FORMAT_ERR_RE = /^(please\s+)?(enter|provide|type|use)\s+(a|an)\s+(valid\s+)?(whole|decimal|positive|non-negative|numeric)?\s*(number|integer|amount|value|answer|date|email(\s+address)?|phone(\s+number)?|year|url|time)\b|^(the\s+)?(value|answer|number|amount|entry)\s+(must|should|has\s+to|needs\s+to)\s+be\b|^(must|should)\s+be\s+(a|an|between|less|greater|larger|smaller|at\s+(least|most)|no\s+more)\b|\b(whole|decimal)\b[^.?]{0,50}\d|\d[^.?]{0,50}\b(whole|decimal)\b|^(only\s+)?(numbers?|digits?|numeric\s+values?)\s+(are\s+)?(allowed|accepted)\b|^(saisissez|entrez|indiquez|veuillez\s+(saisir|entrer|indiquer))\s+(un|une)\s+(nombre|valeur|r[ée]ponse|montant|date)|^(introduce|ingresa|ingrese|escribe)\s+(un|una)\s+(n[uú]mero|valor|respuesta)|^(insira|digite|informe)\s+(um|uma)\s+(n[uú]mero|valor|resposta)|^geben\s+sie\s+(eine|einen)\s+(g[uü]ltige[nr]?\s+)?(zahl|wert|antwort|ganzzahl)|^inserisci\s+(un|una)\s+(numero|valore|risposta)/i;
  function _isFormatErrMsg(t, el) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 140 || /[?*]\s*$/.test(s) || /^\d[\d\s,./]*$/.test(s)) return false;
    if (/\d+\s*(\/|of|sur|de|von)\s*\d+/i.test(s) && /characters?|caract[eè]res|zeichen/i.test(s)) return false; // "4 of 20 characters"
    if (_NOT_FIELD_ERR.test(s)) return false;
    if (el && el.closest && el.closest('label, legend, button, footer, [role="listbox"], [role="option"]')) return false;
    return _FORMAT_ERR_RE.test(s);
  }
  // The field a message sits under (≤ 4 levels up, never past the form footer / the whole form).
  function _nearField(p, modal) {
    let f = null;
    for (let n = p.parentElement, k = 0; n && n !== modal && !f && k < 4; n = n.parentElement, k++) {
      if (n.querySelector('footer')) break;
      f = n.querySelector('input:not([type="hidden"]), select, textarea');
    }
    return f;
  }

  // ─── v2.5.126: did Next / Review move the form? ────────────────────────────
  // The engine snapshots the page right before each Next / Review click. A page still identical afterwards (same
  // progress, same fields, same headings) was refused; the texts LinkedIn added under a field are its messages.
  let _clickSnap = null;
  function _leafTexts(modal) {
    const out = [];
    try { for (const el of modal.querySelectorAll('p, span, div, small, li')) { if (el.children.length) continue; const t = String(el.textContent || '').replace(/\s+/g, ' ').trim(); if (t) out.push(t); } } catch (_) {}
    return out;
  }
  function pageSignature(modal) {
    if (!modal) return '';
    try {
      const t = String(modal.textContent || '');
      const pg = (t.match(/(\d+)\s*\/\s*(\d+)\s*pages?/i) || t.match(/(\d{1,3})\s*(%|percent)/i) || [''])[0];
      const fields = Array.from(modal.querySelectorAll('input:not([type="hidden"]), select, textarea')).map(el => el.id || el.name || el.getAttribute('aria-label') || el.type).join('|');
      const h = Array.from(modal.querySelectorAll('h1, h2, h3, legend')).map(x => String(x.textContent || '').trim().slice(0, 40)).join('|');
      return pg + '#' + fields + '#' + h;
    } catch (_) { return ''; }
  }
  // The texts are those of the FIRST click on this page: LinkedIn's message stays on screen between two clicks, so a
  // later snapshot would already contain it.
  function snapshotBeforeClick(modal) {
    if (!modal) { _clickSnap = null; return; }
    const sig = pageSignature(modal);
    if (_clickSnap && _clickSnap.sig === sig) { _clickSnap.armed = false; return; }
    _clickSnap = { sig, texts: new Set(_leafTexts(modal)), armed: false };
  }
  function clearClickSnapshot() { _clickSnap = null; }
  function samePageAsSnapshot(modal) { return !!(_clickSnap && modal && _clickSnap.sig && pageSignature(modal) === _clickSnap.sig); }
  function armNewTextErrors(modal) { if (samePageAsSnapshot(modal)) { _clickSnap.armed = true; return true; } return false; }
  // [{ el, f, text }] — visible leaf texts added under a field since the snapshot, page unchanged.
  function newTextsAfterClick(modal) {
    const out = [];
    if (!samePageAsSnapshot(modal)) return out;
    try {
      for (const el of modal.querySelectorAll('p, span, div, small, li')) {
        if (el.children.length || !_shown(el)) continue;
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length < 3 || t.length > 160 || _clickSnap.texts.has(t)) continue;
        if (_NOT_FIELD_ERR.test(t) || /^\d[\d\s,./%]*$/.test(t) || (/\d+\s*(\/|of|sur|de|von)\s*\d+/i.test(t) && /characters?|caract[eè]res|zeichen/i.test(t))) continue;
        if (el.closest('label, legend, button, footer, [role="listbox"], [role="option"], [data-eam-bot-notice]')) continue;
        const f = _nearField(el, modal);
        if (f) out.push({ el, f, text: t });
        if (out.length >= 4) break;
      }
    } catch (_) {}
    return out;
  }
  const _REQ_MSG = /^(this field is (required|mandatory)|this is a required field|required field|ce champ est (obligatoire|requis)|champ (obligatoire|requis)|please (make a selection|enter a valid answer|check this box|select an option|fill (in|out) this field)|este campo es (obligatorio|requerido)|campo obligatorio|dieses feld ist (erforderlich|ein pflichtfeld)|pflichtfeld|questo campo [èe] obbligatorio)\.?$/i;
  function _visibleErrors(modal) { return fieldErrorElements(modal); }
  function _errBox(err) {
    const f = _errField.get(err);
    if (f) return f.closest(_FIELD_SEL) || (f.parentElement && f.parentElement.parentElement) || f.parentElement;
    return err.closest(_FIELD_SEL) || err.parentElement;
  }
  function _errLabel(box, err, modal) {
    let lab = String(((box && box.querySelector('label, legend, [data-test-form-builder-radio-button-form-component__title]')) || {}).textContent || '').trim();
    if (!lab) {
      const f = _errField.get(err) || (box && box.querySelector('input, select, textarea'));
      if (f) { try { lab = f.tagName === 'FIELDSET' ? String((f.querySelector('input') || f).getAttribute('aria-label') || '') : getFieldQuestion(f, modal); } catch (_) {} }
      // v2.5.112: never the error text itself ("This field is required" was reported as the field label).
      if ((!lab || _REQ_MSG.test(lab.trim())) && box) { const p = Array.from(box.querySelectorAll('p')).find(x => { const t = String(x.textContent || '').trim(); return t && !_REQ_MSG.test(t) && !/^\d[\d,]*\s*\/\s*[\d,]+$|characters?$/i.test(t); }); lab = p ? p.textContent || '' : ''; }
    }
    if (_REQ_MSG.test(String(lab || '').trim())) lab = '';
    return String(lab || '').trim().replace(/\s+/g, ' ');
  }
  function validationErrorDetails(modal) {
    return _visibleErrors(modal).slice(0, 4).map(err => {
      const box = _errBox(err);
      return { msg: String(err.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90), label: _errLabel(box, err, modal).slice(0, 110) };
    });
  }
  // Questions whose answer must come from the profile, never from a "make the error go away" value.
  const _NO_REPAIR_Q = /gender|genre\b|sexe|race|ethnic|disabilit|handicap|veteran|date\s+of\s+birth|birth\s*date|\bd\.?o\.?b\b|naissance/i;
  async function repairValidationErrors(modal, config) {
    const details = validationErrorDetails(modal);
    let fixed = 0;
    for (const err of _visibleErrors(modal)) {
      const msg = String(err.textContent || '').toLowerCase();
      const box = _errBox(err);
      if (!box) continue;
      const label = _errLabel(box, err, modal);
      const input = box.querySelector('input[type="text"], input[type="number"], input:not([type]), textarea');
      const select = box.querySelector('select');
      const radios = Array.from(box.querySelectorAll('input[type="radio"]'));
      const cbs = Array.from(box.querySelectorAll('input[type="checkbox"]')).filter(c => c.id !== 'follow-company-checkbox');
      try {
        // v2.5.113: location typeahead with free text / nothing picked ("Please enter a valid answer", "This field is
        // required") → pick the suggestion naming the profile city.
        if (input && isTypeaheadInput(input) && /city|location|ville|localisation|ciudad|ubicaci|stadt|standort|citt/i.test(label + ' ' + (input.getAttribute('placeholder') || ''))) {
          if (await fillLocationTypeahead(input, config, modal)) { fixed++; u().log(`Validation repair: location typeahead "${label.slice(0, 40)}" picked`); }
          continue;
        }
        // v2.5.109: a required single checkbox = application consent (privacy notice / data processing / terms) →
        // ticked; a marketing opt-in is ticked only because the form refuses to go on without it (Théo's rule).
        if (cbs.length === 1 && !cbs[0].checked && !input && !select && !radios.length) {
          const cbt = _checkboxText(cbs[0], modal) + ' ' + label.toLowerCase();
          if (/consent|agree|terms|conditions|policy|privacy|accept|confirm|acknowledge|gdpr|rgpd|donn[ée]es|data|j'accepte|j'autorise|consentement|certif/.test(cbt) || isMarketingOptInLabel(cbt)) {
            const l = cbs[0].id ? modal.querySelector(`label[for="${CSS.escape(cbs[0].id)}"]`) : null;
            (l || cbs[0]).click();
            if (!cbs[0].checked) cbs[0].click();
            fixed++; u().log(`Validation repair: required checkbox ticked: ${cbt.slice(0, 60)}`);
          } else if (/^(yes|oui|s[ií]|ja)$/i.test(_checkboxOptionText(cbs[0], box)) && !isSelfDeclarationQuestion(cbt)) {
            const l = cbs[0].id ? modal.querySelector(`label[for="${CSS.escape(cbs[0].id)}"]`) : null;
            (l || cbs[0]).click();
            if (!cbs[0].checked) cbs[0].click();
            fixed++; u().log(`Validation repair: required "Yes" checkbox ticked: ${cbt.slice(0, 60)}`);
          } else if (workLocationAnswer(cbt, config) === 'yes') {
            // v2.5.112: "I'm local to the San Francisco Bay Area" — true for the profile city → ticked.
            const l = cbs[0].id ? modal.querySelector(`label[for="${CSS.escape(cbs[0].id)}"]`) : null;
            (l || cbs[0]).click();
            if (!cbs[0].checked) cbs[0].click();
            fixed++; u().log(`Validation repair: location statement ticked (your city): ${cbt.slice(0, 60)}`);
          } else u().log(`Validation repair: required checkbox "${cbt.slice(0, 50)}" not guessed`);
          continue;
        }
        // v2.5.109: pay / identity / EEO answers are never "repaired" into a made-up value
        // ("Enter a whole number larger than 100" on "current CTC" would have become 101).
        if (isPayQuestion(label) && !/how\s+many\s+years|years?\s+of\s+(experience|exp)/i.test(label)) {
          let sal = input ? salaryAnswer(label, config, input) : ''; // current pay only from the currentSalary setting
          // v2.5.126: the field wants a number ("Enter a decimal number larger than 0.0" under "current CTC", setting
          // "4.5 LPA") → the SAME amount as a plain number (450000; lakhs stay lakhs when the question asks LPA, monthly /
          // yearly follow the question). Never another value: a whole-number field only gets an exact whole number.
          if (sal && !/^\d+(\.\d+)?$/.test(sal) && /whole|decimal|d[ée]cimal|number|nombre|n[uú]mero|zahl|numero|entier|integer|amount|montant|digit/.test(msg)) {
            const p = parsePayAmount(sal);
            if (p && p.amount > 0) {
              const lakhQ = /\blpa\b|\blakhs?\b|\blacs?\b|\bin\s+lakh/i.test(label);
              const monthQ = /per\s+month|monthly|\/\s*month|par\s+mois|mensuel|al\s+mes|pro\s+monat/i.test(label);
              let n = lakhQ ? p.amount / 1e5 : (monthQ && !p.monthly ? p.amount / 12 : (!monthQ && p.monthly ? p.amount * 12 : p.amount));
              n = Math.round(n * 100) / 100;
              sal = String(n);
            } else sal = '';
          }
          if (sal && /whole|entier|integer|ganzzahl/.test(msg) && /^\d+\.\d+$/.test(sal) && Number(sal) !== Math.round(Number(sal))) sal = ''; // never rounded
          if (sal && sal !== String(input.value || '')) { u().fill(input, sal); fixed++; u().log(`Validation repair: pay "${label.slice(0, 50)}" → ${sal}`); }
          else u().log(`Validation repair: pay field "${label.slice(0, 50)}" left as is (no profile value) — ${msg.slice(0, 60)}`);
          continue;
        }
        if (_NO_REPAIR_Q.test(label) && !(select || radios.length)) { u().log(`Validation repair: "${label.slice(0, 50)}" not guessed`); continue; }
        // 1. Numbers: "Enter a whole number between 0 and 99", "Enter a decimal number larger than 0.0"
        if (input && /whole|entier|decimal|décimal|number|nombre|número|zahl|between|entre|larger than|greater than|supérieur|mayor que/.test(msg)) {
          const dec = /decimal|décimal/.test(msg);
          let v = parseFloat(String(input.value || '').replace(',', '.').replace(/[^\d.\-]/g, ''));
          if (_isYesNoNumericQ(label) && !(v >= 1)) v = 1; // v2.5.113: yes/no asked as a number → 1 (Yes)
          if (!isFinite(v)) { const y = yearsForQuestion(label, config); v = y && isFinite(y.years) ? y.years : 0; }
          const rng = msg.match(/(-?\d+(?:[.,]\d+)?)\s*(?:and|et|y|und|to|à|a|-)\s*(-?\d+(?:[.,]\d+)?)/);
          if (rng) { const lo = parseFloat(rng[1].replace(',', '.')), hi = parseFloat(rng[2].replace(',', '.')); v = Math.min(Math.max(v, lo), hi); }
          const gt = msg.match(/(?:larger|greater|supérieur|mayor)\s+(?:than|à|que)\s+(-?\d+(?:[.,]\d+)?)/);
          if (gt) { const lo = parseFloat(gt[1].replace(',', '.')); if (v <= lo) v = dec ? lo + 0.5 : Math.floor(lo) + 1; }
          const out = dec ? String(Math.round(v * 10) / 10) : String(Math.round(v));
          if (out !== String(input.value || '')) { u().fill(input, out); fixed++; u().log(`Validation repair: "${label.slice(0, 50)}" → ${out} (${msg.slice(0, 60)})`); }
          continue;
        }
        // 2. Too long: "must be 200 characters or fewer"
        const lim = msg.match(/(\d+)\s*(?:characters|caractères|caracteres|zeichen)/);
        if (input && lim && String(input.value || '').length > Number(lim[1])) { u().fill(input, String(input.value).slice(0, Number(lim[1]) - 1).trim()); fixed++; continue; }
        // 3. A selection is missing: select → "Yes" if offered, else the first real option; radios → Yes / first
        if (select && (!select.value || /select an option|sélectionnez|selecciona|make a selection|choose/i.test(select.options[select.selectedIndex]?.text || ''))) {
          const opts = Array.from(select.options).filter(o => o.value && !/select an option|sélectionnez|selecciona|choose|choisir/i.test(o.text));
          let pick = null;
          // v2.5.109: country / dial-code lists → the profile country; gender → "prefer not to say";
          // any other long list or EEO question → never a blind first option (was "Afghanistan").
          if (isCountryQuestion(label) || looksLikeCountryList(opts.map(o => o.text))) pick = findCountryOption(opts, o => o.text, config);
          else if (_isGenderChoice(label, opts.map(o => o.text))) pick = config && config.gender ? opts.find(o => matchGenderOption(o.text, config.gender)) : opts.find(o => _GENDER_DECLINE_RE.test(o.text || ''));
          else if (_NO_REPAIR_Q.test(label) || opts.length > 30 || isCurrentPayQuestion(label)) pick = null;
          else pick = opts.find(o => _YES_RE.test(o.text.trim())) || opts.find(o => !_isOtherOption(o.text)) || opts[0];
          if (pick) { select.value = pick.value; select.dispatchEvent(new Event('change', { bubbles: true })); fixed++; u().log(`Validation repair: select "${label.slice(0, 50)}" → ${pick.text.trim()}`); }
          else u().log(`Validation repair: select "${label.slice(0, 50)}" not guessed`);
          continue;
        }
        if (radios.length && !radios.some(r => r.checked)) {
          const txt = (x) => { const l = _radioLabel(box, x); return ((l && l.textContent) || x.value || '').trim(); };
          let r = null;
          if (_isGenderChoice(label, radios.map(txt))) r = config && config.gender ? radios.find(x => matchGenderOption(txt(x), config.gender)) : radios.find(x => _GENDER_DECLINE_RE.test(txt(x)));
          else if (_NO_REPAIR_Q.test(label) || isCurrentPayQuestion(label)) r = null;
          else r = radios.find(x => _YES_RE.test(txt(x))) || radios.find(x => !_isOtherOption(txt(x))) || radios[0];
          if (!r) { u().log(`Validation repair: radios "${label.slice(0, 50)}" not guessed`); continue; }
          const l = _radioLabel(box, r); (l || r).click();
          if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
          fixed++; continue;
        }
        // 4. Required free text left empty → the AI (premium), never an invented default
        if (input && !String(input.value || '').trim() && window.EAM.aiForm && window.EAM.aiForm.askAI) {
          const a = String(await window.EAM.aiForm.askAI(label, config, input.tagName === 'TEXTAREA' ? 'textarea' : (input.type || 'text')) || '').trim();
          if (a && !/^(skip|n\/a|none)$/i.test(a)) { u().fill(input, a); fixed++; }
        }
      } catch (e) { u().log('Validation repair error: ' + (e && e.message)); }
    }
    return { fixed, details };
  }

  // ─── Export ───────────────────────────────────────────────────────────
  window.EAM.FormFiller = {
    repairValidationErrors,
    validationErrorDetails,
    fieldErrorElements,
    // v2.5.126
    isFormatErrMsg: _isFormatErrMsg,
    pageSignature,
    snapshotBeforeClick,
    clearClickSnapshot,
    samePageAsSnapshot,
    armNewTextErrors,
    newTextsAfterClick,
    isPayQuestion,
    isCurrentPayQuestion,
    profileDateOfBirth,
    formatDobFor: _formatDobFor,
    parsePayAmount,
    profileCountry,
    currentRoleAnswer,
    latestCvRole,
    sectorOfYearsQuestion,
    isSelfDeclarationQuestion,
    NEGATIVE_OPTION_RE,
    yesNoNoAllowedReason,
    knownNoFromProfile,
    isYesNoOptions,
    YES_OPTION_RE,
    NO_OPTION_STRICT_RE,
    fillFormStep,
    fillTextInputs,
    fillResumeInputs,
    fillCheckboxes,
    fillExperienceForms,
    experienceEntryForms,
    deterministicTextAnswer,
    profileCountryName,
    postalCodeValue,
    workLocationAnswer,
    fillRadioButtons,
    fillSelectDropdowns,
    fillCustomDropdowns,
    isTypeaheadInput,
    fillLocationTypeahead,
    pickLocationOption,
    fillTextareas,
    getFieldLabel,
    getFieldQuestion,
    profileUrlKind,
    ownLinkedInUrl,
    yearsQuestionSkill,
    yearsForQuestion,
    totalYears,
    cvSpanYears,
    salaryAnswer,
    START_DATE_RE,
    isDateField,
    startDateAnswer,
    pickLanguageLevelOption,
    _languageTarget,
    _lowestLevelOption,
    fillLanguageLevelRadio,
    // v2.5.119
    studyFieldAnswer,
    educationYears,
    isAvailabilitySlot,
    countryCode,
    findCountryOption,
    regionForCity,
    fillEducationEntry,
    checkboxGroupPicks,
    isMarketingOptInLabel
  };
})();
