/**
 * AutoApplyMax - Welcome to the Jungle (WTTJ) Adapter
 * Clean HTML, no iframes, popular in French market.
 * SPA: uses MutationObserver for route changes.
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};
  const u = () => window.EAM.utils;

  class WTTJAdapter extends window.EAM.BaseAdapter {

    get siteKey() { return 'wttj'; }
    get siteName() { return 'Welcome to the Jungle'; }
    get badgeColor() { return '#ffcd00'; }

    constructor() {
      super();
      this._routeObserver = null;
    }

    matchURL(url) {
      return /welcometothejungle\.(com|co)/i.test(url);
    }

    // ── SPA route change detection ──────────────────────────────────────
    async onStart() {
      // Observe URL changes (SPA)
      let lastURL = window.location.href;
      this._routeObserver = new MutationObserver(() => {
        if (window.location.href !== lastURL) {
          lastURL = window.location.href;
          u().log(`Route changed: ${lastURL}`);
          u().updateActivity();
        }
      });
      this._routeObserver.observe(document.body, { childList: true, subtree: true });
    }

    async onStop() {
      if (this._routeObserver) {
        this._routeObserver.disconnect();
        this._routeObserver = null;
      }
    }

    // ── Job cards ───────────────────────────────────────────────────────
    getJobCards() {
      return document.querySelectorAll(
        '[data-testid="search-results-list-item-wrapper"], ' +
        'li[data-testid*="job"], ' +
        'div[class*="SearchResults"] li, ' +
        'ol[data-testid="search-results"] > li, ' +
        'a[href*="/jobs/"]'
      );
    }

    getJobInfo(jobCard) {
      const title = jobCard.querySelector(
        'h4, [data-testid="job-title"], [class*="title"], strong'
      )?.textContent.trim() || '';
      const company = jobCard.querySelector(
        '[data-testid="company-name"], [class*="company"], span[class*="subtitle"]'
      )?.textContent.trim() || '';
      const description = jobCard.querySelector(
        '[class*="description"], [class*="snippet"], p'
      )?.textContent.trim() || '';
      const link = jobCard.querySelector('a[href*="/jobs/"]')?.href ||
                   (jobCard.tagName === 'A' ? jobCard.href : '') ||
                   window.location.href;
      return { title, company, description, link };
    }

    async clickJobCard(jobCard) {
      jobCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await u().wait(500);
      const link = jobCard.querySelector('a[href*="/jobs/"]') ||
                   (jobCard.tagName === 'A' ? jobCard : null);
      if (link) {
        await u().click(link);
        await u().wait(1500); // WTTJ SPA needs more time for route change
      }
    }

    // ── Apply button ────────────────────────────────────────────────────
    getApplyButton() {
      return document.querySelector(
        'a[data-testid="job-application-button"], ' +
        'button[data-testid="job-application-button"], ' +
        'a[href*="/apply"], ' +
        'button[class*="apply"], ' +
        '[data-testid="apply-button"]'
      ) || Array.from(document.querySelectorAll('a, button')).find(el => {
        const text = el.textContent.toLowerCase();
        return (text.includes('postuler') || text.includes('apply') || text.includes('candidater')) &&
               el.offsetParent !== null;
      }) || null;
    }

    // ── Form modal ──────────────────────────────────────────────────────
    getFormModal() {
      // WTTJ typically opens the form inline or on a new route
      return document.querySelector(
        '[data-testid="application-form"], ' +
        'form[class*="application"], form[class*="apply"], ' +
        '[role="dialog"], .modal, ' +
        'main form'
      );
    }

    // ── Form filling ────────────────────────────────────────────────────
    async fillFormStep(modal, config) {
      // WTTJ uses standard HTML forms - shared filler works well
      await window.EAM.FormFiller.fillFormStep(modal, config);

      // WTTJ-specific: sometimes uses <textarea> for cover letter / motivation
      const textareas = modal.querySelectorAll('textarea');
      for (const ta of textareas) {
        if (ta.value) continue;
        const label = window.EAM.FormFiller.getFieldLabel(ta, modal).toLowerCase();
        if (label.match(/motivation|cover|lettre|message/)) {
          // Leave empty - user can configure a default message later
          u().log(`Motivation field detected (left empty)`);
        }
      }
    }

    // ── Next step button ────────────────────────────────────────────────
    getNextStepButton(modal) {
      return modal.querySelector(
        'button[type="submit"], ' +
        'button[data-testid="submit-application"], ' +
        'input[type="submit"]'
      ) || Array.from(modal.querySelectorAll('button')).find(btn => {
        const text = btn.textContent.toLowerCase();
        return text.includes('envoyer') || text.includes('submit') ||
               text.includes('postuler') || text.includes('send') ||
               text.includes('next') || text.includes('suivant');
      }) || null;
    }

    isSubmitButton(button) {
      const text = button.textContent.toLowerCase();
      return text.includes('envoyer') || text.includes('submit') ||
             text.includes('postuler') || text.includes('send') ||
             button.getAttribute('type') === 'submit';
    }

    // ── Done button ─────────────────────────────────────────────────────
    async findAndClickDoneButton(contextElement = document, contextName = 'page', maxAttempts = 10) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await u().wait(1000);
        // Look for success message and close/continue button
        const successEl = contextElement.querySelector(
          '[data-testid="application-success"], ' +
          '[class*="success"], [class*="confirmation"]'
        );
        if (successEl) {
          const closeBtn = contextElement.querySelector('button[aria-label*="Close"], a[href*="/jobs"]');
          if (closeBtn) {
            closeBtn.click();
            await u().wait(500);
            return { success: true, clicked: true };
          }
          return { success: true, clicked: false };
        }
      }
      return { success: false, clicked: false, reason: 'No success element' };
    }

    // ── Discard ─────────────────────────────────────────────────────────
    async discardApplication() {
      try {
        const closeBtn = document.querySelector(
          'button[aria-label*="Close"], button[aria-label*="Fermer"], ' +
          '[data-testid="close-button"], .modal-close'
        );
        if (closeBtn) {
          closeBtn.click();
          await u().wait(1000);
          return true;
        }
        // Navigate back
        window.history.back();
        await u().wait(1500);
        return true;
      } catch (e) {
        return false;
      }
    }

    // ── Validation ──────────────────────────────────────────────────────
    hasValidationErrors(modal) {
      const errors = modal.querySelectorAll(
        '[class*="error"], [role="alert"], .invalid-feedback, ' +
        '[data-testid*="error"], [aria-invalid="true"]'
      );
      for (const err of errors) {
        if (err.offsetParent !== null && err.textContent.trim()) return true;
      }
      return false;
    }

    // ── Next page ───────────────────────────────────────────────────────
    async goToNextPage() {
      // WTTJ uses infinite scroll or pagination
      const nextBtn = document.querySelector(
        'a[rel="next"], button[aria-label="Next"], ' +
        '[data-testid="pagination-next"], a[href*="page="]'
      );
      if (nextBtn && nextBtn.offsetParent !== null) {
        await u().click(nextBtn);
        await u().wait(2000);
        return true;
      }
      // Try infinite scroll
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await u().wait(2000);
      return true; // Optimistic - assume more jobs loaded
    }

    async isLoading() {
      const spinners = document.querySelectorAll('[class*="loading"], [class*="spinner"], [data-testid="loading"]');
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

  window.EAM.registry.register(new WTTJAdapter());
})();
