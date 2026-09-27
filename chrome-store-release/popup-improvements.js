// ==========================================
// AMÉLIORATIONS POPUP - v1.3.0
// Toast notifications, Validation, Onboarding
// ==========================================

// ==========================================
// TOAST NOTIFICATIONS (remplace les alerts)
// ==========================================

let toastContainer = null;

// Line icons (dashboard style) — the popup never uses emoji (Théo 2026-09-26).
const UI_ICON = {
  close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
  alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
};
window.UI_ICON = UI_ICON;

// Class-based toast styled by popup.css (#toast-container / .toast-*).
function showToast(message, type = 'info', duration = 4000) {
  if (!toastContainer || !document.body.contains(toastContainer)) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastContainer);
  }
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const dot = document.createElement('span');
  dot.className = 'toast-dot';
  const msg = document.createElement('div');
  msg.className = 'toast-message';
  msg.textContent = message; // textContent: no XSS
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = UI_ICON.close;
  close.addEventListener('click', () => toast.remove());
  toast.append(dot, msg, close);
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// ==========================================
// VALIDATION DES CHAMPS
// ==========================================

const validators = {
  email: {
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: 'Please enter a valid email address'
  },
  phone: {
    pattern: /^[0-9]{7,15}$/,
    message: 'Phone must be 7-15 digits only'
  },
  firstName: {
    pattern: /^[a-zA-ZÀ-ÿ\s'-]{2,50}$/,
    message: 'First name must be 2-50 characters'
  },
  lastName: {
    pattern: /^[a-zA-ZÀ-ÿ\s'-]{2,50}$/,
    message: 'Last name must be 2-50 characters'
  },
  yearsOfExperience: {
    validate: (value) => {
      const num = parseInt(value);
      return num >= 0 && num <= 50;
    },
    message: 'Years of experience must be between 0 and 50'
  }
};

function validateField(fieldId) {
  const field = document.getElementById(fieldId);
  if (!field) return true;

  const value = field.value.trim();

  // Skip validation if field is empty and not required
  if (!value && !field.hasAttribute('required')) {
    clearFieldError(fieldId);
    return true;
  }

  const validator = validators[fieldId];
  if (!validator) return true;

  let isValid = false;

  if (validator.pattern) {
    isValid = validator.pattern.test(value);
  } else if (validator.validate) {
    isValid = validator.validate(value);
  }

  if (!isValid) {
    showFieldError(fieldId, validator.message);
    return false;
  } else {
    clearFieldError(fieldId);
    return true;
  }
}

function showFieldError(fieldId, message) {
  const field = document.getElementById(fieldId);
  if (!field) return;

  // Add error class to field
  field.style.borderColor = '#ef4444';
  field.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.1)';

  // Find or create error message element
  let errorMsg = field.parentElement.querySelector('.field-error');
  if (!errorMsg) {
    errorMsg = document.createElement('div');
    errorMsg.className = 'field-error';
    errorMsg.style.cssText = `
      color: #ef4444;
      font-size: 12px;
      margin-top: 4px;
      display: flex;
      align-items: center;
      gap: 4px;
    `;
    field.parentElement.appendChild(errorMsg);
  }

  errorMsg.textContent = '';
  const warnIcon = document.createElement('span');
  warnIcon.style.display = 'inline-flex';
  warnIcon.innerHTML = UI_ICON.alert;
  errorMsg.appendChild(warnIcon);
  errorMsg.appendChild(document.createTextNode(' ' + message));
}

function clearFieldError(fieldId) {
  const field = document.getElementById(fieldId);
  if (!field) return;

  // Remove error styling
  field.style.borderColor = '';
  field.style.boxShadow = '';

  // Remove error message
  const errorMsg = field.parentElement.querySelector('.field-error');
  if (errorMsg) {
    errorMsg.remove();
  }
}

function validateAllFields() {
  const fieldsToValidate = ['email', 'phone', 'firstName', 'lastName', 'yearsOfExperience'];
  const requiredFields = ['firstName', 'lastName', 'email'];
  let allValid = true;

  // Check required fields are filled
  requiredFields.forEach(fieldId => {
    const field = document.getElementById(fieldId);
    if (field && !field.value.trim()) {
      showFieldError(fieldId, 'This field is required');
      allValid = false;
    }
  });

  fieldsToValidate.forEach(fieldId => {
    if (!validateField(fieldId)) {
      allValid = false;
    }
  });

  return allValid;
}

// Setup validation listeners
function setupValidation() {
  const fieldsToValidate = ['email', 'phone', 'firstName', 'lastName', 'yearsOfExperience'];

  fieldsToValidate.forEach(fieldId => {
    const field = document.getElementById(fieldId);
    if (field) {
      // Validate on blur
      field.addEventListener('blur', () => {
        validateField(fieldId);
      });

      // Clear error on focus
      field.addEventListener('focus', () => {
        const errorMsg = field.parentElement.querySelector('.field-error');
        if (errorMsg) {
          field.style.borderColor = '';
          field.style.boxShadow = '';
        }
      });
    }
  });
}

// ==========================================
// ONBOARDING - PREMIÈRE UTILISATION
// ==========================================

// First-run flow, 3 steps: connect account → check profile/CV → open LinkedIn
// Easy Apply search. Each step opens a tab (which closes the popup), so the
// current step is saved in chrome.storage.local.onboardingStep and the flow
// resumes where the user left it the next time the popup opens.
const OB_URL = 'https://www.autoapplymax.com';
const OB_STEPS = [
  {
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    title: 'Create your free account',
    text: 'Optional, but recommended: your applications, CV and AI credits stay in sync between this extension and your dashboard.',
    points: ['Every application tracked on your dashboard', 'A CV tailored to each job with AI', 'Your info pre-filled from your account'],
    primary: { label: 'Sign up free', url: '/auth.html?mode=signup&src=ext_onboarding' },
    secondary: { label: 'I already have an account — sign in', url: '/auth.html?src=ext_onboarding' },
    later: 'Continue without an account',
    doneWhenSignedIn: 'You\'re signed in',
  },
  {
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    title: 'Fill in your info',
    text: 'Auto-apply answers each application with these details. The more complete they are, the fewer applications get skipped.',
    points: ['Name, email, phone and city', 'Years of experience and expected salary', 'Work authorization, notice period, relocation'],
    primary: { label: 'Fill my info', action: 'personal' },
    secondary: { label: 'Review my full profile on the dashboard', url: '/dashboard.html#smart-profile' },
  },
  {
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l14 8-14 8V4z"/></svg>',
    title: 'Start auto-applying',
    text: 'Open LinkedIn jobs with the Easy Apply filter, then open this extension and click <b>Start auto-apply</b>.',
    note: '<b>Applying on another site?</b> Open the application form and click <b>Autofill this form</b> — the extension fills it, you review and submit. Click <b>?</b> at the top any time for a refresher.',
    primary: { label: 'Find Easy Apply jobs on LinkedIn', linkedin: true, finish: true },
    secondary: { label: 'Finish — I\'ll open LinkedIn later', finishOnly: true },
  },
];

async function checkOnboarding() {
  const { onboardingCompleted, onboardingStep } = await chrome.storage.local.get(['onboardingCompleted', 'onboardingStep']);
  if (onboardingCompleted) return;
  // Signed-in users (came through the website onboarding) start at step 2
  // instead of being blocked on "connect your account".
  const { eam_session } = await chrome.storage.local.get(['eam_session']);
  const signedIn = !!(eam_session && eam_session.access_token);
  let step = Number(onboardingStep) || 0;
  if (signedIn && step < 1) step = 1;
  showOnboarding(step, signedIn);
}

function showOnboarding(startStep = 0, signedIn = false) {
  let step = Math.max(0, Math.min(OB_STEPS.length - 1, startStep));
  const overlay = document.createElement('div');
  overlay.id = 'onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Get started with AutoApplyMax');
  document.body.appendChild(overlay);

  const openUrl = (url, external) => {
    const full = external ? url : OB_URL + url;
    try { chrome.tabs.create({ url: full }); } catch (_) { window.open(full, '_blank'); }
  };
  const saveStep = (n) => { try { chrome.storage.local.set({ onboardingStep: n }); } catch (_) {} };

  async function finish() {
    try { await chrome.storage.local.set({ onboardingCompleted: true, onboardingStep: OB_STEPS.length }); } catch (_) {}
    overlay.remove();
  }

  // Step 2: go straight to "Your info" (pre-filled from the account when
  // signed in); the flow resumes on "Start auto-applying" at the next open.
  async function goFillInfo() {
    step = 2; saveStep(step);
    overlay.remove();
    document.querySelector('[data-tab="personal"]')?.click();
    try {
      if (signedIn && window.prefillFromAccountFromSession) await window.prefillFromAccountFromSession();
    } catch (_) {}
    const first = ['firstName', 'lastName', 'email', 'phone', 'city'].map(id => document.getElementById(id)).find(el => el && !el.value.trim());
    (first || document.getElementById('firstName'))?.focus();
    try { showToast('Fill in your info — it saves automatically. Reopen the extension to finish setup.', 'info', 5000); } catch (_) {}
  }

  function render() {
    const s = OB_STEPS[step];
    const progress = OB_STEPS.map((_, i) => '<span class="' + (i <= step ? 'done' : '') + '"></span>').join('');
    const points = s.points ? '<ul class="ob-points">' + s.points.map(p => '<li>' + p + '</li>').join('') + '</ul>' : '';
    const note = s.note ? '<div class="ob-note">' + s.note + '</div>' : '';
    const done = (step === 0 && signedIn) ? '<div class="ob-done">' + UI_ICON.check + ' ' + s.doneWhenSignedIn + '</div>' : '';
    const primaryLabel = (step === 0 && signedIn) ? 'Continue' : s.primary.label;
    overlay.innerHTML =
      '<div class="ob-top">' +
        '<span class="logo"><img src="icons/icon48.png" alt="" width="28" height="28"><span class="wordmark">AutoApplyMax</span></span>' +
        '<button type="button" class="ob-skip" id="close-onboarding">Skip setup</button>' +
      '</div>' +
      '<div class="ob-body">' +
        '<div class="ob-progress">' + progress + '</div>' +
        '<div class="ob-step-count">Step ' + (step + 1) + ' of ' + OB_STEPS.length + '</div>' +
        '<div class="ob-icon">' + s.icon + '</div>' +
        '<h2 class="ob-title">' + s.title + '</h2>' +
        done +
        '<p class="ob-text">' + s.text + '</p>' +
        points + note +
        '<div class="ob-actions">' +
          '<button type="button" class="btn btn-primary btn-block" id="ob-primary">' + primaryLabel + '</button>' +
          // "Continue without an account" carries the same weight as sign-up
          // (Théo 2026-09-27: never force the sign-up).
          (s.later && !(step === 0 && signedIn) ? '<button type="button" class="btn btn-secondary btn-block" id="ob-later">' + s.later + '</button>' : '') +
          (s.secondary && !(step === 0 && signedIn) ? '<button type="button" class="ob-link" id="ob-secondary">' + s.secondary.label + '</button>' : '') +
          (step > 0 ? '<button type="button" class="ob-link" id="ob-back">← Back</button>' : '') +
        '</div>' +
      '</div>';

    overlay.querySelector('#close-onboarding').addEventListener('click', finish);
    overlay.querySelector('#ob-primary').addEventListener('click', async () => {
      if (step === 0 && signedIn) { step = 1; saveStep(step); render(); return; }
      if (s.primary.action === 'personal') { await goFillInfo(); return; }
      if (s.primary.linkedin) {
        let url = 'https://www.linkedin.com/jobs/search/?f_AL=true';
        try { if (window.buildLinkedInSearchUrl) url = await window.buildLinkedInSearchUrl(); } catch (_) {}
        openUrl(url, true);
        await finish();
        return;
      }
      openUrl(s.primary.url, s.primary.external);
      if (s.primary.finish) { await finish(); return; }
      // Opening a tab closes the popup: resume on the next step next time.
      step = Math.min(step + 1, OB_STEPS.length - 1);
      saveStep(step);
      render();
    });
    overlay.querySelector('#ob-later')?.addEventListener('click', () => { step = 1; saveStep(step); render(); });
    overlay.querySelector('#ob-secondary')?.addEventListener('click', async () => {
      if (s.secondary.finishOnly) { await finish(); return; }
      if (s.secondary.url) {
        openUrl(s.secondary.url, s.secondary.external);
        // Sign in (step 1) resumes on the next step; "review on the dashboard"
        // (step 2) keeps the user on "Fill in your info".
        if (step > 0) return;
        step = Math.min(step + 1, OB_STEPS.length - 1);
        saveStep(step);
        render();
        return;
      }
      if (s.secondary.action === 'personal') {
        step = Math.min(step + 1, OB_STEPS.length - 1);
        saveStep(step);
        overlay.remove();
        document.querySelector('[data-tab="personal"]')?.click();
        document.getElementById('firstName')?.focus();
      }
    });
    overlay.querySelector('#ob-back')?.addEventListener('click', () => { step = Math.max(0, step - 1); saveStep(step); render(); });
  }
  render();
}

// ==========================================
// HELP GUIDE — "?" in the header (v2.5.90)
// ==========================================

// Short "how it works", reopenable any time. Same overlay styling as the
// first-run onboarding; links go to the dashboard, never block the popup.
const HELP_ICON = {
  play: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l14 8-14 8V4z"/></svg>',
  pause: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M10 9v6M14 9v6"/></svg>',
  list: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  edit: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  spark: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/></svg>',
  doc: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg>',
};
const HELP_STEPS = [
  {
    icon: HELP_ICON.play,
    title: 'Auto-apply on LinkedIn Easy Apply',
    text: 'Auto-apply works on <b>LinkedIn Easy Apply</b> jobs only.',
    points: ['Search your role on LinkedIn with the <b>Easy Apply</b> filter', 'Open this extension and click <b>Start auto-apply</b>', 'It fills each form with your info and submits it for you'],
    links: [{ label: 'Open Easy Apply jobs', url: 'https://www.linkedin.com/jobs/search/?f_AL=true', external: true }],
  },
  {
    icon: HELP_ICON.pause,
    title: 'Pauses and the daily limit',
    text: 'LinkedIn limits how fast and how much you can apply. The extension follows those limits for you.',
    points: ['<b>Paused</b> — LinkedIn asked to slow down: it waits a few minutes, then resumes on its own', '<b>Daily limit reached</b> — LinkedIn stops Easy Apply for the day: it stops, start again tomorrow', 'Jobs you already applied to are skipped'],
  },
  {
    icon: HELP_ICON.list,
    title: 'Track every application',
    text: 'Each application sent by the extension appears on your dashboard, with the company, the date and a link to the job.',
    links: [{ label: 'See my applications', url: '/dashboard#applications' }],
  },
  {
    icon: HELP_ICON.doc,
    title: 'Tailor your CV to each job',
    text: 'On a LinkedIn job page, the <b>Match · Tailor CV</b> button next to Easy Apply shows how well your CV matches that job.',
    points: ['Click it: your CV generator opens with the job already filled in', 'The AI rewrites your real experience for this job — it never invents', 'Check any CV against a job with the <b>ATS score</b> on your dashboard'],
    links: [{ label: 'Tailor my CV', url: '/dashboard.html#cv-generator' }, { label: 'ATS score', url: '/dashboard.html#ats-checker' }],
  },
  {
    icon: HELP_ICON.edit,
    title: 'Any other site: Autofill or Track',
    text: 'On any job site or career page, open the application form and click <b>Autofill this form</b>.',
    points: ['Your name, email, phone and links are filled in', '<b>You</b> review the answers and click Submit on the site', '<b>Track this job</b> saves it to your dashboard'],
  },
  {
    icon: HELP_ICON.spark,
    title: 'What Premium adds',
    text: 'On the free plan the extension fills the standard fields from your profile.',
    points: ['<b>AI answers</b> to screening questions during auto-apply, written from your CV', '30 AI credits a month: a tailored CV and cover letter for each job'],
    links: [{ label: 'See plans', url: '/dashboard?section=upgrade&src=ext_help' }, { label: 'Tailor my CV', url: '/dashboard?section=cv-generator&src=ext_help' }],
  },
];

function showHelp(startStep = 0) {
  document.getElementById('help-overlay')?.remove();
  let step = Math.max(0, Math.min(HELP_STEPS.length - 1, startStep));
  const overlay = document.createElement('div');
  overlay.id = 'help-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'How AutoApplyMax works');
  document.body.appendChild(overlay);
  const openUrl = (url, external) => {
    const full = external ? url : OB_URL + url;
    try { chrome.tabs.create({ url: full }); } catch (_) { window.open(full, '_blank'); }
  };
  const close = () => { overlay.remove(); document.getElementById('help-btn')?.focus(); };

  function render() {
    const s = HELP_STEPS[step];
    const last = step === HELP_STEPS.length - 1;
    const progress = HELP_STEPS.map((_, i) => '<span class="' + (i <= step ? 'done' : '') + '"></span>').join('');
    const points = s.points ? '<ul class="ob-points">' + s.points.map(p => '<li>' + p + '</li>').join('') + '</ul>' : '';
    const links = s.links ? '<div class="help-links">' + s.links.map((l, i) => '<a href="#" data-help-link="' + i + '">' + l.label + '&nbsp;→</a>').join('') + '</div>' : '';
    overlay.innerHTML =
      '<div class="ob-top">' +
        '<span class="logo"><img src="icons/icon48.png" alt="" width="28" height="28"><span class="wordmark">How it works</span></span>' +
        '<button type="button" class="ob-skip" id="help-close" aria-label="Close help">Close ' + UI_ICON.close + '</button>' +
      '</div>' +
      '<div class="ob-body">' +
        '<div class="ob-progress">' + progress + '</div>' +
        '<div class="ob-step-count">' + (step + 1) + ' of ' + HELP_STEPS.length + '</div>' +
        '<div class="ob-icon">' + s.icon + '</div>' +
        '<h2 class="ob-title">' + s.title + '</h2>' +
        '<p class="ob-text">' + s.text + '</p>' +
        points + links +
        '<div class="ob-actions">' +
          '<div class="help-nav">' +
            (step > 0 ? '<button type="button" class="btn btn-secondary" id="help-back">← Back</button>' : '') +
            '<button type="button" class="btn btn-primary" id="help-next">' + (last ? 'Got it' : 'Next →') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    overlay.querySelector('#help-close').addEventListener('click', close);
    overlay.querySelector('#help-next').addEventListener('click', () => { if (last) { close(); return; } step++; render(); });
    overlay.querySelector('#help-back')?.addEventListener('click', () => { step--; render(); });
    overlay.querySelectorAll('[data-help-link]').forEach(a => a.addEventListener('click', async (e) => {
      e.preventDefault();
      const l = s.links[Number(a.getAttribute('data-help-link'))];
      if (/linkedin\.com\/jobs\/search/.test(l.url) && window.buildLinkedInSearchUrl) {
        try { openUrl(await window.buildLinkedInSearchUrl(), true); return; } catch (_) {}
      }
      openUrl(l.url, l.external);
    }));
    overlay.querySelector('#help-next').focus();
  }
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  render();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('help-btn')?.addEventListener('click', () => showHelp(0));
});

// ==========================================
// EXPORT: Rendre disponibles globalement
// ==========================================

window.showToast = showToast;
window.validateField = validateField;
window.validateAllFields = validateAllFields;
window.setupValidation = setupValidation;
window.checkOnboarding = checkOnboarding;
window.showHelp = showHelp;
