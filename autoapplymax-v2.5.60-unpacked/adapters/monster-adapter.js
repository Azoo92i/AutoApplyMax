/**
 * AutoApplyMax - Monster Adapter
 * Handles Monster.com job applications.
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};
  const u = () => window.EAM.utils;

  class MonsterAdapter extends window.EAM.BaseAdapter {

    get siteKey() { return 'monster'; }
    get siteName() { return 'Monster'; }
    get badgeColor() { return '#6e45a5'; }

    matchURL(url) {
      return /monster\.(com|fr|co\.uk|de|es|it|ca|com\.au)/i.test(url);
    }

    // ── Job cards ───────────────────────────────────────────────────────
    getJobCards() {
      return document.querySelectorAll(
        '[data-testid="svx-job-card"], .job-cardstyle, ' +
        '.card-content, article[data-job-id], ' +
        '[data-testid="jobCard"], .results-card'
      );
    }

    getJobInfo(jobCard) {
      const title = jobCard.querySelector(
        '[data-testid="jobTitle"], .job-cardstyle__title, ' +
        'h3, .title a, [class*="JobTitle"]'
      )?.textContent.trim() || '';
      const company = jobCard.querySelector(
        '[data-testid="company"], .company, ' +
        '[class*="CompanyName"], .job-cardstyle__company'
      )?.textContent.trim() || '';
      const description = jobCard.querySelector(
        '[data-testid="jobDescription"], .job-cardstyle__description, ' +
        '[class*="snippet"]'
      )?.textContent.trim() || '';
      const link = jobCard.querySelector('a[href*="/job/"], a[href*="/jobs/"]')?.href || window.location.href;
      return { title, company, description, link };
    }

    async clickJobCard(jobCard) {
      jobCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await u().wait(500);
      const link = jobCard.querySelector('a[href*="/job/"], a[href*="/jobs/"], h3 a, a');
      if (link) {
        await u().click(link);
        await u().wait(1000);
      }
    }

    // ── Apply button ────────────────────────────────────────────────────
    getApplyButton() {
      return document.querySelector(
        'button[data-testid="applyButton"], ' +
        '.apply-button, #applyButton, ' +
        'button[aria-label*="Apply"], a[data-testid="applyButton"]'
      ) || Array.from(document.querySelectorAll('button, a')).find(el => {
        const text = el.textContent.toLowerCase();
        return (text.includes('apply') || text.includes('postuler')) &&
               !text.includes('applied') && el.offsetParent !== null;
      }) || null;
    }

    // ── Form modal ──────────────────────────────────────────────────────
    getFormModal() {
      return document.querySelector(
        '[data-testid="apply-modal"], ' +
        '[role="dialog"], .modal, ' +
        'form[data-testid*="apply"], main form'
      );
    }

    async fillFormStep(modal, config) {
      await window.EAM.FormFiller.fillFormStep(modal, config);
    }

    // ── Next step ───────────────────────────────────────────────────────
    getNextStepButton(modal) {
      return modal.querySelector(
        'button[data-testid="submit"], button[data-testid="next"], ' +
        'button[type="submit"]'
      ) || Array.from(modal.querySelectorAll('button')).find(btn => {
        const text = btn.textContent.toLowerCase();
        return text.includes('next') || text.includes('continue') ||
               text.includes('submit') || text.includes('apply') ||
               text.includes('suivant') || text.includes('postuler');
      }) || null;
    }

    isSubmitButton(button) {
      const text = button.textContent.toLowerCase();
      return text.includes('submit') || text.includes('apply') ||
             text.includes('postuler') || text.includes('soumettre');
    }

    async findAndClickDoneButton(contextElement = document, contextName = 'page', maxAttempts = 10) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await u().wait(1000);
        const closeBtn = contextElement.querySelector(
          'button[aria-label*="Close"], button[aria-label*="Dismiss"]'
        );
        if (closeBtn && closeBtn.offsetParent !== null) {
          closeBtn.click();
          await u().wait(500);
          return { success: true, clicked: true };
        }
        const doneBtn = Array.from(contextElement.querySelectorAll('button, a')).find(
          el => el.textContent.toLowerCase().match(/done|close|return|back/) && el.offsetParent !== null
        );
        if (doneBtn) {
          doneBtn.click();
          await u().wait(500);
          return { success: true, clicked: true };
        }
      }
      return { success: false, clicked: false, reason: 'Button not found' };
    }

    async discardApplication() {
      try {
        const closeBtn = document.querySelector(
          'button[aria-label*="Close"], .modal-close, [data-testid="close"]'
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

    async goToNextPage() {
      const nextBtn = document.querySelector(
        'a[data-testid="svx-pagination-next"], ' +
        'button[aria-label="Next"], a[aria-label="Next Page"], ' +
        'a.pagination-next, [data-testid="pagination-next"]'
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

  window.EAM.registry.register(new MonsterAdapter());
})();
