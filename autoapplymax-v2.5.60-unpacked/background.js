// Service worker de l'extension - Multi-site v2.0

// ── Supabase config — fetched from autoapplymax.com at SW startup ──────
// Fetched dynamically so we can switch backend without republishing the
// extension. Cached in chrome.storage for 6h. Falls back to hardcoded
// defaults if the fetch fails (offline, Vercel down).
const SUPABASE_CONFIG_URL = 'https://www.autoapplymax.com/supabase-config.json';
const SUPABASE_CONFIG_TTL_MS = 6 * 60 * 60 * 1000;
let SUPABASE_URL = 'https://tgknaopmwbelterrhrnz.supabase.co';
let SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRna25hb3Btd2JlbHRlcnJocm56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NzYzMTcsImV4cCI6MjA5NDI1MjMxN30.2-V5Z6-ZIKOkC6RJEjdEEAVKjGYbSOdX_FSd3yPdE6Q';

async function loadSupabaseConfig() {
  try {
    const cached = await chrome.storage.local.get(['supabase_config_cached', 'supabase_config_cached_at']);
    const age = Date.now() - (cached.supabase_config_cached_at || 0);
    if (cached.supabase_config_cached && age < SUPABASE_CONFIG_TTL_MS) {
      SUPABASE_URL = cached.supabase_config_cached.url;
      SUPABASE_ANON_KEY = cached.supabase_config_cached.anon_key;
      return;
    }
  } catch (e) {}
  try {
    const res = await fetch(SUPABASE_CONFIG_URL, { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg && cfg.url && cfg.anon_key) {
        SUPABASE_URL = cfg.url;
        SUPABASE_ANON_KEY = cfg.anon_key;
        try { await chrome.storage.local.set({ supabase_config_cached: cfg, supabase_config_cached_at: Date.now() }); } catch (e) {}
      }
    }
  } catch (e) {
    console.warn('[EAM] Could not fetch Supabase config, using fallback:', e?.message);
  }
}
loadSupabaseConfig();

// Queue for failed syncs — persisted in storage to survive service worker restarts
let _failedSyncQueue = [];
const MAX_RETRY_QUEUE = 50;

// Local cache of already-synced job links — avoids hammering Supabase with
// duplicate-check polls. Persisted to chrome.storage to survive worker restarts.
const _syncedLinksCache = new Set();
let _syncedLinksLoaded = false;
const SYNCED_CACHE_MAX = 5000;

// Per-session sync attempt throttle: tracks last attempt time per link.
// Prevents the same job link from being POSTed > 1× per 60s even on legit retries.
const _lastSyncAttempt = new Map();
const SYNC_MIN_INTERVAL_MS = 60 * 1000;

async function loadSyncedLinksCache() {
  if (_syncedLinksLoaded) return;
  const { _syncedLinks } = await chrome.storage.local.get('_syncedLinks');
  if (Array.isArray(_syncedLinks)) {
    for (const l of _syncedLinks) _syncedLinksCache.add(l);
  }
  _syncedLinksLoaded = true;
}

function persistSyncedLink(link) {
  if (!link) return;
  _syncedLinksCache.add(link);
  if (_syncedLinksCache.size > SYNCED_CACHE_MAX) {
    const arr = [..._syncedLinksCache];
    _syncedLinksCache.clear();
    for (const l of arr.slice(-SYNCED_CACHE_MAX)) _syncedLinksCache.add(l);
  }
  chrome.storage.local.set({ _syncedLinks: [..._syncedLinksCache] });
}

// Load persisted queue on service worker startup
chrome.storage.local.get('_failedSyncQueue', (result) => {
  if (Array.isArray(result._failedSyncQueue)) {
    _failedSyncQueue = result._failedSyncQueue;
    if (_failedSyncQueue.length > 0) {
      console.log(`[EAM] Loaded ${_failedSyncQueue.length} queued jobs from storage`);
      retryFailedSyncs();
    }
  }
});

function persistFailedQueue() {
  chrome.storage.local.set({ _failedSyncQueue });
}

function queueFailedJob(job) {
  if (_failedSyncQueue.length < MAX_RETRY_QUEUE) {
    _failedSyncQueue.push(job);
    persistFailedQueue();
  }
}

// ────────────────────────────────────────────────────────────────────
// AI form-answer — proxies `ai-form.js` → Supabase `ai-generate` Edge Fn
// ────────────────────────────────────────────────────────────────────
// `core/ai-form.js` fires chrome.runtime.sendMessage({ type: 'ai-form-answer',
// prompt }). This handler relays it to the Edge Function with the user's
// JWT attached. Without this bridge, sendResponse is never called, ai-form
// receives undefined, and every open-ended question stays blank — which is
// exactly the "fields left empty / AI never fires" bug that cost us a
// $29.99 refund from our first unlimited-plan user.
async function handleAIFormAnswer(prompt) {
  try {
    let { eam_session } = await chrome.storage.local.get('eam_session');
    if (!eam_session?.access_token) {
      return { error: 'not_signed_in' };
    }

    const callOnce = async (token) => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-generate`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt,
          task: 'form-answer',
          temperature: 0.2,
          maxTokens: 300
        })
      });
      return res;
    };

    let res = await callOnce(eam_session.access_token);

    // Refresh + retry once on 401
    if (res.status === 401) {
      const newSession = await refreshSupabaseToken();
      if (newSession) {
        res = await callOnce(newSession.access_token);
      } else {
        return { error: 'session_expired' };
      }
    }

    // 403 Premium required — surface the code ai-form.js checks for
    if (res.status === 403) {
      let body = {};
      try { body = await res.json(); } catch {}
      if (/premium/i.test(body?.error || '')) {
        return { error: 'premium_required' };
      }
      return { error: body?.error || 'forbidden' };
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { error: `status_${res.status}` + (txt ? ': ' + txt.slice(0, 80) : '') };
    }

    const data = await res.json();
    // ai-generate returns { response: "...", model, creditsUsed, creditsRemaining }
    const answer = (data.response || data.result || '').trim();
    if (!answer) return { error: 'empty_response' };
    return { answer };
  } catch (e) {
    console.warn('[EAM] handleAIFormAnswer failed:', e.message);
    return { error: e.message || 'network_error' };
  }
}

async function refreshSupabaseToken() {
  try {
    const { eam_session } = await chrome.storage.local.get('eam_session');
    if (!eam_session?.refresh_token) return null;

    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refresh_token: eam_session.refresh_token })
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (data.access_token) {
      const newSession = {
        user_id: eam_session.user_id,
        access_token: data.access_token,
        refresh_token: data.refresh_token || eam_session.refresh_token
      };
      await chrome.storage.local.set({ eam_session: newSession });
      console.log('[EAM] Token refreshed successfully');
      return newSession;
    }
    return null;
  } catch (e) {
    console.warn('[EAM] Token refresh failed:', e.message);
    return null;
  }
}

// ── Proactive session keep-alive ──────────────────────────────────────
// Supabase's default JWT TTL is 60 min. The pre-existing refresh path
// was reactive: only the 401-response handler in syncJobToSupabase
// triggered a refresh. So if a user wasn't applying for >60 min, opened
// the popup or hit any other auth-gated path, they'd see "please log
// in again" even though the refresh_token was still valid (default 30d
// TTL). Now an alarm fires every 50 min, refreshing while we still
// have an unexpired access_token in storage. Idempotent: if there's
// no session, this is a no-op.
const KEEPALIVE_ALARM = 'eam-session-keepalive';
async function setupSessionKeepalive() {
  try {
    const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
    if (existing) return;
    await chrome.alarms.create(KEEPALIVE_ALARM, {
      delayInMinutes: 50,
      periodInMinutes: 50,
    });
    console.log('[EAM] Session keep-alive alarm scheduled (50 min interval)');
  } catch (e) {
    console.warn('[EAM] Failed to schedule keep-alive alarm:', e?.message);
  }
}
// Schedule on service-worker boot AND on install/update.
setupSessionKeepalive();
chrome.runtime.onInstalled.addListener(setupSessionKeepalive);
chrome.runtime.onStartup?.addListener?.(setupSessionKeepalive);

// Reset `isRunning` on SW startup / install / update. The service worker can
// die at any time (Chrome policy: idle SWs are killed after 30s). Without this
// reset, the storage flag stays `true` after restart even though no engine
// loop is actually running → popup shows "Running" forever until user clicks
// Stop, and dashboard shows misleading state. Extension edge-case audit
// 2026-08-14 caught this zombie state (scenario 7).
try {
  const resetRunning = () => {
    chrome.storage.local.set({ isRunning: false }).catch(() => {});
  };
  chrome.runtime.onStartup?.addListener?.(resetRunning);
  chrome.runtime.onInstalled.addListener(resetRunning);
} catch (_) { /* older Chrome without onStartup — fall back silently */ }

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  try {
    const { eam_session } = await chrome.storage.local.get('eam_session');
    if (!eam_session?.refresh_token) return; // not logged in — nothing to keep alive
    const refreshed = await refreshSupabaseToken();
    if (refreshed) {
      console.log('[EAM] Keep-alive refresh succeeded');
    } else {
      console.warn('[EAM] Keep-alive refresh returned null — refresh_token may be invalid');
    }
  } catch (e) {
    console.warn('[EAM] Keep-alive listener error:', e?.message);
  }
});

async function syncJobToSupabase(job, isRetry = false) {
  try {
    const link = job.link || '';

    // Fast path #1 — local cache: link already synced this session/device.
    // Avoids every duplicate GET-then-INSERT round-trip to Supabase.
    await loadSyncedLinksCache();
    if (link && _syncedLinksCache.has(link)) {
      return;
    }

    // Fast path #2 — per-link throttle: cap at 1 sync attempt per 60s per link.
    // Defends against the engine re-firing jobApplied for the same job in a loop.
    if (link) {
      const last = _lastSyncAttempt.get(link);
      const now = Date.now();
      if (last && now - last < SYNC_MIN_INTERVAL_MS) {
        return;
      }
      _lastSyncAttempt.set(link, now);
      if (_lastSyncAttempt.size > 2000) {
        const cutoff = now - SYNC_MIN_INTERVAL_MS;
        for (const [k, t] of _lastSyncAttempt) {
          if (t < cutoff) _lastSyncAttempt.delete(k);
        }
      }
    }

    let { eam_session } = await chrome.storage.local.get('eam_session');
    if (!eam_session?.access_token || !eam_session?.user_id) {
      if (!isRetry) {
        queueFailedJob(job);
        console.warn('[EAM] No session — queued job for later sync');
      }
      return;
    }

    // Single INSERT with resolution=ignore-duplicates relies on the
    // partial UNIQUE index on (user_id, link). No more pre-check GET — which
    // was costing 1 GET per jobApplied event (the SAME event was firing
    // hundreds of times for the same job, driving the egress quota up).
    const doInsert = async (session) => fetch(`${SUPABASE_URL}/rest/v1/job_applications`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal,resolution=ignore-duplicates'
      },
      body: JSON.stringify({
        user_id: session.user_id,
        title: job.title,
        company: job.company,
        location: job.location || '',
        link,
        applied_at: job.date || new Date().toISOString(),
        status: 'applied',
        source: job.source || 'linkedin'
      })
    });

    let insertRes = await doInsert(eam_session);

    if (insertRes.status === 401) {
      console.warn('[EAM] Token expired, attempting refresh...');
      const newSession = await refreshSupabaseToken();
      if (!newSession) {
        if (!isRetry) queueFailedJob(job);
        return;
      }
      eam_session = newSession;
      insertRes = await doInsert(eam_session);
    }

    if (insertRes.ok || insertRes.status === 201) {
      // Mark as synced locally either way — whether inserted or silently ignored
      persistSyncedLink(link);
      console.log(`[EAM] Auto-synced: ${job.title} @ ${job.company}`);
      if (job.source === 'linkedin') {
        enqueueDiag({ site: 'linkedin', event_type: 'submit_ok', url_path: null, meta: {} });
      }

      // On successful sync, retry any queued jobs
      if (_failedSyncQueue.length > 0) {
        console.log(`[EAM] Retrying ${_failedSyncQueue.length} queued jobs...`);
        const queued = _failedSyncQueue.splice(0);
        persistFailedQueue();
        for (const qJob of queued) {
          await syncJobToSupabase(qJob, true);
        }
      }
    } else if (insertRes.status === 429) {
      // Server-side rate-limit hit (60/user/min trigger) — do NOT re-queue,
      // that would amplify the spam pattern the trigger is defending against.
      console.warn('[EAM] Server rate-limited — skipping sync for this job');
    } else {
      console.warn(`[EAM] Insert failed (${insertRes.status})`);
      if (!isRetry && _failedSyncQueue.length < MAX_RETRY_QUEUE) {
        _failedSyncQueue.push(job);
      }
    }
  } catch (e) {
    console.warn('[EAM] Auto-sync failed:', e.message);
    if (!isRetry && _failedSyncQueue.length < MAX_RETRY_QUEUE) {
      _failedSyncQueue.push(job);
    }
  }
}

// Retry failed syncs (called on startup and periodically)
async function retryFailedSyncs() {
  if (_failedSyncQueue.length === 0) return;
  const { eam_session } = await chrome.storage.local.get('eam_session');
  if (!eam_session?.access_token) return;
  console.log(`[EAM] Retrying ${_failedSyncQueue.length} failed syncs...`);
  const queued = _failedSyncQueue.splice(0);
  persistFailedQueue();
  for (const job of queued) {
    await syncJobToSupabase(job, true);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[EAM] onInstalled:', details.reason);

  // Periodic retry alarm for failed syncs — must run on every install AND
  // update so the alarm exists after a CWS auto-update.
  chrome.alarms.create('retrySyncQueue', { periodInMinutes: 5 });

  // Only initialize counters on a real first install. On `update` /
  // `chrome_update` / `shared_module_update` we MUST NOT touch
  // appliedCount/skippedCount/appliedJobs — wiping them on every CWS auto-
  // update is a regression that surprised v2.5.1 users (counts visible in
  // the popup reset to 0 after the auto-update, while the dashboard kept
  // the real numbers because those live in Supabase).
  if (details.reason !== 'install') return;

  console.log('[EAM] Fresh install — initializing storage defaults');
  chrome.storage.local.set({
    isRunning: false,
    appliedCount: 0,
    skippedCount: 0,
    appliedJobs: [],
    onboardingCompleted: false
  });
});

// Retry on alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'retrySyncQueue') {
    retryFailedSyncs();
  }
});

// Retry when user logs in (session appears)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.eam_session?.newValue?.access_token) {
    retryFailedSyncs();
  }
});

// ── Indeed cross-tab orchestration ────────────────────────────────────────
// Track which smartapply tabs have already been auto-started (prevent duplicates)
const startedSmartApplyTabs = new Set();
// Track tabs where post-apply has already been handled
const handledPostApplyTabs = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || '';
  if (!/smartapply\.indeed\.com/i.test(url)) return;

  // ── Post-apply detection (application complete) ─────────────────────
  // Fires on URL change (SPA pushState) or full navigation
  if (/post-apply/i.test(url) && (changeInfo.url || changeInfo.status === 'complete')) {
    if (handledPostApplyTabs.has(tabId)) return;

    console.log('[EAM] Post-apply page detected — waiting for formOnlyLoop to save...');

    // Wait 4 seconds to let formOnlyLoop finish saving the application
    // This is a safety fallback — normally formOnlyLoop sends indeedSmartApplyDone first
    setTimeout(() => {
      if (handledPostApplyTabs.has(tabId)) return; // Already handled by message
      console.log('[EAM] Post-apply fallback: closing smartapply tab');
      handledPostApplyTabs.add(tabId);

      chrome.storage.local.get(['isRunning', 'indeedSearchTabId'], (result) => {
        if (!result.isRunning) return;

        // Signal completion via DIRECT MESSAGE (not throttled in background tabs)
        if (result.indeedSearchTabId) {
          chrome.tabs.sendMessage(result.indeedSearchTabId, { action: 'indeedApplyComplete' }).catch(() => {});
        }
        // Also set in storage as fallback
        chrome.storage.local.set({ indeedApplyComplete: true });

        // Switch to search tab and close smartapply tab
        if (result.indeedSearchTabId) {
          chrome.tabs.update(result.indeedSearchTabId, { active: true }).then(() => {
            setTimeout(() => {
              startedSmartApplyTabs.delete(tabId);
              chrome.tabs.remove(tabId).catch(() => {});
            }, 500);
          }).catch(() => {
            startedSmartApplyTabs.delete(tabId);
            chrome.tabs.remove(tabId).catch(() => {});
          });
        } else {
          startedSmartApplyTabs.delete(tabId);
          chrome.tabs.remove(tabId).catch(() => {});
        }
      });
    }, 4000);

    return; // Don't auto-start on post-apply
  }

  // ── Indeed AUTOFILL-ONLY mode (v2.5.24) ──────────────────────────────
  // Auto-start on smartapply.indeed.com is DISABLED. Reason: Indeed's
  // Cloudflare bot-detection intermittently blocks automated form flows;
  // rather than push a "sometimes works" experience, we let the user drive.
  //
  // New Indeed UX:
  //   1. User clicks Postuler on indeed.com (unchanged)
  //   2. Indeed redirects to smartapply.indeed.com (unchanged)
  //   3. Engine does NOT auto-fill/submit (was: auto-start)
  //   4. User opens popup + clicks "Autofill" → universal autofill fills
  //      the form fields (name/email/phone/etc + AI for screening Qs)
  //   5. User reviews + clicks Submit themselves
  //
  // Post-apply tab cleanup above (lines 413-456) STAYS — if user manually
  // navigates through, the tab-close still helps hygiene.
  // Old auto-start block preserved as commented reference — if we ever
  // decide to re-enable (e.g. via user setting), just uncomment.
  //
  // if (changeInfo.status === 'complete') {
  //   if (startedSmartApplyTabs.has(tabId)) return;
  //   chrome.storage.local.get(['isRunning'], (result) => {
  //     if (result.isRunning) {
  //       startedSmartApplyTabs.add(tabId);
  //       const sendStart = (attempt) => {
  //         chrome.tabs.sendMessage(tabId, { action: 'start', adapter: 'indeed' }).catch(() => {
  //           if (attempt < 3) setTimeout(() => sendStart(attempt + 1), 1500);
  //         });
  //       };
  //       setTimeout(() => sendStart(1), 2000);
  //     }
  //   });
  // }
});

// Clean up tracking sets when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  startedSmartApplyTabs.delete(tabId);
  handledPostApplyTabs.delete(tabId);
});

// Ecouter les messages
// ── LinkedIn-only diagnostic telemetry ────────────────────────────────
// Buffers events emitted by content-scripts, flushes on 60s alarm or
// when buffer >= 15 items. Cost cap: server rejects >2000 rows/hr/user.
const EAM_DIAG_BUFFER_MAX = 15;
const EAM_DIAG_FLUSH_URL = () => `${SUPABASE_URL}/functions/v1/ext-diag-ingest`;
let _diagBuffer = [];
let _diagFlushing = false;

async function flushDiagBuffer() {
  if (_diagFlushing || _diagBuffer.length === 0) return;
  _diagFlushing = true;
  const batch = _diagBuffer.splice(0, 100);
  try {
    const { eam_session } = await chrome.storage.local.get('eam_session');
    if (!eam_session?.access_token) { _diagBuffer.unshift(...batch); return; }
    let extVersion = null;
    try { extVersion = chrome.runtime.getManifest().version; } catch (e) {}
    const res = await fetch(EAM_DIAG_FLUSH_URL(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${eam_session.access_token}`,
      },
      body: JSON.stringify({ ext_version: extVersion, events: batch }),
    });
    if (!res.ok && res.status !== 400) {
      // Requeue on transient failure; drop on 401/403/429 to prevent loops.
      if (res.status >= 500) _diagBuffer.unshift(...batch);
    }
  } catch (e) {
    if (_diagBuffer.length < 200) _diagBuffer.unshift(...batch);
  } finally {
    _diagFlushing = false;
  }
}

function enqueueDiag(event) {
  if (!event || event.site !== 'linkedin') return;
  _diagBuffer.push(event);
  if (_diagBuffer.length >= EAM_DIAG_BUFFER_MAX) flushDiagBuffer();
}

chrome.alarms.create('eam-diag-flush', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'eam-diag-flush') flushDiagBuffer();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // AI form-answer proxy — must be FIRST so we can `return true` to keep
  // the response channel open for the async fetch.
  if (message.type === 'ai-form-answer') {
    handleAIFormAnswer(message.prompt).then(sendResponse);
    return true; // keep channel open
  }
  // Diagnostic event from a content-script (LinkedIn only, server-enforced).
  if (message.type === 'eam-diag' && message.event) {
    enqueueDiag(message.event);
    return; // fire-and-forget
  }
  // Token refresh proxy — called by popup when its access_token returns 401.
  // Without this the popup falls back to logged-out state every hour
  // (default Supabase JWT TTL), forcing the user to re-login repeatedly.
  if (message.type === 'refreshToken') {
    refreshSupabaseToken().then(session => sendResponse(session || null));
    return true; // keep channel open
  }
  // Autofill tracking beacon — fire-and-forget. Fires for EVERY popup
  // Autofill click so we get admin observability even on pattern-matched-
  // only sessions where no AI call happens. Insert into tool_usage
  // (name='autofill') via authenticated REST call from the service worker.
  if (message.type === 'track-autofill') {
    (async () => {
      try {
        const { eam_session } = await chrome.storage.local.get('eam_session');
        if (!eam_session?.access_token) return;
        // Decode user_id from the JWT so the row attributes to this user
        // (RLS policy tool_usage_authed_insert_own requires user_id = auth.uid()
        // or NULL — NULL rows are orphaned in per-user reports so we always
        // set it explicitly).
        let userId = eam_session.user?.id || null;
        if (!userId) {
          try {
            const payload = JSON.parse(atob(eam_session.access_token.split('.')[1]));
            userId = payload?.sub || null;
          } catch (_) { userId = null; }
        }
        if (!userId) return;
        const body = {
          tool_name: 'autofill',
          user_id: userId,
          metadata: { filled: message.filled || 0, hostname: message.hostname || '', path: message.path || '' },
        };
        await fetch(`${SUPABASE_URL}/rest/v1/tool_usage`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${eam_session.access_token}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(body),
        });
      } catch (_) { /* fire-and-forget */ }
    })();
    return; // no async response needed
  }
  if (message.type === 'incrementCount') {
    chrome.storage.local.get(['appliedCount'], (result) => {
      const newCount = (result.appliedCount || 0) + 1;
      chrome.storage.local.set({ appliedCount: newCount });
    });
  } else if (message.type === 'incrementSkippedCount') {
    chrome.storage.local.get(['skippedCount'], (result) => {
      const newCount = (result.skippedCount || 0) + 1;
      chrome.storage.local.set({ skippedCount: newCount });
    });
  } else if (message.type === 'setRunning') {
    chrome.storage.local.set({ isRunning: message.value });
  } else if (message.type === 'jobApplied') {
    // engine.js already saves to chrome.storage.local.appliedJobs
    // so we only need to sync to Supabase here (no local push to avoid duplicates)
    const job = {
      title: message.title || '',
      company: message.company || '',
      link: message.link || '',
      location: message.location || '',
      date: message.date || new Date().toISOString(),
      source: message.source || 'linkedin'
    };
    syncJobToSupabase(job);

  // ── Indeed cross-tab messages ───────────────────────────────────────
  } else if (message.type === 'saveSearchTabId') {
    // Save the Indeed search tab ID for cross-tab orchestration
    const tabId = sender.tab?.id || message.tabId;
    console.log(`[EAM] Saved search tab ID: ${tabId}`);
    chrome.storage.local.set({ indeedSearchTabId: tabId });
    sendResponse({ success: true });

  } else if (message.type === 'indeedSmartApplyDone') {
    // SmartApply formOnlyLoop completed — close tab and switch to search
    const smartApplyTabId = sender.tab?.id;
    console.log(`[EAM] SmartApply done signal from tab ${smartApplyTabId}`);

    // Mark as handled so the fallback timer doesn't fire
    if (smartApplyTabId) handledPostApplyTabs.add(smartApplyTabId);

    chrome.storage.local.get(['indeedSearchTabId'], (result) => {
      // Signal completion to mainLoop via DIRECT MESSAGE (not throttled in background tabs)
      if (result.indeedSearchTabId) {
        chrome.tabs.sendMessage(result.indeedSearchTabId, { action: 'indeedApplyComplete' }).catch(() => {});
      }
      // Also set in storage as fallback
      chrome.storage.local.set({ indeedApplyComplete: true });

      // Switch to search tab, then close smartapply tab
      if (result.indeedSearchTabId) {
        chrome.tabs.update(result.indeedSearchTabId, { active: true }).then(() => {
          if (smartApplyTabId) {
            setTimeout(() => {
              startedSmartApplyTabs.delete(smartApplyTabId);
              chrome.tabs.remove(smartApplyTabId).catch(() => {});
            }, 300);
          }
        }).catch(() => {
          if (smartApplyTabId) {
            startedSmartApplyTabs.delete(smartApplyTabId);
            chrome.tabs.remove(smartApplyTabId).catch(() => {});
          }
        });
      } else if (smartApplyTabId) {
        startedSmartApplyTabs.delete(smartApplyTabId);
        chrome.tabs.remove(smartApplyTabId).catch(() => {});
      }
    });

    sendResponse({ success: true });
  }
});
