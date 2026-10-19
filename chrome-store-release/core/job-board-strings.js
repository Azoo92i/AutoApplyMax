/**
 * AutoApplyMax — Multilingual job-board UI strings.
 *
 * Job boards (LinkedIn, Indeed, Glassdoor, WTTJ, Monster) render their UI in
 * the user's browser language. Button labels, badges, and modal text change.
 * If our adapters only match English, users on FR/ES/PT/DE sites have their
 * jobs skipped or their applications stuck.
 *
 * This module exposes translations for the action labels we care about,
 * plus a `matchText(node, category)` helper that returns true if the node's
 * text matches ANY language for the given category.
 *
 * Adding a language: extend each array. Keep lowercase, no diacritics stripping
 * (we lowercase the haystack with `toLowerCase()` which preserves accents).
 *
 * Sources: each label was observed on the corresponding LinkedIn / Indeed /
 * Glassdoor page rendered in the given locale. When both "formal" and
 * colloquial variants exist we include both.
 */

(function () {
  'use strict';
  window.EAM = window.EAM || {};

  // Each category -> array of lowercase strings (substring match).
  // IMPORTANT: order matters for HTML output but not for matching; substring
  // matches are tested in insertion order.
  const STRINGS = {
    // LinkedIn "Easy Apply" badge + button
    easy_apply: [
      'easy apply',            // en
      'candidature simplifiée', // fr
      'candidature simplifiee',  // fr without accent (some LinkedIn feeds)
      'postulación sencilla',   // es (LATAM)
      'postulacion sencilla',
      'solicitud sencilla',     // es (ES)
      'solicitud simplificada',
      'candidatura simplificada', // pt-br, pt-pt
      'einfaches bewerben',     // de
      'einfache bewerbung',
      'candidatura semplice',   // it
      'candidatura facile',
      'snelle sollicitatie',    // nl
      'łatwa aplikacja',        // pl
      '簡単応募',                 // ja
      '간편 지원',               // ko
    ],

    // "Next" step button
    next: [
      'next', 'next step',
      'suivant', 'étape suivante',
      'siguiente', 'siguiente paso',
      'próximo', 'avançar', 'seguinte',
      'weiter', 'nächster schritt',
      'avanti', 'prossimo',
      'volgende',
      'dalej',
    ],

    // "Review" before submit
    review: [
      'review',
      'vérifier', 'verifier', 'réviser',
      'revisar',
      'revisar', 'revisão',
      'überprüfen', 'prüfen',
      'rivedi',
      'beoordelen',
      'przejrzyj',
    ],

    // "Submit" / "Submit application"
    submit: [
      'submit', 'submit application',
      'soumettre', 'envoyer la candidature', 'envoyer ma candidature',
      'enviar', 'enviar solicitud', 'enviar candidatura', 'enviar aplicación',
      'enviar candidatura',
      'absenden', 'senden', 'bewerbung senden',
      'invia', 'invia candidatura',
      'verzenden',
      'wyślij',
    ],

    // "Done" after submit
    done: [
      'done',
      'terminé', 'termine',
      'listo', 'hecho',
      'concluído', 'concluido', 'pronto',
      'fertig',
      'fatto',
      'klaar',
      'gotowe',
    ],

    // "Dismiss" / close button on modal
    close: [
      'dismiss', 'close',
      'fermer', 'ignorer',
      'cerrar', 'descartar',
      'fechar', 'descartar',
      'schließen', 'ablehnen',
      'chiudi',
      'sluiten',
      'zamknij',
    ],

    // Apply-related generic (fallback for getApplyButton if Easy Apply fails)
    apply: [
      'apply',
      'postuler', 'candidater',
      'postularse', 'aplicar', 'postular',
      'candidatar-se', 'candidatar',
      'bewerben',
      'candidati',
      'solliciteer',
      'aplikuj',
    ],

    // Resume / CV upload field labels
    resume: [
      'resume', 'cv', 'curriculum vitae', 'curriculum',
      'lebenslauf',       // de
      'currículo',         // pt-br (long form)
      'currículum',        // es
      'hoja de vida',      // es (LATAM)
      'cv résumé',
      'upload resume', 'upload cv',
    ],

    // Cover letter field labels — detecting these lets us AVOID uploading
    // the resume into the wrong slot.
    cover_letter: [
      'cover letter', 'cover-letter',
      'lettre de motivation', 'lettre motivation',
      'carta de presentación', 'carta de presentacion',  // es
      'carta de motivación', 'carta motivacion',
      'carta de apresentação', 'carta de apresentacao',  // pt-br
      'carta motivação',
      'anschreiben', 'motivationsschreiben',              // de
      'lettera di presentazione', 'lettera motivazionale', // it
      'motivatiebrief',                                    // nl
      'list motywacyjny',                                  // pl
      'motivasjonsbrev',                                   // no
    ],
  };

  /**
   * Case-insensitive substring match against any translation in a category.
   * @param {string} haystack - Text to search in (typically textContent).
   * @param {string} category - One of the STRINGS keys.
   * @returns {boolean}
   */
  function matchText(haystack, category) {
    if (!haystack) return false;
    const arr = STRINGS[category];
    if (!arr) return false;
    const h = String(haystack).toLowerCase();
    for (const needle of arr) {
      if (h.includes(needle)) return true;
    }
    return false;
  }

  /**
   * Build an attribute-contains CSS selector matching any translation.
   * Useful for [aria-label*="..."] matching.
   * @param {string} attr - Attribute name (e.g. 'aria-label').
   * @param {string} category - STRINGS key.
   * @returns {string} CSS selector joined with commas.
   */
  function attrSelector(attr, category) {
    const arr = STRINGS[category] || [];
    // CSS attribute selectors match case-insensitively with the " i" flag.
    return arr.map(s => `[${attr}*="${s}" i]`).join(',');
  }

  window.EAM.JobBoardStrings = { STRINGS, matchText, attrSelector };
})();
