// ULTRA SIMPLE - COPIE EXACTE DU PYTHON
let isRunning = false;
let config = {};
let appliedCount = 0;
let skippedCount = 0;
let appliedJobs = []; // Liste des jobs appliqués pour export
let lastActivityTime = Date.now(); // Track last activity for stuck detection
let lastJobIndex = -1; // Track last job processed
const STUCK_TIMEOUT = 120000; // 2 minutes without activity = stuck

// SECURITY: Ultimate protection flag - bot can ONLY run if user explicitly clicked Start
let userExplicitlyClickedStart = false;

// Resume/CV data for automatic upload
let resumeFile = null; // Base64 data
let resumeFileName = null;
let resumeFileType = null;

// Logs simples
function log(msg) {
  console.log('[LinkedIn Bot]', msg);
  try {
    chrome.runtime.sendMessage({ type: 'log', message: msg });
  } catch (e) {}
}

// Attendre
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Cliquer - PROTECTED: Only works if bot is running
async function click(element) {
  // CRITICAL SECURITY CHECK: Prevent ANY clicks if bot is not explicitly started
  if (!isRunning || !userExplicitlyClickedStart) {
    console.error('🚨 SECURITY VIOLATION: Attempted click() but bot is NOT running!');
    console.error('🔒 isRunning:', isRunning, '| userExplicitlyClickedStart:', userExplicitlyClickedStart);
    console.error('🚫 Click BLOCKED for security');
    console.trace('Call stack:'); // Show where this was called from
    return; // BLOCK THE CLICK
  }

  element.click();
  updateActivity(); // Update activity on every click
  await wait(500);
}

// Update last activity time
function updateActivity() {
  lastActivityTime = Date.now();
}

// Check if script is stuck (no activity for STUCK_TIMEOUT)
function isStuck() {
  const timeSinceActivity = Date.now() - lastActivityTime;
  return timeSinceActivity > STUCK_TIMEOUT;
}

// Check for LinkedIn's daily Easy Apply limit
function checkDailyLimit() {
  try {
    // List of limit message patterns (case-insensitive)
    const limitPatterns = [
      "You've reached today's Easy Apply limit",
      "You've reached today's easy apply limit",
      "reached today's Easy Apply limit",
      "Great effort applying today",
      "we limit daily submissions",
      "continue applying tomorrow",
      "Save this job and continue applying tomorrow",
      "exceeded the daily application limit",
      "reached today\\'s easy apply limit",
      "daily Easy Apply limit",
      "limit daily submissions"
    ];

    // Search in entire page text
    const bodyText = document.body.innerText || '';

    for (const pattern of limitPatterns) {
      if (bodyText.toLowerCase().includes(pattern.toLowerCase())) {
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('🚫 DAILY LIMIT REACHED!');
        log(`   Message detected: "${pattern}"`);
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('LinkedIn limits Easy Apply to ~50-100 per day');
        log('📊 Session stats:');
        log(`   ✅ Applied: ${appliedCount}`);
        log(`   ⏭️  Skipped: ${skippedCount}`);
        log('⏰ You can continue applying tomorrow!');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Show visual notification to user
        alert(`🚫 LinkedIn Daily Limit Reached!\n\n` +
              `You've reached LinkedIn's daily Easy Apply limit (~50-100 applications).\n\n` +
              `📊 Today's Stats:\n` +
              `   ✅ Applied: ${appliedCount}\n` +
              `   ⏭️  Skipped: ${skippedCount}\n\n` +
              `⏰ You can continue applying tomorrow!\n\n` +
              `The bot has been stopped automatically.`);

        return true;
      }
    }

    // Also check for specific error messages in modal/toast elements
    const errorElements = document.querySelectorAll('.artdeco-inline-feedback, .artdeco-toast-item, .artdeco-modal__content');
    for (const element of errorElements) {
      const elementText = element.textContent || '';
      for (const pattern of limitPatterns) {
        if (elementText.toLowerCase().includes(pattern.toLowerCase())) {
          log('🚫 DAILY LIMIT DETECTED in error element!');
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    log(`⚠️ Error checking daily limit: ${error.message}`);
    return false;
  }
}

// IMPROVED: Function to find and click Done button with exhaustive search
async function findAndClickDoneButton(contextElement = document, contextName = 'page', maxAttempts = 15) {
  log(`🔍 [${contextName}] Starting exhaustive search for Done button...`);

  const doneTexts = ['Done', 'Terminé', 'Submit application', 'Soumettre la candidature', 'Dismiss', 'Close', 'Fermer'];
  let doneBtn = null;

  for (let attempt = 0; attempt < maxAttempts && !doneBtn; attempt++) {
    await wait(1000);

    // Log what we're looking for on first attempt
    if (attempt === 0) {
      log(`   Looking for buttons with text: ${doneTexts.join(', ')}`);
    }

    // METHOD 1: Search by SPAN text (Python method - most reliable)
    for (let targetText of doneTexts) {
      // Find ALL spans in context
      const spans = Array.from(contextElement.querySelectorAll('span.artdeco-button__text, span'));

      for (let span of spans) {
        const spanText = span.textContent.trim();

        if (spanText === targetText) {
          // Find clickable parent
          let clickableElement = span.closest('button, [role="button"], .artdeco-button');

          if (!clickableElement) {
            clickableElement = span;
          }

          // Check if visible
          if (clickableElement.offsetParent !== null) {
            doneBtn = clickableElement;
            log(`   ✅ [METHOD 1] Found via SPAN: "${targetText}"`);
            break;
          }
        }
      }
      if (doneBtn) break;
    }

    // METHOD 2: Direct button search (fallback)
    if (!doneBtn) {
      const buttons = Array.from(contextElement.querySelectorAll('button, [role="button"]'));
      for (let btn of buttons) {
        const btnText = btn.textContent.trim();
        for (let targetText of doneTexts) {
          if (btnText === targetText && btn.offsetParent !== null) {
            doneBtn = btn;
            log(`   ✅ [METHOD 2] Found via direct button search: "${targetText}"`);
            break;
          }
        }
        if (doneBtn) break;
      }
    }

    // METHOD 3: Search by aria-label
    if (!doneBtn) {
      for (let targetText of doneTexts) {
        const ariaBtn = contextElement.querySelector(`button[aria-label*="${targetText}"], [role="button"][aria-label*="${targetText}"]`);
        if (ariaBtn && ariaBtn.offsetParent !== null) {
          doneBtn = ariaBtn;
          log(`   ✅ [METHOD 3] Found via aria-label: "${targetText}"`);
          break;
        }
      }
    }

    // METHOD 4: Search by data-control-name (LinkedIn specific)
    if (!doneBtn) {
      const controlNames = ['done', 'submit', 'continue_application'];
      for (let name of controlNames) {
        const controlBtn = contextElement.querySelector(`button[data-control-name*="${name}"]`);
        if (controlBtn && controlBtn.offsetParent !== null) {
          doneBtn = controlBtn;
          log(`   ✅ [METHOD 4] Found via data-control-name: "${name}"`);
          break;
        }
      }
    }

    // Debug: Log all visible buttons on first and every 5th attempt
    if (attempt === 0 || attempt % 5 === 0) {
      if (!doneBtn) {
        const allButtons = Array.from(contextElement.querySelectorAll('button, [role="button"]'));
        const visibleButtons = allButtons.filter(b => b.offsetParent !== null);
        log(`   [DEBUG Attempt ${attempt + 1}/${maxAttempts}] Found ${visibleButtons.length} visible buttons:`);
        visibleButtons.slice(0, 10).forEach((btn, i) => {
          const text = btn.textContent.trim().substring(0, 30);
          const ariaLabel = btn.getAttribute('aria-label') || 'none';
          const dataControl = btn.getAttribute('data-control-name') || 'none';
          log(`      ${i + 1}. Text: "${text}" | Aria: "${ariaLabel}" | Data: "${dataControl}"`);
        });
      }
    }

    if (!doneBtn && (attempt === 0 || attempt % 5 === 0)) {
      log(`   ⏳ [${contextName}] Attempt ${attempt + 1}/${maxAttempts}: Still searching...`);
    }
  }

  // Try to click if found
  if (doneBtn) {
    log(`✅✅✅ [${contextName}] Done button FOUND! Attempting click...`);

    let clickSuccessful = false;

    // Method 1: Standard click
    try {
      log('   Click Method 1: Standard click...');
      doneBtn.click();
      await wait(500);
      log('   ✅ Standard click successful');
      clickSuccessful = true;
    } catch (e1) {
      log(`   ⚠️ Standard click failed: ${e1.message}`);

      // Method 2: MouseEvent
      try {
        log('   Click Method 2: MouseEvent dispatch...');
        doneBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await wait(500);
        log('   ✅ MouseEvent click successful');
        clickSuccessful = true;
      } catch (e2) {
        log(`   ⚠️ MouseEvent failed: ${e2.message}`);

        // Method 3: Focus + Enter
        try {
          log('   Click Method 3: Keyboard Enter...');
          doneBtn.focus();
          await wait(200);
          doneBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          doneBtn.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          await wait(500);
          log('   ✅ Keyboard trigger successful');
          clickSuccessful = true;
        } catch (e3) {
          log(`   ❌ All click methods failed: ${e3.message}`);
        }
      }
    }

    if (clickSuccessful) {
      updateActivity();
      await wait(700); // Ultra optimized job card click wait
      return { success: true, clicked: true };
    } else {
      return { success: false, clicked: false, reason: 'Click failed' };
    }
  } else {
    log(`❌ [${contextName}] Done button NOT FOUND after ${maxAttempts} attempts`);
    return { success: false, clicked: false, reason: 'Button not found' };
  }
}

// Refresh page and return to job search
async function refreshAndReturnToSearch() {
  log('🔄 REFRESHING page due to stuck detection...');
  try {
    // Reload the page
    location.reload();
    // Wait will happen automatically when page reloads
    return true;
  } catch (error) {
    log(`❌ Error refreshing page: ${error.message}`);
    return false;
  }
}

// Discard application (Python ligne 1500-1580) - ULTRA AGGRESSIVE VERSION + STUCK DETECTION
async function discardApplication() {
  log('🚀 DISCARD: Starting SAFE discard sequence...');

  const discardTexts = ['discard', 'annuler', 'cancel', 'abandonner', 'descarter'];

  try {
    // 🆕 DETECTION CRITIQUE: Vérifier si popup de chargement est bloqué (Python ligne 1547-1558)
    if (checkForStuckLoadingPopup()) {
      // Skip reload if a rate-limit or daily-limit popup is up. Those are
      // NOT stuck (they have working buttons); reloading would just re-serve
      // the same popup and users report it as "page keeps refreshing".
      const isRateLimit = typeof checkRateLimit === 'function' ? checkRateLimit() : false;
      const isDailyLimit = typeof checkDailyLimit === 'function' ? checkDailyLimit() : false;
      if (isRateLimit || isDailyLimit) {
        log('⚠ Stuck heuristic fired but ' + (isDailyLimit ? 'daily-limit' : 'rate-limit') + ' popup up — skip reload.');
        return false;
      }
      log('🚨 POPUP DE CHARGEMENT BLOQUÉ DÉTECTÉ!');
      log('🔄 REFRESH DE LA PAGE POUR DÉBLOQUER...');
      try {
        location.reload();
        await wait(2000); // Optimized refresh wait
        log('✅ Page rafraîchie avec succès');
        return true;
      } catch (error) {
        log(`❌ Erreur lors du refresh: ${error.message}`);
      }
    }

    // STEP 1: Force close with X button (MOST RELIABLE METHOD - moved to first)
    log('🔍 STEP 1: Looking for X/Close button...');
    const closeButtons = document.querySelectorAll('button[aria-label*="Dismiss"], button[aria-label*="Close"], button.artdeco-modal__dismiss');

    for (let btn of closeButtons) {
      if (btn.offsetParent) {
        log(`✅ Clicking close button: ${btn.getAttribute('aria-label')}`);
        btn.click();
        await wait(1000);

        // Look for discard confirmation again
        const discardBtn = Array.from(document.querySelectorAll('button')).find(b =>
          b.offsetParent && discardTexts.some(t => b.textContent.trim().toLowerCase().includes(t))
        );

        if (discardBtn) {
          log('✅ Clicking discard confirmation');
          discardBtn.click();
          await wait(1500);
        }

        const modal = document.querySelector('.jobs-easy-apply-modal');
        if (!modal || modal.offsetParent === null) {
          log('✅✅✅ MODAL CLOSED!');
          return true;
        }
      }
    }

    // STEP 2: Press ESC key (fallback)
    log('📤 STEP 2: Pressing ESC key...');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
    await wait(1000); // Optimized ESC wait

    // STEP 3: Look for ANY discard/cancel button (last resort)
    log('🔍 STEP 3: Searching for Discard/Cancel buttons...');

    // Try 3 times to find the button (it may appear slowly)
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`   Attempt ${attempt}/3...`);

      // Get ALL buttons on page (including in dialogs/modals)
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
      log(`   Found ${allButtons.length} total buttons`);

      for (let btn of allButtons) {
        // Skip invisible buttons
        if (!btn.offsetParent) continue;

        // Get text from button and nested elements
        const btnText = btn.textContent.trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const dataControl = (btn.getAttribute('data-control-name') || '').toLowerCase();

        // Check if it's a discard/cancel button
        const isDiscardButton = discardTexts.some(text =>
          btnText === text ||
          btnText.includes(text) ||
          ariaLabel.includes(text) ||
          dataControl.includes(text)
        );

        if (isDiscardButton) {
          log(`✅ FOUND: "${btn.textContent.trim()}" (visible, will click)`);

          // Click with multiple methods
          try {
            btn.click();
            await wait(300);
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          } catch (e) {
            log(`⚠️ Click error: ${e.message}`);
          }

          await wait(1500);

          // Check if modal closed
          const modal = document.querySelector('.jobs-easy-apply-modal');
          if (!modal || modal.offsetParent === null) {
            log('✅✅✅ MODAL CLOSED SUCCESSFULLY!');
            return true;
          }
        }
      }

      await wait(1000); // Wait before retry
    }

    log('❌ DISCARD FAILED: Could not close modal after all attempts');
    return false;

  } catch (error) {
    log(`❌ Error discarding: ${error.message}`);
    return false;
  }
}

// Remplir un champ - PROTECTED: Only works if bot is running
function fill(input, value) {
  // CRITICAL SECURITY CHECK: Prevent ANY form filling if bot is not explicitly started
  if (!isRunning || !userExplicitlyClickedStart) {
    console.error('🚨 SECURITY VIOLATION: Attempted fill() but bot is NOT running!');
    console.error('🔒 isRunning:', isRunning, '| userExplicitlyClickedStart:', userExplicitlyClickedStart);
    console.error('🚫 Fill BLOCKED for security');
    return; // BLOCK THE FILL
  }

  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Convert base64 to File object for resume upload
function base64ToFile(base64String, filename, mimeType) {
  try {
    // Remove data URL prefix if present (e.g., "data:application/pdf;base64,")
    const base64Data = base64String.includes(',') ? base64String.split(',')[1] : base64String;

    // Convert base64 to binary
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Create File object
    const file = new File([bytes], filename, { type: mimeType });
    return file;
  } catch (error) {
    log(`❌ Error converting base64 to file: ${error.message}`);
    return null;
  }
}

// Fill file input with resume
async function fillFileInput(fileInput, file) {
  try {
    // Create a DataTransfer object to set files
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    // Set the files property
    fileInput.files = dataTransfer.files;

    // Trigger change event
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    log(`✅ Resume uploaded: ${file.name}`);
    return true;
  } catch (error) {
    log(`❌ Error filling file input: ${error.message}`);
    return false;
  }
}

// BOUCLE PRINCIPALE - EXACTEMENT COMME PYTHON
async function mainLoop() {
  // SECURITY: Triple-layer protection - bot MUST be explicitly started by user
  if (!isRunning) {
    log('⚠️ SECURITY BLOCK 1/3: mainLoop called but isRunning=false - ABORTING');
    return;
  }

  if (!userExplicitlyClickedStart) {
    log('🚨 SECURITY BLOCK 2/3: mainLoop called but user did NOT click Start - ABORTING');
    log('🔒 This prevents any automatic execution. Bot ONLY runs when you click Start.');
    isRunning = false; // Force stop for safety
    await chrome.storage.local.set({ isRunning: false });
    return;
  }

  // Final sanity check
  if (!config || !config.email) {
    log('⚠️ SECURITY BLOCK 3/3: No config loaded - ABORTING');
    isRunning = false;
    userExplicitlyClickedStart = false;
    await chrome.storage.local.set({ isRunning: false });
    return;
  }

  console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: green; font-weight: bold;');
  console.log('%c🚀 BOT STARTED - User clicked START button', 'color: green; font-weight: bold; font-size: 14px;');
  console.log('%c✅ ALL SECURITY CHECKS PASSED', 'color: green; font-weight: bold;');
  console.log('%c🔓 Click() and Fill() functions are now ENABLED', 'color: green; font-weight: bold;');
  console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: green; font-weight: bold;');
  log('🚀 ✅ ALL SECURITY CHECKS PASSED - Bot started by user');

  // Detect page type ONCE at start
  const isCollectionsPage = window.location.href.includes('/jobs/collections/');
  if (isCollectionsPage) {
    log('📋 Page type: COLLECTIONS (infinite scroll mode)');
  } else {
    log('📋 Page type: SEARCH (pagination mode)');
  }
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  while (isRunning) {
    try {
      // 🆕 CHECK: Daily limit reached?
      if (checkDailyLimit()) {
        log('⛔ Stopping bot: Daily limit reached');
        isRunning = false;
        userExplicitlyClickedStart = false; // Clear security flag

        // Update storage
        await chrome.storage.local.set({ isRunning: false });

        // Notify popup
        try {
          chrome.runtime.sendMessage({
            type: 'updateStatus',
            status: 'stopped',
            message: 'Daily limit reached'
          });
        } catch (e) {
          // Popup may be closed
        }
        break;
      }

      // 🆕 CHECK: Script stuck? (no activity for 2 minutes)
      if (isStuck()) {
        log('🚨 SCRIPT STUCK DETECTED: No activity for 2 minutes!');
        log('🔄 Refreshing page to recover...');
        await refreshAndReturnToSearch();
        await wait(2500); // Optimized stuck recovery wait
        updateActivity(); // Reset activity after refresh
        continue;
      }

      // Python ligne 1695: job_listings = driver.find_elements(By.XPATH, "//li[@data-occludable-job-id]")
      let jobCards = document.querySelectorAll('li[data-occludable-job-id]');

      // ONLY on collections page: use fallback selectors if no jobs found with standard selector
      if (jobCards.length === 0 && isCollectionsPage) {
        jobCards = document.querySelectorAll('.jobs-search-results__list-item, .scaffold-layout__list-item');
        if (jobCards.length > 0) {
          log(`📋 Collections mode: found ${jobCards.length} jobs with fallback selectors`);
        }
      }

      if (jobCards.length === 0) {
        log(`Aucune offre trouvée. Attente 5s...`);

        // Check if page is unrecognized (no jobs for too long)
        if (isStuck()) {
          log('🚨 Page might be unrecognized (no jobs found + stuck)');
          log('🔄 Refreshing to return to job search...');
          await refreshAndReturnToSearch();
          await wait(2500); // Optimized refresh recovery wait
          updateActivity();
        }

        await wait(2500); // Optimized no jobs wait
        continue;
      }

      log(`${jobCards.length} offres trouvées`);
      updateActivity(); // Found jobs = activity

      // Python ligne 1701: for job in job_listings
      for (let i = 0; i < jobCards.length; i++) {
        if (!isRunning) break;

        const job = jobCards[i];
        const jobId = job.getAttribute('data-occludable-job-id');

        log(`\n--- Job ${i + 1}/${jobCards.length} (ID: ${jobId}) ---`);

        // CRITICAL: Check if modal from previous job is still open (stuck scenario)
        const leftoverModal = document.querySelector('.jobs-easy-apply-modal');
        if (leftoverModal && leftoverModal.offsetParent !== null) {
          log('⚠️ WARNING: Modal from previous job still open! Cleaning up...');
          await discardApplication();
          await wait(1000); // Optimized cleanup wait

          // Verify it's closed
          const stillOpen = document.querySelector('.jobs-easy-apply-modal');
          if (stillOpen && stillOpen.offsetParent !== null) {
            log('❌ CRITICAL: Could not close leftover modal, skipping this job');
            skippedCount++;
            updateSkippedCount();
            continue;
          } else {
            log('✅ Leftover modal cleaned up successfully');
          }
        }

        // Get job info for filtering
        // Use extended selectors ONLY on collections page
        let jobTitle, jobCompany, jobDescription;
        if (isCollectionsPage) {
          jobTitle = job.querySelector('.job-card-list__title, .artdeco-entity-lockup__title, .job-card-container__link strong, a[class*="job-card"] strong')?.textContent.trim() || '';
          jobCompany = job.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .artdeco-entity-lockup__caption')?.textContent.trim() || '';
          jobDescription = job.querySelector('.job-card-container__metadata-item, .job-card-list__insight')?.textContent.trim() || '';
        } else {
          // Standard selectors for /jobs/search/
          jobTitle = job.querySelector('.job-card-list__title, .artdeco-entity-lockup__title')?.textContent.trim() || '';
          jobCompany = job.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle')?.textContent.trim() || '';
          jobDescription = job.querySelector('.job-card-container__metadata-item')?.textContent.trim() || '';
        }

        // Check blacklist keywords
        if (shouldSkipByBlacklist(jobTitle, jobCompany, jobDescription, config.blacklistKeywords)) {
          skippedCount++;
          updateSkippedCount();
          continue;
        }

        // Check max years required
        if (shouldSkipByExperience(job, parseInt(config.maxYearsRequired))) {
          skippedCount++;
          updateSkippedCount();
          continue;
        }

        // Scroll and click (Python line 371)
        job.scrollIntoView({ block: 'start', behavior: 'smooth' });
        await wait(500);

        const link = job.querySelector('a');
        if (link) {
          await click(link);
          await wait(600); // Ultra optimized job link wait
        }

        // Chercher Easy Apply (Python ligne 1853)
        let easyApplyBtn = document.querySelector('button.jobs-apply-button[aria-label*="Easy"]');

        // ONLY on collections page: try additional selectors if not found
        if (!easyApplyBtn && isCollectionsPage) {
          // Try other Easy Apply selectors (must contain "Easy" to avoid external Apply)
          easyApplyBtn = document.querySelector('button[aria-label*="Easy Apply"]');
          if (easyApplyBtn) {
            log('📋 Found Easy Apply with collections selector');
          }
        }

        if (!easyApplyBtn) {
          log('Pas Easy Apply, skip');
          skippedCount++;
          updateSkippedCount();
          continue;
        }

        await click(easyApplyBtn);
        await wait(800); // Ultra optimized Easy Apply wait

        // Safety reminder modal ("Continue applying")
        // LinkedIn sometimes shows a "Job search safety reminder" dialog
        const safetyModal = document.querySelector('[role="dialog"], .artdeco-modal');
        if (safetyModal && safetyModal.offsetParent !== null) {
          const safetyText = safetyModal.textContent.toLowerCase();
          if (safetyText.includes('safety reminder') || safetyText.includes('rappel de sécurité') ||
              safetyText.includes('continue applying') || safetyText.includes('continuer à postuler')) {
            log('Safety reminder detected — clicking Continue applying...');
            const continueBtn = Array.from(safetyModal.querySelectorAll('button')).find(btn => {
              const t = btn.textContent.trim().toLowerCase();
              return t.includes('continue applying') || t.includes('continuer à postuler') ||
                     t.includes('continue') || t.includes('continuer');
            });
            if (continueBtn) {
              await click(continueBtn);
              log('Safety reminder dismissed');
              await wait(1000);
            }
          }
        }

        // CRITICAL: Check for daily limit immediately after clicking Easy Apply
        // This catches the network error case where modal doesn't appear
        if (checkDailyLimit()) {
          log('');
          log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          log('🚫 LINKEDIN DAILY LIMIT REACHED!');
          log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          log('LinkedIn limits Easy Apply to ~50-100 per day');
          log(`✅ Applied today: ${appliedCount}`);
          log(`⏭️  Skipped today: ${skippedCount}`);
          log('⏰ You can continue applying tomorrow!');
          log('🛑 Bot stopped automatically');
          log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          log('');

          isRunning = false;
          userExplicitlyClickedStart = false; // Clear security flag

          // Update storage
          await chrome.storage.local.set({ isRunning: false });

          try {
            chrome.runtime.sendMessage({
              type: 'updateStatus',
              status: 'stopped',
              message: 'Daily limit reached'
            });
          } catch (e) {
            // Popup might be closed
          }

          break; // Exit job loop
        }

        // Verify that modal appeared (if not, might be limit reached)
        const modalCheck = document.querySelector('.jobs-easy-apply-modal');
        if (!modalCheck || modalCheck.offsetParent === null) {
          log('⚠️ Easy Apply modal did not appear - checking for limit...');
          await wait(1000); // Optimized modal check wait

          if (checkDailyLimit()) {
            log('');
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log('🚫 LINKEDIN DAILY LIMIT REACHED!');
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log('LinkedIn limits Easy Apply to ~50-100 per day');
            log(`✅ Applied today: ${appliedCount}`);
            log(`⏭️  Skipped today: ${skippedCount}`);
            log('⏰ You can continue applying tomorrow!');
            log('🛑 Bot stopped automatically');
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            log('');

            isRunning = false;
            userExplicitlyClickedStart = false; // Clear security flag

            // Update storage
            await chrome.storage.local.set({ isRunning: false });

            try {
              chrome.runtime.sendMessage({
                type: 'updateStatus',
                status: 'stopped',
                message: 'Daily limit reached'
              });
            } catch (e) {
              // Popup might be closed
            }

            break; // Exit job loop
          }

          // Modal still not there and no limit message - skip job
          log('❌ Modal did not appear (unknown reason), skipping job');
          skippedCount++;
          updateSkippedCount();
          continue;
        }

        // Infos du job déjà extraites plus haut pour blacklist, on les réutilise
        const jobLink = job.querySelector('a')?.href || window.location.href;

        // Remplir formulaire multi-étapes avec TIMEOUT (Python ligne 528-529)
        let step = 0;
        const applicationStartTime = Date.now();
        const applicationTimeout = 180000; // 3 minutes max par candidature
        let loadingScreenTimeout = 20000; // 20 secondes pour écran de chargement (Python ligne 1481-1497)
        let lastActivityTime = Date.now();

        while (step < 10) {
          step++;

          // TIMEOUT CHECK (Python ligne 639)
          if (Date.now() - applicationStartTime > applicationTimeout) {
            log('⏰ TIMEOUT 3min - Discarding application');
            await discardApplication();
            skippedCount++;
            updateSkippedCount();
            break;
          }

          // 🆕 RE-CHECK: Popup bloqué avant chaque step (Python ligne 1563-1568)
          if (checkForStuckLoadingPopup()) {
            // Guard: rate-limit / daily-limit popups have working buttons
            // and should NOT trigger reload. Reload would just re-serve
            // them and users report "page keeps refreshing + filter lost".
            const isRateLimit = typeof checkRateLimit === 'function' ? checkRateLimit() : false;
            const isDailyLimit = typeof checkDailyLimit === 'function' ? checkDailyLimit() : false;
            if (isRateLimit || isDailyLimit) {
              log('⚠ Stuck-heuristic fired but ' + (isDailyLimit ? 'daily' : 'rate') + '-limit popup up — skip reload, break step loop.');
              break;
            }
            log('🚨 POPUP TOUJOURS BLOQUÉ - REFRESH...');
            location.reload();
            await wait(2000); // Optimized refresh wait
            skippedCount++;
            updateSkippedCount();
            break;
          }

          // CHECK FOR VALIDATION ERRORS EARLY (stuck scenario)
          let modal = document.querySelector('.jobs-easy-apply-modal');
          if (modal) {
            const errors = modal.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error, .fb-form-element-label__error');
            for (let error of errors) {
              if (error.offsetParent !== null) {
                const errorText = error.textContent.toLowerCase();
                if (errorText.includes('please enter') ||
                    errorText.includes('valid answer') ||
                    errorText.includes('required') ||
                    errorText.includes('must be') ||
                    errorText.includes('invalid')) {

                  log(`❌ STUCK: Validation error detected: ${error.textContent.substring(0, 50)}`);
                  log('⚠️ Discarding application due to validation error');

                  await discardApplication();
                  skippedCount++;
                  updateSkippedCount();
                  step = 999; // Force break
                  break;
                }
              }
            }
            if (step === 999) break;
          }

          // CHECK LOADING SCREEN (Python ligne 1481-1497)
          if (await isPageLoadingSlow()) {
            log('⏳ Loading screen detected...');
            const loadingStart = Date.now();

            while (await isPageLoadingSlow()) {
              if (Date.now() - loadingStart > loadingScreenTimeout) {
                log('⏰ Loading screen TIMEOUT 20s - Discarding application');

                // Use the discardApplication function to properly close modal
                const discarded = await discardApplication();

                if (discarded) {
                  log('✅ Modal closed successfully, moving to next job');
                } else {
                  log('⚠️ Modal may not be closed, forcing break anyway');
                }

                skippedCount++;
                updateSkippedCount();

                // Wait to ensure modal is closed and page is stable
                await wait(1000); // Optimized modal stable wait

                // Exit the step loop to move to next job
                break;
              }
              await wait(1000);
            }

            if (Date.now() - loadingStart > loadingScreenTimeout) {
              break; // Sortir du while principal pour passer au job suivant
            }
          }

          log(`Step ${step}`);

          // Find modal (reuse variable from earlier)
          modal = document.querySelector('.jobs-easy-apply-modal');
          if (!modal) {
            log('Modal closed');
            break;
          }

          // 1. TEXT FIELDS (Python line 1102) - Multilingual support
          const textInputs = modal.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"]');
          for (let input of textInputs) {
            if (input.value) continue; // Skip if already filled

            // Get label from multiple sources
            let labelText = '';

            // aria-label
            labelText += ' ' + (input.getAttribute('aria-label') || '');

            // name attribute
            labelText += ' ' + (input.getAttribute('name') || '');

            // Associated <label> element
            const inputId = input.getAttribute('id');
            if (inputId) {
              const labelEl = modal.querySelector(`label[for="${inputId}"]`);
              if (labelEl) labelText += ' ' + labelEl.textContent;
            }

            // Parent label
            const parentLabel = input.closest('label');
            if (parentLabel) labelText += ' ' + parentLabel.textContent;

            const label = labelText.toLowerCase();

            // Years of experience (EN/FR/ES/DE/IT)
            if (label.match(/experience|years|expérience|années|años|jahre|anni|esperienza/)) {
              fill(input, config.yearsOfExperience || '2');
              log(`Years exp: ${config.yearsOfExperience || '2'}`);
            }
            // Salary / Compensation (EN/FR/ES/DE/IT)
            else if (label.match(/salary|compensation|remuneration|salaire|rémunération|sueldo|salario|gehalt|stipendio/)) {
              if (config.expectedSalary) {
                fill(input, config.expectedSalary);
                log(`Salary filled: ${config.expectedSalary}`);
              } else {
                log(`⚠️ Salary question detected but no expected salary configured`);
              }
            }
            // Email
            else if (label.match(/email|e-mail|courriel|correo/)) fill(input, config.email);
            // First name (EN/FR/ES/DE/IT)
            else if (label.match(/first|prénom|prenom|nombre|vorname|nome/)) fill(input, config.firstName);
            // Last name (EN/FR/ES/DE/IT)
            else if (label.match(/last|nom|apellido|nachname|cognome/)) fill(input, config.lastName);
            // Phone (EN/FR/ES/DE/IT) - includes "portable", "cell", "móvil"
            else if (label.match(/phone|téléphone|telefono|telefon|mobile|portable|cell|móvil|cellulare/)) {
              fill(input, config.phone);
              log(`Phone filled: ${config.phone}`);
            }
            // City/Location (EN/FR/ES/DE/IT) - with autocomplete handling
            else if (label.match(/city|ville|ciudad|stadt|città|location|localisation|ubicación|standort/)) {
              fill(input, config.city || '');
              log(`Location filled: ${config.city}`);

              // Wait for autocomplete dropdown to appear
              await wait(1000);

              // Try multiple selectors for autocomplete dropdown
              let dropdown = null;
              const dropdownSelectors = [
                '[role="listbox"]',
                '.basic-typeahead__selectable',
                '.artdeco-typeahead__results',
                '.artdeco-dropdown__content-inner',
                'ul[role="listbox"]',
                '.typeahead-results'
              ];

              for (let selector of dropdownSelectors) {
                dropdown = document.querySelector(selector);
                if (dropdown && dropdown.offsetParent !== null) { // Visible
                  break;
                }
              }

              if (dropdown) {
                // Find first option
                const optionSelectors = [
                  '[role="option"]:first-child',
                  'li:first-child',
                  '.basic-typeahead__selectable-item:first-child'
                ];

                let firstOption = null;
                for (let selector of optionSelectors) {
                  firstOption = dropdown.querySelector(selector);
                  if (firstOption) break;
                }

                if (firstOption) {
                  firstOption.click();
                  log(`✓ Location autocomplete: ${firstOption.textContent.substring(0, 30)}`);
                  await wait(500);
                }
              } else {
                // Fallback: Keyboard navigation (Arrow Down + Enter)
                log('Using keyboard fallback for location');
                input.focus();
                await wait(300);
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
                await wait(500);
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                await wait(300);
              }
            }
          }

          // 2. FILE INPUTS (Resume/CV Upload) - SMART: Select existing or upload once
          // LinkedIn remembers previously uploaded CVs - we should select those instead of re-uploading

          // STEP 2a: First, try to select an existing/previously uploaded resume
          let resumeAlreadySelected = false;

          // Look for resume selection cards/radio buttons (LinkedIn shows previously uploaded resumes)
          const resumeSelectors = [
            // Radio buttons for resume selection
            'input[type="radio"][name*="resume"]',
            'input[type="radio"][name*="cv"]',
            'input[type="radio"][id*="resume"]',
            'input[type="radio"][id*="document"]',
            // Clickable resume cards
            '[data-test-document-upload-item]',
            '.jobs-document-upload-redesign-card',
            '.jobs-document-upload__container',
            '.document-upload-item',
            // Resume list items
            '[class*="resume-card"]',
            '[class*="document-card"]'
          ];

          for (let selector of resumeSelectors) {
            const resumeOptions = modal.querySelectorAll(selector);
            if (resumeOptions.length > 0) {
              // Find the first/most recent resume option
              for (let option of resumeOptions) {
                if (option.offsetParent !== null) { // Visible
                  // For radio buttons
                  if (option.type === 'radio') {
                    if (!option.checked) {
                      const label = modal.querySelector(`label[for="${option.id}"]`);
                      if (label) {
                        label.click();
                        log(`✅ Selected existing resume: ${label.textContent.substring(0, 40)}`);
                      } else {
                        option.click();
                        log(`✅ Selected existing resume (radio)`);
                      }
                      resumeAlreadySelected = true;
                      await wait(500);
                      break;
                    } else {
                      log(`✅ Resume already selected`);
                      resumeAlreadySelected = true;
                      break;
                    }
                  } else {
                    // For clickable cards - click if not already selected
                    const isSelected = option.classList.contains('selected') ||
                                      option.getAttribute('aria-selected') === 'true' ||
                                      option.querySelector('input[type="radio"]:checked');
                    if (!isSelected) {
                      option.click();
                      log(`✅ Selected existing resume card`);
                      resumeAlreadySelected = true;
                      await wait(500);
                      break;
                    } else {
                      log(`✅ Resume card already selected`);
                      resumeAlreadySelected = true;
                      break;
                    }
                  }
                }
              }
              if (resumeAlreadySelected) break;
            }
          }

          // STEP 2b: If no existing resume found/selected, upload new one (only once per session)
          if (!resumeAlreadySelected && resumeFile && resumeFileName && resumeFileType) {
            const fileInputs = modal.querySelectorAll('input[type="file"]');

            for (let fileInput of fileInputs) {
              // Check if already has a file
              if (fileInput.files && fileInput.files.length > 0) {
                log(`⏭️ File input already has file: ${fileInput.files[0].name}`);
                continue;
              }

              // Get label to understand what file is requested
              let labelText = '';
              labelText += ' ' + (fileInput.getAttribute('aria-label') || '');
              labelText += ' ' + (fileInput.getAttribute('name') || '');

              const inputId = fileInput.getAttribute('id');
              if (inputId) {
                const labelEl = modal.querySelector(`label[for="${inputId}"]`);
                if (labelEl) labelText += ' ' + labelEl.textContent;
              }

              const parentLabel = fileInput.closest('label');
              if (parentLabel) labelText += ' ' + parentLabel.textContent;

              const label = labelText.toLowerCase();

              // Check if it's asking for resume/CV (multilingual)
              const isResumeInput = label.match(/resume|cv|curriculum|vitae|upload.*document|file/);

              if (isResumeInput) {
                log(`📎 File input detected (no existing resume found): ${labelText.substring(0, 50)}`);

                // Convert base64 to File object
                const file = base64ToFile(resumeFile, resumeFileName, resumeFileType);

                if (file) {
                  const success = await fillFileInput(fileInput, file);

                  if (success) {
                    log(`✅ Resume uploaded successfully (first time upload)`);
                    await wait(500); // Wait for LinkedIn to process the upload
                  } else {
                    log(`⚠️ Failed to upload resume to file input`);
                  }
                } else {
                  log(`❌ Failed to convert resume to File object`);
                }
              } else {
                log(`⏭️ Skipping file input (not resume): ${labelText.substring(0, 50)}`);
              }
            }
          } else if (!resumeAlreadySelected && modal.querySelector('input[type="file"]')) {
            // File input found but no resume uploaded in extension
            const fileInputsCount = modal.querySelectorAll('input[type="file"]').length;
            log(`⚠️ ${fileInputsCount} file input(s) found but no resume uploaded in extension`);
            log(`   Upload your resume in the extension popup to auto-fill file uploads`);
          }

          // 3. CHECKBOXES (consent, terms, etc.)
          const checkboxes = modal.querySelectorAll('input[type="checkbox"]');
          for (let checkbox of checkboxes) {
            if (checkbox.id === 'follow-company-checkbox') continue; // Skip follow company (handled later)

            // Get associated label
            const checkboxLabel = modal.querySelector(`label[for="${checkbox.id}"]`);
            const labelText = checkboxLabel ? checkboxLabel.textContent.toLowerCase() : '';

            // Check for consent, terms, conditions, etc.
            if (labelText.match(/consent|agree|terms|conditions|policy|privacy|accept|j'accepte|j'autorise|consentement/)) {
              if (!checkbox.checked) {
                checkboxLabel ? checkboxLabel.click() : checkbox.click();
                log(`✓ Checkbox: ${labelText.substring(0, 40)}`);
                await wait(300);
              }
            }
          }

          // 4. RADIO BUTTONS (Python ligne 1037)
          const radios = modal.querySelectorAll('fieldset[data-test-form-builder-radio-button-form-component]');
          for (let fieldset of radios) {
            const questionLabel = fieldset.querySelector('legend, span[class*="title"]');
            const questionText = questionLabel ? questionLabel.textContent.toLowerCase() : '';

            const radioInputs = fieldset.querySelectorAll('input[type="radio"]');
            let answered = false;

            // SMART DETECTION: Check for specific questions and use user's configuration
            let desiredAnswer = 'yes'; // default

            // Visa sponsorship question
            if (questionText.match(/visa|sponsor|sponsorship/i) && config.visaSponsorship) {
              desiredAnswer = config.visaSponsorship;
              log(`⚙️ Visa question detected, answering: ${desiredAnswer}`);
            }
            // Work authorization question
            else if (questionText.match(/author|legal.*work|permit.*work|eligib.*work|right.*work/i) && config.legallyAuthorized) {
              desiredAnswer = config.legallyAuthorized;
              log(`⚙️ Work authorization question detected, answering: ${desiredAnswer}`);
            }
            // Relocation question
            else if (questionText.match(/relocat|move.*locat|willing.*move/i) && config.willingToRelocate) {
              desiredAnswer = config.willingToRelocate;
              log(`⚙️ Relocation question detected, answering: ${desiredAnswer}`);
            }
            // Security clearance question (always answer No)
            else if (questionText.match(/security.*clearance|clearance/i)) {
              desiredAnswer = 'no';
              log(`⚙️ Security clearance question detected, answering: no (default)`);
            }
            // Driver's license question
            else if (questionText.match(/driver.*license|driving.*license|valid.*license/i) && config.driversLicense) {
              desiredAnswer = config.driversLicense;
              log(`⚙️ Driver's license question detected, answering: ${desiredAnswer}`);
            }

            // Click the appropriate answer (Yes or No)
            for (let radio of radioInputs) {
              const radioLabel = fieldset.querySelector(`label[for="${radio.id}"]`);
              const radioText = radioLabel ? radioLabel.textContent.trim().toLowerCase() : '';

              // Match Yes/No in multiple languages
              const isYes = radioText.match(/^(yes|oui|sí|si|ja|y)$/);
              const isNo = radioText.match(/^(no|non|nein|n)$/);

              if ((desiredAnswer === 'yes' && isYes) || (desiredAnswer === 'no' && isNo)) {
                if (!radio.checked) {
                  radioLabel ? radioLabel.click() : radio.click();
                  log(`Radio ${desiredAnswer}: ${questionText.substring(0, 30)}`);
                  answered = true;
                }
                break;
              }
            }

            // If no specific answer found, look for "Yes" as default (backward compatibility)
            if (!answered) {
              for (let radio of radioInputs) {
                const radioLabel = fieldset.querySelector(`label[for="${radio.id}"]`);
                const radioText = radioLabel ? radioLabel.textContent.trim().toLowerCase() : '';

                // Yes in multiple languages: EN, FR, ES, DE, IT
                if (radioText.match(/^(yes|oui|sí|si|ja|y)$/)) {
                  if (!radio.checked) {
                    radioLabel ? radioLabel.click() : radio.click();
                    log(`Radio Yes (default): ${questionText.substring(0, 30)}`);
                    answered = true;
                  }
                  break;
                }
              }
            }

            // If still no answer, check first option as last resort
            if (!answered && radioInputs.length > 0 && !radioInputs[0].checked) {
              const firstLabel = fieldset.querySelector(`label[for="${radioInputs[0].id}"]`);
              firstLabel ? firstLabel.click() : radioInputs[0].click();
              log(`Radio first option: ${questionText.substring(0, 30)}`);
            }
          }

          // 5. DROPDOWN/SELECT (Python ligne 661)
          const selects = modal.querySelectorAll('select');
          for (let select of selects) {
            if (select.selectedIndex > 0) continue; // Skip si déjà sélectionné

            // Get label from multiple sources
            let labelText = '';
            labelText += ' ' + (select.getAttribute('aria-label') || '');
            labelText += ' ' + (select.getAttribute('name') || '');
            const selectId = select.getAttribute('id');
            if (selectId) {
              const labelEl = modal.querySelector(`label[for="${selectId}"]`);
              if (labelEl) labelText += ' ' + labelEl.textContent;
            }
            const parentLabel = select.closest('label');
            if (parentLabel) labelText += ' ' + parentLabel.textContent;

            const label = labelText.toLowerCase();
            const options = Array.from(select.options);

            // Essayer de trouver une option intelligente
            let selectedOption = null;

            // Language proficiency questions (English, French, Spanish, etc.)
            // "What is your level of proficiency in English?"
            if (label.match(/proficiency|level.*english|level.*french|level.*spanish|level.*german|niveau.*anglais|niveau.*français|nivel.*inglés/)) {
              // Priority order: Native > Fluent > Professional > Intermediate
              selectedOption = options.find(opt => {
                const text = opt.text.toLowerCase();
                return text.includes('native') || text.includes('bilingual') || text.includes('bilingue') || text.includes('langue maternelle');
              });

              if (!selectedOption) {
                selectedOption = options.find(opt => {
                  const text = opt.text.toLowerCase();
                  return text.includes('fluent') || text.includes('courant') || text.includes('fluide');
                });
              }

              if (!selectedOption) {
                selectedOption = options.find(opt => {
                  const text = opt.text.toLowerCase();
                  return text.includes('professional') || text.includes('professionnel') || text.includes('advanced');
                });
              }

              log(`Dropdown language proficiency: ${selectedOption ? selectedOption.text : 'fallback'}`);
            }
            // General language questions
            else if (label.match(/english|anglais|language|langue|french|français|spanish|español|german|deutsch/)) {
              selectedOption = options.find(opt => {
                const text = opt.text.toLowerCase();
                return text.includes('native') || text.includes('bilingual') || text.includes('fluent') ||
                       text.includes('courant') || text.includes('professionnel') || text.includes('bilingue');
              });
              log(`Dropdown language: ${selectedOption ? selectedOption.text : 'fallback'}`);
            }

            // Si pas trouvé, prendre option 1 (pas 0 car souvent "Select...")
            if (!selectedOption && options.length > 1) {
              selectedOption = options[1];
            }

            if (selectedOption) {
              select.value = selectedOption.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }

          // 6. DROPDOWN CUSTOM LINKEDIN (Python ligne 668)
          const customDropdowns = modal.querySelectorAll('button[aria-haspopup="listbox"], button.artdeco-dropdown__trigger');
          for (let dropdown of customDropdowns) {
            // Get label/question text for smart selection
            let questionText = '';
            questionText += ' ' + (dropdown.getAttribute('aria-label') || '');
            questionText += ' ' + (dropdown.textContent || '');

            // Look for associated label
            const dropdownId = dropdown.getAttribute('id');
            if (dropdownId) {
              const labelEl = modal.querySelector(`label[for="${dropdownId}"]`);
              if (labelEl) questionText += ' ' + labelEl.textContent;
            }
            const parentDiv = dropdown.closest('div[class*="form-component"]');
            if (parentDiv) {
              const label = parentDiv.querySelector('label, legend, span[class*="label"]');
              if (label) questionText += ' ' + label.textContent;
            }

            const question = questionText.toLowerCase();

            // Cliquer pour ouvrir
            dropdown.click();
            await wait(500);

            // Chercher les options
            const listbox = document.querySelector('[role="listbox"]');
            if (listbox) {
              const options = Array.from(listbox.querySelectorAll('[role="option"]'));
              if (options.length > 0) {
                let selectedOption = null;

                // Language proficiency questions
                if (question.match(/proficiency|level.*english|level.*french|level.*spanish|niveau.*anglais|nivel.*inglés/)) {
                  // Try: Native/Bilingual first
                  selectedOption = options.find(opt => {
                    const text = opt.textContent.toLowerCase();
                    return text.includes('native') || text.includes('bilingual') || text.includes('bilingue');
                  });

                  // Then: Fluent
                  if (!selectedOption) {
                    selectedOption = options.find(opt => {
                      const text = opt.textContent.toLowerCase();
                      return text.includes('fluent') || text.includes('courant');
                    });
                  }

                  // Then: Professional
                  if (!selectedOption) {
                    selectedOption = options.find(opt => {
                      const text = opt.textContent.toLowerCase();
                      return text.includes('professional') || text.includes('professionnel') || text.includes('advanced');
                    });
                  }

                  log(`Custom dropdown language: ${selectedOption ? selectedOption.textContent.substring(0, 30) : 'fallback'}`);
                }

                // If no smart match, take first valid option (not "Select...")
                if (!selectedOption) {
                  selectedOption = options.find(opt =>
                    !opt.textContent.toLowerCase().includes('select') &&
                    !opt.textContent.toLowerCase().includes('choose') &&
                    !opt.textContent.toLowerCase().includes('choisir')
                  );
                }

                if (selectedOption) {
                  selectedOption.click();
                  log(`Dropdown custom: ${selectedOption.textContent.substring(0, 30)}`);
                  await wait(300);
                }
              }
            }
          }

          await wait(1500);

          // Chercher bouton Next ou Submit
          const nextBtn = Array.from(modal.querySelectorAll('button')).find(btn => {
            const text = btn.textContent.toLowerCase();
            return text.includes('next') || text.includes('suivant') ||
                   text.includes('review') || text.includes('submit') || text.includes('soumettre');
          });

          if (!nextBtn) {
            log('Pas de bouton trouvé');
            break;
          }

          const isSubmit = nextBtn.textContent.toLowerCase().includes('submit') ||
                          nextBtn.textContent.toLowerCase().includes('soumettre');

          // IMPORTANT: Unfollow AVANT de cliquer Submit (Python ligne 1974)
          if (isSubmit) {
            log('Avant Submit: unfollow entreprise...');

            // Scroll vers le bas de la modale pour voir la checkbox
            nextBtn.scrollIntoView({ block: 'end', behavior: 'smooth' });
            await wait(800);

            // Chercher checkbox Follow company (Python ligne 1319)
            const followCheckbox = modal.querySelector('input[id="follow-company-checkbox"]') ||
                                  modal.querySelector('input[id*="follow-company"][type="checkbox"]');

            if (followCheckbox && followCheckbox.checked) {
              // Scroll vers la checkbox
              followCheckbox.scrollIntoView({ block: 'center', behavior: 'smooth' });
              await wait(500);

              // Cliquer sur le label (Python ligne 1321)
              const label = modal.querySelector(`label[for="${followCheckbox.id}"]`);
              if (label) {
                await click(label);
                log('✅ Entreprise UNFOLLOWED');
              } else {
                followCheckbox.click();
                log('✅ Entreprise UNFOLLOWED (fallback)');
              }
            } else {
              log('Checkbox Follow déjà décochée ou non trouvée');
            }

            await wait(500);
          }

          // Vérifier que le bouton n'est pas disabled
          if (nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') {
            log('⚠️ Button disabled, checking for stuck scenario...');

            // If button stays disabled for too long = stuck
            if (step > 2) {
              log('❌ STUCK: Button remains disabled after multiple attempts');
              log('⚠️ Probably validation error - DISCARDING');

              await discardApplication();
              skippedCount++;
              updateSkippedCount();
              break;
            }

            await wait(1000);
            continue;
          }

          await click(nextBtn);

          // Attendre que la page change
          await wait(1000); // Optimized page change wait

          // Vérifier si vraiment passé à l'étape suivante
          const stillSameModal = document.querySelector('.jobs-easy-apply-modal');
          if (stillSameModal && !isSubmit) {
            // Vérifier si une erreur est affichée (validation failed)
            const errorMessages = [
              '[role="alert"]',
              '.artdeco-inline-feedback--error',
              '.fb-form-element-label__error'
            ];

            for (let selector of errorMessages) {
              const errors = stillSameModal.querySelectorAll(selector);
              for (let error of errors) {
                if (error.offsetParent !== null) { // Visible
                  const errorText = error.textContent.toLowerCase();

                  // Check for validation errors
                  if (errorText.includes('please enter') ||
                      errorText.includes('valid answer') ||
                      errorText.includes('required') ||
                      errorText.includes('must be') ||
                      errorText.includes('invalid') ||
                      errorText.includes('veuillez') ||
                      errorText.includes('requis')) {

                    log(`❌ VALIDATION ERROR: ${error.textContent.substring(0, 60)}`);
                    log('⚠️ Cannot fix validation error - DISCARDING application');

                    await discardApplication();
                    skippedCount++;
                    updateSkippedCount();

                    // Break out of step loop
                    step = 999;
                    break;
                  }
                }
              }
              if (step === 999) break;
            }

            // If we're discarding, break out
            if (step === 999) break;
          }

          if (isSubmit) {
            log('✅ Submit cliqué !');
            appliedCount++;

            // Sauvegarder le job appliqué pour export
            appliedJobs.push({
              title: jobTitle,
              company: jobCompany,
              link: jobLink,
              date: new Date().toISOString()
            });
            updateAppliedCount();
            saveAppliedJobsToStorage();

            // OPTIMIZED: Check modal status immediately after Submit
            log('🔍 Checking if modal closed after Submit...');
            await wait(1000); // Short wait to let page process

            // OPTIMIZATION: Check if modal already closed (means application is complete)
            let modalCheck = document.querySelector('.jobs-easy-apply-modal, [role="dialog"], .artdeco-modal');
            if (!modalCheck || modalCheck.offsetParent === null) {
              log('✅ Modal closed immediately - Application completed!');
              updateActivity();

              // Skip all waiting - application is done
              log('--- End of job processing, moving to next ---');
              await wait(500); // Ultra optimized wait before next job
              break;
            }

            // Modal still open - need to find Done button
            log('⏳ Modal still open, searching for Done button...');
            await wait(1000); // Optimized Done button wait

            // Use improved Done button finder
            const result = await findAndClickDoneButton(document, 'Main Modal', 15);

            if (!result.clicked) {
              log('⚠️ Done button not found, checking modal status...');
              const modal = document.querySelector('.jobs-easy-apply-modal');
              if (modal && modal.offsetParent !== null) {
                log('⚠️ Modal still open, trying to close it...');
                await discardApplication();
              } else {
                log('✅ Modal closed during search');
              }
            }

            // Final check: is there an "Application sent" modal?
            await wait(1500);
            let sentModal = document.querySelector('.jobs-easy-apply-modal, [role="dialog"], .artdeco-modal');
            if (sentModal && sentModal.offsetParent !== null) {
              log('📨 "Application sent" modal detected, clicking Done...');
              const sentResult = await findAndClickDoneButton(sentModal, 'Application Sent Modal', 8);

              if (!sentResult.clicked) {
                log('⚠️ Done button not found in sent modal, forcing discard');
                await discardApplication();
              }
            }

            // Application completed
            log('✅ Application completed, moving to next job');
            log('--- End of job processing ---');
            await wait(500); // Ultra optimized wait before next job
            break;
          }
        }
      }

      // Check if bot was stopped during job processing (e.g., daily limit reached)
      if (!isRunning) {
        log('🛑 Bot stopped during job processing - Exiting main loop');
        break; // Exit the while loop
      }

      // Page suivante (Python ligne 2047) - IMPROVED WITH FALLBACKS
      log('🔍 Recherche page suivante...');
      let nextPageClicked = false;

      // COLLECTIONS PAGE: Use infinite scroll instead of pagination
      if (isCollectionsPage) {
        log('📜 Collections page - using infinite scroll');

        // Get the job list container
        const jobListContainer = document.querySelector('.jobs-search-results-list, .scaffold-layout__list-container, .jobs-search-results__list');

        if (jobListContainer) {
          const currentJobCount = jobCards.length;

          // Scroll to bottom to trigger loading more jobs
          jobListContainer.scrollTo({ top: jobListContainer.scrollHeight, behavior: 'smooth' });
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

          log('📜 Scrolled down to load more jobs...');
          await wait(2000);

          // Check if new jobs were loaded
          const newJobCount = document.querySelectorAll('li[data-occludable-job-id], .jobs-search-results__list-item, .scaffold-layout__list-item').length;

          if (newJobCount > currentJobCount) {
            log(`✅ Loaded ${newJobCount - currentJobCount} more jobs (total: ${newJobCount})`);
            nextPageClicked = true;
          } else {
            log('📋 No more jobs to load (reached end of collection)');
          }
        }
      }

      // SEARCH PAGE: Use standard pagination
      // METHOD 1: Try pagination by page number
      const pagination = document.querySelector('.jobs-search-pagination__pages');
      if (!nextPageClicked) {
        if (pagination) {
          const activeBtn = pagination.querySelector('button.active, button[aria-current="true"], li.active button, li.selected button');
          if (activeBtn) {
            const currentPage = parseInt(activeBtn.textContent);
            log(`📄 Page actuelle: ${currentPage}`);

            // Try to find next page button
            const nextPageBtn = pagination.querySelector(`button[aria-label="Page ${currentPage + 1}"]`) ||
                               pagination.querySelector(`button[data-test-pagination-page-btn="${currentPage + 1}"]`);

            if (nextPageBtn && nextPageBtn.offsetParent !== null) {
              log(`✅ Clique sur page ${currentPage + 1}`);
              await click(nextPageBtn);
              await wait(1000); // Ultra optimized page load wait
              nextPageClicked = true;
            }
          }
        }
      }

      // METHOD 2: Try "Next" button (fallback)
      if (!nextPageClicked) {
        log('🔍 Recherche bouton "Next"...');
        const nextButtons = Array.from(document.querySelectorAll('button, [role="button"]'));

        for (let btn of nextButtons) {
          if (!btn.offsetParent) continue; // Skip hidden

          const btnText = btn.textContent.trim().toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

          // Check for "Next" in multiple languages
          if (btnText === 'next' || btnText === 'suivant' || btnText === 'siguiente' ||
              ariaLabel.includes('next') || ariaLabel.includes('suivant')) {

            // Make sure it's the pagination next, not a form next
            const isPaginationNext = btn.closest('.jobs-search-pagination') ||
                                    btn.closest('[class*="pagination"]') ||
                                    btn.getAttribute('aria-label')?.includes('page');

            if (isPaginationNext) {
              log('✅ Clique sur bouton Next');
              await click(btn);
              await wait(1000); // Ultra optimized page load wait
              nextPageClicked = true;
              break;
            }
          }
        }
      }

      // METHOD 3: Try icon-based next button (LinkedIn uses icons)
      if (!nextPageClicked) {
        const iconNextBtn = document.querySelector('.jobs-search-pagination button[aria-label*="Next"], .jobs-search-pagination button svg[class*="chevron-right"]')?.closest('button');
        if (iconNextBtn && iconNextBtn.offsetParent !== null && !iconNextBtn.disabled) {
          log('✅ Clique sur bouton Next (icône)');
          await click(iconNextBtn);
          await wait(1000); // Ultra optimized page load wait
          nextPageClicked = true;
        }
      }

      if (nextPageClicked) {
        log('✅ Passage à la page suivante réussi');
        continue;
      } else {
        log('📋 Fin des pages - Aucune page suivante trouvée');
        break;
      }

    } catch (error) {
      log(`Erreur: ${error.message}`);
      await wait(1500); // Optimized error wait
    }
  }

  log('Arrêt');
}

// Vérifier si le job contient des mots blacklistés
function shouldSkipByBlacklist(title, company, description, blacklistKeywords) {
  if (!blacklistKeywords || blacklistKeywords.trim() === '') return false;

  // Parse keywords (comma-separated)
  const keywords = blacklistKeywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);
  if (keywords.length === 0) return false;

  // Combine all job text
  const jobText = (title + ' ' + company + ' ' + description).toLowerCase();

  // Check each keyword
  for (let keyword of keywords) {
    if (jobText.includes(keyword)) {
      log(`⏭️ Skip (Blacklist): "${keyword}" found in job`);
      log(`   Title: ${title.substring(0, 50)}`);
      return true;
    }
  }

  return false;
}

// Extraire années d'expérience requises du texte (multilingue)
function extractYearsRequired(text) {
  if (!text) return 0;

  const lowerText = text.toLowerCase();

  // Patterns multilingues pour années d'expérience
  const patterns = [
    // English: "5+ years", "5-8 years", "5 years"
    /(\d+)\+?\s*(?:years?|yrs?)/gi,
    // French: "5 ans", "5+ ans", "5 années"
    /(\d+)\+?\s*(?:ans?|années?)/gi,
    // Spanish: "5 años"
    /(\d+)\+?\s*años?/gi,
    // German: "5 Jahre"
    /(\d+)\+?\s*jahre?/gi,
    // Italian: "5 anni"
    /(\d+)\+?\s*anni?/gi
  ];

  const years = [];
  patterns.forEach(pattern => {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const num = parseInt(match[1]);
      if (num > 0 && num <= 20) years.push(num);
    }
  });

  return years.length > 0 ? Math.max(...years) : 0;
}

// Vérifier si le job doit être skippé selon années requises
function shouldSkipByExperience(jobCard, maxYearsRequired) {
  if (!maxYearsRequired || maxYearsRequired <= 0) return false;

  try {
    // Chercher dans le titre et la description visible
    const title = jobCard.querySelector('.job-card-list__title, .artdeco-entity-lockup__title')?.textContent || '';
    const subtitle = jobCard.querySelector('.job-card-container__metadata-item')?.textContent || '';
    const combinedText = title + ' ' + subtitle;

    const yearsRequired = extractYearsRequired(combinedText);

    if (yearsRequired > 0 && yearsRequired > maxYearsRequired) {
      log(`⏭️ Skip: ${yearsRequired}+ years required (max: ${maxYearsRequired})`);
      return true;
    }
  } catch (error) {
    // Si erreur, ne pas skipper
  }

  return false;
}

// Fonction pour détecter si la page charge lentement (Python ligne 1440-1479)
async function isPageLoadingSlow() {
  try {
    // Check document readyState (Python ligne 1446)
    if (document.readyState !== 'complete') {
      log(`⏳ Page still loading (readyState: ${document.readyState})`);
      return true;
    }

    // Chercher des spinners/loaders visibles (Python ligne 1517-1528)
    const spinners = document.querySelectorAll('[role="progressbar"], .artdeco-loader, .loading-spinner, .spinner, .loading');
    for (let spinner of spinners) {
      if (spinner.offsetParent !== null) { // Visible
        return true;
      }
    }

    // Vérifier si la modal est visible (Python ligne 1466-1469)
    const modal = document.querySelector('.jobs-easy-apply-modal');
    if (!modal || !modal.offsetParent) {
      return true; // Modal pas visible = en chargement
    }

    return false;
  } catch (error) {
    return true; // Assume slow loading on error (Python ligne 1477)
  }
}

// Fonction pour détecter si popup de chargement est BLOQUÉ (Python ligne 1513-1545)
function checkForStuckLoadingPopup() {
  try {
    // Chercher les spinners/loaders de LinkedIn (Python ligne 1517-1528)
    const loadingIndicators = document.querySelectorAll(
      '.artdeco-loader, .loading, .spinner, [role="progressbar"]'
    );

    if (loadingIndicators.length > 0) {
      for (let indicator of loadingIndicators) {
        if (indicator.offsetParent !== null) { // Visible
          log('⚠️ POPUP DE CHARGEMENT DÉTECTÉ ET VISIBLE!');
          return true;
        }
      }
    }

    // Vérifier aussi si le modal est figé (pas de boutons cliquables) (Python ligne 1531-1540)
    const modal = document.querySelector('.jobs-easy-apply-modal');
    if (modal && modal.offsetParent !== null) {
      const buttons = modal.querySelectorAll('button');
      const clickableButtons = Array.from(buttons).filter(b =>
        !b.disabled && b.offsetParent !== null
      );

      if (clickableButtons.length === 0) {
        log('⚠️ MODAL FIGÉ DÉTECTÉ (aucun bouton cliquable)!');
        return true;
      }
    }

    return false;
  } catch (error) {
    log(`⚠️ Erreur lors de la vérification du popup: ${error.message}`);
    return false;
  }
}

// Mettre à jour le compteur appliqués
function updateAppliedCount() {
  chrome.storage.local.set({ appliedCount: appliedCount });
  try {
    chrome.runtime.sendMessage({ type: 'updateCount', count: appliedCount });
  } catch (e) {}
}

// Mettre à jour le compteur skipped
function updateSkippedCount() {
  chrome.storage.local.set({ skippedCount: skippedCount });
  try {
    chrome.runtime.sendMessage({ type: 'updateSkippedCount', count: skippedCount });
  } catch (e) {}
}

// Sauvegarder les jobs appliqués dans le storage
function saveAppliedJobsToStorage() {
  chrome.storage.local.set({ appliedJobs: appliedJobs });
}

// Écouter les messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle async operations properly
  (async () => {
    try {
      if (request.action === 'start') {
        config = await chrome.storage.sync.get([
          'firstName', 'lastName', 'email', 'phone', 'phoneCountryCode',
          'yearsOfExperience', 'maxYearsRequired', 'blacklistKeywords', 'city', 'country', 'expectedSalary',
          'visaSponsorship', 'legallyAuthorized', 'willingToRelocate', 'driversLicense'
        ]);

        // Charger les compteurs depuis storage
        const local = await chrome.storage.local.get(['appliedCount', 'skippedCount', 'appliedJobs', 'resumeFile', 'resumeFileName', 'resumeFileType']);
        appliedCount = local.appliedCount || 0;
        skippedCount = local.skippedCount || 0;
        appliedJobs = local.appliedJobs || [];

        // Load resume data if available
        resumeFile = local.resumeFile || null;
        resumeFileName = local.resumeFileName || null;
        resumeFileType = local.resumeFileType || null;

        if (resumeFile) {
          log(`📄 Resume loaded: ${resumeFileName}`);
        } else {
          log('ℹ️ No resume uploaded - file upload fields will be skipped');
        }

        log(`Config: ${config.firstName} ${config.lastName}, exp: ${config.yearsOfExperience || 2}, max required: ${config.maxYearsRequired || 3}`);
        log(`Counters: Applied ${appliedCount}, Skipped ${skippedCount}`);

        // SECURITY: Set both protection flags
        isRunning = true;
        userExplicitlyClickedStart = true; // CRITICAL: Only set when user clicks Start

        log('✅ Bot started by USER');
        log('🔒 Security flags set: isRunning=true, userExplicitlyClickedStart=true');

        // Update storage
        await chrome.storage.local.set({ isRunning: true });

        // Send response before starting main loop
        sendResponse({ success: true, message: 'Bot started' });

        // Notify popup that bot has started
        try {
          chrome.runtime.sendMessage({ type: 'botStarted' });
        } catch (e) {
          // Popup may be closed
        }

        // Start main loop (don't await - let it run in background)
        mainLoop();
      } else if (request.action === 'stop') {
        isRunning = false;
        userExplicitlyClickedStart = false; // Clear security flag
        log('⏸️ Bot stopped by user');
        log('🔒 Security flags cleared: isRunning=false, userExplicitlyClickedStart=false');

        // Update storage
        await chrome.storage.local.set({ isRunning: false });

        sendResponse({ success: true, message: 'Bot stopped' });

        // Notify popup that bot has stopped
        try {
          chrome.runtime.sendMessage({ type: 'botStopped' });
        } catch (e) {
          // Popup may be closed
        }
      } else if (request.action === 'exportJobs') {
        // Exporter les jobs en CSV
        sendResponse({ jobs: appliedJobs });
      } else if (request.action === 'resetCounters') {
        appliedCount = 0;
        skippedCount = 0;
        appliedJobs = [];
        await chrome.storage.local.set({ appliedCount: 0, skippedCount: 0, appliedJobs: [] });
        updateAppliedCount();
        updateSkippedCount();
        sendResponse({ success: true, message: 'Counters reset' });
      } else if (request.action === 'clearAppliedJobs') {
        appliedJobs = [];
        await chrome.storage.local.set({ appliedJobs: [] });
        log('🗑️ Applied jobs list cleared');
        sendResponse({ success: true, message: 'Applied jobs cleared' });
      }
    } catch (error) {
      log(`❌ Message handler error: ${error.message}`);
      sendResponse({ success: false, error: error.message });
    }
  })();

  // Return true to indicate we will send a response asynchronously
  return true;
});

console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0a66c2; font-weight: bold;');
console.log('%c🔒 EASYAPPLYMAX v1.5.0 - MANUAL INJECTION MODE', 'color: #0a66c2; font-weight: bold; font-size: 16px;');
console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0a66c2; font-weight: bold;');
console.log('%c✅ Script injected ONLY when you clicked START', 'color: green; font-weight: bold;');
console.log('%c🔒 NO automatic loading on LinkedIn pages', 'color: green; font-weight: bold;');
console.log('%c🚀 Bot will start automatically after injection', 'color: orange; font-weight: bold;');
console.log('%c📋 Supports: /jobs/search/ AND /jobs/collections/', 'color: cyan; font-weight: bold;');
console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0a66c2; font-weight: bold;');
log('Script loaded v1.5.0 - Supports /jobs/search/ and /jobs/collections/');

// SECURITY: Clear ALL running state on page load to prevent auto-start
// Bot will ONLY start when user explicitly clicks "Start" button
(async () => {
  try {
    // CRITICAL: Clear ALL security flags
    isRunning = false;
    userExplicitlyClickedStart = false;

    // PURGE: Clean any residual running state from storage
    await chrome.storage.local.set({ isRunning: false });

    // Load counters and state for display only (don't start bot)
    const state = await chrome.storage.local.get(['appliedCount', 'skippedCount', 'appliedJobs']);
    appliedCount = state.appliedCount || 0;
    skippedCount = state.skippedCount || 0;
    appliedJobs = state.appliedJobs || [];

    console.log('%c⏸️ BOT STATUS: STOPPED (Waiting for START button)', 'background: #ff9800; color: white; font-weight: bold; padding: 4px 8px; border-radius: 3px;');
    log('ℹ️ Content script loaded - Bot ready (NOT running)');
    log('🔒 Security initialized: isRunning=false, userExplicitlyClickedStart=false');
    log(`📊 Current stats: Applied ${appliedCount}, Skipped ${skippedCount}`);
    log('⏸️ Waiting for user to click START button...');
    console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0a66c2; font-weight: bold;');
    console.log('%c⚠️ IF YOU SEE ANY CLICKS WITHOUT CLICKING START:', 'color: red; font-weight: bold;');
    console.log('%c   Check console for 🚨 SECURITY VIOLATION errors', 'color: red; font-weight: bold;');
    console.log('%c   These will show WHERE the unauthorized click came from', 'color: red; font-weight: bold;');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (error) {
    log(`⚠️ Initialization error: ${error.message}`);
  }
})();
