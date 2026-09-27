/**
 * AutoApplyMax - Site Registry
 * Simple adapter registry: register(adapter) / get(siteKey)
 * Namespace: window.EAM.registry
 */

(function () {
  'use strict';

  window.EAM = window.EAM || {};

  const adapters = {};

  function register(adapter) {
    if (!adapter || !adapter.siteKey) {
      console.error('[EAM Registry] Adapter must have a siteKey property');
      return;
    }
    adapters[adapter.siteKey] = adapter;
    console.log(`[EAM Registry] Registered adapter: ${adapter.siteKey} (${adapter.siteName})`);
  }

  function get(siteKey) {
    return adapters[siteKey] || null;
  }

  function getAll() {
    return { ...adapters };
  }

  function getSiteKeys() {
    return Object.keys(adapters);
  }

  /**
   * Detect which adapter to use based on the current URL.
   * Returns the adapter instance or null.
   */
  function detectFromURL(url) {
    for (const key of Object.keys(adapters)) {
      const adapter = adapters[key];
      if (adapter.matchURL && adapter.matchURL(url)) {
        return adapter;
      }
    }
    return null;
  }

  window.EAM.registry = {
    register,
    get,
    getAll,
    getSiteKeys,
    detectFromURL
  };
})();
