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
  const CACHE_VERSION = 3; // Bump to clear stale cache

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

  function findCached(question, fieldType, options) {
    const hit = cache[cacheKey(question, fieldType, options)];
    return typeof hit === 'string' && hit ? hit : null;
  }

  // ─── Groq API call ──────────────────────────────────────────────────

  async function askAI(question, config, fieldType, options) {
    // Skip all AI calls if premium_required was already received this session
    if (premiumBlocked) return null;
    // 2026-09-18 (task #880): `options` is an array of choice labels for
    // radio/checkbox/select questions. When present, the AI is instructed
    // to reply with the EXACT text of the best-matching option (or "skip"
    // if none applies). Caller can then match the string to a control.

    await loadCache();

    // Check cache first
    const cached = findCached(question, fieldType, options);
    if (cached) {
      log()(`AI [cache]: "${question.substring(0, 40)}" → "${cached.substring(0, 40)}"`);
      return cached;
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
    const recentRoles = (cv.experience || []).slice(0, 3)
      .map(e => `- ${e.title || ''} @ ${e.company || ''} (${e.duration || e.dates || ''})`)
      .filter(s => s.length > 5).join('\n');
    const education = (cv.education || []).slice(0, 2)
      .map(e => `- ${e.degree || ''}${e.school ? ', ' + e.school : ''}${e.year ? ' (' + e.year + ')' : ''}`)
      .filter(s => s.length > 5).join('\n');
    const languages = Array.isArray(cv.languages)
      ? cv.languages.map(l => typeof l === 'string' ? l : (l.name || '')).filter(Boolean).join(', ')
      : '';
    const summary = config.summary || cv.summary || '';

    const prompt = `You are filling a job application form. Give a SHORT, CONCISE answer for this form field. Plain text only, no markdown.

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
${summary ? `\nProfessional summary: ${summary.substring(0, 400)}` : ''}
${topSkills ? `Top skills: ${topSkills}` : ''}
${languages ? `Languages: ${languages}` : ''}
${recentRoles ? `\nRecent experience:\n${recentRoles}` : ''}
${education ? `\nEducation:\n${education}` : ''}

${isChoice ? `\nOPTIONS (pick ONE, reply with EXACT text):\n${options.map(o => `- ${o}`).join('\n')}\n` : ''}
${recentAnswers ? `PREVIOUS ANSWERS:\n${recentAnswers}\n` : ''}
RULES:
- ${isMultiChoice ? 'MULTI-CHOICE MODE: Reply with a JSON array of the EXACT text of ALL applicable options — e.g. ["Option A", "Option C"]. Include EVERY option that honestly matches the candidate profile. If NONE apply, reply []. No commentary, no explanation, just the JSON array.' : isChoice ? 'CHOICE MODE: Reply with the EXACT text of ONE option from the list above — no commentary, no punctuation, no quotes. If genuinely none applies, reply "skip". Prefer the option that best matches candidate data + question intent. For "how did you hear about us"-style questions, pick the most plausible neutral answer like "LinkedIn" or "Google" or the option matching signup_source if listed. For consent/eligibility questions, pick "yes" if candidate qualifies per data above, else "no".' : isNumeric ? 'IMPORTANT: Reply with ONLY a single number. No text, no units, no punctuation. Just the number. Example: 160' : isTextarea ? 'Write 2-4 sentences, in first person, grounded in the candidate data above. Do not invent facts.' : 'Max 1 sentence. Use data above when available.'}
- If the question asks for a specific candidate datapoint (LinkedIn URL, portfolio, gender, etc.) and the value is EMPTY above, reply with an appropriate empty marker: "" for open text, "N/A" for identity questions, "0" for numeric. NEVER fabricate a URL, email, phone, or biographical fact that is not listed above.
- Match the language of the question.
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
            premiumBlocked = true;
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

      // Cache it
      cache[cacheKey(question, fieldType, options)] = answer;
      await saveCache();

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
    findCached,
    _cacheKey: cacheKey, // exposed for unit tests
    loadCache,
    clearCache: async () => { cache = {}; await saveCache(); }
  };

})();
