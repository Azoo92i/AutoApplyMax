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

  const CACHE_VERSION = 2; // Bump to clear stale cache

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

  // Jaccard similarity on words (ignoring short words)
  function similarity(a, b) {
    const w1 = new Set(normalize(a).split(' ').filter(w => w.length > 2));
    const w2 = new Set(normalize(b).split(' ').filter(w => w.length > 2));
    if (!w1.size || !w2.size) return 0;
    const inter = [...w1].filter(x => w2.has(x)).length;
    const union = new Set([...w1, ...w2]).size;
    return inter / union;
  }

  function findCached(question) {
    const norm = normalize(question);
    if (cache[norm]) return cache[norm];

    let best = null, bestScore = 0;
    for (const [q, a] of Object.entries(cache)) {
      const s = similarity(question, q);
      if (s > bestScore && s >= 0.7) {
        bestScore = s;
        best = a;
      }
    }
    return best;
  }

  // ─── Groq API call ──────────────────────────────────────────────────

  async function askAI(question, config, fieldType) {
    // Skip all AI calls if premium_required was already received this session
    if (premiumBlocked) return null;

    await loadCache();

    // Check cache first
    const cached = findCached(question);
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
      .map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n');

    const isNumeric = fieldType === 'number' || fieldType === 'tel';
    const isTextarea = fieldType === 'textarea';

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

${recentAnswers ? `PREVIOUS ANSWERS:\n${recentAnswers}\n` : ''}
RULES:
- ${isNumeric ? 'IMPORTANT: Reply with ONLY a single number. No text, no units, no punctuation. Just the number. Example: 160' : isTextarea ? 'Write 2-4 sentences, in first person, grounded in the candidate data above. Do not invent facts.' : 'Max 1 sentence. Use data above when available.'}
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
      cache[normalize(question)] = answer;
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
    loadCache,
    clearCache: async () => { cache = {}; await saveCache(); }
  };

})();
