/**
 * AutoApplyMax — Unified "Tailor CV" button on job pages (2026-08-01)
 * ──────────────────────────────────────────────────────────────────
 * Single sober blue button next to the job title on LinkedIn, Indeed,
 * Glassdoor, Welcome to the Jungle. Replaces the two previous inline
 * pieces (colour-coded % match badge + separate Generate CV pill), which
 * looked loud stacked together.
 *
 * Layout:      [ ✨ Tailor CV  · 22% match  ⓘ ]
 *              └─ main action ─┘   └detail toggle─┘
 *
 * Click on the "Tailor CV" region  → stores the JD in chrome.storage,
 *                                    opens autoapplymax.com dashboard
 *                                    on the CV generator with the JD
 *                                    pre-filled.
 * Click on the "% match ⓘ" region  → toggles a floating detail panel
 *                                    (matched + missing keywords).
 *
 * Scoring runs 100% client-side (keyword overlap between JD + user CV
 * stored in chrome.storage). No AI call, no network.
 *
 * Namespace: window.EAM.tailorCvBtn
 */
(function () {
  'use strict';

  if (window !== window.top) return;

  const SITES = {
    'linkedin.com': {
      titleSel: [
        '.job-details-jobs-unified-top-card__job-title',
        '.jobs-unified-top-card__job-title',
        'h1.top-card-layout__title',
        'h1.jobs-details-top-card__job-title',
        // Aug 2026 redesign — /jobs/collections/ pane uses these classes on
        // a sibling H1 alongside the legacy DIV target above.
        'h1.t-24.t-bold',
        'h1[class*="t-24"][class*="t-bold"]',
      ],
      jdSel: [
        '#job-details',
        '.jobs-description-content__text',
        '.jobs-description__content',
        '.description__text',
        // Aug 2026 — jobs-box html content wrapper on new collections/ layout.
        '.jobs-box__html-content',
      ],
      companySel: [
        '.job-details-jobs-unified-top-card__company-name a',
        '.jobs-unified-top-card__company-name a',
        '.topcard__org-name-link',
      ],
    },
    'indeed.com': {
      titleSel: [
        'h2[data-testid="simpler-jobTitle"]',
        'h1[data-testid="simpler-jobTitle"]',
        'h2[data-testid="jobsearch-JobInfoHeader-title"]',
        'h1[data-testid="jobsearch-JobInfoHeader-title"]',
        'h1.jobsearch-JobInfoHeader-title',
        'h2.jobsearch-JobInfoHeader-title',
      ],
      jdSel: [
        '#jobDescriptionText',
        'div[data-testid="jobDescriptionText"]',
      ],
      companySel: [
        'div[data-testid="inlineHeader-companyName"] a',
        'div[data-company-name] a',
        '.jobsearch-InlineCompanyRating a',
      ],
    },
    // Glassdoor: their DOM refactored 2026-08 — data-test testid on the h1 was
    // dropped; jobTitle class hash renamed to employerAndJobTitle. Left legacy
    // fallbacks last so older Glassdoor DOM branches still work. Direct .com
    // access is captcha-gated in some geos → split-panel .fr / .co.uk / .de
    // are declared as separate matches in the manifest.
    'glassdoor.com': {
      titleSel: [
        'a[data-test="job-title"]',
        'h1[data-test="job-title"]',
        '[class*="JobDetails_employerAndJobTitle__"] h1',
        '[class*="JobDetails_jobTitle__"]',
      ],
      jdSel: [
        '[class*="JobDetails_jobDescription"]',
        'div[data-test="jobDescriptionContent"]',
      ],
      companySel: [
        '[class*="EmployerProfile_employerNameHeading__"]',
        '[class*="EmployerProfile_employerName"]',
        'a[class*="EmployerProfile_profileContainer"] h4',
        'h4[data-test="employer-name"]',
      ],
    },
    // Monster (.fr / .com / .co.uk / .de) — wired 2026-08-15 after mobile
    // audit revealed the adapter file existed (adapters/monster-adapter.js)
    // but no matcher for monster.* in this map + no content_scripts entry.
    // Copy in landing/for-recruiters + README/manifest description advertised
    // Monster autofill; without wiring the widget never rendered on monster
    // job pages. Selectors validated against monster.com + monster.fr Aug 2026.
    'monster.com': {
      titleSel: [
        'h1[data-testid="jobTitle"]',
        'h1.job_title',
        'h1[itemprop="title"]',
      ],
      jdSel: [
        'div[data-testid="svx-description-container"]',
        'div[data-testid="jobDescription"]',
        'section[data-testid="jobDescription"]',
      ],
      companySel: [
        'h2[data-testid="company-name"]',
        'a[data-testid="employerName"]',
        'a[itemprop="hiringOrganization"]',
      ],
    },
    // WTTJ: data-testid="job-title" dropped from the h2; description tag
    // changed from <section> → <div> with the same testid; company link
    // testid gone but URL follows /companies/<slug> pattern.
    'welcometothejungle.com': {
      titleSel: [
        'section h2.wui-text',
        'section h2',
        'h2[data-testid="job-title"]',
      ],
      jdSel: [
        '[data-testid="job-section-description"]',
        'section[data-testid="job-section-description"]',
      ],
      companySel: [
        'a[href^="/en/companies/"]:not([href*="/jobs"]):not([href*="/reviews"])',
        'a[href^="/fr/companies/"]:not([href*="/jobs"]):not([href*="/reviews"])',
        'a[data-testid="job-organization-link"]',
      ],
    },
  };

  const HOST = location.hostname.replace(/^www\./, '');
  // Match by suffix; special-case Glassdoor country variants (.co.uk, .fr, .de,
  // .ca, .com.au) which share the same DOM as .com but don't literally
  // endsWith('glassdoor.com').
  const config = (HOST.match(/^glassdoor\.(com|co\.uk|fr|de|ca|com\.au)$/i) ? SITES['glassdoor.com'] : null)
    || (HOST.match(/^monster\.(com|fr|co\.uk|de|nl|be|se|it|es|pl)$/i) ? SITES['monster.com'] : null)
    || Object.entries(SITES).find(([host]) => HOST.endsWith(host))?.[1]
    || (HOST === 'localhost' || HOST === '127.0.0.1' ? SITES['linkedin.com'] : null);
  if (!config) return;

  const BTN_ID = 'aam-tailor-cv-btn';
  const PANEL_ID = 'aam-match-panel';
  const DASHBOARD_URL = 'https://www.autoapplymax.com/dashboard#cv-generator';

  // ─── Lightweight keyword-overlap match scoring ─────────────────────
  const STOP_WORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from',
    'is','are','was','were','be','been','have','has','had','do','does','did','will','would',
    'could','should','may','might','this','that','these','those','we','you','they','them','their',
    'our','your','its','who','which','what','where','when','why','how','all','each','both','few',
    'more','most','some','such','no','not','only','very','just','also','work','working','experience',
    'role','position','team','company','ability','strong','looking','join','opportunity','including',
    'within','across','well','new','about','than','other','can','into','over','after','before',
    'between','under','through','during','any','here','there','own','being','make','like','get','got',
    'must','need','use','used','using','shall','much','many','then','while','still','already','often',
    'every','even','really','always','never','part','way','based','requirements','required','qualifications',
    'responsibilities','description','details','apply','application','job','jobs','candidate','candidates',
    'le','la','les','un','une','des','de','du','au','aux','et','ou','mais','dans','sur','sous','avec',
    'sans','pour','par','en','ce','cette','ces','je','tu','il','elle','nous','vous','ils','elles','est',
    'sont','été','être','avoir','fait','faire','peut','deux','ans','tout','tous','toute','toutes','même',
    'autre','autres','comme','entre','poste','sein','mission','profil','recherche','rejoindre',
  ]);

  function extractKeywords(text) {
    if (!text || typeof text !== 'string') return [];
    const words = text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s+#.-]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && w.length <= 30 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
    const counts = {};
    words.forEach(w => { counts[w] = (counts[w] || 0) + 1; });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([w]) => w);
  }

  // Common tech + business skills — used as a stopword-safe recognizer that
  // beats simple word-overlap. If both CV and JD mention 3+ of these skills,
  // that's a stronger signal than 3 random word matches.
  const KNOWN_SKILLS = new Set([
    'python','sql','javascript','typescript','react','vue','angular','node','nodejs',
    'java','kotlin','swift','go','golang','rust','c++','c#','ruby','php','scala','r',
    'aws','gcp','azure','docker','kubernetes','terraform','ansible','jenkins','ci/cd',
    'postgresql','mongodb','mysql','redis','elasticsearch','snowflake','databricks',
    'kafka','airflow','spark','hadoop','tableau','powerbi','looker','metabase',
    'figma','sketch','photoshop','illustrator','indesign','adobe','canva',
    'jira','confluence','notion','asana','trello','slack','monday',
    'agile','scrum','kanban','waterfall','okrs','kpis','roadmap','backlog',
    'seo','sem','ppc','ads','adwords','facebook','instagram','linkedin','twitter','tiktok',
    'saas','b2b','b2c','crm','erp','cms','api','rest','graphql','microservices',
    'salesforce','hubspot','marketo','pardot','mailchimp','sendgrid','intercom','zendesk',
    'excel','powerpoint','word','office','g-suite','sheets',
    'analytics','a/b','testing','ux','ui','wireframes','prototypes','user research','interviews',
    'machine learning','ml','ai','llm','nlp','deep learning','tensorflow','pytorch',
    'marketing','sales','growth','retention','onboarding','activation','conversion',
    'product management','product marketing','brand','positioning','pricing','packaging',
    'strategy','leadership','stakeholder','cross-functional','mentoring','hiring',
    'finance','accounting','budget','forecast','p&l','revenue','arr','mrr','ltv','cac',
    'legal','compliance','gdpr','hipaa','soc2','pci','audit','risk',
    'html','css','sass','tailwind','bootstrap','webpack','vite','next.js','nextjs',
    'django','flask','fastapi','rails','spring','laravel','express',
    'git','github','gitlab','bitbucket',
  ]);

  function extractSkills(text) {
    if (!text) return new Set();
    const lower = text.toLowerCase();
    const found = new Set();
    for (const s of KNOWN_SKILLS) {
      // Match whole word (with word boundaries — allow / . + # as skill chars)
      const re = new RegExp('(?:^|[^a-z0-9])' + s.replace(/[.+#/]/g, '\\$&') + '(?:[^a-z0-9]|$)', 'i');
      if (re.test(lower)) found.add(s);
    }
    return found;
  }

  function extractYoE(text) {
    if (!text) return null;
    // "5 years of experience", "5+ years", "5-8 years", "8 ans d'expérience"
    const patterns = [
      /(\d{1,2})\s*[-–]\s*\d{1,2}\s*(?:years?|yrs?|ans)/i,
      /(\d{1,2})\+?\s*(?:years?|yrs?|ans)\s*(?:of)?\s*(?:experience|exp[ée]rience)/i,
      /(?:minimum|min\.?|at least)\s*(\d{1,2})\s*(?:years?|yrs?|ans)/i,
    ];
    for (const p of patterns) { const m = text.match(p); if (m) return parseInt(m[1], 10); }
    return null;
  }

  function seniorityLevel(text) {
    if (!text) return 0;
    const t = text.toLowerCase();
    if (/\b(director|vp\b|head of|chief|c[eiot]o|principal|staff\s+eng)/i.test(t)) return 4;
    if (/\b(lead|senior|sr\.?\s|manager|expert|architect)/i.test(t)) return 3;
    if (/\b(mid-?level|intermediate|expérimenté)/i.test(t)) return 2;
    if (/\b(junior|jr\.?\s|entry|graduate|associate|assistant|stage|internship|intern|apprenti)/i.test(t)) return 1;
    return 2; // default mid
  }

  // Profile-based match score (2026-08-04 rewrite). Weights:
  //   50% skills overlap (from KNOWN_SKILLS set on both sides)
  //   25% years-of-experience proximity (JD asks 5, CV has 4 = 80% credit)
  //   15% seniority alignment (JD "senior" + CV "senior" = 100%, else scaled)
  //   10% generic keyword overlap (former algorithm — catch domain/company terms)
  // Score floor 25% and cap 85% so users always see room to improve — even a
  // strong match reads as "worth tailoring" not "already perfect".
  function computeMatch(cvText, jdText, cvProfile) {
    const jdKeywords = extractKeywords(jdText);
    if (!jdKeywords.length) return { score: 0, matched: [], missing: [], total: 0 };

    const cvLower = (cvText || '').toLowerCase();

    // 1. Skills overlap
    const jdSkills = extractSkills(jdText);
    const cvSkills = cvProfile?.skills
      ? new Set((cvProfile.skills || []).map(s => (typeof s === 'string' ? s : s.name || '').toLowerCase()))
      : extractSkills(cvText);
    // Also add any KNOWN_SKILLS found in cvText raw
    for (const s of extractSkills(cvText)) cvSkills.add(s);
    const skillsMatched = [...jdSkills].filter(s => cvSkills.has(s));
    const skillsScore = jdSkills.size ? (skillsMatched.length / jdSkills.size) : 0.5;

    // 2. Years of experience
    const jdYoE = extractYoE(jdText);
    const cvYoE = cvProfile?.yearsOfExperience ? Number(cvProfile.yearsOfExperience) : extractYoE(cvText);
    let yoEScore = 0.7; // neutral if we can't parse either
    if (jdYoE && cvYoE) {
      const ratio = Math.min(cvYoE, jdYoE) / Math.max(cvYoE, jdYoE);
      yoEScore = ratio; // perfect match=1, half=0.5
    }

    // 3. Seniority
    const jdSen = seniorityLevel(jdText);
    const cvSen = seniorityLevel(cvProfile?.jobTitle || cvText);
    const senDiff = Math.abs(jdSen - cvSen);
    const senScore = senDiff === 0 ? 1 : senDiff === 1 ? 0.7 : 0.4;

    // 4. Generic keyword overlap (existing logic)
    const matched = [];
    const missing = [];
    for (const kw of jdKeywords) {
      if (cvLower.includes(kw)) matched.push(kw);
      else missing.push(kw);
    }
    const kwScore = matched.length / jdKeywords.length;

    // Weighted combination
    const raw = (skillsScore * 0.50) + (yoEScore * 0.25) + (senScore * 0.15) + (kwScore * 0.10);
    // Contrast stretch: raw usually clusters 0.30-0.65 in real jobs so a
    // linear raw→40-70 map compressed everything to 48-58%. Map the useful
    // 0.20-0.75 band to the full 40-70 range, then clamp. Result: bad matches
    // hit 40-45, great matches hit 65-70, average matches spread 50-60.
    const normalized = Math.max(0, Math.min(1, (raw - 0.20) / 0.55));
    let score = Math.round(40 + normalized * 30);
    score = Math.min(70, Math.max(40, score));

    return {
      score,
      matched: matched.concat([...skillsMatched]).slice(0, 15),
      missing: missing.concat([...jdSkills].filter(s => !cvSkills.has(s))).slice(0, 15),
      total: jdKeywords.length,
      breakdown: {
        skills: Math.round(skillsScore * 100),
        yoe: Math.round(yoEScore * 100),
        seniority: Math.round(senScore * 100),
        keywords: Math.round(kwScore * 100),
      },
    };
  }

  // ─── DOM extraction ────────────────────────────────────────────────
  function firstMatching(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // /jobs/view/{jobId}/ (LinkedIn's public non-modal share page) has a
  // fully hashed DOM: 0 <h1> elements, title in an unrooted <div class="_hash">.
  // The About-the-job section is an <h2> whose text content we can find in
  // 40+ locales (see JOB_LOCALES). We anchor JD extraction to that h2's
  // container. Title falls back to document.title (LinkedIn always sets it
  // as "{Title} | {Company} | LinkedIn").
  const JOB_LOCALES = [
    /about the job/i,           // en
    /à propos du poste/i,       // fr
    /descripción del empleo/i,  // es
    /descrizione del lavoro/i,  // it
    /über den job/i,            // de
    /over de baan/i,            // nl
    /sobre o trabalho/i,        // pt
    /о вакансии/i,              // ru
    /关于该职位/i,               // zh
    /この求人について/i,          // ja
    /채용정보/i,                 // ko
    /oferta de trabajo/i,       // es alt
    /opis oferty/i,             // pl
  ];

  function heuristicJd() {
    const headings = document.querySelectorAll('h1,h2,h3');
    for (const h of headings) {
      if (JOB_LOCALES.some(re => re.test(h.textContent || ''))) {
        // Walk up until we find a container with >400 chars — that's the JD.
        let scope = h.parentElement;
        for (let i = 0; i < 8 && scope; i++) {
          if ((scope.textContent || '').trim().length > 400) return scope;
          scope = scope.parentElement;
        }
      }
    }
    return null;
  }

  function heuristicTitleFromDocTitle() {
    // LinkedIn format: "{Job Title} | {Company} | LinkedIn"
    const t = (document.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
    if (!t) return null;
    // Strip trailing " | Company" (last pipe segment)
    const parts = t.split('|').map(s => s.trim()).filter(Boolean);
    return parts[0] || null;
  }

  // Aug 2026: LinkedIn dropped stable classes on the job title AND changed
  // the wrapper from <h1> to <p> (font-size 24, weight 600). Walk elements
  // above the Easy Apply button, find the largest heading-style element in
  // the right pane. Survives future class-hash rotations since it uses
  // computed styles, not CSS selectors.
  function heuristicTitleFromEaAnchor() {
    if (!HOST.endsWith('linkedin.com')) return null;
    const ea = document.querySelector(
      'a[aria-label="Easy Apply to this job"], a[aria-label*="Easy Apply"], ' +
      'button[aria-label*="Easy Apply"], a[aria-label*="Candidature simplifiée"]'
    );
    if (!ea) return null;
    const eaRect = ea.getBoundingClientRect();
    if (!eaRect || eaRect.width === 0) return null;

    // Scan all elements. Look for heading-style: 20-30px + 500+ weight,
    // 5-100 chars text, few children, above the EA button, in the right
    // pane (x > 350 to skip left search list).
    let best = null;
    let bestDistance = Infinity;
    const walker = document.body.getElementsByTagName('*');
    for (const el of walker) {
      const t = (el.textContent || '').trim();
      if (t.length < 5 || t.length > 100) continue;
      if (el.children.length > 3) continue;
      const cs = window.getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      const fw = parseInt(cs.fontWeight, 10);
      if (fs < 20 || fs > 32 || fw < 500) continue;
      const r = el.getBoundingClientRect();
      if (r.left < 350) continue;      // avoid left-pane card list
      if (r.top > eaRect.top) continue; // must be above EA button
      const distance = eaRect.top - r.top;
      if (distance < bestDistance) { best = el; bestDistance = distance; }
    }
    return best;
  }

  // Aug 2026: JD block also lost its class hooks. Find the "About the job" /
  // "À propos du poste" heading and take its enclosing container's longest
  // text descendant. Survives redesigns because the heading text is a WCAG-
  // required section landmark.
  function heuristicJdViaAboutHeading() {
    if (!HOST.endsWith('linkedin.com')) return null;
    const headings = document.querySelectorAll('h1,h2,h3');
    const aboutHeading = [...headings].find(h => {
      const t = (h.textContent || '').trim();
      return /^(About the job|À propos du poste|Sobre el trabajo|Über die Stelle|Su questo lavoro|Sobre a vaga)$/i.test(t);
    });
    if (!aboutHeading) return null;
    // Walk container tree upward looking for the block that holds both the
    // heading AND >400 chars of text (the JD body).
    let scope = aboutHeading.parentElement;
    for (let i = 0; i < 8 && scope; i++) {
      if ((scope.textContent || '').trim().length > 400) return scope;
      scope = scope.parentElement;
    }
    return null;
  }

  function extractJob() {
    let titleEl = firstMatching(config.titleSel);
    let jdEl = firstMatching(config.jdSel);
    // Heuristic fallback: walk up from JD to find nearest h1/h2. Survives
    // DOM refactors when the JD selector still matches.
    if (!titleEl && jdEl) {
      let scope = jdEl;
      for (let i = 0; i < 5 && scope; i++) {
        scope = scope.parentElement;
        if (!scope) break;
        const h = scope.querySelector('h1, h2');
        if (h && h.textContent && h.textContent.trim().length >= 5 && h.textContent.trim().length <= 100) {
          titleEl = h;
          break;
        }
      }
    }
    // Aug 2026: LinkedIn switched from <h1> to <p> for the job title and
    // dropped every class hook we relied on. Fall back to computed-style
    // heuristic anchored on the Easy Apply button.
    if (!titleEl && HOST.endsWith('linkedin.com')) {
      titleEl = heuristicTitleFromEaAnchor();
    }
    // Locale-aware JD fallback (LinkedIn /jobs/view/{id}/ has hashed DOM).
    if (!jdEl && HOST.endsWith('linkedin.com')) {
      jdEl = heuristicJdViaAboutHeading() || heuristicJd();
    }
    // Doc-title fallback for pages with hashed title node (LinkedIn /jobs/view/).
    // We synthesize a titleEl anchor by using jdEl's nearest sibling of the
    // top card — since there's no h1, we use jdEl itself as the mount anchor
    // and insert the button before the JD block.
    let syntheticTitle = null;
    if (!titleEl && jdEl && HOST.endsWith('linkedin.com')) {
      const docTitle = heuristicTitleFromDocTitle();
      if (docTitle) {
        syntheticTitle = docTitle;
        titleEl = jdEl; // Button will render right before the JD text block.
      }
    }
    if (!titleEl || !jdEl) return null;
    const title = syntheticTitle || (titleEl.textContent || '').trim();
    const jd = (jdEl.textContent || '').trim();
    if (!title || jd.length < 100) return null;
    const companyEl = firstMatching(config.companySel || []);
    const company = (companyEl?.textContent || '').trim();
    return { title, jd, company, titleEl, source: HOST };
  }

  // ─── User CV text ──────────────────────────────────────────────────
  async function loadUserCvText() {
    const data = await new Promise(resolve => {
      chrome.storage.local.get(null, d => resolve(d || {}));
    });
    // Threshold lowered from 200 → 100 to match scan() check.
    // Prior mismatch dropped short but valid CVs into the parts-fallback path.
    if (data.cvText && typeof data.cvText === 'string' && data.cvText.length > 100) {
      return data.cvText;
    }
    const cv = data.cvProfile || {};
    const parts = [
      cv.summary || data.summary || '',
      (cv.skills || []).join(', '),
      (cv.experience || []).map(e => `${e.title || ''} ${e.company || ''} ${(e.bullets || []).join(' ')}`).join('\n'),
      (cv.education || []).map(e => `${e.degree || ''} ${e.school || ''}`).join('\n'),
      (cv.certifications || []).join(', '),
      (cv.languages || []).map(l => typeof l === 'string' ? l : l.name || '').join(', '),
    ];
    return parts.filter(Boolean).join('\n');
  }

  // ─── Button rendering ─────────────────────────────────────────────
  function scoreDot(score) {
    // Subtle inline indicator — keeps the button sober while still hinting
    // at fit strength. Muted next to the blue background.
    if (score >= 75) return '#4ade80'; // green
    if (score >= 55) return '#fde047'; // yellow
    if (score >= 30) return '#fdba74'; // orange
    return '#fca5a5';                    // red
  }

  function renderButton(job, result) {
    document.getElementById(BTN_ID)?.remove();

    // SINGLE button (v2.5.29): "✨ 50% Match · Tailor CV" — emoji at START,
    // placed after Easy Apply + Save in the actions row (not in pills row).
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    // Two distinct button states — never mix labels awkwardly:
    //   A. HAVE match → "✨ 50% Match · Tailor CV" (full-size, primary CTA)
    //   B. NO match  → "✨ Get match score" (compact, secondary — user is not
    //      signed in / hasn't synced CV; clicking opens dashboard so the
    //      auto-sync flow runs).
    const hasScore = !!(result && result.total > 0);
    btn.innerHTML = hasScore
      ? `✨&nbsp;${result.score}% Match · Tailor CV`
      : `✨&nbsp;Get job match score`;
    const tooltip = result && result.total > 0
      ? `Open AutoApplyMax with this job pre-filled. ${result.matched.length}/${result.total} keywords match your CV.${result.missing.length ? ' Top missing: ' + result.missing.slice(0, 5).join(', ') : ''}`
      : 'Open AutoApplyMax with this job description pre-filled';
    btn.title = tooltip;
    btn.setAttribute('aria-label', tooltip);
    // Both states use LinkedIn-blue background — only sizing changes so the
    // signed-out CTA stays discoverable but a touch smaller (32px vs 40px)
    // to visually defer to native Easy Apply / Save alongside which it sits.
    // Both states now share the LinkedIn native size (40px height, 16px font,
    // 24px padding) so the signed-out CTA visually aligns with Easy Apply
    // and Save when placed alongside them in the actions row.
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'margin:0 0 0 8px', 'vertical-align:middle',
      'background:#0a66c2', 'color:#fff', 'border:1px solid #0a66c2',
      'border-radius:20px',
      'padding:0 14px',
      'cursor:pointer',
      'font-family:-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
      'font-size:15px', 'font-weight:600',
      'gap:6px',
      'user-select:none', 'line-height:1', 'letter-spacing:normal',
      'height:40px',
      'min-width:auto',
      'transition:background .167s ease-in-out, box-shadow .167s ease-in-out',
    ].join(';');
    btn.addEventListener('mouseenter', () => { btn.style.background = '#0958a5'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#0a66c2'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleTailorClick(job, result);
    });

    // Placement depends on state:
    //  - hasScore (signed-in): pills row (On-site / Full-time / skills match)
    //    — sits inline with the fit-level pills where the % Match info lives.
    //  - !hasScore (signed-out CTA): actions row AFTER Easy Apply + Save —
    //    fits the "call to action" mental model and matches user preference.
    const inlineTarget = findActionsRow(job.titleEl) || findPillsOrActionsRow(job.titleEl);
    if (inlineTarget) {
      inlineTarget.appendChild(btn);
    } else if (job.titleEl.parentNode) {
      job.titleEl.parentNode.insertBefore(btn, job.titleEl.nextSibling);
    } else {
      job.titleEl.appendChild(btn);
    }
    return btn;
  }

  // Find the actions-row container (Easy Apply + Save). Used for the
  // signed-out "Get job match score" button so it sits next to native
  // CTAs rather than mixed with the pills row.
  function findActionsRow(titleEl) {
    // ─── Indeed ──────────────────────────────────────
    // Details panel has a stable class .jobsearch-ViewJobButtons-container
    // that holds Postuler + Save + Dislike + Share as flex row. Prefer it
    // when on any indeed.com host (also fr/es/de/uk/... variants).
    if (/\bindeed\./i.test(location.hostname)) {
      const indeedRow = document.querySelector('.jobsearch-ViewJobButtons-container, [class*="jobsearch-ViewJobButtons-container"]');
      if (indeedRow && indeedRow.offsetParent !== null) return indeedRow;
      // Fallback: walk up from "Postuler sur Indeed" / "Apply on Indeed"
      const postuler = [...document.querySelectorAll('button, a')].find(e => {
        if (!e.offsetParent) return false;
        const t = (e.textContent || '').trim().toLowerCase();
        return (t === 'postuler sur indeed' || t === 'apply on indeed' || t === 'apply on company site' || t === 'postuler') && t.length < 40;
      });
      if (postuler) {
        let el = postuler.parentElement;
        for (let i = 0; i < 8 && el; i++) {
          if (el.querySelectorAll('button, a').length >= 4 && getComputedStyle(el).display === 'flex') return el;
          el = el.parentElement;
        }
      }
    }

    // ─── LinkedIn (default) ───────────────────────────
    // Strategy: find the SAVE button first — the container it sits in is
    // the actions-row parent (holds Easy Apply + Save + follow icon). If
    // we appendChild there, our button lands AFTER Save (user preference).
    // Fallback: find Easy Apply and walk up to a flex ancestor.
    const topCard = document.querySelector('.job-details-jobs-unified-top-card, [class*="jobs-unified-top-card"], [class*="job-details-top-card"]');
    const scope = topCard || document;

    // Locate Save button — legacy has [aria-label*="Save"] / .jobs-save-button
    // and new-layout has <a>/<button> with text "Save" / "Enregistrer"
    const saveBtn = scope.querySelector(
      '[aria-label*="Save" i]:not([aria-label*="Search" i]), ' +
      '[aria-label*="Enregistrer" i], ' +
      '.jobs-save-button, ' +
      '[class*="jobs-save"] button'
    ) || [...scope.querySelectorAll('a, button')].find(e => {
      if (!e.offsetParent) return false;
      const t = (e.textContent || '').trim();
      if (!/^(Save|Enregistrer|Saved|Enregistré)$/i.test(t)) return false;
      // Exclude "Save search" or filter items
      if (e.closest('[class*="search-reusables"], [class*="filter-"]')) return false;
      return true;
    });
    if (saveBtn) {
      // Walk up to the flex row that also contains Easy Apply
      let el = saveBtn.parentElement;
      for (let i = 0; i < 4 && el; i++) {
        const cs = getComputedStyle(el);
        if (cs.display === 'flex' || cs.display === 'inline-flex') {
          // Verify this container also holds an Easy Apply anchor —
          // otherwise we may have grabbed a sub-wrapper too early
          const hasEA = [...el.querySelectorAll('a, button')].some(e => {
            const t = (e.textContent || '').trim();
            return (t === 'Easy Apply' || t === 'Apply' || t === 'Postuler facilement') && !e.closest('[class*="search-reusables"]');
          });
          if (hasEA) return el;
        }
        el = el.parentElement;
      }
      // Fallback: the Save button's own parent (button ends up next to Save)
      if (saveBtn.parentElement) return saveBtn.parentElement;
    }

    // Save not found — fall back to Easy Apply container (legacy path)
    if (!topCard) {
      const eaCands = [...document.querySelectorAll('a, button')].filter(e => {
        if (!e.offsetParent) return false;
        const t = (e.textContent || '').trim();
        if (t !== 'Easy Apply' && t !== 'Apply' && t !== 'Postuler facilement') return false;
        if (t.length > 25) return false;
        if (e.closest('[class*="search-reusables"], [class*="filter-binary"]')) return false;
        return true;
      });
      if (eaCands.length && eaCands[0].parentElement) return eaCands[0].parentElement;
      return null;
    }
    const applyBtn = topCard.querySelector('.jobs-apply-button, button.jobs-apply-button--top-card, [class*="jobs-s-apply"] button');
    if (applyBtn) {
      let el = applyBtn.parentElement;
      for (let i = 0; i < 4 && el; i++) {
        const cs = getComputedStyle(el);
        if (cs.display === 'flex' || cs.display === 'inline-flex') return el;
        el = el.parentElement;
      }
      return applyBtn.parentElement;
    }
    return null;
  }

  // v2.5.30 (user preference confirmed): PRIMARY anchor = pills row
  // (On-site / Full-time / skills match). Fallback to Easy Apply row only
  // if pills row absent. This is stable across search + collections +
  // search-results because .job-details-fit-level-preferences is present
  // on all 3 LinkedIn variants.
  function findPillsOrActionsRow(titleEl) {
    if (!titleEl) return null;
    const topCard = titleEl.closest([
      '.job-details-jobs-unified-top-card',
      '[class*="jobs-unified-top-card"]',
      '[class*="job-details-top-card"]',
    ].join(',')) || document.querySelector('.job-details-jobs-unified-top-card, [class*="jobs-unified-top-card"]');

    // 1. PRIMARY: pills row (On-site / Full-time / skills match) — search
    //    topCard first, fall back to document because LinkedIn sometimes
    //    puts the pills row outside titleEl.closest(top-card) scope
    //    (jobs-details__main-content > top-card + pills as siblings).
    const pillsContainer = (topCard && topCard.querySelector('.job-details-fit-level-preferences, [class*="job-details-fit-level-preferences"]'))
      || document.querySelector('.job-details-fit-level-preferences, [class*="job-details-fit-level-preferences"]');
    if (pillsContainer && pillsContainer.offsetParent !== null) return pillsContainer;

    // 1.5. NEW LAYOUT fallback (search-results with obfuscated classes,
    //      August 2026 redesign): find a workplace-type pill by text and
    //      use its parent container. Pills are <a> or <button> with just
    //      "Hybrid"/"Remote"/"On-site"/"Full-time" as textContent.
    const pillTexts = ['On-site', 'Hybrid', 'Remote', 'Full-time', 'Part-time', 'Contract'];
    const pillEls = [...document.querySelectorAll('a, button')].filter(e => {
      if (!e.offsetParent) return false;
      const t = (e.textContent || '').trim();
      return pillTexts.includes(t) && t.length < 20;
    });
    if (pillEls.length && pillEls[0].parentElement) {
      // Return the parent container so the button appends alongside the pill
      return pillEls[0].parentElement;
    }

    if (topCard) {
      // 2. FALLBACK: Easy Apply / Save actions row (scoped to top-card
      //    to avoid the top filter-pill "Easy Apply")
      const applyBtn = topCard.querySelector('.jobs-apply-button, button.jobs-apply-button--top-card, [class*="jobs-s-apply"] button');
      if (applyBtn) {
        let el = applyBtn.parentElement;
        for (let i = 0; i < 4 && el; i++) {
          const cs = getComputedStyle(el);
          if (cs.display === 'flex' || cs.display === 'inline-flex') return el;
          el = el.parentElement;
        }
        if (applyBtn.parentElement) return applyBtn.parentElement;
      }
    }
    return null;
  }

  // Find the actions row (Easy Apply + Save pills) OR the meta row (location,
  // posted date, applicants) as a stable anchor. Returns {container, mode}
  // where mode = 'after' → insert after the container, 'inside' → append.
  function findStableAnchor(titleEl) {
    if (!titleEl) return null;
    // LinkedIn variants — walk up to top-card container, then find actions row
    const topCard = titleEl.closest([
      '.job-details-jobs-unified-top-card',
      '[class*="jobs-unified-top-card"]',
      '[class*="job-details-top-card"]',
      '[class*="top-card-layout"]',
    ].join(','));
    if (topCard) {
      // Prefer the actions row (Easy Apply + Save + follow buttons)
      const actionsRow = topCard.querySelector([
        '.jobs-apply-button--top-card',
        '[class*="jobs-s-apply"]',
        '[class*="top-card-actions"]',
        'button[aria-label*="Easy Apply"]',
        'a[aria-label*="Easy Apply"]',
      ].join(','));
      if (actionsRow) {
        // Insert AFTER the parent row that contains Easy Apply + Save
        const rowContainer = actionsRow.closest('div');
        if (rowContainer) return { container: rowContainer, mode: 'after' };
      }
      // Fallback: after the pills row (On-site / Full-time)
      const pillsRow = topCard.querySelector('[class*="job-details-preferences"], [class*="job-insight"]');
      if (pillsRow) return { container: pillsRow, mode: 'after' };
      // Fallback: after the meta row (location + posted + applicants)
      const metaRow = topCard.querySelector('.job-details-jobs-unified-top-card__primary-description-container, [class*="primary-description"], [class*="tvm__text"]');
      if (metaRow) return { container: metaRow, mode: 'after' };
    }
    return null;
  }

  function handleTailorClick(job, result) {
    // auto:true signals the dashboard to auto-click Generate right after
    // prefilling the JD — saves the user one click. Dashboard still respects
    // guard rails (must have CV uploaded, must have credits, must be premium
    // or a free-tier gen still available).
    // Also pass match score/matched/missing so dashboard can display it.
    const payload = {
      title: job.title,
      jd: job.jd.slice(0, 8000),
      company: job.company || '',
      source: job.source,
      url: location.href,
      ts: Date.now(),
      auto: true,
      match: result && result.total > 0 ? {
        score: result.score,
        matched: (result.matched || []).slice(0, 15),
        missing: (result.missing || []).slice(0, 15),
      } : null,
    };
    try {
      chrome.storage.local.set({ aam_pending_jd: payload }, () => {
        window.open(DASHBOARD_URL, '_blank', 'noopener');
      });
    } catch (_e) {
      window.open(DASHBOARD_URL, '_blank', 'noopener');
    }
  }

  function togglePanel(job, result) {
    const existing = document.getElementById(PANEL_ID);
    if (existing) { existing.remove(); return; }
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:99999',
      'width:340px', 'max-height:70vh', 'overflow-y:auto',
      'background:#fff', 'border-radius:10px',
      'box-shadow:0 8px 24px rgba(0,0,0,.16), 0 2px 4px rgba(0,0,0,.08)',
      'font-family:system-ui,-apple-system,sans-serif',
      'font-size:13px', 'line-height:1.45', 'color:#0f172a',
      'padding:16px 18px',
    ].join(';');
    const label = result.score >= 75 ? 'Great match'
                : result.score >= 55 ? 'Decent match'
                : result.score >= 30 ? 'Weak match' : 'Poor match';
    const chip = (k, kind) => {
      const css = kind === 'missing'
        ? 'background:#fee2e2;color:#991b1b'
        : 'background:#dcfce7;color:#166534';
      return `<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 7px;${css};border-radius:10px;font-size:11px;font-weight:500">${escapeHtml(k)}</span>`;
    };
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div>
          <div style="font-weight:700;font-size:15px">${result.score}% match — ${label}</div>
          <div style="color:#64748b;font-size:12px;margin-top:2px">${result.matched.length}/${result.total} keywords in your CV</div>
        </div>
        <button id="aam-close-panel" style="background:transparent;border:0;font-size:20px;cursor:pointer;color:#64748b;line-height:1">×</button>
      </div>
      ${result.missing.length ? `<div style="margin-bottom:12px">
        <div style="font-weight:600;font-size:12px;margin-bottom:6px;color:#334155">Missing (${result.missing.length})</div>
        ${result.missing.slice(0, 15).map(k => chip(k, 'missing')).join('')}
      </div>` : ''}
      ${result.matched.length ? `<div style="margin-bottom:12px">
        <div style="font-weight:600;font-size:12px;margin-bottom:6px;color:#334155">Matched (${result.matched.length})</div>
        ${result.matched.slice(0, 12).map(k => chip(k, 'matched')).join('')}
      </div>` : ''}
      <button id="aam-panel-tailor" style="display:block;width:100%;background:#0a66c2;color:#fff;text-align:center;padding:9px;border-radius:6px;font-weight:600;border:0;cursor:pointer;font-size:13px;margin-top:8px">Tailor CV for this job →</button>
      <div style="text-align:center;margin-top:10px;font-size:11px;color:#94a3b8">Client-side keyword match — no data sent to servers</div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#aam-close-panel')?.addEventListener('click', () => panel.remove());
    panel.querySelector('#aam-panel-tailor')?.addEventListener('click', () => {
      handleTailorClick(job);
      panel.remove();
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ─── Scanning ──────────────────────────────────────────────────────
  let currentKey = null;
  let _actionsRetries = 0;
  async function scan() {
    const job = extractJob();
    if (!job) return;

    // Hide button if job already applied. Detection is intentionally
    // restrictive to avoid false positives from unrelated body text that
    // mentions "application submitted" (e.g. sidebar snippets).
    // Signals we trust:
    //   • [aria-live] status region with "Application submitted" heading
    //   • Native LinkedIn class `.jobs-s-apply-btn--applied` / apply button
    //     with aria-label containing "Applied"
    //   • Heading tagged <h3>/<h4> "Application status" followed by
    //     "Application submitted" sibling (right-panel applied state)
    const applyBtn = document.querySelector('.jobs-apply-button, button.jobs-apply-button--top-card');
    const applyLabel = (applyBtn?.getAttribute('aria-label') || applyBtn?.textContent || '').trim();
    const btnSaysApplied = /applied|postulé|candidature envoyée|solicitud enviada|beworben/i.test(applyLabel);
    // Applied state region — LinkedIn shows an <h2>/<h3> "Application status"
    // OR an aria-live status area containing "Application submitted".
    const applicationStatusH = [...document.querySelectorAll('h2, h3, h4')].find(h => /^application status|statut de la candidature/i.test(h.textContent.trim()));
    const hasStatusHeading = !!applicationStatusH;
    const alreadyApplied = btnSaysApplied || hasStatusHeading;
    if (alreadyApplied) {
      document.getElementById(BTN_ID)?.remove();
      currentKey = null;
      return;
    }
    // Key includes whether pills-row anchor is currently available so a late-
    // loading pills row triggers a re-render into the correct container.
    // Without this, the first scan (pills not loaded yet) places the button
    // as the fallback (title next-sibling) and it stays there permanently.
    // Compute score first so anchor selection can depend on state (signed-in
    // → pills row, signed-out → actions row).
    let result = null;
    try {
      const cvText = await loadUserCvText();
      const stored = await new Promise(r => chrome.storage.local.get(['cvProfile'], r));
      const cvProfile = stored?.cvProfile || null;
      if (cvText && cvText.length >= 100) {
        result = computeMatch(cvText, job.jd, cvProfile);
      }
    } catch (_e) {}
    const hasScore = !!(result && result.total > 0);
    // Both states go AFTER Easy Apply + Save (user preference 2026-08-05).
    // Fallback to pills row only if no actions row is discoverable on this
    // particular job (some non-EA link-outs don't have Save either).
    const actionsAnchor = findActionsRow(job.titleEl);
    const anchor = actionsAnchor || findPillsOrActionsRow(job.titleEl);
    const anchorKey = anchor ? anchor.className.slice(0, 40) : 'none';
    // Include hasScore in the key so state flip (sign-in / sign-out) triggers a re-render.
    const key = (job.title + '|' + job.jd.slice(0, 80) + '|' + anchorKey + '|' + (hasScore ? 'S' : 'N'));
    const existing = document.getElementById(BTN_ID);
    const inRightPlace = existing && anchor && anchor.contains(existing);
    if (key === currentKey && existing && (!anchor || inRightPlace)) return;
    currentKey = key;
    renderButton(job, result);
  }

  scan();

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 700);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentKey = null;
      setTimeout(scan, 500);
    }
  }, 800);

  // Re-scan when the extension's cvProfile/cvText storage changes so a user
  // who signs in on autoapplymax.com (content-marker syncs → local storage
  // updated) immediately sees the button flip from "Get job match score" to
  // "X% Match · Tailor CV" without needing to navigate LinkedIn.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.cvProfile || changes.cvText) {
        currentKey = null;
        setTimeout(scan, 200);
      }
    });
  } catch (_e) { /* extension context invalidated */ }

  window.EAM = window.EAM || {};
  window.EAM.tailorCvBtn = { scan, extractJob, computeMatch };
})();
