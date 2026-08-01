
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
