/**
 * AutoApplyMax - Indeed Adapter
 * Handles Indeed job applications.
 *
 * Indeed flow: user clicks Apply on indeed.com → redirects to smartapply.indeed.com
 * So this adapter has two modes:
 *   1. Job browsing mode (indeed.com) - browse listings, click Apply
 *   2. Form-only mode (smartapply.indeed.com) - fill form, click Continue/Submit
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};
  const u = () => window.EAM.utils;

  class IndeedAdapter extends window.EAM.BaseAdapter {

    get siteKey() { return 'indeed'; }
    get siteName() { return 'Indeed'; }
    get badgeColor() { return '#2164f3'; }

    matchURL(url) {
      return /indeed\.(com|fr|co\.uk|de|es|it|ca|com\.au)/i.test(url) ||
             /smartapply\.indeed\.com/i.test(url);
    }

    // ── Form-only detection ─────────────────────────────────────────────
    isFormOnlyPage() {
      return /smartapply\.indeed\.com/i.test(window.location.href);
    }

    // ── Cross-tab: Indeed apply opens a new tab ──────────────────────────
    // When on the search page (indeed.com), clicking Apply opens smartapply in a new tab.
    // The engine should wait for the new tab to complete instead of looking for a modal.
    opensNewTab() {
      return !this.isFormOnlyPage();
    }

    // ── Job cards (indeed.com search page) ──────────────────────────────
    getJobCards() {
      // Use the outermost unique wrapper to avoid duplicates
      // Priority: .job_seen_beacon (most common outer wrapper)
      let cards = document.querySelectorAll('.job_seen_beacon');
      if (cards.length > 0) return cards;

      // Fallback selectors (in order of specificity)
      cards = document.querySelectorAll('[data-testid="job-tile"]');
      if (cards.length > 0) return cards;

      cards = document.querySelectorAll('.tapItem');
      if (cards.length > 0) return cards;

      cards = document.querySelectorAll('.jobsearch-ResultsList > li');
      if (cards.length > 0) return cards;

      return document.querySelectorAll('.slider_item, .resultContent');
    }

    getJobInfo(jobCard) {
      const title = this._extractCleanTitle(jobCard);
      const company = jobCard.querySelector(
        '[data-testid="company-name"], .companyName, .company_location .companyName, ' +
        '[data-testid="company-name"] a'
      )?.textContent.trim() || '';
      const description = jobCard.querySelector(
        '.job-snippet, .underShelfFooter, [data-testid="jobDescriptionText"]'
      )?.textContent.trim() || '';
      const link = jobCard.querySelector('a[href*="/viewjob"], a[data-jk], h2 a')?.href || window.location.href;
      return { title, company, description, link };
    }

    // Extract job title from Indeed card, avoiding badge duplication
    _extractCleanTitle(jobCard) {
      // Strategy 1: Target the innermost span with a title attribute (most reliable)
      const titledSpan = jobCard.querySelector('.jobTitle span[title], [data-testid="jobTitle"] span[title]');
      if (titledSpan) return titledSpan.getAttribute('title').trim();

      // Strategy 2: Get the link text inside jobTitle (avoids badge elements)
      const titleLink = jobCard.querySelector('h2.jobTitle a, .jobTitle a[data-jk], .jcs-JobTitle a');
      if (titleLink) {
        // Get only direct text from the first span inside the link
        const innerSpan = titleLink.querySelector('span');
        if (innerSpan && innerSpan.children.length === 0) {
          return innerSpan.textContent.trim();
        }
        // Fallback: use the link's own first text node
        const firstText = titleLink.childNodes[0]?.textContent?.trim();
        if (firstText) return firstText;
      }

      // Strategy 3: Generic selectors with cleanup
      const raw = jobCard.querySelector(
        '.jobTitle span, h2.jobTitle a, [data-testid="jobTitle"], .jcs-JobTitle span, ' +
        'a[data-jk] span, h2 a span'
      )?.textContent.trim() || '';

      return this._cleanJobTitle(raw);
    }

    // Remove badge text and fix duplication in job titles
    _cleanJobTitle(title) {
      if (!title) return '';

      // Remove common Indeed badge suffixes
      let cleaned = title
        .replace(/\s+with verification$/i, '')
        .replace(/\s+avec vérification$/i, '')
        .replace(/\s+- new!?$/i, '')
        .replace(/\s+- nouveau!?$/i, '')
        .replace(/\s+urgently hiring$/i, '')
        .replace(/\s+recrutement urgent$/i, '')
        .trim();

      // Fix title duplication: "Test Manager Test Manager" → "Test Manager"
      if (cleaned.length >= 6) {
        const half = Math.floor(cleaned.length / 2);
        const first = cleaned.substring(0, half).trim();
        const second = cleaned.substring(half).trim();
        if (first === second) {
          cleaned = first;
        }
        // Also check with slight offset (e.g., "Test Manager Test Manager with...")
        for (let i = Math.max(3, half - 5); i <= half + 5 && i < cleaned.length; i++) {
          const part = cleaned.substring(0, i).trim();
          const rest = cleaned.substring(i).trim();
          if (part.length >= 3 && rest.startsWith(part)) {
            cleaned = part;
            break;
          }
        }
      }

      return cleaned;
    }

    async clickJobCard(jobCard) {
      // Scroll the card into view within the job list panel
      jobCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await u().wait(400);

      const prevUrl = window.location.href;
      const prevTitle = this._getDetailPaneTitle();
      console.log('[EAM][clickJobCard] Starting — prevTitle:', prevTitle.substring(0, 40));

      // Strategy 1: Click the main job title link with navigation prevention
      const titleLink = jobCard.querySelector(
        'a[data-jk], a[href*="/viewjob"], .jcs-JobTitle, ' +
        'h2.jobTitle a, h2 a, .jobTitle a, [data-testid="jobTitle"]'
      );
      if (titleLink) {
        titleLink.removeAttribute('target');
        // Prevent browser navigation — we want React to handle the click and update detail pane
        titleLink.addEventListener('click', e => e.preventDefault(), { once: true, capture: true });
        titleLink.click();
        console.log('[EAM][clickJobCard] Strategy 1: clicked titleLink (preventDefault)');
        await u().wait(1200);

        // Check if page navigated away despite preventDefault
        if (window.location.href !== prevUrl) {
          console.warn('[EAM][clickJobCard] Page navigated away! Going back...');
          window.history.back();
          await u().wait(2000);
        }
        if (this._getDetailPaneTitle() !== prevTitle) {
          console.log('[EAM][clickJobCard] Detail pane updated via Strategy 1');
          return;
        }
      }

      // Strategy 2: Dispatch synthetic mouse events (triggers React event delegation)
      const target = titleLink || jobCard.querySelector('.tapItem') || jobCard.closest('.tapItem') || jobCard;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      console.log('[EAM][clickJobCard] Strategy 2: dispatched mouse events on', target.tagName);
      await u().wait(1200);

      if (window.location.href !== prevUrl) {
        console.warn('[EAM][clickJobCard] Page navigated away! Going back...');
        window.history.back();
        await u().wait(2000);
      }
      if (this._getDetailPaneTitle() !== prevTitle) {
        console.log('[EAM][clickJobCard] Detail pane updated via Strategy 2');
        return;
      }

      // Strategy 3: Click the .tapItem wrapper directly
      const tapItem = jobCard.querySelector('.tapItem') || jobCard.closest('.tapItem') || jobCard;
      if (tapItem !== target) {
        tapItem.click();
        console.log('[EAM][clickJobCard] Strategy 3: clicked tapItem');
        await u().wait(1200);
        if (window.location.href !== prevUrl) {
          console.warn('[EAM][clickJobCard] Page navigated away! Going back...');
          window.history.back();
          await u().wait(2000);
        }
        if (this._getDetailPaneTitle() !== prevTitle) {
          console.log('[EAM][clickJobCard] Detail pane updated via Strategy 3');
          return;
        }
      }

      // Strategy 4: Click any <a> tag in the card (last resort)
      const anyLink = jobCard.querySelector('a');
      if (anyLink && anyLink !== titleLink) {
        anyLink.removeAttribute('target');
        anyLink.addEventListener('click', e => e.preventDefault(), { once: true, capture: true });
        anyLink.click();
        console.log('[EAM][clickJobCard] Strategy 4: clicked other link');
        await u().wait(1200);
        if (window.location.href !== prevUrl) {
          console.warn('[EAM][clickJobCard] Page navigated away! Going back...');
          window.history.back();
          await u().wait(2000);
        }
      }

      console.warn('[EAM][clickJobCard] All strategies tried — detail pane may not have updated');
    }

    // Helper: get the current title in the detail pane (right panel)
    _getDetailPaneTitle() {
      const el = document.querySelector(
        '.jobsearch-JobInfoHeader-title, .jobsearch-InlineCompanyRating h1, ' +
        '[data-testid="jobsearch-JobInfoHeader-title"], ' +
        '.jobsearch-ViewjobPaneWrapper h2, .jobsearch-ViewjobPaneWrapper h1, ' +
        '#jobDetailsSection h2, #viewjob-content h1'
      );
      return el?.textContent?.trim() || '';
    }

    // ── Already applied detection ────────────────────────────────────────
    // Indeed shows "Candidature envoyée" / "Applied" badge instead of the apply button
    isAlreadyApplied() {
      const detailPane = document.querySelector(
        '.jobsearch-ViewjobPaneWrapper, .jobsearch-RightPane, ' +
        '#viewjob-content, #jobDetailsSection, [data-testid="jobDetailSection"], ' +
        '.jobsearch-JobComponent, .jobsearch-ViewJobLayout'
      ) || document.body;

      // 1. Check for specific "applied" badges (very targeted selectors only)
      const appliedIndicators = detailPane.querySelectorAll(
        '.jobsearch-AppliedBadge, .applied-snippet, ' +
        '[data-testid="applied-date"], [class*="appliedDate"], ' +
        '[data-testid="applied-badge"], [data-testid="applied-snippet"]'
      );
      for (const el of appliedIndicators) {
        if (el.offsetParent !== null) {
          u().log('Already applied (badge detected: ' + el.className.substring(0, 30) + ')');
          return true;
        }
      }

      // 2. Text-based detection in apply button area (FR + EN + DE + ES + IT)
      const applyArea = document.querySelector(
        '.jobsearch-IndeedApplyButton, #applyButtonLinkContainer, ' +
        '[id*="applyButton"], .jobsearch-ViewJobButtonsContainer, ' +
        '.jobsearch-IndeedApplyButton-newDesign, .jobsearch-ApplyButton'
      ) || detailPane;

      const text = applyArea.textContent || '';
      if (/candidature\s+envoy[ée]/i.test(text) ||
          /already\s+applied/i.test(text) ||
          /you\s+applied/i.test(text) ||
          /applied\s+\d/i.test(text) ||           // "Applied 2 days ago"
          /vous\s+avez\s+(déjà\s+)?postulé/i.test(text) ||
          /application\s+submitted/i.test(text) ||
          /bewerbung\s+gesendet/i.test(text) ||   // German
          /solicitud\s+enviada/i.test(text) ||     // Spanish
          /candidatura\s+inviata/i.test(text)) {   // Italian
        u().log('Already applied (text: "' + text.substring(0, 40).trim() + '...")');
        return true;
      }

      return false;
    }

    // ── Apply button (indeed.com job detail pane) ───────────────────────
    // Auto-apply only handles SmartApply (native Indeed flow that redirects to
    // smartapply.indeed.com). Jobs whose only Apply CTA is "Apply on company site"
    // open the employer's own portal in a new tab — we can't fill those. Returning
    // null here makes the engine skip the job cleanly instead of clicking a button
    // that will just open a new tab and hang the loop.
    isCompanySiteRedirect(btn) {
      if (!btn) return false;
      const label = (btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '');
      // Multilingual: EN "on company site" / FR "sur le site" / DE "auf Unternehmensseite" / ES "en el sitio de la empresa"
      // Also catches "Apply on employer site" and href-based external redirects.
      if (/company\s+site|employer\s+site|external\s+site|site\s+de\s+l['’]entreprise|sur\s+le\s+site|auf\s+der\s+website|sitio\s+de\s+la\s+empresa|sitio\s+web\s+del\s+empleador/i.test(label)) {
        return true;
      }
      // href points off-Indeed → almost always company site redirect
      const href = btn.getAttribute('href') || '';
      if (href && !/^(#|\/|https?:\/\/[^/]*\bindeed\.[a-z.]+\/|https?:\/\/smartapply\.indeed\.com\/)/i.test(href)) {
        return true;
      }
      return false;
    }

    getApplyButton() {
      // Skip if already applied to this job
      if (this.isAlreadyApplied()) return null;

      const pass = (btn) => btn && btn.offsetParent !== null && !this.isCompanySiteRedirect(btn) ? btn : null;

      // Try data-testid and id-based selectors first (most stable)
      let btn = pass(document.querySelector(
        '#indeedApplyButton, [data-testid="indeedApplyButton"], ' +
        'button[id*="indeedApply"], a[data-testid="indeedApplyButton"]'
      ));
      if (btn) return btn;

      // Class-based selectors
      btn = pass(document.querySelector(
        '.jobsearch-IndeedApplyButton-newDesign button, ' +
        'button.indeed-apply-button, ' +
        '.jobsearch-IndeedApplyButton a, .jobsearch-ApplyButton button'
      ));
      if (btn) return btn;

      // aria-label based (multilingual)
      btn = pass(document.querySelector(
        'button[aria-label*="Apply now"], button[aria-label*="Postuler"], ' +
        'button[aria-label*="Jetzt bewerben"], button[aria-label*="Solicitar"], ' +
        'a[aria-label*="Apply now"], a[aria-label*="Postuler"]'
      ));
      if (btn) return btn;

      // Text-based fallback: search for apply buttons by visible text
      const allBtns = document.querySelectorAll(
        '.jobsearch-ViewjobPaneWrapper button, .jobsearch-ViewjobPaneWrapper a, ' +
        '.jobsearch-ViewJobButtonsContainer button, .jobsearch-ViewJobButtonsContainer a, ' +
        '#viewjob-content button, #viewjob-content a, ' +
        '#jobDetailsSection button, #jobDetailsSection a'
      );
      const S = window.EAM.JobBoardStrings;
      for (const b of allBtns) {
        if (b.offsetParent === null) continue;
        if (this.isCompanySiteRedirect(b)) continue;
        if (S && (S.matchText(b.textContent, 'apply') || S.matchText(b.textContent, 'easy_apply'))) {
          return b;
        }
      }

      return null;
    }

    // ── SmartApply challenge / captcha detection ─────────────────────────
    // Indeed occasionally shows a "Verify you're human" step or reCAPTCHA
    // mid-flow. We can't solve it — bail cleanly so the engine surfaces it to
    // the user rather than infinite-looping on a Continue button that never
    // becomes clickable.
    hasSmartApplyChallenge() {
      if (!this.isFormOnlyPage()) return false;
      // iframe recaptcha
      if (document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], iframe[src*="hcaptcha"]')) return true;
      // Cloudflare / Indeed challenge markers
      if (document.querySelector('[data-testid*="challenge"], [data-testid*="captcha"], .challenge-form, #challenge-form')) return true;
      // Text-based fallback
      const body = document.body?.textContent || '';
      if (/verify\s+you.{0,3}re\s+human|are\s+you\s+a\s+robot|prove\s+you.{0,3}re\s+not\s+a\s+robot|vérifiez\s+que\s+vous\s+n.{0,3}etes\s+pas\s+un\s+robot/i.test(body)) return true;
      return false;
    }

    // ── Form modal / container ──────────────────────────────────────────
    getFormModal() {
      // On smartapply.indeed.com: the entire page IS the form
      if (this.isFormOnlyPage()) {
        return document.querySelector(
          '[data-testid="ia-container"], ' +
          '.ia-container, ' +
          'main, ' +
          '[role="main"], ' +
          '.mosaic-provider-module-apply-questions, ' +
          'form'
        ) || document.body;
      }

      // On indeed.com: apply form can be in an iframe or modal
      return document.querySelector(
        '#indeed-apply-modal, .indeed-apply-widget, ' +
        '[data-testid="apply-modal"], .ia-container, ' +
        '.icl-Modal, [role="dialog"]'
      );
    }

    // ── Form filling ────────────────────────────────────────────────────
    async fillFormStep(modal, config) {
      // Use shared form filler for standard fields (text, email, file, checkboxes)
      await window.EAM.FormFiller.fillFormStep(modal, config);

      // ── Indeed-specific: Resume selection radio ──────────────────────
      // Step 1 of smartapply: select existing resume or file upload
      const resumeRadio = modal.querySelector(
        'input[data-testid="resume-selection-file-resume-radio-card-input"], ' +
        'input[data-testid*="resume-selection"][type="radio"]'
      );
      if (resumeRadio && !resumeRadio.checked) {
        const label = modal.querySelector(`label[for="${resumeRadio.id}"]`);
        if (label) label.click();
        else resumeRadio.click();
        u().log('Selected resume radio button');
        await u().wait(500);
      }

      // ── Indeed-specific: Step 2 — job title & company (relevant experience) ──
      const jobTitleInput = modal.querySelector('input[data-testid="job-title-input"]');
      if (jobTitleInput && !jobTitleInput.value) {
        // Try to get saved job info from storage (set before redirect)
        try {
          const stored = await new Promise(r => chrome.storage.local.get(['currentIndeedJob'], r));
          const jobInfo = stored.currentIndeedJob || {};
          if (jobInfo.title) {
            u().fill(jobTitleInput, jobInfo.title);
            u().log(`Filled job title: "${jobInfo.title}"`);
          }
        } catch (e) {}
      }

      const companyInput = modal.querySelector('input[data-testid="company-name-input"]');
      if (companyInput && !companyInput.value) {
        try {
          const stored = await new Promise(r => chrome.storage.local.get(['currentIndeedJob'], r));
          const jobInfo = stored.currentIndeedJob || {};
          if (jobInfo.company) {
            u().fill(companyInput, jobInfo.company);
            u().log(`Filled company: "${jobInfo.company}"`);
          }
        } catch (e) {}
      }

      // ── Indeed-specific: text inputs with data-testid pattern ────────
      const inputs = modal.querySelectorAll('input[data-testid*="input-q_"]');
      for (const input of inputs) {
        if (input.value) continue;

        const label = this._getIndeedFieldLabel(input);
        const labelLower = label.toLowerCase();

        if (/phone|téléphone|telefon/i.test(labelLower)) {
          u().fill(input, (config.phoneCountryCode || '') + (config.phone || ''));
        } else if (/email|e-mail|courriel/i.test(labelLower)) {
          u().fill(input, config.email || '');
        } else if (/city|ville|stadt|ciudad/i.test(labelLower)) {
          u().fill(input, config.city || '');
        } else if (/experience|expérience|erfahrung/i.test(labelLower)) {
          u().fill(input, config.yearsOfExperience || '2');
        } else if (/salary|salaire|gehalt/i.test(labelLower)) {
          u().fill(input, config.expectedSalary || '');
        } else if (/first|prénom|vorname/i.test(labelLower)) {
          u().fill(input, config.firstName || '');
        } else if (/last|nom.*famille|nachname/i.test(labelLower)) {
          u().fill(input, config.lastName || '');
        } else if (input.type === 'number' || input.inputMode === 'numeric') {
          u().fill(input, config.yearsOfExperience || '2');
        }
      }

      // ── Indeed-specific: Radio buttons (Oui/Non questions) ──────────
      // Format: name="q_[hash]" with data-testid="input-q_[hash]-single-select-..."
      const radioGroups = {};
      const radios = modal.querySelectorAll('input[type="radio"][name^="q_"]');
      for (const radio of radios) {
        const name = radio.name;
        if (!radioGroups[name]) radioGroups[name] = [];
        radioGroups[name].push(radio);
      }

      for (const [name, groupRadios] of Object.entries(radioGroups)) {
        // Skip if already answered
        if (groupRadios.some(r => r.checked)) continue;

        // Get question label
        const fieldset = groupRadios[0].closest('fieldset, [role="radiogroup"], [data-testid]');
        const questionEl = fieldset
          ? fieldset.querySelector('legend, label, span[id*="label"], [data-testid*="label"]')
          : null;
        const questionText = (questionEl?.textContent || '').toLowerCase();

        u().log(`Indeed radio Q: "${questionText.substring(0, 50)}"`);

        // Determine best answer
        let desiredValue = null;

        if (/parlez.*français|speak.*french|français/i.test(questionText)) {
          desiredValue = 'yes';
        } else if (/parlez.*anglais|speak.*english|anglais/i.test(questionText)) {
          desiredValue = 'yes';
        } else if (/visa|sponsor/i.test(questionText)) {
          desiredValue = config.visaSponsorship || 'no';
        } else if (/autoris|authorized|right.*work|droit.*travail|permit/i.test(questionText)) {
          desiredValue = config.legallyAuthorized || 'yes';
        } else if (/relocat|déménag|déplac/i.test(questionText)) {
          desiredValue = config.willingToRelocate || 'yes';
        } else if (/permis|driver|conduire/i.test(questionText)) {
          desiredValue = config.driversLicense || 'yes';
        }

        // Find the right radio to click
        let clicked = false;
        for (const radio of groupRadios) {
          const radioLabel = modal.querySelector(`label[for="${radio.id}"]`);
          const radioText = (radioLabel?.textContent || '').trim().toLowerCase();
          const radioValue = radio.value;

          // Indeed uses value="1" for Oui/Yes and value="0" for Non/No
          const isYes = radioText.match(/^(oui|yes|sí|ja|y)$/i) || radioValue === '1';
          const isNo = radioText.match(/^(non|no|nein|n)$/i) || radioValue === '0';

          if ((desiredValue === 'yes' && isYes) || (desiredValue === 'no' && isNo)) {
            if (radioLabel) radioLabel.click();
            else radio.click();
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            u().log(`Indeed radio → ${desiredValue}: "${radioText}"`);
            clicked = true;
            break;
          }
        }

        // Default: click "Oui"/first option
        if (!clicked && groupRadios.length > 0) {
          const firstLabel = modal.querySelector(`label[for="${groupRadios[0].id}"]`);
          if (firstLabel) firstLabel.click();
          else groupRadios[0].click();
          groupRadios[0].dispatchEvent(new Event('change', { bubbles: true }));
          u().log(`Indeed radio → default first option`);
        }

        await u().wait(300);
      }

      // ── Indeed-specific: Select dropdowns (diplôme, etc.) ───────────
      // Note: generic FormFiller may have already set a value — override with smarter logic
      const selects = modal.querySelectorAll('select[name^="q_"], select[data-testid*="input-q_"]');
      for (const select of selects) {

        const label = this._getIndeedFieldLabel(select);
        const labelLower = label.toLowerCase();

        if (/diplôme|études|education|degree|qualification/i.test(labelLower)) {
          // Select Bac+5 or Master's equivalent
          this._selectOption(select, 'Bac +5') ||
          this._selectOption(select, 'Master') ||
          this._selectOption(select, 'Bac +3') ||
          this._selectOptionByIndex(select, -2); // second-to-last option
        } else if (/country|pays|land|país/i.test(labelLower)) {
          this._selectOption(select, config.country || 'France');
        } else if (/visa|authorization|autorisation/i.test(labelLower)) {
          // Try both FR and EN options
          this._selectOption(select, config.visaSponsorship === 'yes' ? 'Oui' : 'Non') ||
          this._selectOption(select, config.visaSponsorship === 'yes' ? 'Yes' : 'No');
        } else if (/experience|expérience/i.test(labelLower)) {
          this._selectOption(select, config.yearsOfExperience || '3');
        } else {
          // Default: select first non-empty option
          this._selectOptionByIndex(select, 1);
        }
      }
    }

    _getIndeedFieldLabel(input) {
      // Try aria-describedby
      const describedBy = input.getAttribute('aria-describedby');
      if (describedBy) {
        const labelEl = document.getElementById(describedBy.split(' ')[0]);
        if (labelEl) return labelEl.textContent.trim();
      }
      // Try label[for]
      const id = input.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent.trim();
      }
      // Try closest parent with label
      const parent = input.closest('.mosaic-provider-module-apply-questions, .ia-Questions-item, [data-testid]');
      if (parent) {
        const label = parent.querySelector('label, .ia-Questions-itemLabel, legend, [data-testid*="label"]');
        if (label) return label.textContent.trim();
      }
      // Try previous sibling
      const prev = input.previousElementSibling;
      if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN')) {
        return prev.textContent.trim();
      }
      return '';
    }

    _selectOption(select, value) {
      const valueLower = value.toLowerCase();
      for (const option of select.options) {
        if (option.text.toLowerCase().includes(valueLower) || option.value.toLowerCase().includes(valueLower)) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          u().log(`Indeed select → "${option.text.trim()}"`);
          return true;
        }
      }
      return false;
    }

    _selectOptionByIndex(select, index) {
      // Negative index counts from end
      const idx = index < 0 ? select.options.length + index : index;
      if (idx >= 0 && idx < select.options.length) {
        select.value = select.options[idx].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        u().log(`Indeed select → index ${idx}: "${select.options[idx].text.trim()}"`);
        return true;
      }
      return false;
    }

    // ── Pre-scroll on SmartApply pages ──────────────────────────────────
    // Step 1: ~400px scroll needed to reveal "Continuer"
    // Step 3: ~700px scroll needed to reveal "Déposer ma candidature"
    async scrollToRevealButtons() {
      if (!this.isFormOnlyPage()) return;
      const url = window.location.href;
      let scrollAmount = 400;
      if (/review-module/i.test(url)) {
        scrollAmount = 700;
      }
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      await u().wait(600);
    }

    // ── Next step / Continue button ─────────────────────────────────────
    getNextStepButton(modal) {
      // 1. data-testid="continue-button" (resume step)
      let btn = modal.querySelector('button[data-testid="continue-button"]');
      if (btn && btn.offsetParent !== null) return btn;

      // 2. jf-ext-button-ct (questions step — data-testid is dynamic hash)
      btn = modal.querySelector(
        'button[jf-ext-button-ct="continuer"], button[jf-ext-button-ct="continue"], ' +
        'button[jf-ext-button-ct="weiter"], button[jf-ext-button-ct="siguiente"]'
      );
      if (btn && btn.offsetParent !== null) return btn;

      // 3. data-testid="submit-application-button", "submit-button" or "review-button"
      btn = modal.querySelector(
        'button[data-testid="submit-application-button"], ' +
        'button[data-testid="submit-button"], ' +
        'button[data-testid="review-button"]'
      );
      if (btn && btn.offsetParent !== null) return btn;

      // 4. Class-based selectors for smartapply
      btn = modal.querySelector(
        'button[class*="mosaic-provider-module-apply"][class*="6ja1uy"], ' +
        'button.ia-continueButton, ' +
        'a.ia-continueButton'
      );
      if (btn && btn.offsetParent !== null) return btn;

      // 5. Fallback: search by text content (FR/EN/DE/ES/IT)
      const buttons = Array.from(modal.querySelectorAll('button'));
      btn = buttons.find(b => {
        if (b.offsetParent === null) return false;
        const text = b.textContent.toLowerCase().trim();
        return text === 'continuer' || text === 'continue' || text === 'next' ||
               text === 'weiter' || text === 'siguiente' || text === 'avanti' ||
               text.includes('déposer ma candidature') || text.includes('submit my application') ||
               text.includes('submit') || text.includes('soumettre') ||
               text.includes('postuler') || text.includes('review') ||
               text.includes('envoyer') || text.includes('send') ||
               text.includes('einreichen') || text.includes('enviar');
      });
      if (btn) return btn;

      // 6. On smartapply pages, search the whole document
      if (this.isFormOnlyPage()) {
        btn = document.querySelector('button[data-testid="continue-button"]');
        if (btn && btn.offsetParent !== null) return btn;

        btn = document.querySelector('button[data-testid="submit-application-button"]');
        if (btn && btn.offsetParent !== null) return btn;

        btn = document.querySelector(
          'button[jf-ext-button-ct="continuer"], button[jf-ext-button-ct="continue"]'
        );
        if (btn && btn.offsetParent !== null) return btn;

        const allButtons = Array.from(document.querySelectorAll('button'));
        return allButtons.find(b => {
          if (b.offsetParent === null) return false;
          const text = b.textContent.toLowerCase().trim();
          return text === 'continuer' || text === 'continue' || text === 'next' ||
                 text === 'weiter' || text === 'siguiente' ||
                 text.includes('déposer') || text.includes('submit') ||
                 text.includes('soumettre') || text.includes('envoyer') ||
                 text.includes('send') || text.includes('einreichen');
        }) || null;
      }

      return null;
    }

    isSubmitButton(button) {
      const text = button.textContent.toLowerCase();
      const testId = button.getAttribute('data-testid') || '';
      return text.includes('submit') || text.includes('apply') ||
             text.includes('déposer') || text.includes('postuler') ||
             text.includes('soumettre') || text.includes('envoyer') ||
             text.includes('send application') || text.includes('einreichen') ||
             text.includes('enviar') || text.includes('invia') ||
             testId === 'submit-button' || testId === 'submit-application-button';
    }

    // ── Done button ─────────────────────────────────────────────────────
    async findAndClickDoneButton(contextElement = document, contextName = 'page', maxAttempts = 10) {
      const doneTexts = ['Done', 'Close', 'Return to search', 'Dismiss', 'Terminé', 'Fermer',
                         'Return to job search', 'Retour', 'Continue browsing',
                         'Schließen', 'Zurück', 'Cerrar', 'Chiudi', 'Weiter suchen'];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await u().wait(1000);
        for (const text of doneTexts) {
          const btn = Array.from(contextElement.querySelectorAll('button, a, [role="button"]')).find(
            el => el.textContent.trim().includes(text) && el.offsetParent !== null
          );
          if (btn) {
            btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
            await u().wait(300);
            btn.click();
            await u().wait(500);
            return { success: true, clicked: true };
          }
        }
        const closeBtn = contextElement.querySelector('button[aria-label*="Close"], button[aria-label*="Dismiss"], button[aria-label*="Fermer"]');
        if (closeBtn && closeBtn.offsetParent !== null) {
          closeBtn.click();
          await u().wait(500);
          return { success: true, clicked: true };
        }
      }
      return { success: false, clicked: false, reason: 'Button not found' };
    }

    // ── Discard ─────────────────────────────────────────────────────────
    async discardApplication() {
      try {
        const closeBtn = document.querySelector(
          'button[aria-label*="Close"], button[aria-label*="Dismiss"], button[aria-label*="Fermer"], ' +
          '.icl-Modal-close, .ia-closeButton, [data-testid="close-button"]'
        );
        if (closeBtn) {
          closeBtn.click();
          await u().wait(1000);
          const confirmBtn = Array.from(document.querySelectorAll('button')).find(
            btn => {
              const t = btn.textContent.toLowerCase();
              return t.includes('discard') || t.includes('leave') || t.includes('quitter') || t.includes('abandonner');
            }
          );
          if (confirmBtn) { confirmBtn.click(); await u().wait(1000); }
          return true;
        }
        // On smartapply: just go back
        if (this.isFormOnlyPage()) {
          window.history.back();
          await u().wait(2000);
          return true;
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        await u().wait(1000);
        return true;
      } catch (e) {
        return false;
      }
    }

    // ── Validation errors ───────────────────────────────────────────────
    hasValidationErrors(modal) {
      const errors = modal.querySelectorAll(
        '.ia-input-error, [data-testid="error-message"], [data-testid*="error-text"], ' +
        '[role="alert"], .invalid-feedback, [aria-invalid="true"]'
      );
      for (const err of errors) {
        // aria-invalid="true" on inputs means validation error
        if (err.tagName === 'INPUT' && err.getAttribute('aria-invalid') === 'true') {
          // Only count as error if the field is required and empty
          if (err.required && !err.value) return true;
        } else if (err.offsetParent !== null && err.textContent.trim()) {
          return true;
        }
      }
      return false;
    }

    // ── Next page (indeed.com search results) ───────────────────────────
    async goToNextPage() {
      const nextBtn = document.querySelector(
        'a[data-testid="pagination-page-next"], ' +
        'a[aria-label="Next Page"], a[aria-label="Page suivante"], ' +
        '.np, nav[aria-label*="pagination"] a:last-child'
      );
      if (nextBtn && nextBtn.offsetParent !== null) {
        nextBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await u().wait(300);
        await u().click(nextBtn);
        await u().wait(2000);
        return true;
      }
      return false;
    }

    // ── Loading ─────────────────────────────────────────────────────────
    async isLoading() {
      const spinners = document.querySelectorAll(
        '.ia-loading, [data-testid="loading"], .loading-spinner, ' +
        '[aria-busy="true"], .mosaic-loading-spinner'
      );
      for (const s of spinners) {
        if (s.offsetParent !== null) return true;
      }
      return false;
    }

    checkForStuckLoading() {
      // On smartapply: check if the continue button has aria-busy="true" for too long
      const busyBtn = document.querySelector('button[aria-busy="true"]');
      return !!busyBtn;
    }

    checkDailyLimit() {
      return false;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────
    async onStart() {
      // Save this tab as the search tab for cross-tab orchestration
      // (only on indeed.com, not on smartapply form pages)
      if (!this.isFormOnlyPage()) {
        try {
          chrome.runtime.sendMessage({ type: 'saveSearchTabId' });
          u().log('Registered as Indeed search tab for cross-tab orchestration');
        } catch (e) {}
      }

      // Dismiss cookie consent banner if present
      const cookieBtn = document.querySelector(
        'button[id*="onetrust-accept"], ' +
        'button[aria-label*="cookie"], button[aria-label*="Accept"]'
      ) || Array.from(document.querySelectorAll('button')).find(b => {
        const t = b.textContent.toLowerCase();
        return t.includes('autoriser tous les cookies') || t.includes('accept all') || t.includes('tout accepter');
      });
      if (cookieBtn) {
        cookieBtn.click();
        await u().wait(500);
        u().log('Cookie banner dismissed');
      }
    }

    shouldSkipByExperience(jobCard, maxYearsRequired) {
      if (!maxYearsRequired || maxYearsRequired <= 0) return false;
      const text = jobCard.textContent || '';
      const years = u().extractYearsRequired(text);
      if (years > 0 && years > maxYearsRequired) {
        u().log(`Skip: ${years}+ years required (max: ${maxYearsRequired})`);
        return true;
      }
      return false;
    }
  }

  window.EAM.registry.register(new IndeedAdapter());
})();
