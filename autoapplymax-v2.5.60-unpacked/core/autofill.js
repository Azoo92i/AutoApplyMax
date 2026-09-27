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
    city:      /\b(city|ville|ciudad|stadt|città|location|localisation|ubicación|standort|adresse|address)\b/i,
    yearsOfExperience: /\b(experience|years|expérience|années|años|jahre|anni)\b/i,
    expectedSalary:    /\b(salary|compensation|remuneration|salaire|rémunération|sueldo|gehalt|stipendio)\b/i,
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

  function classifyField(el) {
    // 1. autocomplete attribute
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
    if (AUTOCOMPLETE_MAP[ac]) return AUTOCOMPLETE_MAP[ac];

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
      const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
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

  // ─── Main autofill logic ────────────────────────────────────────────

  async function autofill(config) {
    if (!config) return { filled: 0 };

    let filled = 0;

    // Build value map from config
    const values = {};
    if (config.firstName) values.firstName = config.firstName;
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
    if (config.summary) values.summary = config.summary;

    // Fill text/email/tel/number inputs
    const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type]), textarea');
    const aiAvailable = !!(window.EAM && window.EAM.aiForm);
    for (const input of inputs) {
      if (input.value && input.value.trim() !== '') continue;
      if (input.offsetParent === null || input.disabled || input.readOnly) continue;
      if (input.dataset.eamFilled === 'true') continue;

      const fieldType = classifyField(input);
      if (fieldType && values[fieldType]) {
        setNativeValue(input, values[fieldType]);
        input.style.outline = '2px solid #10b981';
        input.dataset.eamFilled = 'true';
        filled++;
        continue;
      }

      // AI fallback for unknown fields (restored from v2.1.0).
      if (!aiAvailable) continue;
      const hints = [];
      hints.push(input.getAttribute('name') || '');
      hints.push((input.getAttribute('id') || '').replace(/[-_]/g, ' '));
      hints.push(input.getAttribute('aria-label') || '');
      const id2 = input.getAttribute('id');
      if (id2) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id2)}"]`);
        if (lbl) hints.push(lbl.textContent);
      }
      hints.push(input.getAttribute('placeholder') || '');
      const parent = input.closest('div, fieldset, li, td');
      if (parent) {
        const nearby = parent.querySelector('label, legend, span');
        if (nearby && nearby.textContent.length < 80) hints.push(nearby.textContent);
      }
      const label = hints.map(s => (s || '').trim()).filter(Boolean).join(' ').trim();
      if (!label) continue;

      const isTextarea = input.tagName === 'TEXTAREA';
      const fType = isTextarea ? 'textarea' : (input.type || 'text');
      try {
        let answer = await window.EAM.aiForm.askAI(label, config, fType);
        if (!answer) continue;
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
    const selects = document.querySelectorAll('select');
    for (const select of selects) {
      if (select.selectedIndex > 0) continue;
      if (select.offsetParent === null || select.disabled) continue;
      if (select.dataset.eamFilled === 'true') continue;

      const hints = [];
      hints.push(select.getAttribute('name') || '');
      hints.push(select.getAttribute('aria-label') || '');
      const selectId = select.getAttribute('id');
      if (selectId) {
        const lbl = document.querySelector(`label[for="${CSS.escape(selectId)}"]`);
        if (lbl) hints.push(lbl.textContent);
      }
      const parent = select.closest('div, fieldset');
      if (parent) {
        const lbl = parent.querySelector('label, legend, span');
        if (lbl && lbl.textContent.length < 80) hints.push(lbl.textContent);
      }
      const combined = hints.join(' ').toLowerCase();

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

    // Check consent/CGU checkboxes
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      if (cb.checked) continue;
      if (cb.offsetParent === null || cb.disabled) continue;
      if (cb.dataset.eamFilled === 'true') continue;

      const hints = [];
      hints.push(cb.getAttribute('name') || '');
      const cbId = cb.getAttribute('id');
      if (cbId) {
        const lbl = document.querySelector(`label[for="${CSS.escape(cbId)}"]`);
        if (lbl) hints.push(lbl.textContent);
      }
      const parentLabel = cb.closest('label');
      if (parentLabel) hints.push(parentLabel.textContent);

      const combined = hints.join(' ').toLowerCase();
      if (combined.match(/consent|agree|terms|conditions|policy|privacy|accept|j'accepte|j'autorise|consentement|cgu/)) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.style.outline = '2px solid #10b981';
        cb.dataset.eamFilled = 'true';
        filled++;
      }
    }

    // Show floating badge — ONLY from top frame. If we render "No fields
    // detected" from the top frame at the same time as a child frame renders
    // "3 fields filled" the user sees contradictory toasts overlapping.
    // Extension audit 2026-08-14 caught this on SmartRecruiters-style forms.
    // Child frames still fill fields — their own badge would draw INSIDE
    // the iframe (invisible on most portals) so we skip it entirely.
    if (window === window.top) {
      showBadge(filled);
    }

    return { filled };
  }

  // ─── Floating badge ─────────────────────────────────────────────────

  function showBadge(count) {
    // Remove previous badge if any
    const existing = document.getElementById('eam-autofill-badge');
    if (existing) existing.remove();

    const badge = document.createElement('div');
    badge.id = 'eam-autofill-badge';
    badge.textContent = count > 0
      ? `AutoApplyMax: ${count} field${count > 1 ? 's' : ''} filled`
      : 'AutoApplyMax: No fields detected in the top frame — if the form is in an iframe (SmartRecruiters, Workday), check inside it';
    badge.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${count > 0 ? 'linear-gradient(135deg, #10b981, #059669)' : '#6b7280'};
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
        autofill(msg.config).then(result => {
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
                hostname: location.hostname,
                path: (location.pathname || '').slice(0, 100),
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
