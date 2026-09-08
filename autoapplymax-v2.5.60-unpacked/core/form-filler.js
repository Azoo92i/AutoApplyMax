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
          const aiAnswer = await window.EAM.aiForm.askAI(label, config, input.type);
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
      const answer = await window.EAM.aiForm.askAI(label, config, 'textarea');
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

  // ─── Checkboxes ───────────────────────────────────────────────────────
  async function fillCheckboxes(modal) {
    const checkboxes = modal.querySelectorAll('input[type="checkbox"]');
    for (const checkbox of checkboxes) {
      if (checkbox.id === 'follow-company-checkbox') continue;
      const checkboxLabel = modal.querySelector(`label[for="${checkbox.id}"]`);
      const labelText = checkboxLabel ? checkboxLabel.textContent.toLowerCase() : '';
      if (labelText.match(/consent|agree|terms|conditions|policy|privacy|accept|j'accepte|j'autorise|consentement/)) {
        if (!checkbox.checked) {
          checkboxLabel ? checkboxLabel.click() : checkbox.click();
          u().log(`Checkbox: ${labelText.substring(0, 40)}`);
          await u().wait(300);
        }
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

      let desiredAnswer = 'yes';
      if (questionText.match(/visa|sponsor|sponsorship/i) && config.visaSponsorship) {
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

      if (!answered) {
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

      if (!answered && radioInputs.length > 0 && !radioInputs[0].checked) {
        const firstLabel = fieldset.querySelector(`label[for="${radioInputs[0].id}"]`);
        firstLabel ? firstLabel.click() : radioInputs[0].click();
        u().log(`Radio first option: ${questionText.substring(0, 30)}`);
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
          if (labelText.match(/visa|sponsor|sponsorship/i)) desired = config.visaSponsorship;
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
    await fillCheckboxes(modal);
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
    getFieldLabel
  };
})();
