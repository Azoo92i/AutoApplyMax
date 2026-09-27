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
  const EEO_RE = /\b(gender|genre|sexe|sex|race|racial|ethnic\w*|ethnicit\w*|hispanic|latin[oax]|veteran|disabilit\w*|handicap\w*|sexual orientation|transgender|pronouns?|self[- ]identif\w*)\b/i;
  const MARKETING_RE = /(marketing|newsletter|promot|job alert|alerts|offers|updates|sms|whatsapp|text message|talent (community|network|pool)|future (opportunit|roles|openings|positions)|other (opportunit|openings|roles)|contact me about|keep me informed|stay in touch)/i;
  const NOT_AUTO_CONSENT_RE = /(arbitration|waive|non[- ]?compete|background check|credit check|drug test)/i;

  // Visible question text for a control: explicit label, aria-label, or the
  // closest label-like element in the surrounding question block (Lever
  // `.application-label`, Ashby / Greenhouse question containers).
  function questionText(el) {
    const id = el.getAttribute('id');
    if (id) {
      const l = labelFor(el);
      const t = l && l.textContent.replace(/\s+/g, ' ').trim();
      if (t && t.length >= 3) return t.slice(0, 300);
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
        const t = cand.textContent.replace(/\s+/g, ' ').trim();
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
  const SELF_DECL_LITE = /\b(previously|formerly|ever|currently|presently)\b.{0,30}\b(worked|employed|consulted)\b.{0,20}\b(at|for|by|with)\b|\b(former|current|ex[- ])\s*employee\b|\bconflict of interest\b|\brelatives?\b.{0,40}\b(work|employ)|\bpost-employment\b|\bnon-?compete\b|\bemployment agreements?\b/i;

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
    const identity = /\b(e-?mail|phone|téléphone|first name|last name|prénom|nom de famille|linkedin)\b/i.test(qText || '');
    if (qText && ((qText.length > 25 && QUESTION_RE.test(qText)) || (qText.length > 60 && !identity))) {
      if (/(how many|combien)[^?]{0,40}(years|ans|années)|years of (relevant |professional |work )?experience/i.test(qText)) return 'yearsOfExperience';
      if (/(salary|salaire|compensation|rémunération|pay expectation)/i.test(qText)) return 'expectedSalary';
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
    const det = deterministicAnswer(s, config);
    if (det) return { kind: 'yesno', value: det };
    if (/\b(country|pays)\b/i.test(s) && config.country
        && (!/\?/.test(s) || /\b(country|pays)\b.{0,40}\b(reside|live|based|located|currently|résid|habit)|\b(reside|live|based|located|résid|habit).{0,40}\b(country|pays)\b/i.test(s))) return { kind: 'country', value: config.country };
    if (/\b(current location|location|city|ville|localisation|where are you (based|located)|lieu)\b/i.test(s) && !/(relocat|sponsor|remote|onsite|on-site|willing)/i.test(s) && config.city) return { kind: 'city', value: config.city };
    return null;
  }
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function pickOption(items, q, config) {
    const tgt = comboTarget(q, config);
    if (!tgt) return null;
    const list = items.filter(x => x.text && !/^\s*(select|choose|sélectionner|choisir|--|please select)/i.test(x.text));
    if (tgt.kind === 'yesno') return list.find(x => (tgt.value === 'Yes' ? /^\s*(yes|oui)\b/i : /^\s*(no|non)\b/i).test(x.text)) || null;
    const v = norm(tgt.value);
    if (tgt.kind === 'city') {
      // "Paris, Île-de-France, FRA" before "Paris, TX, USA": prefer the suggestion in the user's country.
      const c = String(config.country || '');
      const inCountry = (t) => c && (norm(t).includes(norm(c)) || new RegExp('\\b' + c.slice(0, 3).toUpperCase() + '\\b').test(t));
      const cands = list.filter(x => norm(x.text) === v || norm(x.text).startsWith(v + ',') || norm(x.text).startsWith(v + ' '));
      const best = cands.find(x => inCountry(x.text));
      if (best) return best;
      if (c && cands.length > 1) return null;   // ambiguous city, none in the user's country → leave it
    }
    return list.find(x => norm(x.text) === v) || list.find(x => norm(x.text).startsWith(v + ',') || norm(x.text).startsWith(v + ' ')) || list.find(x => norm(x.text).startsWith(v)) || null;
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
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: ch.charCodeAt(0), bubbles: true }));
      if (d && d.set) d.set.call(input, v); else input.value = v;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
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
  async function fillComboboxes(config) {
    let n = 0;
    const boxes = deepAll('input[role="combobox"], input[aria-autocomplete], input#location-input, input.location-input, input[data-qa="location-input"]');
    for (const input of boxes) {
      if (input.dataset.eamFilled === 'true' || input.disabled || input.readOnly || input.offsetParent === null) continue;
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
          const hit = ans && ans !== 'skip' ? labels.find(l => norm(l) === norm(ans)) : null;
          if (hit) pick = { text: hit };
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
      input.focus();
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input.click();
      const typed = tgt.kind === 'yesno' ? tgt.value : String(tgt.value).split(',')[0].trim();
      await typeChars(input, typed);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      let pick = null;
      for (let t = 0; t < 14 && !pick; t++) {
        await new Promise(r => setTimeout(r, 250));
        pick = pickOption(visibleOptions(input).map(o => ({ o, text: o.textContent })), q, config);
      }
      if (pick) {
        pressOption(pick.o);
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
    const _cs = (window.EAM && window.EAM.utils && window.EAM.utils.cleanProfileSummary) || ((x) => x || '');
    if (_cs(config.summary)) values.summary = _cs(config.summary);

    // Fill text/email/tel/number inputs
    const inputs = deepAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input:not([type]), textarea');
    const aiAvailable = !!(window.EAM && window.EAM.aiForm);
    for (const input of inputs) {
      if (input.value && input.value.trim() !== '') continue;
      if (input.offsetParent === null || input.disabled || input.readOnly) continue;
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
        if (lbl) hints.push(lbl.textContent);
      }
      hints.push(input.getAttribute('placeholder') || '');
      const parent = input.closest('div, fieldset, li, td');
      if (parent) {
        const nearby = parent.querySelector('label, legend, span');
        if (nearby && nearby.textContent.length < 80) hints.push(nearby.textContent);
      }
      const label = [...new Set(hints.map(s => (s || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' ').trim();
      if (!label || !meaningfulLabel(label)) continue;
      if (EEO_RE.test(qt || label)) continue;

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

    // Check consent/CGU checkboxes
    const checkboxes = deepAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      if (cb.checked) continue;
      if (cb.offsetParent === null || cb.disabled) continue;
      if (cb.dataset.eamFilled === 'true') continue;

      const hints = [];
      hints.push(cb.getAttribute('name') || '');
      const cbId = cb.getAttribute('id');
      if (cbId) {
        const lbl = labelFor(cb);
        if (lbl) hints.push(lbl.textContent);
      }
      const parentLabel = cb.closest('label');
      if (parentLabel) hints.push(parentLabel.textContent);

      const combined = hints.join(' ').toLowerCase();
      // v2.5.90: marketing / newsletter / talent-community opt-ins stay
      // unticked (policy 2026-09-25: default No), and legal waivers
      // (arbitration, background checks) are left for the candidate.
      if (MARKETING_RE.test(combined) || NOT_AUTO_CONSENT_RE.test(combined)) continue;
      if (combined.match(/consent|agree|terms|conditions|policy|privacy|accept|j'accepte|j'autorise|consentement|cgu/)) {
        // click() so React-controlled checkboxes (Ashby, Greenhouse) register it
        cb.click();
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        if (!cb.checked) continue;
        cb.style.outline = '2px solid #10b981';
        cb.dataset.eamFilled = 'true';
        filled++;
      }
    }

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
          if (/\?|sponsor|authori[sz]|relocat|licen[cs]e|permis/i.test(txt)) q = txt;
          else if (i >= 2 && /\?/.test(n.textContent || '') && (n.textContent || '').length < 600) q = n.textContent;
        }
        const ans = deterministicAnswer(q, config);
        if (!ans) continue;
        const pick = ans === 'Yes' ? yes.r : no.r;
        pick.click();
        if (!pick.checked) { pick.checked = true; pick.dispatchEvent(new Event('change', { bubbles: true })); }
        if (pick.checked) { pick.dataset.eamFilled = 'true'; filled++; }
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
