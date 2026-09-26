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

  // ─── Fill text inputs ─────────────────────────────────────────────────
  async function fillTextInputs(modal, config) {
    const textInputs = modal.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"]');
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
          u().fill(input, config.yearsOfExperience || '2');
          u().log(`Years exp: ${config.yearsOfExperience || '2'}`);
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

      // Years of experience (EN/FR/ES/DE/IT)
      if (haystack.match(/experience|years|expérience|années|años|jahre|anni|esperienza/)) {
        u().fill(input, config.yearsOfExperience || '2');
        u().log(`Years exp: ${config.yearsOfExperience || '2'}`);
      }
      // Salary / Compensation / Prétentions salariales
      else if (haystack.match(/salary|compensation|remuneration|salaire|rémunération|prétention|pretention|sueldo|salario|gehalt|stipendio|pay.*expect|expectation.*pay/)) {
        if (config.expectedSalary) {
          u().fill(input, config.expectedSalary);
          u().log(`Salary filled: ${config.expectedSalary}`);
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
        const labelExpectsNumber =
          input.type === 'number' ||
          input.getAttribute('inputmode') === 'numeric' ||
          /\(\s*(mois|months?|meses|monate|mesi)\s*\)/i.test(haystack) ||
          /^\d+$/.test(rawValue.replace(/\s*(mois|months?|meses|monate|mesi)\s*$/i, ''));
        const noticePeriod = labelExpectsNumber
          ? rawValue.replace(/\s*(mois|months?|meses|monate|mesi)\s*$/i, '').trim() || '1'
          : rawValue;
        u().fill(input, noticePeriod);
        u().log(`Notice period filled: ${noticePeriod}`);
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
      const answer = await window.EAM.aiForm.askAI(getFieldQuestion(ta, modal), config, 'textarea');
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
  async function fillResumeInputs(modal) {
    const state = u();
    let resumeAlreadySelected = false;

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
          state.log(`Resume field: uploading resume — ${labelText.substring(0, 60)}`);
          const file = state.base64ToFile(state.resumeFile, state.resumeFileName, state.resumeFileType);
          if (file) {
            const ok = await state.fillFileInput(fileInput, file);
            if (ok) { state.log('Resume uploaded successfully'); await state.wait(500); }
          }
          continue;
        }

        if (isGenericUpload) {
          // Ambiguous — prefer resume but log clearly so we can diagnose.
          state.log(`Generic upload field (no clear resume/cover label): uploading resume — ${labelText.substring(0, 60)}`);
          const file = state.base64ToFile(state.resumeFile, state.resumeFileName, state.resumeFileType);
          if (file) {
            const ok = await state.fillFileInput(fileInput, file);
            if (ok) await state.wait(500);
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
      const label = fieldset.querySelector(`label[for="${radio.id}"]`);
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
      const lbl = fieldset.querySelector(`label[for="${bestRadio.id}"]`);
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
      const label = fieldset.querySelector(`label[for="${radio.id}"]`);
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
    if (/(c1|bilingu|maitrise|maîtrise)/.test(s))                                             return 5;
    if (/(b2|fluent|courant|fluid|upper[-\s]?intermediate|professional working|full professional)/.test(s)) return 4;
    if (/(professional|professionnel|professionnelle|advanced|avanc[eé]|avanzado|conversational)/.test(s)) return 4;
    if (/(b1|intermediate|interm[eé]diaire|intermedio)/.test(s))                              return 3;
    if (/(a2|elementary|[eé]l[eé]mentaire|basic|basique|b[aá]sico|limited working)/.test(s)) return 2;
    if (/(a1|beginner|d[eé]butant|principiante|notions|none|no knowledge|aucun)/.test(s))    return 1;
    return 0;
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
      const label = fieldset.querySelector(`label[for="${radio.id}"]`);
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
      const lbl = fieldset.querySelector(`label[for="${bestRadio.id}"]`);
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
      const questionLabel = fieldset.querySelector('legend, span[class*="title"], p[class*="title"], h3, h4');
      const questionText = (questionLabel ? questionLabel.textContent : fieldset.textContent || '').toLowerCase();
      const radioInputs = fieldset.querySelectorAll('input[type="radio"]');
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
        const cvYears = parseInt(String(config.yearsOfExperience || 0), 10);
        if (cvYears > 0 && fillYearsRangeRadio(fieldset, radioInputs, cvYears)) continue;
      }

      // Language-level radios (English/French/Spanish + level/niveau + CEFR
      // scale A1-C2 or Basic/Intermediate/Fluent/Native). Théo repro
      // 2026-09-17: bot was picking A1 (first option) via the yes/no
      // fallback. Look up the user's declared level for THAT language in
      // config.languages, then map to the closest radio option label.
      // Fallback when profile has no matching language: pick the "safe
      // middle" answer — Professional > Fluent > B2 > Intermediate — so we
      // never send a random A1 for someone who forgot to fill in a level.
      if (/\b(level|niveau|proficiency|proficien[cç]y|nivel|livello|niveau de langue)\b/i.test(questionText)
          || /\b(english|anglais|inglés|inglese|french|fran[çc]ais|francés|francese|spanish|espagnol|español|spagnolo|german|allemand|alemán|tedesco|italian|italien|italiano|chinese|chinois|mandarin|arabic|arabe|árabe|russian|russe|ruso|portuguese|portugu[eê]s|dutch|n[ée]erlandais|nederlands|japanese|japonais|hindi)\b.*\b(level|niveau|proficien|nivel|livello)\b/i.test(questionText)) {
        if (fillLanguageLevelRadio(fieldset, radioInputs, questionText, config.languages || [])) continue;
      }

      let desiredAnswer = 'yes';
      const isOptIn = isMarketingOptInLabel(questionText);
      if (isOptIn) {
        desiredAnswer = 'no'; // v2.5.87: marketing / SMS opt-in → No, never the Yes default
      } else if (questionText.match(/visa|sponsor|sponsorship/i) && config.visaSponsorship) {
        desiredAnswer = config.visaSponsorship;
      } else if (questionText.match(/author|legal.*work|permit.*work|eligib.*work|right.*work/i) && config.legallyAuthorized) {
        desiredAnswer = config.legallyAuthorized;
      } else if (questionText.match(/relocat|move.*locat|willing.*move/i) && config.willingToRelocate) {
        desiredAnswer = config.willingToRelocate;
      } else if (questionText.match(/security.*clearance|clearance/i)) {
        desiredAnswer = 'no';
      } else if (questionText.match(/driver.*license|driving.*license|valid.*license/i) && config.driversLicense) {
        desiredAnswer = config.driversLicense;
      }

      for (const radio of radioInputs) {
        const radioLabel = fieldset.querySelector(`label[for="${radio.id}"]`);
        const radioText = radioLabel ? radioLabel.textContent.trim().toLowerCase() : '';
        const isYes = radioText.match(/^(yes|oui|sí|si|ja|y)$/);
        const isNo = radioText.match(/^(no|non|nein|n)$/);
        if ((desiredAnswer === 'yes' && isYes) || (desiredAnswer === 'no' && isNo)) {
          if (!radio.checked) {
            radioLabel ? radioLabel.click() : radio.click();
            u().log(`Radio ${desiredAnswer}: ${questionText.substring(0, 30)}`);
            answered = true;
          }
          break;
        }
      }

      if (!answered && !isOptIn) {
        for (const radio of radioInputs) {
          const radioLabel = fieldset.querySelector(`label[for="${radio.id}"]`);
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
          const lbl = fieldset.querySelector(`label[for="${r.id}"]`);
          const txt = lbl ? lbl.textContent.trim() : (r.value || '').trim();
          if (txt) optionLabels.push(txt);
        }
        let clicked = false;
        try {
          if (window.EAM && window.EAM.aiForm && optionLabels.length >= 2) {
            const cleanQ = (questionLabel ? questionLabel.textContent : '').trim();
            const q = cleanQ && cleanQ.length > 4 ? cleanQ : fieldset.textContent.trim().split('\n')[0];
            const aiPick = await window.EAM.aiForm.askAI(q, config, 'radio', optionLabels);
            const pickNorm = String(aiPick || '').trim().toLowerCase();
            if (pickNorm && pickNorm !== 'skip') {
              // Exact-label match, then contains, then loose word overlap
              let match = null;
              for (const r of radioInputs) {
                const lbl = fieldset.querySelector(`label[for="${r.id}"]`);
                const txt = (lbl ? lbl.textContent : (r.value || '')).trim().toLowerCase();
                if (txt === pickNorm) { match = { r, lbl }; break; }
              }
              if (!match) {
                for (const r of radioInputs) {
                  const lbl = fieldset.querySelector(`label[for="${r.id}"]`);
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
        if (!clicked && !radioInputs[0].checked && !isOptIn) {
          const firstLabel = fieldset.querySelector(`label[for="${radioInputs[0].id}"]`);
          firstLabel ? firstLabel.click() : radioInputs[0].click();
          u().log(`Radio first option (fallback): ${questionText.substring(0, 30)}`);
        }
      }
    }
  }

  // ─── Native <select> dropdowns ────────────────────────────────────────
  async function fillSelectDropdowns(modal, config) {
    const selects = modal.querySelectorAll('select');
    for (const select of selects) {
      if (select.selectedIndex > 0) continue;

      const labelText = getFieldLabel(select, modal).toLowerCase();
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
      } else if (labelText.match(/proficiency|level.*english|level.*french|level.*spanish|level.*german|niveau.*anglais|niveau.*français|nivel.*inglés/)) {
        selectedOption = options.find(opt => opt.text.toLowerCase().match(/native|bilingual|bilingue|langue maternelle/));
        if (!selectedOption) selectedOption = options.find(opt => opt.text.toLowerCase().match(/fluent|courant|fluide/));
        if (!selectedOption) selectedOption = options.find(opt => opt.text.toLowerCase().match(/professional|professionnel|advanced/));
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

          if (question.match(/proficiency|level.*english|level.*french|level.*spanish|niveau.*anglais|nivel.*inglés/)) {
            selectedOption = options.find(opt => opt.textContent.toLowerCase().match(/native|bilingual|bilingue/));
            if (!selectedOption) selectedOption = options.find(opt => opt.textContent.toLowerCase().match(/fluent|courant/));
            if (!selectedOption) selectedOption = options.find(opt => opt.textContent.toLowerCase().match(/professional|professionnel|advanced/));
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
    fillFormStep,
    fillTextInputs,
    fillResumeInputs,
    fillCheckboxes,
    fillRadioButtons,
    fillSelectDropdowns,
    fillCustomDropdowns,
    fillTextareas,
    getFieldLabel,
    getFieldQuestion
  };
})();
