/**
 * AutoApplyMax - Base Adapter
 * Defines the interface that every site adapter must implement.
 * Namespace: window.EAM.BaseAdapter
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};

  class BaseAdapter {
    /** Unique key used in the registry, e.g. 'linkedin', 'indeed' */
    get siteKey() { throw new Error('siteKey not implemented'); }

    /** Human-readable name, e.g. 'LinkedIn' */
    get siteName() { throw new Error('siteName not implemented'); }

    /** Color for dashboard badge */
    get badgeColor() { return '#666'; }

    /**
     * Return true if this adapter should handle the given URL.
     * @param {string} url
     * @returns {boolean}
     */
    matchURL(url) { throw new Error('matchURL not implemented'); }

    /**
     * Return true if the current page IS the application form
     * (no job browsing needed, e.g. smartapply.indeed.com).
     * @returns {boolean}
     */
    isFormOnlyPage() { return false; }

    /**
     * Return an array of job card elements on the current page.
     * @returns {NodeList|Element[]}
     */
    getJobCards() { return []; }

    /**
     * Extract job information from a job card element.
     * @param {Element} jobCard
     * @returns {{ title: string, company: string, description: string, link: string }}
     */
    getJobInfo(jobCard) {
      return { title: '', company: '', description: '', link: '' };
    }

    /**
     * Scroll to and click a job card to load its details.
     * @param {Element} jobCard
     */
    async clickJobCard(jobCard) {
      const u = window.EAM.utils;
      jobCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
      await u.wait(500);
      const link = jobCard.querySelector('a');
      if (link) {
        await u.click(link);
        await u.wait(600);
      }
    }

    /**
     * Return the "Apply" / "Easy Apply" button for the current job, or null.
     * @returns {Element|null}
     */
    getApplyButton() { return null; }

    /**
     * Return the modal/container element of the application form, or null.
     * @returns {Element|null}
     */
    getFormModal() { return null; }

    /**
     * Fill one step of the application form inside the modal.
     * Default implementation uses the shared FormFiller.
     * @param {Element} modal
     * @param {Object} config
     */
    async fillFormStep(modal, config) {
      await window.EAM.FormFiller.fillFormStep(modal, config);
    }

    /**
     * Return the Next / Submit / Review button inside the modal, or null.
     * @param {Element} modal
     * @returns {Element|null}
     */
    getNextStepButton(modal) { return null; }

    /**
     * Return true if the given button is a final Submit button.
     * @param {Element} button
     * @returns {boolean}
     */
    isSubmitButton(button) { return false; }

    /**
     * Handle unfollow-company checkbox before submit (LinkedIn-specific, no-op by default).
     * @param {Element} modal
     * @param {Element} submitBtn
     */
    async handlePreSubmit(modal, submitBtn) {}

    /**
     * Find and click the "Done" / "Dismiss" button that appears after submission.
     * @returns {{ success: boolean, clicked: boolean }}
     */
    async findAndClickDoneButton() {
      return { success: false, clicked: false };
    }

    /**
     * Discard / close the current application modal.
     * @returns {boolean} true if modal was successfully closed
     */
    async discardApplication() { return false; }

    /**
     * Robust cleanup: close ANY open modal/popup after submit.
     * Default no-op — overridden by site adapters (LinkedIn, etc.).
     * @param {number} maxAttempts
     * @returns {boolean} true if all modals are closed
     */
    async clearAllModals(maxAttempts = 5) { return true; }

    /**
     * Navigate to the next page of job listings.
     * @returns {boolean} true if next page was triggered
     */
    async goToNextPage() { return false; }

    /**
     * Check if the page has a daily application limit message.
     * @returns {boolean}
     */
    checkDailyLimit() {
      return window.EAM.utils.checkDailyLimit();
    }

    /**
     * Check if LinkedIn is rate-limiting (fast pace warning).
     * @returns {boolean}
     */
    checkRateLimit() {
      return window.EAM.utils.checkRateLimit();
    }

    /**
     * Check for site-specific validation errors in the modal.
     * @param {Element} modal
     * @returns {boolean}
     */
    hasValidationErrors(modal) { return false; }

    /**
     * Check if the form/page is still loading.
     * @returns {boolean}
     */
    async isLoading() {
      return window.EAM.utils.isPageLoadingSlow();
    }

    /**
     * Check for stuck loading popup.
     * @returns {boolean}
     */
    checkForStuckLoading() {
      return window.EAM.utils.checkForStuckLoadingPopup();
    }

    /**
     * Refresh the page to recover from a stuck state.
     */
    async refreshPage() {
      window.EAM.utils.log('Refreshing page...');
      location.reload();
    }

    /**
     * Called when the bot starts. Can be used for site-specific setup.
     */
    async onStart() {}

    /**
     * Called when the bot stops. Can be used for site-specific cleanup.
     */
    async onStop() {}
  }

  window.EAM.BaseAdapter = BaseAdapter;
})();
