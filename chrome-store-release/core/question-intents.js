// question-intents.js — "To complete" (2026-10-19): maps an application-form question label to the
// profile field that answers it, or to a per-question saved answer.
//
// Shared, byte-identical, by the extension (core/question-intents.js) and the dashboard
// (js/question-intents.js) — tests/to-complete-intents.test.js checks both copies match.
// Pure functions, no DOM, no chrome.* — Node-testable.
//
// Intents with a profile field (one answer reused for every job):
//   expectedSalary, currentSalary (yearly amount, digits) · city · postalCode · noticePeriod ·
//   dateOfBirth (YYYY-MM-DD) · gender · nationality · phone · legallyAuthorized · visaSponsorship ·
//   willingToRelocate (yes / no)
// 'custom'      → the user's answer is saved for THIS question (normalized text) and reused only when
//                 a form asks the same question again.
// 'unsupported' → cannot be answered by a stored text (file upload, cover letter, work-experience /
//                 education entry forms): never put in the "To complete" list.
(function (root) {
  'use strict';

  const deaccent = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');

  // "What is your nationality?What is your nationality?" / "Title Title" → one copy.
  function dedupeDoubled(s) {
    const t = String(s || '').trim();
    const n = t.length;
    if (n >= 8 && n % 2 === 0 && t.slice(0, n / 2) === t.slice(n / 2)) return t.slice(0, n / 2).trim();
    const m = t.match(/^(.{4,}?)\s+\1$/);
    return m ? m[1].trim() : '';
  }

  // LinkedIn label noise: "Headline single line text form component formelement urn li jobs apply…",
  // trailing "*", "(required)", doubled a11y copies.
  function cleanLabel(raw) {
    let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*\b(single line text|multi line text|form component|formelement|urn li)\b.*$/i, '').trim();
    s = s.replace(/\s*\((required|obligatoire|requis|obligatorio)\)\s*$/i, '').replace(/\s*\*+\s*$/, '').trim();
    for (let i = 0; i < 2; i++) { const d = dedupeDoubled(s); if (d) s = d; }
    s = s.replace(/\s*\*+\s*$/, '').trim();
    return s.slice(0, 200);
  }

  // Stable key for a question (saved answers): lowercase, no accents, letters / digits only.
  function questionKey(label) {
    return deaccent(cleanLabel(label)).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 160);
  }

  // A closed yes/no question ("Are you located in Toronto?", "Do you have a driver's license?").
  const YESNO_Q = /^(are|is|do|does|did|have|has|can|could|will|would|should|were|was)\s+you\b|^(etes|êtes|es|avez|pouvez|serez|seriez|souhaitez|accepteriez|acceptez|voulez|habitez|residez|résidez)[\s-]+vous\b|^(est-ce que|estas|estás|tienes|puedes|eres|vives|resides|voce|você|tem|pode)\b|^(क्या)\b/i;

  const SAL = '(salary|salaries|salarial|salariales|salariais|ctc|compensation|pay\\b|package|remuneration|rémunération|remuneracion|remuneração|salaire|sueldo|salario|salário|wage|वेतन|सैलरी|सीटीसी|पैकेज)';
  const CUR_WORDS = /\b(current|present|existing|actual|last\s+drawn|last|most\s+recent|today'?s|actuel(le)?|actual(mente)?|atual|aujourd'?hui|वर्तमान|मौजूदा|अभी)\b/i;
  const EXP_WORDS = /\b(expected|expectation|expectations|desired|desire|target|minimum|asking|required|requirement|preferred|ideal|prétentions?|pretentions?|souhait[ée]?e?s?|attendu|vis[ée]|pretensi[oó]n|pretendid[ao]|esperad[ao]|deseado|expectativa|pretens[aã]o|अपेक्षित|उम्मीद)\b|\bectc\b/i;
  // Part of the pay that no setting holds (variable / bonus / incentive): a per-question answer.
  const VARIABLE_PAY = /\b(variable|bonus|incentive|commission|stock|esop|equity|prime|variable)\b/i;
  // A currency the yearly setting cannot express (never converted) → per-question answer.
  const KNOWN_CUR = /\b(EUR|USD|INR|GBP|CAD|CHF|AUD)\b|[€£₹$]|\blpa\b|\blakhs?\b|\blacs?\b/i;
  const OTHER_CUR = /\b(EGP|AED|SAR|QAR|KWD|OMR|BHD|JOD|SGD|MYR|PHP|PKR|BDT|LKR|NPR|IDR|THB|VND|KRW|JPY|CNY|RMB|HKD|TWD|NZD|ZAR|NGN|KES|GHS|MAD|TND|TRY|ILS|PLN|CZK|HUF|RON|BGN|SEK|NOK|DKK|BRL|MXN|ARS|CLP|COP|PEN|UAH|RUB|riyals?|dirhams?)\b/i;
  const HOURLY = /\b(hourly|per\s+hour|an\s+hour|\/\s*h(ou)?r|par\s+heure|por\s+hora|taux\s+horaire)\b/i;

  const RX = {
    unsupported: [
      /^(work\s+experience|education)\s*:/i,
      /\b(upload|attach|joindre|t[ée]l[ée]charger|adjuntar|anexar)\b/i,
      /^(resume|r[ée]sum[ée]|cv|curriculum(\s+vitae)?|cover\s+letter|lettre\s+de\s+motivation|carta\s+de\s+presentaci[oó]n|carta\s+de\s+apresenta[cç][aã]o|photo|photograph)\s*[?:]?$/i,
      /\bcover\s+letter\b|\blettre\s+de\s+motivation\b/i,
      // An answer option reported as the question (radio group without its question text): "Yes", "No, have never heard".
      /^(yes|no|oui|non|si|sí|sim|n[aã]o|हाँ|नहीं)(\s*[,.!:-]|\s*$)/i,
      // Work-experience entry sub-form (dates of one role).
      /^year\s+of\s+(from|to)$|^(from|to)\s+(year|month|date)$/i,
      /^photo\b/i,
    ],
    postalCode: /\b(postal\s*code|post\s*code|postcode|zip(\s*code)?|code\s+postal|c[oó]digo\s+postal|\bcep\b|pin\s*code|pincode)\b|पिन\s*कोड/i,
    dateOfBirth: /\b(date\s+of\s+birth|birth\s*date|birthday|\bdob\b|date\s+de\s+naissance|fecha\s+de\s+nacimiento|data\s+de\s+nascimento)\b|जन्म\s*(तिथि|तारीख)/i,
    nationality: /\b(nationality|nationalit[ée]|nacionalidad|nacionalidade|citizenship)\b|राष्ट्रीयता|नागरिकता/i,
    gender: /^(gender|sex|sexe|genre|g[ée]nero|g[êe]nero)\b|\b(your\s+gender|gender\s+identity|what\s+is\s+your\s+(gender|sex))\b|लिंग/i,
    phone: /^(mobile|cell|phone|telephone|t[ée]l[ée]phone|tel[ée]fono|telefone|contact)(\s+(number|no\.?|num[ée]ro|n[uú]mero))?\s*[?:]?$|\b(mobile|phone)\s+number\b|फ़ोन|फोन|मोबाइल/i,
    noticePeriod: /\b(notice\s+period|\bnp\b|pr[ée]avis|preaviso|aviso\s+pr[ée]vio|how\s+soon\s+(can|could|would)\s+you\s+(start|join|be\s+able\s+to\s+start)|when\s+can\s+you\s+(start|join)|earliest\s+(start|joining|possible\s+start)\s*date|joining\s+(time|period|date)|availability\s+to\s+(start|join)|date\s+de\s+disponibilit[ée]|disponibilit[ée]|d[ée]lai\s+de\s+pr[ée]avis|cu[aá]ndo\s+(puedes|podr[ií]as)\s+(empezar|incorporarte)|quando\s+(pode|poderia)\s+come[cç]ar)\b|नोटिस/i,
    city: /\b((current|present|your)\s+(location|city|town|residence|address)|city\s+of\s+residence|place\s+of\s+residence|where\s+(are|do)\s+you\s+(currently\s+)?(based|located|live|reside|living)|where\s+do\s+you\s+live|candidate\s+location|location\s*\(\s*city|city\s*(,|and|\/)\s*(state|province|country)|lieu\s+de\s+r[ée]sidence|ville(\s+actuelle|\s+de\s+r[ée]sidence)?|o[uù]\s+habitez|localisation(\s+actuelle)?|ubicaci[oó]n(\s+actual)?|ciudad(\s+de\s+residencia)?|d[oó]nde\s+vives|cidade(\s+atual)?|localiza[cç][aã]o(\s+atual)?|onde\s+(voc[eê]\s+)?mora)\b|^(location|city|town|ville|ciudad|cidade)\s*[?:]?$|वर्तमान\s+(स्थान|शहर)|शहर|स्थान/i,
    legallyAuthorized: /\b(legally\s+(authori[sz]ed|eligible|allowed)|authori[sz]ed\s+to\s+work|eligible\s+to\s+work|right\s+to\s+work|work\s+permit|work\s+authori[sz]ation|autoris[ée]e?\s+[àa]\s+travailler|permis\s+de\s+travail|permiso\s+de\s+trabajo|autorizado\s+a\s+trabajar|autoriza[cç][aã]o\s+de\s+trabalho)\b/i,
    visaSponsorship: /\b(sponsor(ship)?|visa|parrainage|patrocinio|patroc[ií]nio)\b/i,
    willingToRelocate: /\b(relocat\w*|d[ée]m[ée]nag\w*|reubica\w*|mudar(te|se)?\s+de\s+ciudad|mudar\s+de\s+cidade|relocaliza\w*)\b|स्थानांतरित/i,
  };

  const SETTING_KIND = {
    expectedSalary: 'money', currentSalary: 'money', city: 'text', postalCode: 'postal', noticePeriod: 'notice',
    dateOfBirth: 'date', gender: 'gender', nationality: 'text', phone: 'phone',
    legallyAuthorized: 'yesno', visaSponsorship: 'yesno', willingToRelocate: 'yesno',
  };
  const SETTINGS = Object.keys(SETTING_KIND);

  function salaryIntent(s) {
    const re = new RegExp(SAL, 'i');
    if (!re.test(s) && !/\b(lpa|ectc|cctc)\b|\bexpectativas?\s+econ[oó]micas?\b|\bpr[ée]tentions?\b/i.test(s)) return '';
    if ((VARIABLE_PAY.test(s) && !/\b(fixed\s*(and|&|\+|\/)\s*variable|including|incl\.?|total|full\s+package|overall)\b/i.test(s)) || HOURLY.test(s)) return 'custom';
    if (OTHER_CUR.test(s) && !KNOWN_CUR.test(s.replace(OTHER_CUR, ''))) return 'custom';
    if (/\bcctc\b/i.test(s)) return 'currentSalary';
    const exp = EXP_WORDS.test(s), cur = CUR_WORDS.test(s);
    if (exp && !cur) return 'expectedSalary';
    if (cur && !exp) return 'currentSalary';
    if (exp && cur) return /\b(expected|desired|ectc|minimum|prétention|pretensi|expectativa|अपेक्षित)\b/i.test(s) && !/^\s*(what\s+is\s+)?(your\s+)?(current|present)\b/i.test(s) ? 'expectedSalary' : 'currentSalary';
    // Bare "CTC" (India) is the current package; bare "Salary" / "Compensation" asks the expectation.
    if (/\bctc\b|सीटीसी/i.test(s)) return 'currentSalary';
    return 'expectedSalary';
  }

  // label → { intent, key, label, field, kind }
  function classify(rawLabel) {
    const label = cleanLabel(rawLabel);
    const key = questionKey(label);
    const out = (intent) => ({ intent, key, label, field: SETTING_KIND[intent] ? intent : null, kind: SETTING_KIND[intent] || (intent === 'custom' ? 'text' : null) });
    if (!key || key.length < 2) return out('unsupported');
    const s = deaccent(label).replace(/\s+/g, ' ');
    const sRaw = label; // Devanagari patterns test the raw label (deaccent strips the nukta / matras)
    const t = (rx) => rx.test(s) || rx.test(sRaw);
    if (RX.unsupported.some(rx => t(rx))) return out('unsupported');
    const yesno = YESNO_Q.test(s);
    if (yesno) {
      if (t(RX.legallyAuthorized)) return out('legallyAuthorized');
      if (t(RX.visaSponsorship)) return out('visaSponsorship');
      if (t(RX.willingToRelocate)) return out('willingToRelocate');
      return out('custom'); // "Are you located in Toronto?" → Yes / No for this question only
    }
    const sal = salaryIntent(s) || salaryIntent(sRaw);
    if (sal) return out(sal);
    for (const k of ['postalCode', 'dateOfBirth', 'nationality', 'gender', 'noticePeriod', 'phone']) if (t(RX[k])) return out(k);
    if (t(RX.city) && !/\b(preferred|desired|willing|prefer|souhait|open\s+to|which\s+of\s+(these|the\s+following))\b/i.test(s)) return out('city');
    if (t(RX.legallyAuthorized)) return out('legallyAuthorized');
    if (t(RX.visaSponsorship)) return out('visaSponsorship');
    if (t(RX.willingToRelocate)) return out('willingToRelocate');
    return out('custom');
  }

  // Amount typed by the user → yearly digits. "45,000" / "45 000" / "45k" / "8 LPA" / "8 lakhs" / "1.2 cr".
  // Returns '' when it is not an amount. Never guesses a period: the field asks "per year".
  function parseAmount(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[€£₹$]/g, '').replace(/\b(eur|usd|inr|gbp|cad|aud|chf)\b/g, '').trim();
    if (!s) return '';
    let m = s.match(/^(\d+(?:[.,]\d+)?)\s*(lpa|lakhs?|lacs?|l)$/);
    if (m) return String(Math.round(parseFloat(m[1].replace(',', '.')) * 100000));
    m = s.match(/^(\d+(?:[.,]\d+)?)\s*(cr|crores?)$/);
    if (m) return String(Math.round(parseFloat(m[1].replace(',', '.')) * 10000000));
    m = s.match(/^(\d+(?:[.,]\d+)?)\s*k$/);
    if (m) return String(Math.round(parseFloat(m[1].replace(',', '.')) * 1000));
    if (!/^\d[\d\s,.]*$/.test(s)) return '';
    const digits = s.replace(/[\s,]/g, '').replace(/\.\d{1,2}$/, '').replace(/\./g, '');
    if (!/^\d{1,12}$/.test(digits) || /^0+$/.test(digits)) return '';
    return String(parseInt(digits, 10));
  }

  // Normalized value for a setting intent, '' = invalid / empty.
  function normalizeAnswer(intent, raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    switch (SETTING_KIND[intent] || 'text') {
      // 2.5.122: current pay may be 0 (an India fresher's "Current CTC"); an expectation never is.
      case 'money': return (intent === 'currentSalary' && /^0+(?:[.,]0+)?s*(?:lpa|lakhs?|k)?$/i.test(s)) ? '0' : parseAmount(s);
      case 'yesno': { const v = deaccent(s).toLowerCase(); return /^(yes|oui|si|sim|y|हाँ|हां)$/.test(v) ? 'yes' : /^(no|non|nao|n|नहीं)$/.test(v) ? 'no' : ''; }
      case 'gender': { const v = s.toLowerCase(); return ['male', 'female', 'non_binary', 'other'].includes(v) ? v : ''; }
      case 'date': return /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s) ? s : '';
      case 'postal': return /^[A-Za-z0-9][A-Za-z0-9 -]{0,11}$/.test(s) ? s : '';
      case 'phone': return /^[+()\d][\d\s().-]{5,24}$/.test(s) ? s : '';
      case 'notice': return s.slice(0, 40);
      default: return s.replace(/[<>]/g, '').slice(0, intent === 'custom' ? 500 : 80);
    }
  }

  // A To-complete question list for one skipped job: required labels the bot could not answer +
  // settings reported missing (state._missingSettings). Deduped by key; unsupported dropped.
  const MISSING_LABEL = { expectedSalary: 'Expected salary', currentSalary: 'Current salary / CTC', postalCode: 'Postal code', dateOfBirth: 'Date of birth', gender: 'Gender' };
  function questionsForSkip(labels, missing, meta) {
    const out = []; const seen = new Set(); const fields = new Set();
    for (const raw of labels || []) {
      const c = classify(raw);
      if (c.intent === 'unsupported' || seen.has(c.key)) continue;
      seen.add(c.key);
      const m = meta && meta[String(raw || '').trim().toLowerCase().slice(0, 120)];
      const q = { label: c.label, key: c.key, intent: c.intent };
      if (m && m.kind) q.kind = m.kind;
      if (m && Array.isArray(m.options) && m.options.length) q.options = m.options.slice(0, 12).map(o => String(o).slice(0, 80));
      if (c.field) fields.add(c.field);
      out.push(q);
    }
    for (const k of missing || []) {
      if (!SETTING_KIND[k] || fields.has(k)) continue;
      fields.add(k);
      const label = MISSING_LABEL[k] || k;
      out.push({ label, key: questionKey(label), intent: k });
    }
    return out.slice(0, 8);
  }

  const api = { cleanLabel, questionKey, classify, parseAmount, normalizeAnswer, questionsForSkip, SETTINGS, SETTING_KIND, _dedupeDoubled: dedupeDoubled };
  root.AAMQuestionIntents = api;
  if (typeof window !== 'undefined' && window.EAM) window.EAM.QuestionIntents = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
