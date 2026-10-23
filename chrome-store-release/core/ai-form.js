/**
 * AutoApplyMax - AI Form Answering
 * Uses Groq API to answer unknown form questions during autoapply.
 * Caches answers locally (Jaccard similarity matching).
 * Namespace: window.EAM.aiForm
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};
  const log = () => window.EAM.utils?.log || console.log;

  let cache = {};
  let cacheLoaded = false;
  let premiumBlocked = false; // Session flag: skip all AI calls if premium_required

  // ─── Cache management ───────────────────────────────────────────────

  // v3 (2.5.87): exact keys only — v2 fuzzy (Jaccard ≥ 0.7) matching reused a
  // "Bachelor's Degree?" answer for "Master's Degree?" (8/10 shared words) and a
  // wrong answer was submitted on a real application (FamilyOS, 2026-09-24).
  const CACHE_VERSION = 4; // Bump to clear stale cache (4 = 2.5.126: drops answers flipped by the old Oui rule, e.g. Powerdot "prépa" → Yes)

  async function loadCache() {
    if (cacheLoaded) return;
    try {
      const result = await chrome.storage.local.get(['eam_ai_cache', 'eam_ai_cache_v']);
      if (result.eam_ai_cache_v === CACHE_VERSION) {
        cache = result.eam_ai_cache || {};
      } else {
        // Clear old cache
        cache = {};
        await chrome.storage.local.set({ eam_ai_cache: {}, eam_ai_cache_v: CACHE_VERSION });
        log()('AI cache cleared (version upgrade)');
      }
      cacheLoaded = true;
      const count = Object.keys(cache).length;
      if (count > 0) log()(`AI cache loaded: ${count} answers`);
    } catch (e) {}
  }

  async function saveCache() {
    try {
      await chrome.storage.local.set({ eam_ai_cache: cache });
    } catch (e) {}
  }

  function normalize(text) {
    return (text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Cache key = normalized question + field type + sorted normalized options.
  // A cached answer is reused ONLY for the exact same question with the exact
  // same choices — no fuzzy matching (a one-word difference like degree level,
  // years, language or country changes the right answer).
  const KEY_SEP = '||';
  function cacheKey(question, fieldType, options) {
    const opts = Array.isArray(options) && options.length
      ? options.map(o => normalize(String(o))).filter(Boolean).sort().join('¦')
      : '';
    return [normalize(question), String(fieldType || ''), opts].join(KEY_SEP);
  }
  function questionOfKey(key) {
    return String(key).split(KEY_SEP)[0];
  }

  const JOB_SPECIFIC_RE = /^\s*(headline|titre du profil|summary|r[ée]sum[ée] du profil|cover letter|lettre de motivation|message (to|for) the (hiring|recruit)\w*|motivation)\b|\bwhy (do you want|are you interested|would you like|this (role|position|job|company))|\bwhat (interests|attracts) you\b|\bpourquoi\b.{0,60}\b(poste|entreprise|soci[ée]t[ée]|candidat|rejoindre|int[ée]ress)|\bmotivations?\b|\bcover letter\b|\blettre de motivation\b/i;
  function isJobSpecificQuestion(question) { return JOB_SPECIFIC_RE.test(String(question || '')); }

  function findCached(question, fieldType, options) {
    const hit = cache[cacheKey(question, fieldType, options)];
    return typeof hit === 'string' && hit ? hit : null;
  }

  // ─── Marketing opt-in guard (v2.5.87, Théo 2026-09-25) ───────────────
  // Marketing / contact opt-ins default to "No" / unchecked — decided by the
  // extension, never asked to the user and never left to the AI (which said
  // "Yes" to "Email me about other job openings" on a real application).
  // A REQUIRED consent (privacy policy / data processing needed to submit) is
  // not marketing and stays ticked by the form filler.
  const MARKETING_OPTIN_RE = new RegExp([
    // NB: bare "marketing" is a skill ("years of experience in digital marketing") — only marketing *messages*.
    'newsletter', 'marketing (e-?mails?|messages?|updates|offers|communications?|materials?)', '(receive|send me) marketing', 'promotional',
    'job alerts?', 'alertes?\\s+(e-?mail|emploi|offres?)',
    'other (job )?(openings|opportunities|positions|roles|jobs)', 'future (job )?(openings|opportunities|positions|roles)',
    'similar (jobs|roles|positions|opportunities)', 'talent (community|network|pool|pipeline)',
    'keep me (informed|updated|posted)', 'email me', 'text me', 'contact me (about|for|regarding) (other|future|new)',
    '\\bsms\\b', 'whats\\s?app', 'text messages?',
    'recevoir\\s+(des|les|nos|l[ae])?\\s*(offres|newsletters?|actualit[ée]s|informations|communications|sms|e-?mails?|notifications|alertes)',
    '(autres|nouvelles|futures|prochaines)\\s+offres', 'offres\\s+(similaires|d.emploi\\s+par)',
    '(tenir|être)\\s+inform[ée]', 'communications?\\s+commerciales?',
    // v2.5.119 (dry-run gate 2026-10-17, EVERIENCE via LinkedIn): "…et que vous acceptez de faire partie des
    // communautés pour de futures opportunités d'emploi" (optional) was ticked as a privacy consent.
    'futures?\\s+opportunit', 'opportunit[ée]s\\s+futures', 'communaut[ée]s?\\s+(de\\s+talents?|pour\\s+de\\s+futures?)', 'vivier\\s+de\\s+(talents?|candidat)',
  ].join('|'), 'i');
  function isMarketingOptIn(label) {
    return MARKETING_OPTIN_RE.test(String(label || ''));
  }
  const NO_OPTION_RE = /^(no|non|nein|não|nao)\b|do not|don'?t|decline|opt[- ]?out|unsubscribe|ne (souhaite|veux) pas|pas int[ée]ress|refuse/i;
  // Deterministic "No" in the shape the caller expects. null = nothing safe to pick.
  function marketingNoAnswer(fieldType, options) {
    if (fieldType === 'checkbox' && Array.isArray(options)) return '[]';
    if (Array.isArray(options) && options.length) {
      return options.find(o => NO_OPTION_RE.test(String(o).trim())) || null;
    }
    return 'No';
  }

  // ─── Groq API call ──────────────────────────────────────────────────

  // v2.5.97: "which position are you looking for / applying to" (EN/FR/ES/DE/IT).
  function isDesiredPositionQuestion(q) {
    const s = String(q || '').toLowerCase();
    return /(quel(le)?s?\s+(est\s+le\s+)?(poste|emploi|m[ée]tier|fonction)s?\s+(recherch|vis|souhait|pr[ée]f[ée]r|cibl|postul|candidat)|poste\s+(recherch[ée]|vis[ée]|souhait[ée])|(type|intitul[ée])\s+de\s+poste\s+(recherch|souhait|vis)|what\s+(position|role|job)s?\s+(are\s+you|do\s+you|would\s+you)\s+(looking|applying|seeking|interested|want)|(which|what)\s+(position|role|job)\s+(are\s+you\s+)?(applying|looking)|(desired|target|preferred)\s+(position|role|job\s*title)|position\s+applied\s+for|role\s+you\s+are\s+applying|qu[eé]\s+puesto\s+(busca|desea)|puesto\s+(deseado|al\s+que\s+aplica)|gew[üu]nschte\s+position|posizione\s+(desiderata|ricercata))/i.test(s);
  }
  // "Chef de projet (Verified job)" / duplicated card titles → one clean title.
  function cleanJobTitle(t) {
    let s = String(t || '').replace(/\s*\((verified job|vérifiée?)\)\s*/ig, ' ').replace(/\s+/g, ' ').trim();
    const half = s.length / 2;
    if (s.length % 2 === 0 && s.slice(0, half) === s.slice(half)) s = s.slice(0, half);
    return s.slice(0, 120);
  }

  // v2.5.99: AI answers are Premium. Same handling whether the server said 403 or the
  // cached plan already says free: no more AI calls this session + the popup notice
  // "some applications were skipped — Premium AI answers them" (once per session: a
  // notice seen more than 12 h ago is re-armed; the engine counts the skips).
  function markPremiumBlocked() {
    premiumBlocked = true;
    try {
      chrome.storage.local.get(['eam_ai_premium_notice'], (r) => {
        const n = r && r.eam_ai_premium_notice;
        const stale = n && n.seen && (Date.now() - (n.at || 0)) > 12 * 3600 * 1000;
        if (!n || stale) chrome.storage.local.set({ eam_ai_premium_notice: { at: Date.now(), seen: false, skipped: 0 } });
      });
    } catch (_) {}
  }
  // v2.5.99: FREE plan → no form-answer request at all (gate 2026-10-04: universal autofill
  // sent one request per click that the server refused with 403). The popup writes `plan`
  // from user_profiles each time it opens, and autofill / auto-apply both start from the
  // popup, so the value is fresh. Unknown plan → ask the server (it stays the authority).
  async function cachedPlanIsFree() {
    try {
      const r = await chrome.storage.local.get(['plan', 'isPremium']);
      return r.plan === 'free' && !r.isPremium;
    } catch (_) { return false; }
  }

  // v2.5.110: state / region of the main cities of the user base (FR, IN, US, UK) — "" when unknown.
  const _CITY_REGION = {
    'paris': 'Île-de-France', 'boulogne-billancourt': 'Île-de-France', 'la defense': 'Île-de-France', 'nanterre': 'Île-de-France', 'versailles': 'Île-de-France', 'saint-denis': 'Île-de-France', 'issy-les-moulineaux': 'Île-de-France', 'neuilly-sur-seine': 'Île-de-France', 'levallois-perret': 'Île-de-France', 'courbevoie': 'Île-de-France',
    'lyon': 'Auvergne-Rhône-Alpes', 'grenoble': 'Auvergne-Rhône-Alpes', 'marseille': "Provence-Alpes-Côte d'Azur", 'nice': "Provence-Alpes-Côte d'Azur", 'toulouse': 'Occitanie', 'montpellier': 'Occitanie', 'lille': 'Hauts-de-France', 'bordeaux': 'Nouvelle-Aquitaine', 'nantes': 'Pays de la Loire', 'strasbourg': 'Grand Est', 'rennes': 'Bretagne', 'rouen': 'Normandie', 'dijon': 'Bourgogne-Franche-Comté', 'orleans': 'Centre-Val de Loire', 'tours': 'Centre-Val de Loire',
    'bengaluru': 'Karnataka', 'bangalore': 'Karnataka', 'mumbai': 'Maharashtra', 'pune': 'Maharashtra', 'nagpur': 'Maharashtra', 'delhi': 'Delhi', 'new delhi': 'Delhi', 'hyderabad': 'Telangana', 'chennai': 'Tamil Nadu', 'coimbatore': 'Tamil Nadu', 'kolkata': 'West Bengal', 'noida': 'Uttar Pradesh', 'lucknow': 'Uttar Pradesh', 'gurgaon': 'Haryana', 'gurugram': 'Haryana', 'ahmedabad': 'Gujarat', 'jaipur': 'Rajasthan', 'kochi': 'Kerala', 'thiruvananthapuram': 'Kerala', 'indore': 'Madhya Pradesh', 'bhopal': 'Madhya Pradesh', 'chandigarh': 'Chandigarh', 'bhubaneswar': 'Odisha',
    'new york': 'New York', 'san francisco': 'California', 'los angeles': 'California', 'san diego': 'California', 'san jose': 'California', 'seattle': 'Washington', 'austin': 'Texas', 'dallas': 'Texas', 'houston': 'Texas', 'chicago': 'Illinois', 'boston': 'Massachusetts', 'atlanta': 'Georgia', 'miami': 'Florida', 'denver': 'Colorado', 'washington dc': 'District of Columbia',
    'london': 'England', 'manchester': 'England', 'birmingham': 'England', 'edinburgh': 'Scotland', 'glasgow': 'Scotland', 'cardiff': 'Wales',
  };
  function _regionForCity(city) {
    const parts = String(city || '').split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 3) return parts[1]; // LinkedIn format "Paris, Île-de-France, France"
    const k = String(parts[0] || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return _CITY_REGION[k] || '';
  }

  // ─── v2.5.116: "Oui" rule on AI answers (Théo 2026-10-16) ─────────────
  // A yes/no screening question leans YES: an AI (or cached) "No" is turned into the Yes option / "Yes" unless
  // the question is one where No is legitimate (FormFiller.yesNoNoAllowedReason: self-declaration, opt-in,
  // sponsorship / authorisation / relocation / licence / notice settings, adjustments, clearance, EEO, student
  // status, "do you require…", age, legal history, pay; 2.5.122: spoken language removed). Live 2026-10-16 (KYC): "projets de
  // Transformation RH et/ou conduite du changement ?" → "Non" with "Conduite du Changement" in the CV skills.
  const _NO_TEXT_RE = /^(no|non|nein|n[ãa]o)\s*[.!]?$/i;
  const _YES_FOR_NO = { no: 'Yes', non: 'Oui', nein: 'Ja', 'não': 'Sim', nao: 'Sim' };
  // 2.5.126 (Théo 2026-10-23, "IA choisi le oui non"): the AI's Yes / No stands — leanYes no longer flips an AI or
  // cached answer (kept as a pass-through so callers / tests stay; the forced Oui lives only on the no-AI path).
  const LEAN_YES_ENABLED = false;
  function leanYes(question, fieldType, options, answer) {
    if (!LEAN_YES_ENABLED) return answer;
    const a = String(answer == null ? '' : answer).trim();
    if (!a) return answer;
    const FF = window.EAM && window.EAM.FormFiller;
    if (!FF || !FF.yesNoNoAllowedReason) return answer;
    const opts = Array.isArray(options) ? options.map(o => String(o || '').trim()).filter(Boolean) : [];
    if (fieldType === 'checkbox') return answer; // multi-select arrays / single consent boxes have their own rules
    let isNo = false, yes = null;
    if (opts.length) {
      if (!FF.isYesNoOptions(opts)) return answer;
      const hit = opts.find(o => o.toLowerCase() === a.toLowerCase());
      isNo = !!(hit ? FF.NO_OPTION_STRICT_RE.test(hit) : _NO_TEXT_RE.test(a));
      yes = opts.find(o => FF.YES_OPTION_RE.test(o)) || null;
    } else {
      if (fieldType === 'number' || fieldType === 'tel' || fieldType === 'textarea') return answer;
      // v2.5.119: a count question ("Sur combien de projets…", "How many…") is not a yes/no question.
      if (/\b(combien|how\s+many|how\s+much|number\s+of|nombre\s+de|cu[aá]nt[oa]s|wie\s+viele|quant[ie])\b/i.test(String(question || ''))) return answer;
      isNo = _NO_TEXT_RE.test(a);
      const k = a.toLowerCase().replace(/[.!\s]+$/, '');
      yes = _YES_FOR_NO[k] || 'Yes';
    }
    if (!isNo || !yes) return answer;
    const why = FF.yesNoNoAllowedReason(question);
    if (why) { log()(`AI [Oui rule]: "${String(question).substring(0, 50)}" → "No" kept (${why})`); return answer; }
    log()(`AI [Oui rule]: "${String(question).substring(0, 50)}" → "${a}" turned into "${yes}"`);
    return yes;
  }
  // v2.5.116: "How many years of X" numeric questions follow the extension's years policy (X in the CV → its roles,
  // ≥ 1; X absent → total years) — never the AI's "0".
  const _YEARS_Q_RE = /how many years|years? of\b.{0,60}experience|combien d.ann[ée]es|nombre d.ann[ée]es|ann[ée]es? d.exp[ée]rience|a[ñn]os de experiencia|jahre\b.{0,30}erfahrung/i;

  async function askAI(question, config, fieldType, options) {
    // Skip all AI calls if premium_required was already received this session
    // v2.5.99: the premium block only stops the AI call (checked below, before the prompt) —
    // deterministic guards and exact cached answers keep working on the free plan.
    // 2026-09-18 (task #880): `options` is an array of choice labels for
    // radio/checkbox/select questions. When present, the AI is instructed
    // to reply with the EXACT text of the best-matching option (or "skip"
    // if none applies). Caller can then match the string to a control.

    // Marketing opt-in → deterministic "No", before cache and AI.
    if (isMarketingOptIn(question)) {
      const no = marketingNoAnswer(fieldType, options);
      log()(`AI [opt-in guard]: "${String(question).substring(0, 50)}" → ${no === null ? '(no "No" option — left unanswered)' : '"' + no + '"'}`);
      return no;
    }

    // v2.5.92: self-declaration choice (conflict of interest, current/former employee, relationship
    // with staff, prior interview, criminal record) → the negative option, before cache and AI.
    const FF = window.EAM && window.EAM.FormFiller;
    if (FF && FF.isSelfDeclarationQuestion && Array.isArray(options) && options.length && fieldType !== 'checkbox'
        && FF.isSelfDeclarationQuestion(question)) {
      const neg = options.find(o => FF.NEGATIVE_OPTION_RE.test(String(o).trim())) || null;
      log()(`AI [self-declaration guard]: "${String(question).substring(0, 50)}" → ${neg ? '"' + neg + '"' : '(no negative option — left unanswered)'}`);
      return neg || 'skip';
    }

    // v2.5.93: start-date questions → today + notice period (the AI answered "January 2022").
    if (FF && FF.startDateAnswer && FF.START_DATE_RE.test(String(question)) && !(Array.isArray(options) && options.length)
        && fieldType !== 'number' && fieldType !== 'checkbox' && fieldType !== 'radio') {
      const sd = FF.startDateAnswer(question, config, null);
      log()(`AI [start-date guard]: "${String(question).substring(0, 50)}" → "${sd}"`);
      return sd;
    }

    // v2.5.97: "Quel poste recherchez-vous ?" / "What position are you applying for?" → the job
    // being applied to. Live 2026-10-03 (julhiet sterwen, submitted): the AI answered
    // "Directeur Financier" for a project-management candidate applying to a change-manager job.
    // v2.5.119: universal autofill passes the job on the page (title / company / description) in config.jobContext.
    const _jc = (config && config.jobContext && (config.jobContext.title || config.jobContext.company)) ? config.jobContext : null;
    const _job = (window.EAM && window.EAM.utils && window.EAM.utils.currentJobInfo) || _jc || null;
    if (_job && _job.title && isDesiredPositionQuestion(question) && !(Array.isArray(options) && options.length)
        && fieldType !== 'number' && fieldType !== 'checkbox' && fieldType !== 'radio') {
      const t = cleanJobTitle(_job.title);
      log()(`AI [position guard]: "${String(question).substring(0, 50)}" → "${t}"`);
      return t;
    }

    if (FF && FF.yearsForQuestion && _YEARS_Q_RE.test(String(question || '')) && !(Array.isArray(options) && options.length)
        && fieldType !== 'textarea' && fieldType !== 'checkbox' && fieldType !== 'radio' && !/\b(and|et)\s+(describe|d[ée]cri|explain|expliqu)/i.test(String(question))
        && !/^\s*(do|did|have|has|are|is|can|could|will|would|avez|[êe]tes|poss[ée]dez|disposez|justifiez|pouvez)\b/i.test(String(question))
        && !/\b(at least|minimum|au moins|au minimum|more than|plus de)\s+\d/i.test(String(question))) {
      try {
        const y = FF.yearsForQuestion(question, config);
        if (y && isFinite(y.years)) { log()(`AI [years guard]: "${String(question).substring(0, 50)}" → ${y.years} (${y.basis})`); return String(y.years); }
      } catch (_) {}
    }

    await loadCache();

    // v2.5.98: job-specific free text (headline, summary, cover letter, motivation) is never served
    // from / written to the cross-job cache — live 2026-10-04 the "Summary" written for a Saudi
    // Service-Delivery job would have been reused verbatim on every later application.
    const jobSpecific = isJobSpecificQuestion(question);
    // Check cache first
    const cached = jobSpecific ? null : findCached(question, fieldType, options);
    if (cached) {
      log()(`AI [cache]: "${question.substring(0, 40)}" → "${cached.substring(0, 40)}"`);
      const lean = leanYes(question, fieldType, options, cached); // v2.5.116: older cached "No" answers too
      if (lean !== cached) { cache[cacheKey(question, fieldType, options)] = lean; await saveCache(); }
      return lean;
    }

    // Deterministic short-circuit for identity-URL questions where the real
    // value is empty. gpt-oss-20b will otherwise fabricate a plausible
    // linkedin.com/in/<name> or portfolio URL despite the "NEVER fabricate a
    // URL" rule in the prompt. Faster (no API call) and safe (no hallucination).
    const qLower = String(question || '').toLowerCase();
    const cvUrl = (config.cvProfile || {});
    const urlEmpty = (v) => !v || String(v).trim() === '';
    if (/\blinkedin\b.*\b(url|profile|link|address)\b|linkedin url|url\s+linkedin/i.test(qLower)
        && urlEmpty(config.linkedinUrl) && urlEmpty(cvUrl.linkedin)) {
      log()('AI [short-circuit]: LinkedIn URL empty → returning ""');
      return '';
    }
    if (/\b(portfolio|website|personal\s+site|personal\s+webpage)\b.*\b(url|link)\b|portfolio url|website url/i.test(qLower)
        && urlEmpty(config.portfolioUrl) && urlEmpty(cvUrl.website)) {
      log()('AI [short-circuit]: portfolio/website URL empty → returning ""');
      return '';
    }
    if (/\b(github|gitlab|bitbucket)\b.*\b(url|link|profile)\b/i.test(qLower)
        && urlEmpty(cvUrl.github)) {
      log()('AI [short-circuit]: github URL empty → returning ""');
      return '';
    }
    // v2.5.99: social profile fields (SmartRecruiters "Facebook", "X (formerly Twitter)") — the
    // profile never holds these; the AI was asked and replied "" on every form.
    if (/^\s*(facebook|twitter|x \(|instagram|tiktok|snapchat|youtube)\b/i.test(String(question || '')) && fieldType !== 'textarea'
        && !(Array.isArray(options) && options.length)) {
      log()('AI [short-circuit]: social profile field → returning ""');
      return '';
    }
    // v2.5.100: bare "Website" field (SmartRecruiters) with no website in the profile.
    if (/^\s*(website|personal website|site web|site internet|webseite|sitio web)\b/i.test(String(question || '')) && fieldType !== 'textarea'
        && !(Array.isArray(options) && options.length) && urlEmpty(config.portfolioUrl) && urlEmpty(cvUrl.website)) {
      log()('AI [short-circuit]: website field, none in the profile → returning ""');
      return '';
    }

    // v2.5.109: data the profile does not hold is never asked to the AI (it would invent it): the
    // CURRENT / last-drawn pay ("What is your current CTC?") — the expectation is not the current pay —
    // and the date of birth.
    if (FF && FF.isCurrentPayQuestion && FF.isCurrentPayQuestion(question) && fieldType !== 'checkbox' && config && String(config.currentSalary || '').trim() && FF.salaryAnswer) {
      const cur = FF.salaryAnswer(question, config);
      log()(`AI [short-circuit]: current pay from your settings → ${cur || '""'}`);
      return cur || '';
    }
    // v2.5.119 (live AI Draft on Lever 2026-10-17: "What is your current compensation?" → the EXPECTED salary): same
    // rule when FormFiller is not loaded on the page.
    const _curPay = FF && FF.isCurrentPayQuestion ? FF.isCurrentPayQuestion(question)
      : (/\b(current|present|last[\s-]+drawn|existing)\b[^?.]{0,30}\b(ctc|salary|compensation|pay|package|remuneration)\b|salaire\s+actuel|r[ée]mun[ée]ration\s+actuelle/i.test(String(question || '')) && !/expect|desired|souhait|attendu|pr[ée]tention/i.test(String(question || '')));
    if (!FF && _curPay && fieldType !== 'checkbox' && !String((config && config.currentSalary) || '').trim()) {
      log()('AI [short-circuit]: current pay is not in the profile → returning ""');
      return '';
    }
    if (FF && FF.isCurrentPayQuestion && FF.isCurrentPayQuestion(question) && fieldType !== 'checkbox') {
      log()('AI [short-circuit]: current pay is not in the profile → returning ""');
      return '';
    }
    if (/date\s+of\s+birth|\bd\.?o\.?b\b|birth\s*date|\bbirthday\b|date\s+de\s+naissance|fecha\s+de\s+nacimiento|geburtsdatum/i.test(String(question || ''))) {
      const _dob = FF && FF.profileDateOfBirth ? FF.formatDobFor(FF.profileDateOfBirth(config), null, question) : '';
      if (_dob) { log()('AI [short-circuit]: date of birth from your settings'); return _dob; }
      log()('AI [short-circuit]: date of birth is not in the profile → returning ""');
      return '';
    }
    // v2.5.109 (adversarial suite 2026-10-12): a middle name / a street address are identity data the
    // profile does not hold — the AI wrote "Kumar" and "221B Baker Street". Address → the profile city
    // (true, and what most forms accept), else nothing.
    const _qs = String(question || '').replace(/\s+/g, ' ').trim();
    if (/^(?:your\s+)?(middle\s+name|second\s+name|deuxi[eè]me\s+pr[ée]nom|segundo\s+nombre|zweiter\s+vorname)\b/i.test(_qs) && fieldType !== 'checkbox' && fieldType !== 'radio') {
      log()('AI [short-circuit]: middle name is not in the profile → returning ""');
      return '';
    }
    // v2.5.110 (live 2026-10-12, Wakeo / JazzHR): "State" → the AI wrote "France". State / region / province
    // comes from the profile city (known cities only), never the country; postal code is not in the profile.
    if (/^(?:your\s+)?(state|province|region|r[ée]gion|state\s*\/\s*province|county|d[ée]partement|estado|bundesland)\s*\*?$/i.test(_qs) && fieldType !== 'checkbox' && fieldType !== 'radio') {
      const reg = _regionForCity(config.city);
      log()(`AI [short-circuit]: state / region → ${reg ? '"' + reg + '"' : '"" (city not mapped)'}`);
      return reg;
    }
    if (/^(?:your\s+)?(postal(\s+code)?|zip(\s*code)?|post\s*code|code\s+postal|c[oó]digo\s+postal|plz|postleitzahl)\s*\*?$/i.test(_qs) && fieldType !== 'checkbox' && fieldType !== 'radio') {
      // v2.5.112: the optional popup "Postal / ZIP code" (or the CV's) when the user gave one — never invented.
      const pc = FF && FF.postalCodeValue ? FF.postalCodeValue(config) : '';
      log()(`AI [short-circuit]: postal code → ${pc ? 'from your settings' : '"" (not in the profile)'}`);
      return pc;
    }
    // v2.5.112: "Country" as free text → the profile country name.
    if (/^(?:your\s+)?(country(\s+of\s+(residence|citizenship))?|country\s*\/\s*region|pays|pa[ií]s)\s*\*?$/i.test(_qs) && fieldType !== 'checkbox' && fieldType !== 'radio' && !(Array.isArray(options) && options.length) && FF && FF.profileCountryName) {
      const cn = FF.profileCountryName(config);
      if (cn) { log()(`AI [short-circuit]: country → "${cn}"`); return cn; }
    }
    // v2.5.112 (CoreWeave "Legal Address *"): legal / residential / permanent address = the same rule as address.
    if (/^(?:your\s+|home\s+|current\s+|postal\s+|street\s+|mailing\s+|legal\s+|residential\s+|permanent\s+|physical\s+|full\s+)?(address(\s+line\s*\d)?|street(\s+address)?|adresse(\s+postale)?|direcci[oó]n|anschrift)\s*\*?$/i.test(_qs) && fieldType !== 'checkbox' && fieldType !== 'radio') {
      const city = String(config.city || '').trim();
      log()(`AI [short-circuit]: street address is not in the profile → ${city ? 'city "' + city + '"' : '""'}`);
      return city;
    }

    // Skip all AI calls if premium_required was already received this session
    if (premiumBlocked) return null;
    if (await cachedPlanIsFree()) {
      log()('AI [premium]: free plan — AI answers are Premium, no AI call');
      markPremiumBlocked();
      return null;
    }

    // v2.5.87: never guess an education answer without education data — a blind
    // "No" to "Bachelor's Degree?" was submitted for a Master's holder. Returning
    // null leaves the field to the normal flow (required → application skipped).
    const isEducationQ = /\b(degree|bachelor|master'?s?|mba|phd|doctorate|diploma|dipl[oô]me|licence|baccalaur|level of education|niveau d'?[ée]tudes|bac\s*\+\s*\d)\b/i.test(qLower);
    const eduData = (config.cvProfile || {}).education;
    if (isEducationQ && !(Array.isArray(eduData) && eduData.some(e => e && (e.degree || e.school)))) {
      log()('AI [skip]: education question but no CV education data — not guessing');
      return null;
    }

    // Build prompt for the AI
    const recentAnswers = Object.entries(cache).slice(-8)
      .map(([k, a]) => `Q: ${questionOfKey(k)}\nA: ${a}`).join('\n');

    const isNumeric = fieldType === 'number' || fieldType === 'tel';
    const isTextarea = fieldType === 'textarea';
    // Radio / checkbox / select with an explicit list of choices
    const hasChoices = Array.isArray(options) && options.length > 0;
    const isChoice = hasChoices && (fieldType === 'radio' || fieldType === 'checkbox' || fieldType === 'select');
    // v2.5.86 (2026-09-20): multi-checkbox mode — LinkedIn Easy Apply ships
    // "select all that apply" questions (skills, work auths, benefits). The
    // prior CHOICE MODE prompt forced ONE answer, missing the multi-select
    // semantics. Auto-detect from question text (no signature change needed).
    // Reply is a JSON array of exact-text matches; caller parses + toggles
    // each matching checkbox.
    const isMultiChoice = isChoice && fieldType === 'checkbox' &&
      /\b(select all|check all|all that apply|choose all|pick all|which of the following.*apply)\b/i.test(qLower);

    // Rich candidate context from popup settings + uploaded CV (Smart Profile)
    // — prevents the LLM from hallucinating URLs / biography facts when the
    // real data is available in extension storage.
    const cv = config.cvProfile || {};
    const topSkills = (cv.skills || []).slice(0, 12).join(', ');
    // v2.5.99: real achievements (≤2 bullets per role) so open answers cite them instead of
    // inventing one — gate 2026-10-04 (Lever "proudest accomplishment"): "increased user
    // engagement by 15%" was written for a profile whose bullets never say that.
    const bulletsOf = (e) => {
      const b = Array.isArray(e.bullets) ? e.bullets : Array.isArray(e.description) ? e.description : [];
      return b.map(x => String(typeof x === 'string' ? x : (x && x.text) || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 2)
        .map(x => `    • ${x.slice(0, 180)}`).join('\n');
    };
    const recentRoles = (cv.experience || []).slice(0, 3)
      .map(e => { const head = `- ${e.title || ''} @ ${e.company || ''} (${e.duration || e.dates || ''})`; const b = bulletsOf(e); return head.length > 5 ? head + (b ? '\n' + b : '') : ''; })
      .filter(Boolean).join('\n');
    const education = (cv.education || []).slice(0, 4)
      .map(e => `- ${e.degree || ''}${e.school ? ', ' + e.school : ''}${e.year ? ' (' + e.year + ')' : ''}`)
      .filter(s => s.length > 5).join('\n');
    const languages = Array.isArray(cv.languages)
      ? cv.languages.map(l => typeof l === 'string' ? l : (l.name || '')).filter(Boolean).join(', ')
      : '';
    const _cs = (window.EAM && window.EAM.utils && window.EAM.utils.cleanProfileSummary) || ((x) => x || '');
    const summary = _cs(config.summary) || _cs(cv.summary) || '';

    const prompt = `You are filling a job application form. Give a SHORT, CONCISE answer for this form field. Plain text only, no markdown.
Today's date: ${new Date().toISOString().slice(0, 10)} (any availability / start date must be in the future).

CANDIDATE:
Name: ${config.firstName || ''} ${config.lastName || ''}
Email: ${config.email || ''}
Phone: ${config.phone || ''}
Location: ${config.city || ''}
Years of experience: ${config.yearsOfExperience || ''}
Current role: ${config.currentTitle || cv.currentTitle || ''}${(config.currentCompany || cv.currentCompany) ? ` at ${config.currentCompany || cv.currentCompany}` : ''}
LinkedIn: ${config.linkedinUrl || cv.linkedin || ''}
Portfolio/Website: ${config.portfolioUrl || cv.website || ''}
Gender: ${config.gender || ''}
Salary expectation: ${config.expectedSalary || ''}
Visa sponsorship needed: ${config.visaSponsorship || 'no'}
Legally authorized to work: ${config.legallyAuthorized || 'yes'}
Willing to relocate: ${config.willingToRelocate || ''}
Driver's license: ${config.driversLicense || ''}
Notice period: ${config.noticePeriod || ''}
${_job && _job.title ? `Job being applied for (TARGET job — NOT a title the candidate holds or held): ${cleanJobTitle(_job.title)}${_job.company ? ' at ' + _job.company : ''}` : ''}
${_jc && _jc.description ? `Job posting excerpt (the TARGET job's requirements — never the candidate's experience): ${String(_jc.description).slice(0, 1500)}` : ''}
${config && config.formLanguage ? `FORM LANGUAGE: ${config.formLanguage} — write the answer in ${config.formLanguage} (the language of this application form), whatever the language of the question wording, the job posting or the candidate data.` : ''}
${summary ? `\nProfessional summary: ${summary.substring(0, 400)}` : ''}
${topSkills ? `Top skills: ${topSkills}` : ''}
${languages ? `Languages: ${languages}` : ''}
${recentRoles ? `\nRecent experience:\n${recentRoles}` : ''}
${education ? `\nEducation:\n${education}` : ''}

${isChoice ? `\nOPTIONS (pick ONE, reply with EXACT text):\n${options.map(o => `- ${o}`).join('\n')}\n` : ''}
${recentAnswers ? `PREVIOUS ANSWERS:\n${recentAnswers}\n` : ''}
RULES:
- ${isMultiChoice ? 'MULTI-CHOICE MODE: Reply with a JSON array of the EXACT text of ALL applicable options — e.g. ["Option A", "Option C"]. Include EVERY option that honestly matches the candidate profile. If NONE apply, reply []. No commentary, no explanation, just the JSON array.' : isChoice ? 'CHOICE MODE: Reply with the EXACT text of ONE option from the list above — no commentary, no punctuation, no quotes. If genuinely none applies, reply "skip". Prefer the option that best matches candidate data + question intent. For "how did you hear about us"-style questions, pick the most plausible neutral answer like "LinkedIn" or "Google" or the option matching signup_source if listed. YES/NO QUESTIONS (2.5.126): choose "Yes" or "No" TRUTHFULLY from the candidate data above — "Yes" when the data shows it or shows closely related / transferable experience, "No" when it does not (never invent a skill, degree, school, employer, certification or language). Schools / school types (grande école, classe préparatoire, engineering school…), specific degrees and named employers: ONLY from "Education" / "Recent experience". Also "No" when "Yes" would contradict the data above: needs visa sponsorship (use "Visa sponsorship needed"), not authorized to work, current / former employee or relative at this company, conflict of interest, prior application / interview here, criminal record, non-compete, requires adjustments, security clearance, relocation / a place outside the location of the candidate when "Willing to relocate" is no, a language not listed in "Languages".' : isNumeric ? 'IMPORTANT: Reply with ONLY a single number. No text, no units, no punctuation. Just the number. Example: 160' : isTextarea && config && config.coverNote ? 'COVER NOTE: write a short cover note (4-6 sentences, first person, no greeting line, no signature, no placeholders like [Company]) for the TARGET job above: why this job, then the 2-3 most relevant REAL experiences / skills from the candidate data and how they serve the job requirements in the posting excerpt. Every claim about the candidate must come from "Recent experience", "Professional summary", "Top skills" or "Education" above — never claim a requirement of the posting the data does not show; no invented numbers.' : isTextarea ? 'Write 2-4 sentences, in first person, grounded in the candidate data above. Every concrete claim (tool, system, integration, product launch, team type, client, sector, achievement) must be written in "Recent experience", "Professional summary" or "Top skills" above — paraphrase those real bullets, do not extrapolate from a job title (e.g. "Business Developer at Google" does NOT mean "worked with development teams"). If the data does not cover what the question asks, answer with the closest real experience and stay general rather than inventing (v2.5.104: invented a "CRM integration with event tools" and "product launches").' : 'Max 1 sentence. Use data above when available.'}
- If the question asks for a specific candidate datapoint (LinkedIn URL, portfolio, gender, etc.) and the value is EMPTY above, reply with an appropriate empty marker: "" for open text, "N/A" for identity questions, "0" for numeric. NEVER fabricate a URL, email, phone, or biographical fact that is not listed above.
- Marketing / contact opt-ins (newsletters, job alerts, "email me about other openings", talent community, SMS / WhatsApp consent) → always "No" (or the equivalent option). Only a consent REQUIRED to submit the application (privacy policy / data processing) is "Yes".
- Degree / education-level questions: answer ONLY from "Education" above. A higher degree (Master, MBA, PhD, "Bac+5") means the lower levels (Bachelor, Licence, Associate, high school) are completed too.
- Never present the candidate as already holding the target job's title, and in written answers never claim an industry, employer, tool, certification or experience that is not in the candidate data above (v2.5.98: "I am a bilingual Service Delivery Manager…" was written for an events/strategy profile). Headline / summary / cover letter: describe the candidate's REAL background, then why it fits the target job.
- "Do you have experience in / with X?", "Have you worked on X projects?", "Are you familiar with X?", "Can you …?" → "Yes" when the data shows it or closely related experience, otherwise "No" (2.5.126: the answer must be true to the CV; in open text, cite the closest real experience). "Are you willing to work in <place>?" → "Yes" when the place is the candidate's location or "Willing to relocate" is yes, otherwise "No".
- Numeric "how many years of X": X in the candidate data → the years of the matching roles (at least 1); X absent → the candidate's total "Years of experience" above (never "0").
- Never write a number, percentage, amount or metric (e.g. "increased engagement by 15%") that is not written in the candidate data above — quote the real achievements from "Recent experience" or stay qualitative.
- Questions about the size / scope / number of something the candidate did (team size, engineers coordinated, budget managed, number of projects) that the data above does not state → the smallest / "none" option, or "skip" — never a mid-range guess (v2.5.98: "10-19 engineers" was invented).
- Match the language of the question${config && config.formLanguage ? ' — here: ' + config.formLanguage + ' (FORM LANGUAGE)' : ''}.
- For salary/money/hours/quantity fields reply ONLY the number.

Question: "${question}"
Answer:`;

    try {
      log()(`AI [calling]: "${question.substring(0, 50)}..."`);

      // Send request to background.js (service worker has no CORS restrictions)
      let answer = null;
      try {
        log()('AI [sending to background]...');
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: 'ai-form-answer',
            prompt: prompt
          }, (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(resp);
            }
          });
        });
        log()(`AI [background response]: ${JSON.stringify(response || 'undefined').substring(0, 100)}`);
        if (response?.error) {
          if (response.error === 'premium_required') {
            log()('AI [premium]: AI form answers require Premium plan — skipping all AI calls this session');
            markPremiumBlocked();
          } else if (response.error === 'session_expired' || response.error === 'unauthorized' ||
                     response.error === 'no_session' || response.error === 'not_logged_in') {
            // Treat any auth-related error like premium_required: stop calling AI
            // for the rest of this session. Without this, the bot retries on
            // every step (10× per job) wasting time and looking spammy in logs.
            log()(`AI [auth]: ${response.error} — disabling AI for this session (sign in to enable)`);
            premiumBlocked = true;
          } else {
            log()(`AI [error]: ${response.error}`);
          }
          return null;
        }
        answer = (response?.answer || '').trim();
      } catch (e) {
        log()(`AI [error]: ${e.message}`);
        return null;
      }

      if (!answer) return null;

      if (!answer) return null;

      // Clean up: remove quotes if wrapped
      answer = answer.replace(/^["']|["']$/g, '').trim();
      answer = leanYes(question, fieldType, options, answer); // v2.5.116 Oui rule

      // Cache it (not job-specific free text — see isJobSpecificQuestion)
      if (!jobSpecific) {
        cache[cacheKey(question, fieldType, options)] = answer;
        await saveCache();
      }

      log()(`AI [answer]: "${question.substring(0, 35)}" → "${answer.substring(0, 50)}"`);
      return answer;

    } catch (e) {
      log()(`AI [error]: ${e.message}`);
      return null;
    }
  }

  // ─── Export ─────────────────────────────────────────────────────────

  window.EAM.aiForm = {
    askAI,
    isPremiumBlocked: () => premiumBlocked,
    findCached,
    isMarketingOptIn,
    isDesiredPositionQuestion,
    cleanJobTitle,
    regionForCity: _regionForCity,
    leanYes,
    _cacheKey: cacheKey, // exposed for unit tests
    loadCache,
    clearCache: async () => { cache = {}; await saveCache(); }
  };

})();
