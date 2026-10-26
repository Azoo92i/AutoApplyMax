/**
 * AutoApplyMax - Universal Autofill
 * Standalone script that fills form fields on any website using heuristics.
 * Injected via chrome.scripting.executeScript from popup.js.
 * No dependency on EAM namespace, utils.js, engine.js, or adapters.
 */
(function () {
  'use strict';

  // Guard against multiple injections
  if (window.__eamAutofillLoaded) return;
  window.__eamAutofillLoaded = true;

  // ─── Field type detection (7 heuristics) ────────────────────────────

  const FIELD_MAP = {
    firstName: /\b(first.?name|fname|given.?name|prénom|prenom|nombre|vorname)\b/i,
    lastName:  /\b(last.?name|lname|family.?name|surname|nom.?de.?famille|apellido|nachname|cognome)\b/i,
    fullName:  /\b(full.?name|your.?name|name|nom.?complet)\b/i,
    email:     /\b(e?.?mail|courriel|correo)\b/i,
    phone:     /\b(phone|téléphone|telephone|telefono|telefon|mobile|portable|cell|móvil|cellulare|tel)\b/i,
    linkedinUrl: /\b(linkedin|linked.?in)\b/i,
    currentCompany: /\b(current.?company|entreprise.?actuelle|company.?name|société|current.?employer|employeur)\b/i,
    currentTitle: /\b(current.?title|titre.?actuel|job.?title|poste.?actuel|current.?role|current.?position)\b/i,
    city:      /\b(city|ville|ciudad|stadt|stad|woonplaats|città|location|localisation|ubicación|standort|adresse|address)\b/i,
    yearsOfExperience: /\b(experience|years|expérience|années|años|jahre|anni)\b/i,
    expectedSalary:    /\b(salary|compensation|remuneration|salaire|rémunération|sueldo|gehalt|stipendio|ctc|lpa|pay package)\b/i,
    portfolioUrl: /\b(portfolio|website|site.?web|personal.?site|github|personal.?url)\b/i,
    summary:   /\b(cover.?letter|summary|about.?you|presentation|lettre.?de.?motivation|résumé|additional.?info)\b/i
  };

  const AUTOCOMPLETE_MAP = {
    'given-name':    'firstName',
    'family-name':   'lastName',
    'name':          'fullName',
    'email':         'email',
    'tel':           'phone',
    'address-level2':'city',
    'organization':  'currentCompany',
    'organization-title': 'currentTitle',
    'url':           'portfolioUrl'
  };

  // ─── v2.5.90: question-aware helpers ────────────────────────────────
  // The broad FIELD_MAP regexes were matching whole screening QUESTIONS:
  // "Will you require sponsorship … in your current location?" got the city,
  // "Are you subject to any employment agreements?" got the company, and
  // "Do you have practical fluency across the LLM ecosystem?" got the years
  // (gate 2026-09-26, Greenhouse/Lever). Questions now only get explicit
  // answers (deterministic yes/no, years, salary) or go to the AI.

  // v2.5.90: open shadow roots (SmartRecruiters spl-* web components render
  // the whole form in shadow DOM → autofill saw 0 fields, gate 2026-09-26).
  function deepAll(selector, root) {
    const out = [];
    const walk = (r) => {
      r.querySelectorAll(selector).forEach(e => out.push(e));
      r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); });
    };
    walk(root || document);
    return out;
  }
  function labelFor(el) {
    const id = el.getAttribute('id');
    if (!id) return null;
    const root = el.getRootNode && el.getRootNode();
    return (root && root.querySelector ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : null)
      || document.querySelector(`label[for="${CSS.escape(id)}"]`);
  }
  const upOne = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;

  const QUESTION_RE = /\?|^\s*(are|do|does|did|will|would|have|has|is|can|could|should|were|was|why|what|how|when|where|which|please|describe|tell us|êtes|avez|pouvez|seriez|quel|quelle|pourquoi|comment)\b/i;
  // EEO / voluntary self-identification: never answered by autofill (the
  // candidate decides; guessing "No" to "Are you Hispanic/Latino?" is invented data).
  // v2.5.100: accessibility / accommodation requests are the candidate's call too (gate 2026-10-04:
  // the AI answered "No" to Greenhouse's "…accessible and inclusive interview… any adjustments?").
  const EEO_RE = /\b(gender|genre|sexe|sex|race|racial|ethnic\w*|ethnicit\w*|hispanic|latin[oax]|veteran|disabilit\w*|handicap\w*|sexual orientation|transgender|pronouns?|self[- ]identif\w*|accommodat\w*|accessib\w*|reasonable adjustments?|adjustments? (we|to)\b|am[ée]nagements?)\b/i;
  const MARKETING_RE = /(marketing|newsletter|promot|job alert|alerts|offers|updates|sms|whatsapp|text message|talent (community|network|pool)|future (opportunit|roles|openings|positions)|other (opportunit|openings|roles)|contact me about|keep me informed|stay in touch)/i;
  const NOT_AUTO_CONSENT_RE = /(arbitration|waive|non[- ]?compete|background check|credit check|drug test)/i;

  // Visible question text for a control: explicit label, aria-label, or the
  // closest label-like element in the surrounding question block (Lever
  // `.application-label`, Ashby / Greenhouse question containers).
  // v2.5.117: visible text only — icon fallbacks ("SVGs not supported by this browser.") and aria-hidden bits
  // were read as the question (Workable "Notice period" combobox → AI asked "CA_10627 SVGs not supported…").
  function cleanText(node) {
    if (!node) return '';
    try {
      const c = node.cloneNode(true);
      c.querySelectorAll('svg, desc, title, script, style, [aria-hidden="true"]').forEach(x => x.remove());
      return (c.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (_) { return String(node.textContent || '').replace(/\s+/g, ' ').trim(); }
  }
  function questionText(el) {
    const id = el.getAttribute('id');
    if (id) {
      const l = labelFor(el);
      const t = l && cleanText(l);
      if (t && t.length >= 3) return t.slice(0, 300);
    }
    // v2.5.117: aria-labelledby (Workable custom selects point at a span holding the question).
    const lb = (el.getAttribute('aria-labelledby') || '').trim();
    if (lb) {
      const root = el.getRootNode && el.getRootNode();
      const t = lb.split(/\s+/).map(x => (root && root.getElementById ? root.getElementById(x) : null) || document.getElementById(x)).filter(Boolean).map(cleanText).join(' ').trim();
      if (t.length >= 3) return t.slice(0, 300);
    }
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria.length >= 3) return aria.slice(0, 300);
    let node = upOne(el);
    const own = el.getAttribute('name');
    for (let i = 0; i < 5 && node; i++, node = upOne(node)) {
      // Stop once the container holds another question's control — its label
      // would belong to that other field (e.g. the form's first "First Name").
      const others = [...node.querySelectorAll('input:not([type=hidden]), textarea, select')]
        .filter(c => c !== el && !(own && c.getAttribute('name') === own));
      if (others.length) break;
      const cand = node.querySelector('.application-label, label, legend, [class*="question" i], [class*="label" i]');
      if (cand) {
        const t = cleanText(cand);
        if (t.length >= 3 && t.length <= 300) return t;
      }
    }
    return '';
  }

  // A label is worth sending to the AI only if it carries real words
  // (not just "cards[uuid][field0] Type your response").
  function meaningfulLabel(s) {
    const cleaned = String(s || '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, ' ')
      .replace(/\b\d{5,}\b/g, ' ')
      .replace(/\b(cards?|field\d*|question|type your response|start typing\.*|pick date\.*|select\.*)\b/gi, ' ');
    return (cleaned.match(/[A-Za-zÀ-ÿ]{3,}/g) || []).length >= 2;
  }

  function isYesNo(v) { return /^(yes|no)$/i.test(String(v || '')); }
  // Deterministic answers to common yes/no screening questions from settings.
  function deterministicAnswer(q, config) {
    const s = String(q || '').toLowerCase();
    const yn = (v) => (String(v || '').toLowerCase() === 'yes' ? 'Yes' : String(v || '').toLowerCase() === 'no' ? 'No' : null);
    if (/sponsor/.test(s)) return yn(config.visaSponsorship);
    if (/(legally )?(authori[sz]ed|eligible|right) to work|work (authori[sz]ation|permit)|autoris[ée] à travailler/.test(s)) return yn(config.legallyAuthorized);
    if (/relocat|déménag/.test(s)) return yn(config.willingToRelocate);
    if (/driv(er'?s|ing) licen[cs]e|permis de conduire/.test(s)) return yn(config.driversLicense);
    // v2.5.93: self-declarations (worked for us before, relatives, conflicts, restrictive
    // agreements) → No, same policy as the LinkedIn engine (FormFiller when loaded).
    const FF = window.EAM && window.EAM.FormFiller;
    if ((FF && FF.isSelfDeclarationQuestion && FF.isSelfDeclarationQuestion(q)) || SELF_DECL_LITE.test(s)) return 'No';
    // "Are you currently located in Bangalore?" → compare with the profile city / country.
    const m = String(q || '').match(/\b(?:located|based|living|residing|reside|live)\s+in\s+([^?*\n]{2,60})/i);
    if (m && /^\s*(are|do)\s+you\b/i.test(String(q)) && (config.city || config.country)) {
      const place = m[1].toLowerCase();
      const mine = [config.city, config.country].filter(Boolean).map(x => String(x).toLowerCase());
      return mine.some(x => place.includes(x) || x.includes(place.trim())) ? 'Yes' : 'No';
    }
    return null;
  }
  // v2.5.117: "How did you hear about us?" — answered only with the job board the candidate really came from
  // (the page's referrer); never guessed (gate 2026-10-16: required Lever select left on "Select…", premium AI
  // returned "" on Workable).
  const SOURCE_Q = /how\s+did\s+you\s+(first\s+)?(hear|find|learn|come\s+across)|where\s+did\s+you\s+(first\s+)?(hear|find|see|learn)|how\s+were\s+you\s+referred|comment\s+avez[- ]vous\s+(connu|entendu|trouv[ée]|d[ée]couvert|eu\s+connaissance)|o[uù]\s+avez[- ]vous\s+(vu|trouv[ée]|entendu)|source\s+of\s+(application|candidature)|source\s+de\s+(la\s+)?candidature/i;
  function referrerSource() {
    try {
      const h = new URL(document.referrer).hostname.toLowerCase();
      if (!h || h === location.hostname.toLowerCase()) return null;
      const map = [[/linkedin\./, 'LinkedIn'], [/indeed\./, 'Indeed'], [/glassdoor\./, 'Glassdoor'], [/welcometothejungle\./, 'Welcome to the Jungle'], [/monster\./, 'Monster'], [/google\./, 'Google']];
      const hit = map.find(([re]) => re.test(h));
      return hit ? hit[1] : null;
    } catch (_) { return null; }
  }
  const SELF_DECL_LITE =/\b(previously|formerly|ever|currently|presently)\b.{0,30}\b(worked|employed|consulted)\b.{0,20}\b(at|for|by|with)\b|\b(former|current|ex[- ])\s*employee\b|\bconflict of interest\b|\brelatives?\b.{0,40}\b(work|employ)|\bpost-employment\b|\bnon-?compete\b|\bemployment agreements?\b/i;

  const PREFERRED_NAME_RE = /preferred\s+(first\s+)?name|name\s+you.?d\s+prefer|name\s+you\s+prefer|prefer(red)?\s+to\s+be\s+called|\bnickname\b|\bknown\s+as\b|chosen\s+name|pr[ée]nom\s+d.usage|voorkeursnaam|roepnaam|bevorzugter?\s+name|nombre\s+preferido/i;
  const COVER_LETTER_RE = /cover[\s_-]*letter|covering\s+letter|motivation(al)?[\s_-]*letter|lettre\s+de\s+motivation|motivatiebrief|sollicitatiebrief|anschreiben|motivationsschreiben|carta\s+de\s+(presentaci[oó]n|motivaci[oó]n)|lettera\s+di\s+presentazione|hiring[\s_-]*manager[\s_-]*message|message\s+(to|for)\s+(the\s+)?(hiring|recruit)|laat\s+het\s+bedrijf\s+weten|let\s+the\s+company\s+know\s+(why\s+)?you.?re\s+interested/i;
  function isCoverLetterField(el, qText) {
    if (el.tagName !== 'TEXTAREA') return false;
    const own = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('data-qa'), el.getAttribute('data-testid')].join(' ');
    return COVER_LETTER_RE.test(own) || (!!qText && qText.length < 160 && COVER_LETTER_RE.test(qText));
  }
  // The job on this page (title / company / description excerpt) — for a tailored cover note. Read-only DOM scrape.
  function pageJobContext() {
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const meta = (n) => clean((document.querySelector(`meta[property="${n}"], meta[name="${n}"]`) || {}).content);
    const vis = (e) => e && e.getBoundingClientRect && e.getBoundingClientRect().width > 0;
    const h = [...document.querySelectorAll('h1, .posting-headline h2, .app-title, [data-qa="job-title"], [class*="job-title" i], [class*="jobTitle" i]')].find(e => vis(e) && clean(e.textContent).length >= 3 && clean(e.textContent).length <= 140);
    let title = clean(h && h.textContent) || meta('og:title') || clean(document.title).split(/\s+[|–—-]\s+/)[0];
    title = title.replace(/^(job\s+application\s+for|apply\s+(for|to)|application\s+for)\s+/i, '').replace(/\s+at\s+[^@]{2,60}$/i, '').slice(0, 140);
    let company = meta('og:site_name');
    if (!company || /greenhouse|lever|ashby|workable|smartrecruiters|teamtailor|recruitee|personio|indeed|glassdoor/i.test(company)) {
      // SmartRecruiters one-click: /oneclick-ui/company/<Company>/publication/… (live 2026-10-17 read "Oneclick Ui").
      const _parts = location.pathname.split('/').filter(Boolean); const _ci = _parts.indexOf('company');
      const seg = ((_ci >= 0 && _parts[_ci + 1]) || (/^(oneclick-ui|o|j|jobs|careers)$/i.test(_parts[0] || '') ? '' : _parts[0]) || '');
      const byHost = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com/i.test(location.hostname) ? seg
        : /teamtailor|recruitee|personio/i.test(location.hostname) ? location.hostname.split('.')[0] : '';
      const t = clean(document.title).match(/\bat\s+([^|–—-]{2,60})/i);
      company = (t && t[1]) || byHost.replace(/[-_]+/g, ' ') || company || '';
      if (company && company === company.toLowerCase()) company = company.replace(/\b[a-z]/g, m => m.toUpperCase());
    }
    let desc = '';
    const blocks = [...document.querySelectorAll('[class*="description" i], [id*="description" i], [data-qa*="description" i], article, main')]
      .filter(e => vis(e) && !e.querySelector('input, textarea, select'));
    for (const b of blocks) { const t = clean(b.innerText || b.textContent); if (t.length > desc.length) desc = t; }
    if (!desc) desc = meta('og:description') || meta('description');
    return { title: clean(title), company: clean(company), description: desc.slice(0, 1800) };
  }
  // v2.5.119: answers in the FORM's language (live 2026-10-17: Dutch SmartRecruiters form got an English answer).
  const LANG_NAMES = { en: 'English', fr: 'French', nl: 'Dutch', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };
  const LANG_WORDS_STOP = {
    en: /\b(the|and|your|you|with|what|are|please|have|this|for|why|how|our)\b/g,
    fr: /\b(le|la|les|et|vous|votre|vos|des|une|pour|avec|quel|quelle|pourquoi|êtes|avez|nous|est)\b/g,
    nl: /\b(de|het|een|en|je|jouw|uw|van|met|voor|wat|waarom|bent|heb|ons|onze|niet|bij|kies|bestand)\b/g,
    de: /\b(der|die|das|und|sie|ihr|ihre|mit|für|was|warum|sind|haben|wir|unser|nicht|bitte)\b/g,
    es: /\b(el|los|las|y|usted|tu|su|con|para|qué|por|eres|tiene|nuestro|nuestra)\b/g,
    it: /\b(il|lo|gli|e|tu|tuo|tua|con|per|che|perché|sei|hai|nostro|nostra)\b/g,
    pt: /\b(os|as|e|você|seu|sua|com|para|que|porque|é|tem|nosso|nossa|não)\b/g,
  };
  function detectFormLanguage() {
    try {
      const txt = deepAll('label, legend, h1, h2, h3, button, [class*="label" i], [class*="question" i], p').slice(0, 300)
        .map(e => (e.textContent || '')).join(' ').toLowerCase().replace(/\s+/g, ' ').slice(0, 8000);
      const score = {};
      for (const [k, re] of Object.entries(LANG_WORDS_STOP)) score[k] = (txt.match(re) || []).length;
      const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
      const htmlLang = String(document.documentElement.getAttribute('lang') || '').toLowerCase().slice(0, 2);
      if (ranked[0][1] >= 8 && ranked[0][1] >= (ranked[1][1] || 0) * 1.4) return LANG_NAMES[ranked[0][0]];
      if (LANG_NAMES[htmlLang]) return LANG_NAMES[htmlLang];
      return ranked[0][1] >= 4 ? LANG_NAMES[ranked[0][0]] : '';
    } catch (_) { return ''; }
  }
  // A field the form REQUIRES (attribute, aria, or "*" / "required" in its label).
  function isRequiredField(el) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    const q = questionText(el) || '';
    return /[*✱]\s*$|\(required\)|\brequired\b|obligatoire|verplicht|erforderlich|obligatorio/i.test(q);
  }
  // Free plan / AI unavailable: a REQUIRED cover-letter box gets 2 plain sentences from the job title + the profile
  // (latest CV title, years setting) — nothing invented. Optional box → left empty.
  function genericCoverNote(config, job, lang) {
    const role = (job && job.title) || '';
    const co = (job && job.company) || '';
    const cur = String(config.currentTitle || '').trim();
    const yrs = parseInt(config.yearsOfExperience, 10);
    const L = {
      English: [`I am applying for the ${role ? role + ' position' : 'position'}${co ? ' at ' + co : ''}.`, cur ? ` My background as ${cur}${yrs > 0 ? ' (' + yrs + ' years of experience)' : ''} fits this role, and I would welcome the chance to discuss it with you.` : ' I would welcome the chance to discuss how my background fits this role.'],
      French: [`Je vous adresse ma candidature pour le poste${role ? ' de ' + role : ''}${co ? ' chez ' + co : ''}.`, cur ? ` Mon expérience de ${cur}${yrs > 0 ? ' (' + yrs + ' ans d’expérience)' : ''} correspond à ce rôle et je serais ravi(e) d’en échanger avec vous.` : ' Je serais ravi(e) d’échanger avec vous sur l’adéquation de mon parcours avec ce poste.'],
      Dutch: [`Hierbij solliciteer ik naar de functie${role ? ' ' + role : ''}${co ? ' bij ' + co : ''}.`, cur ? ` Mijn achtergrond als ${cur}${yrs > 0 ? ' (' + yrs + ' jaar ervaring)' : ''} past bij deze rol en ik licht dit graag toe in een gesprek.` : ' Ik licht graag in een gesprek toe hoe mijn achtergrond bij deze rol past.'],
      German: [`Hiermit bewerbe ich mich für die Position${role ? ' ' + role : ''}${co ? ' bei ' + co : ''}.`, cur ? ` Mein Hintergrund als ${cur}${yrs > 0 ? ' (' + yrs + ' Jahre Erfahrung)' : ''} passt zu dieser Rolle, und ich freue mich auf ein Gespräch.` : ' Ich freue mich darauf, in einem Gespräch zu zeigen, wie mein Hintergrund zu dieser Rolle passt.'],
      Spanish: [`Me postulo para el puesto${role ? ' de ' + role : ''}${co ? ' en ' + co : ''}.`, cur ? ` Mi experiencia como ${cur}${yrs > 0 ? ' (' + yrs + ' años de experiencia)' : ''} encaja con este puesto y me encantaría comentarlo con ustedes.` : ' Me encantaría comentar con ustedes cómo mi perfil encaja con este puesto.'],
    };
    const t = L[lang] || L.English;
    return (t[0] + t[1]).replace(/\s+/g, ' ').trim();
  }
  // v2.5.119: cover letter / message to the hiring team. Premium → a short note tailored to the job on the page (AI,
  // grounded in the CV). Free (or AI empty) → left empty unless the form requires it (then genericCoverNote).
  async function fillCoverLetter(input, config) {
    const job = pageJobContext();
    const lang = config.formLanguage || 'English';
    const ai = window.EAM && window.EAM.aiForm;
    if (ai && ai.askAI && !aiBlocked()) {
      let a = null;
      try { a = await ai.askAI('Cover letter', Object.assign({}, config, { jobContext: job, coverNote: true }), 'textarea'); } catch (_) { a = null; }
      if (a && !NON_ANSWER_RE.test(String(a)) && String(a).trim().length >= 40) return { value: String(a).trim(), how: 'ai' };
    }
    if (isRequiredField(input)) return { value: genericCoverNote(config, job, lang), how: 'generic' };
    return null;
  }

  function classifyField(el) {
    // 1. autocomplete attribute
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
    if (AUTOCOMPLETE_MAP[ac]) return AUTOCOMPLETE_MAP[ac];

    // 2. input type (before the question check: an email/tel input is that field)
    const type0 = (el.getAttribute('type') || '').toLowerCase();
    if (type0 === 'email') return 'email';
    if (type0 === 'tel') return 'phone';

    // v2.5.90: screening questions and EEO fields never take a profile value
    // from the broad regexes below. Long statements ("It is important to us to
    // create an accessible … interview experience") count as questions too.
    const qText = questionText(el);
    if (qText && EEO_RE.test(qText)) return 'eeo';
    // v2.5.119 (live 2026-10-17, Greenhouse "What's the name you'd prefer us to use throughout the interview process?"
    // got "Sophie Bernard" from the AI): a preferred / chosen name = the first name only.
    if (PREFERRED_NAME_RE.test(qText || '') || PREFERRED_NAME_RE.test([el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '))) return 'preferredName';
    // v2.5.119: the cover-letter / message-to-the-hiring-team box is never the profile summary (live 2026-10-17 Workable
    // "cover_letter" got the summary) — see fillCoverLetter.
    if (isCoverLetterField(el, qText)) return 'coverLetter';
    const identity = /\b(e-?mail|phone|téléphone|first name|last name|prénom|nom de famille|linkedin)\b/i.test(qText || '');
    if (qText && ((qText.length > 25 && QUESTION_RE.test(qText)) || (qText.length > 60 && !identity))) {
      if (/(how many|combien)[^?]{0,40}(years|ans|années)|years of (relevant |professional |work )?experience/i.test(qText)) return 'yearsOfExperience';
      if (/(salary|salaire|compensation|rémunération|pay expectation|\bctc\b|\blpa\b|pay package)/i.test(qText)) return 'expectedSalary';
      if (/linkedin/i.test(qText) && /(url|profile|link|profil)/i.test(qText)) return 'linkedinUrl';
      return 'question';
    }

    // 2. input type
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'email') return 'email';
    if (type === 'tel') return 'phone';

    // Collect all hints from multiple sources
    const hints = [];

    // 3. name / id attributes
    const name = el.getAttribute('name') || '';
    const id = el.getAttribute('id') || '';
    hints.push(name);
    hints.push(id.replace(/[-_]/g, ' '));

    // 4. aria-label
    hints.push(el.getAttribute('aria-label') || '');

    // 5. associated <label for="">
    if (id) {
      const labelEl = labelFor(el);
      if (labelEl) hints.push(labelEl.textContent);
    }

    // 6. placeholder
    hints.push(el.getAttribute('placeholder') || '');

    // 7. data-automation-id (Workday)
    hints.push(el.getAttribute('data-automation-id') || '');

    // 8. Proximity text — parent div/fieldset label/legend/span
    const parent = el.closest('div, fieldset, li, td');
    if (parent) {
      const nearby = parent.querySelector('label, legend, span');
      if (nearby && nearby.textContent.length < 80) {
        hints.push(nearby.textContent);
      }
    }

    // Wrapping parent <label>
    const parentLabel = el.closest('label');
    if (parentLabel) hints.push(parentLabel.textContent);

    const combined = hints.join(' ').trim();
    if (!combined) return null;

    // Match against field patterns — order matters (specific before generic).
    // currentCompany BEFORE lastName so "Nom d'entreprise" wins over "Nom".
    const ordered = ['email', 'phone', 'linkedinUrl', 'currentCompany', 'currentTitle', 'firstName', 'lastName', 'fullName', 'portfolioUrl', 'city', 'yearsOfExperience', 'expectedSalary', 'summary'];
    for (const key of ordered) {
      if (FIELD_MAP[key].test(combined)) return key;
    }

    // FALLBACK: plain French "Nom" with no qualifier → lastName.
    // Many French forms label the last-name field simply "Nom" (not "Nom de
    // famille"). We only trigger this when:
    //   - no other field matched above,
    //   - the combined hints don't contain "prénom" (which has 'nom' inside),
    //   - the hints don't contain a disambiguator ("nom d'entreprise",
    //     "nom complet", "nom de société", "nom de rue", etc.).
    const lower = combined.toLowerCase();
    if (
      /\bnom\b/.test(lower)
      && !/prénom|prenom/.test(lower)
      && !/(entreprise|complet|complète|complete|soci[ée]t[ée]|company|full|domaine|produit|utilisateur|projet|fichier|user|file|project|document|rue|avenue|city|ville)/.test(lower)
    ) {
      return 'lastName';
    }

    return null;
  }

  // ─── React-compatible value setter ──────────────────────────────────

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ─── v2.5.93: option picking for selects + comboboxes ───────────────
  // What the question needs: a deterministic yes/no, the user's country, or
  // their city. Anything else is left to the user (never guessed).
  function comboTarget(q, config) {
    const s = String(q || '');
    if (!s || EEO_RE.test(s)) return null;
    if (SOURCE_Q.test(s)) { const src = referrerSource(); return src ? { kind: 'source', value: src } : null; }
    const det = deterministicAnswer(s, config);
    if (det) return { kind: 'yesno', value: det };
    // v2.5.118: "Notice period / availability" select (Workable, live 2026-10-17 left on "Select an option…").
    if (/\b(notice\s*period|préavis|preavis|k[üu]ndigungsfrist|preaviso)\b/i.test(s) && config.noticePeriod) return { kind: 'notice', value: String(config.noticePeriod) };
    if (/\b(country|pays)\b/i.test(s) && config.country
        && (!/\?/.test(s) || /\b(country|pays)\b.{0,40}\b(reside|live|based|located|currently|résid|habit)|\b(reside|live|based|located|résid|habit).{0,40}\b(country|pays)\b/i.test(s))) return { kind: 'country', value: config.country };
    if (/\b(current location|location|city|ville|localisation|where are you (currently )?(based|located)|lieu|stad|stadt|ciudad|citt[aà]|cidade|woonplaats|wohnort)\b/i.test(s) && !/(relocat|sponsor|remote|onsite|on-site|willing)/i.test(s) && config.city) return { kind: 'city', value: config.city };
    return null;
  }
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // Notice period text → weeks (null = not a single duration, e.g. "1-3 months" / "Other").
  const _NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, six: 6, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, six_: 6 };
  function noticeWeeks(t) {
    const s = String(t || '').toLowerCase().trim();
    if (/^(immediate(ly)?|imm[ée]diat(ement)?|none|no notice|aucun|sofort|0)\b|\b(available|disponible)\s+(immediately|imm[ée]diatement)\b/.test(s)) return 0;
    if (/\d\s*[-–à]\s*\d|\bor\b|\bto\b|\bou\b|\+|more than|plus de|less than|moins de/.test(s)) return null;
    const m = s.match(/^(\d+|one|two|three|four|six|un|une|deux|trois|quatre)\s*(weeks?|semaines?|wochen?|months?|mois|monate?)\b/);
    if (!m) return null;
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : _NUM_WORDS[m[1]];
    return /^(week|semaine|woche)/.test(m[2]) ? n : n * 4;
  }
  function pickOption(items, q, config) {
    const tgt = comboTarget(q, config);
    if (!tgt) return null;
    const list = items.filter(x => x.text && !/^\s*(select|choose|sélectionner|choisir|--|please select)/i.test(x.text));
    if (tgt.kind === 'yesno') return list.find(x => (tgt.value === 'Yes' ? /^\s*(yes|oui)\b/i : /^\s*(no|non)\b/i).test(x.text)) || null;
    const v = norm(tgt.value);
    if (tgt.kind === 'notice') {
      // "1 month" ↔ "One month" / "1 mois" / "4 weeks"; "immediately" ↔ "Immediate" / "Immédiatement" / "None".
      const weeks = noticeWeeks(v);
      if (weeks === null) return list.find(x => norm(x.text) === v) || null;
      return list.find(x => noticeWeeks(norm(x.text)) === weeks) || null;
    }
    if (tgt.kind === 'source') return list.find(x => norm(x.text) === v) || list.find(x => norm(x.text).includes(v)) || null;
    if (tgt.kind === 'city') {
      // "Paris, Île-de-France, FRA" before "Paris, TX, USA": prefer the suggestion in the user's country.
      const c = String(config.country || '');
      // v2.5.119 (live 2026-10-17, SmartRecruiters NL: "Parijs, Île-de-France, Frankrijk"): the suggestions come in the
      // site's language — country names in other languages, and the city's own localised spelling (same country only).
      const cNames = countryNamesFor(c);
      const inCountry = (t) => c && (norm(t).includes(norm(c)) || new RegExp('\\b' + c.slice(0, 3).toUpperCase() + '\\b').test(t) || cNames.some(n => norm(t).includes(n)));
      const cands = list.filter(x => norm(x.text) === v || norm(x.text).startsWith(v + ',') || norm(x.text).startsWith(v + ' '));
      const best = cands.find(x => inCountry(x.text));
      if (best) return best;
      const first = (t) => norm(t).split(',')[0].trim();
      const near = (a, b) => a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4) && Math.abs(a.length - b.length) <= 2;
      const loc = list.find(x => inCountry(x.text) && near(first(x.text), v.split(',')[0].trim()));
      if (loc) return loc;
      if (c && cands.length > 1) return null;   // ambiguous city, none in the user's country → leave it
    }
    return list.find(x => norm(x.text) === v) || list.find(x => norm(x.text).startsWith(v + ',') || norm(x.text).startsWith(v + ' ')) || list.find(x => norm(x.text).startsWith(v)) || null;
  }
  // Country names in the languages the ATS pages use (EN / FR / NL / DE / ES / IT / PT), normalised.
  const COUNTRY_I18N = {
    FR: ['france', 'frankrijk', 'frankreich', 'francia', 'frança'], US: ['united states', 'usa', 'états-unis', 'etats-unis', 'verenigde staten', 'vereinigte staaten', 'estados unidos', 'stati uniti'],
    GB: ['united kingdom', 'royaume-uni', 'verenigd koninkrijk', 'vereinigtes königreich', 'reino unido', 'regno unito'], DE: ['germany', 'allemagne', 'duitsland', 'deutschland', 'alemania', 'germania', 'alemanha'],
    ES: ['spain', 'espagne', 'spanje', 'spanien', 'españa', 'spagna', 'espanha'], IT: ['italy', 'italie', 'italië', 'italien', 'italia', 'itália'], NL: ['netherlands', 'pays-bas', 'nederland', 'niederlande', 'países bajos', 'paesi bassi', 'países baixos'],
    BE: ['belgium', 'belgique', 'belgië', 'belgien', 'bélgica', 'belgio'], CH: ['switzerland', 'suisse', 'zwitserland', 'schweiz', 'suiza', 'svizzera', 'suíça'], IN: ['india', 'inde', 'indien', 'índia'],
    CA: ['canada', 'kanada', 'canadá'], PT: ['portugal', 'portogallo'], IE: ['ireland', 'irlande', 'ierland', 'irland', 'irlanda'], KR: ['south korea', 'corée du sud', 'zuid-korea', 'südkorea', 'corea del sur', 'corea del sud', 'coreia do sul'],
    LU: ['luxembourg', 'luxemburg', 'luxemburgo', 'lussemburgo'], AU: ['australia', 'australie', 'australië', 'australien', 'austrália'],
  };
  function countryNamesFor(c) {
    const n = norm(c); if (!n) return [];
    const code = n.length <= 3 ? (n === 'uk' ? 'GB' : n.toUpperCase()) : (Object.keys(COUNTRY_I18N).find(k => COUNTRY_I18N[k].includes(n)) || '');
    return code && COUNTRY_I18N[code] ? COUNTRY_I18N[code] : [n];
  }
  // v2.5.119 (SmartRecruiters spl-dropdown-item): the role=option div sits in the item's shadow root and the label is
  // slotted from the host's light DOM → the option's own textContent is empty. Read the host's text.
  function optionText(o) {
    const t = String(o.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) return t;
    const host = o.getRootNode && o.getRootNode().host;
    return host ? String(host.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }
  function visibleOptions(input) {
    const ids = (input.getAttribute('aria-controls') || input.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
    const root = input.getRootNode && input.getRootNode();
    let opts = [];
    for (const id of ids) { const lb = (root && root.getElementById ? root.getElementById(id) : null) || document.getElementById(id); if (lb) opts.push(...lb.querySelectorAll('[role="option"]')); }
    if (!opts.length) opts = deepAll('[role="option"], .select__option, [class*="option" i][id*="option" i], .dropdown-location');
    return opts.filter(o => o.getBoundingClientRect().width > 0 && o.getAttribute('aria-disabled') !== 'true'
      && !o.closest('.iti__country-list, .iti__dropdown-content'));   // intl-tel-input flag list is not this field's menu
  }
  function pressOption(o) {
    for (const t of ['mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) o.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }));
  }
  // Character-by-character typing: Lever's location autocomplete only queries on key events.
  async function typeChars(input, text) {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    let v = '';
    for (const ch of String(text)) {
      v += ch;
      // composed: SmartRecruiters / web-component forms listen across shadow boundaries (v2.5.119).
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: ch.charCodeAt(0), bubbles: true, composed: true }));
      if (d && d.set) d.set.call(input, v); else input.value = v;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: ch, inputType: 'insertText' }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, composed: true }));
      await new Promise(r => setTimeout(r, 60));
    }
  }
  let rsSeq = 0;
  const rsBridge = (marker, action, label) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'eam-react-select', marker, action, label }, (resp) => {
        if (chrome.runtime.lastError) resolve({ err: chrome.runtime.lastError.message }); else resolve(resp || { err: 'noresp' });
      });
    } catch (e) { resolve({ err: String(e.message || e) }); }
    setTimeout(() => resolve({ err: 'timeout' }), 4000);
  });
  function isReactSelect(input) {
    return /\bselect__input\b/.test(input.className || '') || !!input.closest('[class*="select__control" i]');
  }
  // v2.5.100: open questions left empty because AI answers are Premium (free plan) —
  // counted so the popup / page can say so instead of a silent partial fill.
  let openLeft = 0;
  const aiBlocked = () => !!(window.EAM && window.EAM.aiForm && window.EAM.aiForm.isPremiumBlocked && window.EAM.aiForm.isPremiumBlocked());

  // ─── v2.5.100: résumé upload ────────────────────────────────────────
  // The CV saved in the popup (chrome.storage.local resumeFile, same source as
  // the LinkedIn engine) goes into ONE file input that is clearly the résumé
  // field. Never a cover-letter / photo / transcript input, and never an ATS
  // "autofill from résumé" dropzone (Ashby, SmartRecruiters): those re-parse
  // the file and overwrite the fields.
  const FILE_AUTOFILL_RE = /autofill|auto-fill|automatisch|automatically|automatiquement|remplir automatiquement|eenvoudig solliciteren|apply with (indeed|linkedin|seek)|quick apply|parse your/i;
  const FILE_NOT_RESUME_RE = /cover|lettre|motivation|anschreiben|carta de presentaci|motivatiebrief|photo|picture|avatar|portrait|foto|headshot|transcript|relev[ée] de notes|portfolio|work sample|certificat|diploma|passport|id card|identity/i;
  const FILE_RESUME_RE = /r[ée]sum[ée]|curriculum|vitae|lebenslauf|curr[íi]culo|hoja de vida|(^|[^a-z])cv(?![a-z])/i;
  // Text nodes joined with spaces: textContent glues a heading to the next text
  // ("Cv" + "Kies een bestand" → "CvKies…", "CV.pdf" + "Remove" → "CV.pdfRemove").
  function spacedText(n) {
    const out = [];
    try {
      const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t && out.length < 60; t = w.nextNode()) { const s = t.nodeValue.trim(); if (s) out.push(s); }
    } catch (_) { return (n.textContent || '').replace(/\s+/g, ' ').trim(); }
    return out.join(' ').replace(/\s+/g, ' ');
  }
  function fileFieldKind(input) {
    const own = [input.id, input.name, input.getAttribute('aria-label'), input.getAttribute('data-qa'), input.getAttribute('data-testid')].filter(Boolean).join(' ');
    const lbl = labelFor(input);
    const texts = [own, lbl ? lbl.textContent : ''];
    let n = input;
    for (let i = 0; i < 7; i++) {
      n = upOne(n);
      if (!n || n === document.body || n === document.documentElement) break;
      if (deepAll('input[type="file"]', n).length > 1) break;   // container shared with another upload → stop
      texts.push(spacedText(n).slice(0, 200));
    }
    // nearest text first: the first decisive signal wins
    // A file name already shown in a résumé field ("Sophie_CV.pdf  Remove") = the form
    // already has a CV for this candidate → 'present', keep it (Théo 2026-10-04).
    const shown = texts.slice(2, 8).some(t => t && FILE_SHOWN_RE.test(t));
    for (const t of texts) {
      if (!t) continue;
      if (FILE_AUTOFILL_RE.test(t)) return 'autofill';
      if (FILE_NOT_RESUME_RE.test(t)) return 'other';
      if (FILE_RESUME_RE.test(t)) return shown ? 'present' : 'resume';
    }
    return 'unknown';
  }
  // A file name (with extension) displayed in the field's own container. "Accepted file
  // types: pdf, doc, docx" hints have no dot before the extension, so they don't match.
  const FILE_SHOWN_RE = /[\w)\]-]\.(pdf|docx?|rtf|odt|pages)\b/i;
  // Once per page: a second Autofill click, a re-render or the next step of a multi-step
  // form must never attach the résumé again (duplicate uploads, Théo 2026-10-04).
  let resumeAttachedOnPage = null;
  async function attachResume() {
    if (resumeAttachedOnPage) { console.log('[EAM Autofill] résumé already attached on this page — not again'); return null; }
    let st = null;
    try { st = await chrome.storage.local.get(['resumeFile', 'resumeFileName', 'resumeFileType']); } catch (_) { return null; }
    if (!st || !st.resumeFile || !st.resumeFileName) return null;
    const fileInputs = deepAll('input[type="file"]');
    // The form already holds a CV (a résumé input with a file, or a file name shown in a
    // résumé field) → keep it, upload nothing.
    for (const input of fileInputs) {
      const kind = fileFieldKind(input);
      if (kind === 'present' || (kind === 'resume' && input.files && input.files.length)) {
        console.log('[EAM Autofill] the form already has a résumé — kept, nothing uploaded');
        return null;
      }
    }
    for (const input of fileInputs) {
      if (input.disabled || (input.files && input.files.length)) continue;
      const kind = fileFieldKind(input);
      if (kind !== 'resume') { console.log(`[EAM Autofill] file input ${input.id || input.name || ''} → ${kind}, left alone`); continue; }
      try {
        const b64 = String(st.resumeFile).includes(',') ? String(st.resumeFile).split(',')[1] : String(st.resumeFile);
        const bin = atob(b64); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], st.resumeFileName, { type: st.resumeFileType || 'application/pdf' });
        const dt = new DataTransfer(); dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // The file is handed over once the change event fired: SmartRecruiters reads it and
        // clears the input (its own chip shows the file) — still ONE upload, never repeated.
        resumeAttachedOnPage = file.name;
        if (input.files && input.files.length) input.dataset.eamFilled = 'true';
        console.log(`[EAM Autofill] résumé attached: ${file.name}`);
        return file.name;
      } catch (e) { console.log('[EAM Autofill] résumé attach failed', e && e.message); }
    }
    return null;
  }

  // ─── v2.5.100: "Language skills (check all that apply)" ─────────────
  // Ticked ONLY from the languages in the profile (basic / A1-A2 levels excluded).
  const LANG_WORDS = {
    english: ['english', 'anglais', 'inglés', 'ingles', 'englisch', 'inglese', 'eng'], french: ['french', 'français', 'francais', 'francés', 'französisch', 'fra'],
    spanish: ['spanish', 'espagnol', 'español', 'espanol', 'spanisch', 'spa'], german: ['german', 'allemand', 'deutsch', 'alemán', 'deu', 'ger'],
    italian: ['italian', 'italien', 'italiano', 'ita'], portuguese: ['portuguese', 'portugais', 'português', 'portugues', 'por'],
    dutch: ['dutch', 'néerlandais', 'neerlandais', 'nederlands', 'nld'], arabic: ['arabic', 'arabe', 'árabe', 'ara'],
    hindi: ['hindi', 'hin'], mandarin: ['mandarin', 'chinese', 'chinois', 'man', 'zho'], cantonese: ['cantonese', 'cant'],
    japanese: ['japanese', 'japonais', 'jpn'], russian: ['russian', 'russe', 'rus'], polish: ['polish', 'polonais'],
    turkish: ['turkish', 'turc', 'tur'], korean: ['korean', 'coréen', 'kor'], urdu: ['urdu', 'urd'], bengali: ['bengali', 'bne', 'ben'],
    tamil: ['tamil'], telugu: ['telugu', 'tel'], marathi: ['marathi', 'mar'], gujarati: ['gujarati', 'guj'],
  };
  function profileLanguageKeys(config) {
    const langs = (config.cvProfile && Array.isArray(config.cvProfile.languages)) ? config.cvProfile.languages : [];
    const keys = new Set();
    for (const l of langs) {
      const name = String(typeof l === 'string' ? l : (l && (l.name || l.language)) || '').toLowerCase();
      const level = String(typeof l === 'string' ? l : (l && l.level) || '').toLowerCase();
      if (/\b(basic|beginner|elementary|notions?|d[ée]butant|a1|a2)\b/.test(level)) continue;
      for (const [k, words] of Object.entries(LANG_WORDS)) if (words.some(w => w.length > 3 && name.includes(w))) keys.add(k);
    }
    return keys;
  }
  function languageOfLabel(text) {
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    for (const [k, words] of Object.entries(LANG_WORDS)) {
      if (words.some(w => new RegExp('(^|[^a-zà-ÿ])' + w + '([^a-zà-ÿ]|$)').test(t))) return k;
    }
    return null;
  }
  function fillLanguageCheckboxes(config) {
    let n = 0;
    const mine = profileLanguageKeys(config);
    if (!mine.size) return 0;
    const groups = new Map();
    deepAll('input[type="checkbox"]').forEach(cb => { if (cb.name) { if (!groups.has(cb.name)) groups.set(cb.name, []); groups.get(cb.name).push(cb); } });
    const optLabel = (cb) => (cb.labels && cb.labels[0] ? cb.labels[0].textContent : (cb.closest('label') ? cb.closest('label').textContent : cb.value)) || '';
    for (const boxes of groups.values()) {
      if (boxes.length < 2) continue;
      // The group's question: text around the options with the option labels removed
      // (questionText() returns the first option's label on Lever, and an option such as
      // "American Sign Language" must not make any checkbox list look like a language question).
      let anc = boxes[0].parentElement;
      while (anc && !boxes.every(b => anc.contains(b))) anc = anc.parentElement;
      let q = '';
      for (let i = 0; anc && i < 3 && !q; i++, anc = anc.parentElement) {
        let t = spacedText(anc);
        for (const b of boxes) { const l = optLabel(b).replace(/\s+/g, ' ').trim(); if (l) t = t.split(l).join(' '); }
        if (/\b(languages?|langues?|idiomas?|sprachen?|lingue)\b/i.test(t)) q = t;
      }
      if (!q) continue;
      for (const cb of boxes) {
        if (cb.checked || cb.disabled || cb.offsetParent === null) continue;
        const lbl = optLabel(cb);
        const k = languageOfLabel(lbl);
        if (!k || !mine.has(k)) continue;
        cb.click();
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        if (cb.checked) { cb.dataset.eamFilled = 'true'; n++; }
      }
    }
    return n;
  }

  async function fillComboboxes(config) {
    let n = 0;
    const boxes = deepAll('input[role="combobox"], input[aria-autocomplete], input#location-input, input.location-input, input[data-qa="location-input"]');
    for (const input of boxes) {
      // v2.5.118: a READ-ONLY combobox is a select-only listbox (Workable "Notice period" custom select) — opened
      // and picked below, never typed into.
      const selectOnly = input.readOnly && input.getAttribute('role') === 'combobox';
      if (input.dataset.eamFilled === 'true' || input.disabled || (input.readOnly && !selectOnly) || input.offsetParent === null) continue;
      // react-select shows the chosen value in a sibling, not in input.value
      const holder = input.closest('[class*="select__control" i], [class*="-control" i]');
      if ((input.value && input.value.trim()) || (holder && holder.querySelector('[class*="single-value" i], [class*="singleValue" i]'))) continue;
      const q = questionText(input) || input.getAttribute('placeholder') || '';
      const tgt = comboTarget(q, config);
      const ai = window.EAM && window.EAM.aiForm;
      const rs = isReactSelect(input) && window.chrome && chrome.runtime && chrome.runtime.sendMessage;
      // no deterministic answer: only react-select with a known option list can go to the AI (premium)
      if (!tgt && !(rs && ai && q && !EEO_RE.test(q))) continue;
      // react-select: synthetic events are ignored → pick through the MAIN-world bridge.
      if (rs) {
        const marker = 'rs' + (++rsSeq) + '_' + Date.now();
        input.setAttribute('data-eam-rs', marker);
        const lst = await rsBridge(marker, 'list');
        const labels = lst && Array.isArray(lst.labels) ? lst.labels : [];
        let pick = tgt ? pickOption(labels.map(t => ({ text: t })), q, config) : null;
        if (!tgt && labels.length && labels.length <= 40) {
          // CHOICE MODE: the AI must reply with one exact label (free plan → premium_required → null)
          let ans = null;
          try { ans = await ai.askAI(q, config, 'select', labels); } catch (e) { ans = null; }
          // v2.5.99: "3. Located Elsewhere" — the AI often drops the list number (gate 2026-10-04, Greenhouse).
          const unnum = (t) => norm(t).replace(/^\(?\d{1,2}[.)]\s*/, '');
          const hit = ans && ans !== 'skip' ? (labels.find(l => norm(l) === norm(ans)) || labels.find(l => unnum(l) === unnum(ans))) : null;
          if (hit) pick = { text: hit };
          else if (ans === null && aiBlocked()) openLeft++;
        }
        let ok = false;
        if (pick) { const r = await rsBridge(marker, 'select', pick.text); ok = !!(r && r.ok); }
        input.removeAttribute('data-eam-rs');
        console.log(`[EAM Autofill] react-select "${String(q).slice(0, 50)}" → ${ok ? '"' + pick.text + '"' : 'not filled (' + ((lst && lst.err) || (pick ? 'select failed' : 'no matching option')) + ')'}`);
        if (ok) {
          await new Promise(r => setTimeout(r, 150));
          (holder || input).style.outline = '2px solid #10b981';
          input.dataset.eamFilled = 'true';
          n++;
          continue;
        }
        if (labels.length || !tgt) continue;   // options known, none fits → leave to the user
      }
      if (selectOnly) {
        if (!tgt) continue;
        input.focus();
        input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        input.click();
        let pick = null;
        for (let t = 0; t < 10 && !pick; t++) {
          await new Promise(r => setTimeout(r, 200));
          pick = pickOption(visibleOptions(input).map(o => ({ o, text: optionText(o) })), q, config);
        }
        if (pick) {
          pressOption(pick.o);
          await new Promise(r => setTimeout(r, 250));
          if (input.value && input.value.trim()) { input.style.outline = '2px solid #10b981'; input.dataset.eamFilled = 'true'; n++; }
        } else {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          input.blur();
        }
        continue;
      }
      input.focus();
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input.click();
      const typed = tgt.kind === 'yesno' ? tgt.value : String(tgt.value).split(',')[0].trim();
      await typeChars(input, typed);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      let pick = null;
      for (let t = 0; t < 14 && !pick; t++) {
        await new Promise(r => setTimeout(r, 250));
        pick = pickOption(visibleOptions(input).map(o => ({ o, text: optionText(o) })), q, config);
      }
      // v2.5.129 (test agent 2026-10-26, Lever required "Current location" left empty): the suggestion list sometimes
      // never opens for the first keystrokes (slow location API) → retype once and wait longer before giving up.
      if (!pick && !visibleOptions(input).length && tgt.kind !== 'yesno') {
        setNativeValue(input, '');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
        await new Promise(r => setTimeout(r, 300));
        input.focus();
        await typeChars(input, typed);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        for (let t = 0; t < 24 && !pick; t++) {
          await new Promise(r => setTimeout(r, 250));
          pick = pickOption(visibleOptions(input).map(o => ({ o, text: optionText(o) })), q, config);
        }
      }
      if (pick) {
        pressOption(pick.o);
        // SmartRecruiters listens on the dropdown item host; the role=option div alone may not select it.
        try { const h = pick.o.getRootNode && pick.o.getRootNode().host; if (h && !(input.value && input.value.trim() && norm(input.value) !== norm(String(tgt.value).split(',')[0]))) { await new Promise(r => setTimeout(r, 150)); if (!input.value || norm(input.value) === norm(String(tgt.value).split(',')[0])) pressOption(h); } } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
        input.style.outline = '2px solid #10b981';
        input.dataset.eamFilled = 'true';
        n++;
      } else {
        setNativeValue(input, '');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    }
    return n;
  }

  // v2.5.118: a yes/no question with no deterministic answer → the AI with the two option labels (Premium; the
  // "Oui" rule in askAI turns a "No" into "Yes" unless No is legitimate). Free plan → counted as left open.
  const NON_ANSWER_RE = /^\s*["'“”]*\s*(n\s*\/?\s*a|none|nil|null|not applicable|non applicable|sans objet|-+|—)?\s*["'“”]*\s*\.?\s*$/i;
  // Age questions ("Avez-vous entre 18 et 28 ans ?") need the birth date — without it nothing is guessed.
  const AGE_Q_RE = /\b\d{2}\s*(et|and|to|à|a|-|–)\s*\d{2}\s*(ans|years|jahre|años)\b|\byears? old\b|\b(your|votre)\s+(age|âge)\b|\bover\s+(the\s+age\s+of\s+)?\d{2}\b|\bplus\s+de\s+\d{2}\s+ans\b/i;
  // The sentence actually asked: a preamble ("If you need an accommodation, we'll partner with you… Are you able to
  // commit to working from one of our offices…?", Ashby 2026-10-17) must not make a question look like an EEO one.
  function askedPart(q) {
    const s = String(q || '');
    const parts = s.split(/(?<=[.!?])\s+/).filter(p => /\?/.test(p));
    return parts.length ? parts.join(' ') : s;
  }
  async function askYesNo(q, config, yesText, noText) {
    const ai = window.EAM && window.EAM.aiForm;
    if (!ai || !ai.askAI || !q || !meaningfulLabel(q) || EEO_RE.test(askedPart(q)) || /pronoun|pronom/i.test(q)) return null;
    if (AGE_Q_RE.test(q) && !config.dateOfBirth) return null;
    let a = null;
    try { a = await ai.askAI(q, config, 'radio', [yesText, noText]); } catch (_) { a = null; }
    if (a === null && aiBlocked()) { openLeft++; return null; }
    if (!a || a === 'skip') return null;
    const n = norm(a);
    if (n === norm(yesText) || /^(yes|oui|ja|s[ií]|sim)\b/.test(n)) return 'Yes';
    if (n === norm(noText) || /^(no|non|nein|n[ãa]o)\b/.test(n)) return 'No';
    return null;
  }

  async function fillYesNoToggles(config) {
    let n = 0;
    const boxes = deepAll('.ashby-application-form-input-yesno, [class*="_yesno_"]');
    for (const box of boxes) {
      const btns = [...box.querySelectorAll('button')];
      const opt = (b) => String(b.getAttribute('data-option') || b.textContent || '').trim().toLowerCase();
      const yesB = btns.find(b => /^(yes|oui)$/.test(opt(b)));
      const noB = btns.find(b => /^(no|non)$/.test(opt(b)));
      if (!yesB || !noB || btns.length > 3) continue;
      if (btns.some(b => b.getAttribute('aria-pressed') === 'true')) continue;
      const entry = box.closest('.ashby-application-form-field-entry, [class*="fieldEntry"]') || box.parentElement;
      const lab = entry && entry.querySelector('.ashby-application-form-question-title, label, legend');
      const q = lab ? cleanText(lab) : '';
      if (!q || EEO_RE.test(askedPart(q))) continue;
      // v2.5.118: any other yes/no toggle goes to the AI (Premium) with the "Oui" rule (askAI → leanYes) —
      // live 2026-10-17 Ashby "Are you able to commit to working from one of our offices…?*" stayed empty.
      const ans = deterministicAnswer(q, config) || await askYesNo(q, config, yesB.textContent.trim() || 'Yes', noB.textContent.trim() || 'No');
      if (!ans) continue;
      const b = ans === 'Yes' ? yesB : noB;
      b.click();
      await new Promise(r => setTimeout(r, 150));
      if (b.getAttribute('aria-pressed') === 'true') { b.dataset.eamFilled = 'true'; n++; }
    }
    return n;
  }

  // ─── Main autofill logic ────────────────────────────────────────────

  async function autofill(config) {
    if (!config) return { filled: 0 };

    let filled = 0;
    openLeft = 0;

    // v2.5.100: the saved résumé into the résumé field (never cover letter / photo), FIRST:
    // Lever / Ashby parse the uploaded CV and rewrite fields (live 2026-10-04: Lever's parse
    // emptied "Current location" after we had filled it) — fields are filled once it settles.
    let resumeName = null;
    try { resumeName = await attachResume(); if (resumeName) { filled++; await new Promise(r => setTimeout(r, 3500)); } } catch (_) {}

    // Build value map from config
    const values = {};
    if (config.firstName) { values.firstName = config.firstName; values.preferredName = config.firstName; }
    // v2.5.119: answers in the form's language; the job on the page for a tailored cover note.
    if (!config.formLanguage) config.formLanguage = detectFormLanguage();
    if (config.lastName) values.lastName = config.lastName;
    if (config.firstName && config.lastName) values.fullName = config.firstName + ' ' + config.lastName;
    if (config.email) values.email = config.email;
    if (config.phone) values.phone = config.phone;
    if (config.city) values.city = config.city;
    if (config.yearsOfExperience) values.yearsOfExperience = config.yearsOfExperience;
    if (config.expectedSalary) values.expectedSalary = config.expectedSalary;
    if (config.linkedinUrl) values.linkedinUrl = config.linkedinUrl;
    if (config.currentCompany) values.currentCompany = config.currentCompany;
    if (config.currentTitle) values.currentTitle = config.currentTitle;
    if (config.portfolioUrl) values.portfolioUrl = config.portfolioUrl;
    const _cs = (window.EAM && window.EAM.utils && window.EAM.utils.cleanProfileSummary) || ((x) => x || '');
    if (_cs(config.summary)) values.summary = _cs(config.summary);

    // Fill text/email/tel/number inputs
    const inputs = deepAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input:not([type]), textarea');
    const aiAvailable = !!(window.EAM && window.EAM.aiForm);
    for (const input of inputs) {
      // v2.5.118: a phone input holding only a dial code ("+241" from the job's country, Recruitee 2026-10-17)
      // is empty — the full international number is written.
      const dialOnly = /^\s*\+\d{1,4}\s*$/.test(input.value || '')
        && (input.type === 'tel' || /phone|t[ée]l[ée]phone|mobile/i.test([input.name, input.id, input.getAttribute('autocomplete'), input.getAttribute('aria-label')].join(' ')));
      if (input.value && input.value.trim() !== '' && !dialOnly) continue;
      if (input.offsetParent === null || input.disabled || input.readOnly) continue;
      // v2.5.117: value holders of custom widgets (Workable select: <input name="CA_x" aria-hidden="true" tabindex="-1">)
      // are not fields — the AI was asked "CA_10627 SVGs not supported by this browser." and its "No" written there.
      if (input.getAttribute('aria-hidden') === 'true') continue;
      if (input.dataset.eamFilled === 'true') continue;
      // v2.5.90: autocomplete comboboxes (react-select, Ashby/Lever location)
      // drop typed text unless an option is picked — leave them to the user
      // rather than showing a fake "filled" outline.
      if (input.getAttribute('role') === 'combobox' || input.getAttribute('aria-autocomplete')) continue;
      if (input.matches('#location-input, .location-input, [data-qa="location-input"]')) continue;   // v2.5.93: fillComboboxes picks a suggestion
      const ph = (input.getAttribute('placeholder') || '').toLowerCase();
      if (/pick date|dd\/mm|mm\/dd|jj\/mm|yyyy/.test(ph)) continue;

      const fieldType = classifyField(input);
      if (fieldType === 'eeo') continue;
      if (fieldType === 'coverLetter') {
        if (input.dataset.eamAsked === '1') continue;
        input.dataset.eamAsked = '1';
        let r = null;
        try { r = await fillCoverLetter(input, config); } catch (_) { r = null; }
        if (r && r.value) {
          setNativeValue(input, r.value);
          input.style.outline = r.how === 'ai' ? '2px solid #8b5cf6' : '2px solid #10b981';
          input.dataset.eamFilled = 'true';
          filled++;
        } else if (aiBlocked() && isRequiredField(input)) openLeft++;
        continue;
      }
      // v2.5.117: source question (text) → the job board in the referrer, else left to the candidate / AI below.
      {
        const sq = questionText(input) || '';
        if (SOURCE_Q.test(sq)) {
          const src = referrerSource();
          if (src) { setNativeValue(input, src); input.style.outline = '2px solid #10b981'; input.dataset.eamFilled = 'true'; filled++; continue; }
        }
        // "How do you pronounce your name?" — only the candidate knows (premium AI invented a phonetic spelling).
        if (/pronounc|prononc/i.test(sq)) continue;
      }
      // v2.5.110 (premium user mail 2026-10-12 "experience and salary field going wrong"): the popup Autofill
      // wrote the TOTAL years into "years of Python?" and the raw expected salary into "current CTC" / LPA
      // questions. Same rules as auto-apply (FormFiller): years per skill (capped at the declared total),
      // expected pay converted to the asked unit, current pay never filled.
      const FF = window.EAM && window.EAM.FormFiller;
      if (FF && (fieldType === 'yearsOfExperience' || fieldType === 'expectedSalary')) {
        const q = questionText(input) || '';
        let v = '';
        try {
          if (fieldType === 'yearsOfExperience') { const y = FF.yearsForQuestion(q, config); v = y && isFinite(y.years) ? String(y.years) : ''; }
          else v = FF.salaryAnswer(q, config, input) || ''; // current pay only from the currentSalary setting
        } catch (_) { v = ''; }
        if (v !== '') {
          setNativeValue(input, v);
          input.style.outline = '2px solid #10b981';
          input.dataset.eamFilled = 'true';
          filled++;
        }
        continue;
      }
      if (fieldType && fieldType !== 'question' && values[fieldType]) {
        setNativeValue(input, values[fieldType]);
        input.style.outline = '2px solid #10b981';
        input.dataset.eamFilled = 'true';
        filled++;
        continue;
      }
      if (fieldType === 'question') {
        const det = deterministicAnswer(questionText(input), config);
        if (det) {
          setNativeValue(input, det);
          input.style.outline = '2px solid #10b981';
          input.dataset.eamFilled = 'true';
          filled++;
          continue;
        }
      }

      // AI fallback for unknown fields (restored from v2.1.0).
      if (!aiAvailable) continue;
      const hints = [];
      const qt = questionText(input);
      if (qt) hints.push(qt);
      hints.push(input.getAttribute('name') || '');
      hints.push((input.getAttribute('id') || '').replace(/[-_]/g, ' '));
      hints.push(input.getAttribute('aria-label') || '');
      const id2 = input.getAttribute('id');
      if (id2) {
        const lbl = labelFor(input);
        if (lbl) hints.push(cleanText(lbl));
      }
      hints.push(input.getAttribute('placeholder') || '');
      const parent = input.closest('div, fieldset, li, td');
      if (parent) {
        const nearby = parent.querySelector('label, legend, span');
        if (nearby && cleanText(nearby).length < 80) hints.push(cleanText(nearby));
      }
      const label = [...new Set(hints.map(s => (s || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' ').trim();
      if (!label || !meaningfulLabel(label)) continue;
      if (EEO_RE.test(qt || label)) continue;

      const isTextarea = input.tagName === 'TEXTAREA';
      const fType = isTextarea ? 'textarea' : (input.type || 'text');
      // v2.5.100: a field the AI already declined ("" / skip) on this page is not asked again
      // on the next Autofill click (gate: Ashby "Additional Information" asked twice).
      if (input.dataset.eamAsked === '1') continue;
      try {
        let answer = await window.EAM.aiForm.askAI(label, config, fType);
        if (answer !== null) input.dataset.eamAsked = '1';
        if (answer === null && aiBlocked()) { openLeft++; continue; }
        if (!answer) continue;
        // v2.5.118: "N/A" / "None" / '""' are not answers — the field stays for the candidate (live 2026-10-17
        // Workable: "Share 2–3 of your open-source contributions… Blank or N/A answers won't move forward" got "N/A").
        if (NON_ANSWER_RE.test(String(answer))) continue;
        const labelLower = label.toLowerCase();
        const isNumeric = input.type === 'number'
          || input.getAttribute('inputmode') === 'numeric'
          || (input.getAttribute('pattern') || '').includes('\\d')
          || labelLower.match(/combien|how many|how much|nombre|number|heures|hours|salary|salaire|année|years|mois|months|percent|pourcentage|budget|quantity|quantité/);
        if (isNumeric) {
          const num = answer.match(/[\d]+\.?[\d]*/);
          answer = num ? num[0] : answer;
        }
        setNativeValue(input, answer);
        input.style.outline = '2px solid #8b5cf6';
        input.dataset.eamFilled = 'true';
        filled++;
      } catch (e) { /* AI error — skip */ }
    }

    // Fill <select> dropdowns — consent/language proficiency
    const selects = deepAll('select');
    for (const select of selects) {
      if (select.selectedIndex > 0) continue;
      if (select.offsetParent === null || select.disabled) continue;
      if (select.dataset.eamFilled === 'true') continue;

      const hints = [];
      hints.push(select.getAttribute('name') || '');
      hints.push(select.getAttribute('aria-label') || '');
      const selectId = select.getAttribute('id');
      if (selectId) {
        const lbl = labelFor(select);
        if (lbl) hints.push(lbl.textContent);
      }
      const parent = select.closest('div, fieldset');
      if (parent) {
        const lbl = parent.querySelector('label, legend, span');
        if (lbl && lbl.textContent.length < 80) hints.push(lbl.textContent);
      }
      const combined = hints.join(' ').toLowerCase();

      // v2.5.93: yes/no screening questions and "Country" as native <select>
      // (classic Greenhouse boards) — same deterministic answers as radios/text.
      {
        const q = questionText(select) || combined;
        if (EEO_RE.test(q)) continue;
        const pick = pickOption(Array.from(select.options).map(o => ({ o, text: o.text })).filter(x => x.o.value !== ''), q, config);
        if (pick) {
          select.value = pick.o.value;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.style.outline = '2px solid #10b981';
          select.dataset.eamFilled = 'true';
          filled++;
          continue;
        }
      }

      if (combined.match(/proficiency|level|langue|language|english|anglais|french|français/)) {
        const options = Array.from(select.options);
        let best = options.find(o => o.text.toLowerCase().match(/native|bilingual|bilingue|langue maternelle/));
        if (!best) best = options.find(o => o.text.toLowerCase().match(/fluent|courant|fluide/));
        if (!best) best = options.find(o => o.text.toLowerCase().match(/professional|professionnel|advanced/));
        if (best) {
          select.value = best.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.style.outline = '2px solid #10b981';
          select.dataset.eamFilled = 'true';
          filled++;
        }
      }
    }

    // v2.5.93: autocomplete comboboxes (Lever "Current location", Greenhouse
    // react-select yes/no + Country + Location, Ashby location). Type the
    // value, wait for the suggestions and PICK a matching option — typed text
    // alone is dropped by these widgets. No matching option → cleared, so
    // nothing looks filled that isn't.
    try { filled += await fillComboboxes(config); } catch (e) { /* never block the rest of the fill */ }

    // v2.5.100: consent / privacy / terms checkboxes are NOT ticked any more — accepting a
    // legal text is the candidate's decision (marketing opt-ins and waivers already stayed
    // unticked). Only "language skills" checkbox groups are filled, from the profile.
    try { filled += fillLanguageCheckboxes(config); } catch (_) {}


    // v2.5.92: yes/no RADIO groups for the deterministic screening questions
    // (sponsorship, work authorization, relocation, driving licence) —
    // answered from settings; any other radio question is left to the user.
    try {
      const groups = new Map();
      deepAll('input[type="radio"]').forEach(r => {
        if (!r.name || r.disabled) return;
        if (!groups.has(r.name)) groups.set(r.name, []);
        groups.get(r.name).push(r);
      });
      for (const radios of groups.values()) {
        if (radios.some(r => r.checked) || radios.length > 4) continue;
        const labelOf = (r) => (r.labels && r.labels[0] ? r.labels[0].textContent : (r.closest('label') ? r.closest('label').textContent : r.value || '')).replace(/\s+/g, ' ').trim();
        const opts = radios.map(r => ({ r, t: labelOf(r).toLowerCase() }));
        const yes = opts.find(o => /^(yes|oui|sí|si|ja)\b/.test(o.t));
        const no = opts.find(o => /^(no|non|nein)\b/.test(o.t));
        if (!yes || !no) continue;
        // The question: the group's legend / label, else the nearest container text.
        let q = '';
        for (let n = radios[0].parentElement, i = 0; n && i < 6 && !q; n = n.parentElement, i++) {
          const leg = n.querySelector && n.querySelector('legend, .application-label, [class*="question"], [class*="label"]');
          const txt = (leg && !leg.contains(radios[0]) ? leg.textContent : '') || '';
          // v2.5.118: a question without "?" ("Êtes-vous en règle avec … service national *", Recruitee) counts too.
          if (/\?|sponsor|authori[sz]|relocat|licen[cs]e|permis/i.test(txt) || QUESTION_RE.test(txt.trim())) q = txt;
          else if (i >= 2 && /\?/.test(n.textContent || '') && (n.textContent || '').length < 600) q = n.textContent;
        }
        const qc = String(q || '').replace(/\s+/g, ' ').trim();
        const ans = deterministicAnswer(qc, config) || (qc.length <= 400 ? await askYesNo(qc, config, labelOf(yes.r) || 'Yes', labelOf(no.r) || 'No') : null);
        if (!ans) continue;
        const pick = ans === 'Yes' ? yes.r : no.r;
        pick.click();
        if (!pick.checked) { pick.checked = true; pick.dispatchEvent(new Event('change', { bubbles: true })); }
        if (pick.checked) { pick.dataset.eamFilled = 'true'; filled++; }
      }
    } catch (_) {}

    // v2.5.117: Ashby yes/no TOGGLE BUTTONS (button[data-option=yes|no][aria-pressed] + hidden checkbox) — same
    // deterministic answers as the radio groups (sponsorship, work authorization, relocation, licence,
    // self-declarations); any other yes/no stays with the candidate (gate 2026-10-16: required "authorized /
    // sponsorship" questions left empty on Ashby).
    try { filled += await fillYesNoToggles(config); } catch (_) {}

    // v2.5.118: "How many years of X?" as a SLIDER (Teamtailor input[type=range], live 2026-10-17 left on 0) —
    // same years policy as text fields (X in the CV → its roles, else total years), clamped to the slider range.
    try {
      const FF = window.EAM && window.EAM.FormFiller;
      for (const r of deepAll('input[type="range"]')) {
        if (r.dataset.eamFilled === 'true' || r.disabled || r.offsetParent === null) continue;
        const min = r.min !== '' ? Number(r.min) : 0, max = r.max !== '' ? Number(r.max) : 100, step = Number(r.step) || 1;
        if (Number(r.value) !== min) continue;   // the candidate already moved it
        const q = questionText(r) || '';
        if (!/(how many|combien|wie viele|cu[aá]ntos)[^?]{0,60}(years?|ans|ann[ée]es|jahre|a[ñn]os)|years? of\b.{0,60}experience|ann[ée]es? d.exp/i.test(q)) continue;
        let y = NaN;
        try { const a = FF && FF.yearsForQuestion ? FF.yearsForQuestion(q, config) : null; if (a && isFinite(a.years)) y = Number(a.years); } catch (_) {}
        if (!isFinite(y)) y = parseFloat(config.yearsOfExperience);
        if (!isFinite(y)) continue;
        const v = Math.min(max, Math.max(min, Math.round((y - min) / step) * step + min));
        setNativeValue(r, String(v));
        if (Number(r.value) === v) { r.dataset.eamFilled = 'true'; r.style.outline = '2px solid #10b981'; filled++; }
      }
    } catch (_) {}

    // v2.5.90: don't claim fields the page wiped (autocomplete widgets,
    // controlled inputs that reset on blur) — honest count + outline.
    await new Promise(r => setTimeout(r, 400));
    deepAll('input[data-eam-filled="true"], textarea[data-eam-filled="true"]').forEach(el => {
      if (el.type === 'checkbox' || el.type === 'radio') return;
      if (!el.value || !el.value.trim()) {
        el.dataset.eamFilled = 'false';
        el.style.outline = '';
        filled = Math.max(0, filled - 1);
      }
    });

    // Show floating badge — ONLY from top frame. If we render "No fields
    // detected" from the top frame at the same time as a child frame renders
    // "3 fields filled" the user sees contradictory toasts overlapping.
    // Extension audit 2026-08-14 caught this on SmartRecruiters-style forms.
    // Child frames still fill fields — their own badge would draw INSIDE
    // the iframe (invisible on most portals) so we skip it entirely.
    const premiumHint = openLeft > 0 && aiBlocked();
    // v2.5.100: a second click on an already-filled form said "No fields detected" — misleading.
    const alreadyFilled = filled === 0 ? deepAll('[data-eam-filled="true"]').length : 0;
    if (window === window.top) {
      if (premiumHint) showPremiumHint(filled, openLeft); else showBadge(filled, alreadyFilled);
    }

    return { filled, openLeft: premiumHint ? openLeft : 0, premiumHint, resume: resumeName, alreadyFilled };
  }

  // ─── v2.5.100: free plan — open questions left to the candidate ─────
  const UPSELL_URL = 'https://www.autoapplymax.com/dashboard?promo=WELCOMEBACK20&src=ext_autofill_free#upgrade';
  const HINT_FONT = 'Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  const HINT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
  const HINT_CLOSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  function showPremiumHint(count, open) {
    try {
      document.getElementById('eam-autofill-badge')?.remove();
      const n = document.createElement('div');
      n.id = 'eam-autofill-badge';
      n.setAttribute('role', 'status');
      n.setAttribute('data-eam-autofill-hint', '1');
      const q = open === 1 ? '1 open question' : open + ' open questions';
      n.innerHTML = '<span style="display:inline-flex;flex-shrink:0;color:#0a66c2">' + HINT_ICON + '</span>'
        + '<span><strong style="font-weight:700">AutoApplyMax — ' + (count > 0 ? count + ' field' + (count === 1 ? '' : 's') + ' filled' : 'form already filled') + '</strong><br>'
        + q + ' left for you — Premium answers them with AI.<br>'
        + '<a data-eam-hint-link href="' + UPSELL_URL + '" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;color:#0a66c2;font-weight:700;text-decoration:none">See Premium →</a></span>'
        + '<button data-eam-hint-close type="button" aria-label="Dismiss" style="all:unset;cursor:pointer;padding:0 2px;line-height:1;opacity:0.6;display:inline-flex">' + HINT_CLOSE + '</button>';
      n.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483646;display:flex;align-items:flex-start;gap:8px;padding:10px 14px;background:#eff6ff;border:1px solid #93c5fd;color:#1e3a8a;border-radius:12px;font:500 13px/1.45 ' + HINT_FONT + ';box-shadow:0 4px 12px rgba(15,23,42,0.12);max-width:360px;box-sizing:border-box;';
      document.body.appendChild(n);
      n.querySelector('[data-eam-hint-close]')?.addEventListener('click', () => n.remove());
      n.querySelector('[data-eam-hint-link]')?.addEventListener('click', () => {
        try { chrome.runtime.sendMessage({ type: 'track-autofill-upsell-click', where: 'page', hostname: location.hostname }); } catch (_) {}
      });
      setTimeout(() => { try { n.remove(); } catch (_) {} }, 30000);
    } catch (_) {}
  }

  // ─── Floating badge ─────────────────────────────────────────────────

  function showBadge(count, alreadyFilled) {
    // Remove previous badge if any
    const existing = document.getElementById('eam-autofill-badge');
    if (existing) existing.remove();

    const badge = document.createElement('div');
    badge.id = 'eam-autofill-badge';
    badge.textContent = count > 0
      ? `AutoApplyMax: ${count} field${count > 1 ? 's' : ''} filled`
      : alreadyFilled > 0
        ? 'AutoApplyMax: this form is already filled — nothing new to fill'
        : 'AutoApplyMax: No fields detected in the top frame — if the form is in an iframe (SmartRecruiters, Workday), check inside it';
    badge.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${(count > 0 || alreadyFilled > 0) ? '#047857' : '#475569'};
      color: white;
      padding: 12px 20px;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 999999;
      transition: opacity 0.3s ease;
    `;
    document.body.appendChild(badge);

    // Auto-remove after 5s
    setTimeout(() => {
      badge.style.opacity = '0';
      setTimeout(() => badge.remove(), 300);
    }, 5000);
  }

  // ─── Message listener for popup communication ───────────────────────

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.action === 'eam-autofill' && msg.config) {
        // v2.5.90: one run per frame at a time — a duplicate delivery must not
        // fill (and call the AI for) every question twice.
        if (window.__eamAutofillRunning) { sendResponse({ filled: 0, duplicate: true }); return; }
        window.__eamAutofillRunning = true;
        autofill(msg.config).finally(() => { window.__eamAutofillRunning = false; }).then(result => {
          // Emit a tracking beacon for EVERY autofill invocation, regardless of
          // whether any AI calls fired. Previously we only had server-side
          // visibility when askAI fired (unknown-field fallback) — pattern-
          // matched-only sessions were completely invisible. Product observability
          // gap surfaced 2026-08-13 (Théo used autofill on his own account and
          // no activity appeared in admin Recent Activity).
          // Beacon ONLY from top frame — otherwise iframe forms produce
          // one beacon per frame + one from top = inflated user counts in
          // admin. Extension audit 2026-08-14 caught this (3 fields filled
          // in child frame produced 2 tool_usage rows).
          try {
            if (window === window.top) {
              chrome.runtime.sendMessage({
                type: 'track-autofill',
                filled: result?.filled || 0,
                openLeft: result?.openLeft || 0,
                premiumHint: !!result?.premiumHint,
                resume: !!result?.resume,
                hostname: location.hostname,
                // v2.5.120: ids / tokens in the URL path never leave the browser (security audit 2026-10-18).
                path: (location.pathname || '').split('/').map(seg => (/^[0-9a-f-]{16,}$/i.test(seg) || /\d{4,}/.test(seg) || (seg.length >= 20 && /\d/.test(seg) && /[a-z]/i.test(seg))) ? ':id' : seg).join('/').slice(0, 100),
              });
            }
          } catch (_) { /* fire-and-forget, never block autofill response */ }
          sendResponse(result);
        }).catch(err => {
          console.warn('[EAM autofill] error:', err);
          sendResponse({ filled: 0, error: err?.message || 'autofill_failed' });
        });
        return true;
      }
    });
  }

  // ─── Expose for testing ─────────────────────────────────────────────

  window.__eamAutofill = autofill;

})();
