// ==========================================
// AMÉLIORATIONS POPUP - v1.3.0
// Toast notifications, Validation, Onboarding
// ==========================================

// ==========================================
// TOAST NOTIFICATIONS (remplace les alerts)
// ==========================================

let toastContainer = null;

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
  close.textContent = '×';
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
  warnIcon.style.fontWeight = '600';
  warnIcon.textContent = '⚠';
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
    title: 'Connect your AutoApplyMax account',
    text: 'Free to create. Your applications, CV and AI credits stay in sync between this extension and your dashboard.',
    points: ['Every application tracked on your dashboard', 'Tailored CVs and cover letters with AI', 'Uses the profile you already filled in'],
    primary: { label: 'Sign in or create a free account', url: '/auth.html?src=ext_onboarding' },
    doneWhenSignedIn: 'You\'re signed in',
  },
  {
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg>',
    title: 'Check your profile & CV',
    text: 'Auto-apply fills each form with your details. The more complete your profile, the fewer applications get skipped.',
    points: ['Name, email, phone and city', 'Years of experience and work authorization', 'Your CV, uploaded once'],
    primary: { label: 'Review my profile on the dashboard', url: '/dashboard.html#smart-profile' },
    secondary: { label: 'Fill it in the extension instead', action: 'personal' },
  },
  {
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l14 8-14 8V4z"/></svg>',
    title: 'Open LinkedIn Easy Apply jobs',
    text: 'Search for your role with the Easy Apply filter, then open this extension and click <b>Start auto-apply</b>.',
    note: '<b>Other job sites?</b> Indeed, Workday, Greenhouse or any career page: click <b>Autofill this form</b> — the extension fills it, you review and submit.',
    primary: { label: 'Open Easy Apply jobs on LinkedIn', url: 'https://www.linkedin.com/jobs/search/?f_AL=true', external: true, finish: true },
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

  function render() {
    const s = OB_STEPS[step];
    const progress = OB_STEPS.map((_, i) => '<span class="' + (i <= step ? 'done' : '') + '"></span>').join('');
    const points = s.points ? '<ul class="ob-points">' + s.points.map(p => '<li>' + p + '</li>').join('') + '</ul>' : '';
    const note = s.note ? '<div class="ob-note">' + s.note + '</div>' : '';
    const done = (step === 0 && signedIn) ? '<div class="ob-done">✓ ' + s.doneWhenSignedIn + '</div>' : '';
    const primaryLabel = (step === 0 && signedIn) ? 'Continue' : s.primary.label;
    overlay.innerHTML =
      '<div class="ob-top">' +
        '<span class="logo"><img src="icons/icon48.png" alt="" width="24" height="24"><span class="wordmark">AutoApply<span>Max</span></span></span>' +
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
          (s.secondary ? '<button type="button" class="ob-link" id="ob-secondary">' + s.secondary.label + '</button>' : '') +
          (step > 0 ? '<button type="button" class="ob-link" id="ob-back">← Back</button>'
                    : '<button type="button" class="ob-link" id="ob-open-dashboard">I\'ll do it later</button>') +
        '</div>' +
      '</div>';

    overlay.querySelector('#close-onboarding').addEventListener('click', finish);
    overlay.querySelector('#ob-primary').addEventListener('click', async () => {
      if (step === 0 && signedIn) { step = 1; saveStep(step); render(); return; }
      openUrl(s.primary.url, s.primary.external);
      if (s.primary.finish) { await finish(); return; }
      // Opening a tab closes the popup: resume on the next step next time.
      step = Math.min(step + 1, OB_STEPS.length - 1);
      saveStep(step);
      render();
    });
    overlay.querySelector('#ob-secondary')?.addEventListener('click', async () => {
      if (s.secondary.action === 'personal') {
        step = Math.min(step + 1, OB_STEPS.length - 1);
        saveStep(step);
        overlay.remove();
        document.querySelector('[data-tab="personal"]')?.click();
        document.getElementById('firstName')?.focus();
      }
    });
    overlay.querySelector('#ob-back')?.addEventListener('click', () => { step = Math.max(0, step - 1); saveStep(step); render(); });
    overlay.querySelector('#ob-open-dashboard')?.addEventListener('click', () => { step = 1; saveStep(step); render(); });
  }
  render();
}

// ==========================================
// EXPORT: Rendre disponibles globalement
// ==========================================

window.showToast = showToast;
window.validateField = validateField;
window.validateAllFields = validateAllFields;
window.setupValidation = setupValidation;
window.checkOnboarding = checkOnboarding;
