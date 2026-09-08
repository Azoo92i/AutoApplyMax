/**
 * AutoApplyMax - Glassdoor Adapter
 * Handles Glassdoor Easy Apply applications.
 * Note: Glassdoor uses iframes for some apply forms.
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};
  const u = () => window.EAM.utils;

  class GlassdoorAdapter extends window.EAM.BaseAdapter {

    get siteKey() { return 'glassdoor'; }
    get siteName() { return 'Glassdoor'; }
    get badgeColor() { return '#0caa41'; }

    matchURL(url) {
      return /glassdoor\.(com|fr|co\.uk|de|es|it|ca|com\.au)/i.test(url);
    }

    // ── Job cards ───────────────────────────────────────────────────────
    getJobCards() {
      return document.querySelectorAll(
        'li.react-job-listing, [data-test="jobListing"], ' +
        '.jobCard, [data-id][data-normalize-job-title], ' +
        'li[data-jobid], .JobsList_jobListItem__JBBUV'
      );
    }

    getJobInfo(jobCard) {
      const title = jobCard.querySelector(
        'a[data-test="job-link"], .job-title, ' +
        '[data-test="jobTitle"], .jobTitle'
      )?.textContent.trim() || '';
      const company = jobCard.querySelector(
        '.employer-name, [data-test="employer-short-name"], ' +
        '.companyName, .EmployerProfile_compactEmployerName__LE242'
      )?.textContent.trim() || '';
      const description = jobCard.querySelector(
        '.job-snippet, [data-test="descSnippet"]'
      )?.textContent.trim() || '';
      const link = jobCard.querySelector('a[href*="/job-listing/"], a[data-test="job-link"]')?.href || window.location.href;
      return { title, company, description, link };
    }

    async clickJobCard(jobCard) {
      jobCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await u().wait(500);
      const link = jobCard.querySelector('a[href*="/job-listing/"], a[data-test="job-link"], a');
      if (link) {
        await u().click(link);
        await u().wait(1000);
      }
    }

    // ── Apply button ────────────────────────────────────────────────────
    getApplyButton() {
      const S = window.EAM.JobBoardStrings;
      // Primary: data-test and class selectors are locale-independent
      let btn = document.querySelector(
        'button[data-test="applyButton"], ' +
        '.applyButton, button.gd-ui-button[data-test="applyButton"], ' +
        'button[data-job-apply]'
      );
      if (btn) return btn;

      // Fallback: aria-label across all supported languages
      if (S) {
        btn = document.querySelector(S.attrSelector('aria-label', 'easy_apply'));
        if (btn) return btn;
        btn = document.querySelector(S.attrSelector('aria-label', 'apply'));
        if (btn) return btn;
      }

      // Last resort: text match across languages
      return Array.from(document.querySelectorAll('button')).find(b => {
        if (!b.offsetParent) return false;
        if (!S) return false;
        return (S.matchText(b.textContent, 'easy_apply') || S.matchText(b.textContent, 'apply'));
      }) || null;
    }

    // ── Form modal ──────────────────────────────────────────────────────
    getFormModal() {
      return document.querySelector(
        '[data-test="applyModal"], .modal_main, ' +
        '[role="dialog"], .applyModal, ' +
        '#apply-modal, .ia-container'
      );
    }

    async fillFormStep(modal, config) {
      await window.EAM.FormFiller.fillFormStep(modal, config);
    }

    // ── Next step ───────────────────────────────────────────────────────
    getNextStepButton(modal) {
      const S = window.EAM.JobBoardStrings;
      let btn = modal.querySelector(
        'button[data-test="next-button"], button[data-test="submit-button"], ' +
        'button[type="submit"]'
      );
      if (btn) return btn;
      if (!S) return null;
      return Array.from(modal.querySelectorAll('button')).find(b => {
        return S.matchText(b.textContent, 'next') ||
               S.matchText(b.textContent, 'submit') ||
               S.matchText(b.textContent, 'apply');
      }) || null;
    }

    isSubmitButton(button) {
      if (button.getAttribute('data-test') === 'submit-button') return true;
      const S = window.EAM.JobBoardStrings;
      return S ? (S.matchText(button.textContent, 'submit') || S.matchText(button.textContent, 'apply')) : false;
    }

    // ── Done button ─────────────────────────────────────────────────────
    async findAndClickDoneButton(contextElement = document, contextName = 'page', maxAttempts = 10) {
      const S = window.EAM.JobBoardStrings;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await u().wait(1000);
        // Locale-independent selectors first
        let closeBtn = contextElement.querySelector(
          'button[data-test="close-button"], .modal-close'
        );
        // Multilingual aria-label fallback
        if (!closeBtn && S) {
          closeBtn = contextElement.querySelector(S.attrSelector('aria-label', 'close'));
        }
        if (closeBtn && closeBtn.offsetParent !== null) {
          closeBtn.click();
          await u().wait(500);
          return { success: true, clicked: true };
        }
        const doneBtn = Array.from(contextElement.querySelectorAll('button')).find(btn => {
          if (!btn.offsetParent || !S) return false;
          return S.matchText(btn.textContent, 'done') || S.matchText(btn.textContent, 'close');
        });
        if (doneBtn) {
          doneBtn.click();
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
          'button[aria-label*="Close"], button[data-test="close-button"], ' +
          '.modal-close, button.modal_closeIcon'
        );
        if (closeBtn) {
          closeBtn.click();
          await u().wait(1000);
          const confirmBtn = Array.from(document.querySelectorAll('button')).find(
            btn => btn.textContent.toLowerCase().match(/discard|leave|cancel/)
          );
          if (confirmBtn) { confirmBtn.click(); await u().wait(1000); }
          return true;
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        await u().wait(1000);
        return true;
      } catch (e) {
        return false;
      }
    }

    hasValidationErrors(modal) {
      const errors = modal.querySelectorAll('[role="alert"], [class*="error"], .invalid-feedback');
      for (const err of errors) {
        if (err.offsetParent !== null && err.textContent.trim()) return true;
      }
      return false;
    }

    // ── Next page ───────────────────────────────────────────────────────
    async goToNextPage() {
      const nextBtn = document.querySelector(
        'button[data-test="pagination-next"], ' +
        'a[data-test="pagination-next"], ' +
        'li.next a, button[aria-label="Next"]'
      );
      if (nextBtn && nextBtn.offsetParent !== null) {
        await u().click(nextBtn);
        await u().wait(2000);
        return true;
      }
      return false;
    }

    async isLoading() {
      const spinners = document.querySelectorAll('[class*="loading"], [class*="spinner"]');
      for (const s of spinners) {
        if (s.offsetParent !== null) return true;
      }
      return false;
    }

    checkDailyLimit() { return false; }

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

  window.EAM.registry.register(new GlassdoorAdapter());
})();
