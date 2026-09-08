// ==========================================
// AMÉLIORATIONS POPUP - v1.3.0
// Toast notifications, Validation, Onboarding
// ==========================================

// ==========================================
// TOAST NOTIFICATIONS (remplace les alerts)
// ==========================================

let toastContainer = null;

function showToast(message, type = 'info', duration = 4000) {
  // Créer le container si nécessaire
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;
    document.body.appendChild(toastContainer);
  }

  // Créer le toast
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };

  const colors = {
    success: '#10b981',
    error: '#ef4444',
    warning: '#0a66c2',
    info: '#0a66c2'
  };

  toast.innerHTML = `
    <div style="
      background: white;
      padding: 14px 18px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 300px;
      max-width: 400px;
      border-left: 4px solid ${colors[type]};
      animation: slideIn 0.3s ease-out;
    ">
      <div style="
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: ${colors[type]};
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        flex-shrink: 0;
      ">${icons[type]}</div>
      <div class="toast-message" style="
        flex: 1;
        font-size: 14px;
        color: #1e293b;
        line-height: 1.4;
      "></div>
      <button class="toast-close" style="
        background: none;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 18px;
        padding: 0;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
      ">×</button>
    </div>
  `;

  // Set message via textContent to prevent XSS
  toast.querySelector('.toast-message').textContent = message;

  // Ajouter au container
  toastContainer.appendChild(toast);

  // Add close button listener (no inline handler for CSP compliance)
  const closeBtn = toast.querySelector('.toast-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => toast.remove());
  }

  // Auto-remove après duration
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Ajouter les animations CSS
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

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

async function checkOnboarding() {
  const { onboardingCompleted, eam_session, plan } = await chrome.storage.local.get(['onboardingCompleted', 'eam_session', 'plan']);

  // Skip intro if user is already signed-in — they came through the web
  // onboarding + auth flow, they don't need the extension's first-run
  // welcome (was blocking premium subscribers who installed extension
  // AFTER subscribing on the dashboard).
  if (eam_session?.access_token) {
    if (!onboardingCompleted) {
      try { await chrome.storage.local.set({ onboardingCompleted: true }); } catch (_) {}
    }
    return;
  }

  if (!onboardingCompleted) {
    showOnboarding();
  }
}

function showOnboarding() {
  // Full-screen overlay that takes the entire popup area. The Chrome popup
  // is already a fixed 400px × ~600px window, so filling it gives the
  // onboarding the whole real estate — bigger text, clearer layout.
  const overlay = document.createElement('div');
  overlay.id = 'onboarding-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: white;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    animation: fadeIn 0.3s ease-out;
    overflow: hidden;
  `;

  overlay.innerHTML = `
    <div style="
      width: 100%;
      height: 100%;
      padding: 24px 22px 20px 22px;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      animation: scaleIn 0.3s ease-out;
    ">
      <div style="text-align: center; margin-bottom: 22px; flex-shrink: 0;">
        <div style="font-size: 44px; line-height: 1; margin-bottom: 10px;">🎉</div>
        <h2 style="margin: 0 0 6px 0; color: #0a66c2; font-size: 22px; font-weight: 800;">Welcome to AutoApplyMax</h2>
        <p style="margin: 0; color: #0a66c2; font-size: 13px; font-weight: 600; letter-spacing: 0.4px;">Autoapply · Autofill · Autotrack</p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 14px; flex: 1; justify-content: center;">
        <div style="display: flex; gap: 13px; align-items: start;">
          <div style="width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #0a66c2, #378fe9); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; flex-shrink: 0; margin-top: 2px; box-shadow: 0 2px 6px rgba(10,102,194,0.3);">1</div>
          <div style="font-size: 13px; color: #475569; line-height: 1.5;"><b style="color:#1e293b; font-size:14px;">Fill your info</b><br>Personal Info tab: name, email, phone, upload your CV.</div>
        </div>
        <div style="display: flex; gap: 13px; align-items: start;">
          <div style="width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #0a66c2, #378fe9); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; flex-shrink: 0; margin-top: 2px; box-shadow: 0 2px 6px rgba(10,102,194,0.3);">2</div>
          <div style="font-size: 13px; color: #475569; line-height: 1.5;"><b style="color:#1e293b; font-size:14px;">Set your preferences</b><br>Settings tab: blacklist keywords, max experience, visa &amp; relocation answers.</div>
        </div>
        <div style="display: flex; gap: 13px; align-items: start;">
          <div style="width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #0a66c2, #378fe9); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; flex-shrink: 0; margin-top: 2px; box-shadow: 0 2px 6px rgba(10,102,194,0.3);">3</div>
          <div style="font-size: 13px; color: #475569; line-height: 1.5;"><b style="color:#1e293b; font-size:14px;">Autoapply or Autofill</b><br>Search on LinkedIn → click <b>Autoapply</b>. On any other site → click <b>Autofill</b>.</div>
        </div>
        <div style="display: flex; gap: 13px; align-items: start;">
          <div style="width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #0a66c2, #378fe9); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; flex-shrink: 0; margin-top: 2px; box-shadow: 0 2px 6px rgba(10,102,194,0.3);">4</div>
          <div style="font-size: 13px; color: #475569; line-height: 1.5;"><b style="color:#1e293b; font-size:14px;">Open your Dashboard</b><br>Every application auto-tracked. Generate AI CVs &amp; cover letters, see response rates.</div>
        </div>
      </div>

      <div style="display: flex; gap: 8px; margin-top: 20px; flex-shrink: 0;">
        <button id="ob-open-dashboard" style="
          flex: 1;
          padding: 13px;
          background: white;
          color: #0a66c2;
          border: 1.5px solid #0a66c2;
          border-radius: 9px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        ">Open Dashboard</button>
        <button id="close-onboarding" style="
          flex: 1;
          padding: 13px;
          background: linear-gradient(135deg, #0a66c2, #378fe9);
          color: white;
          border: none;
          border-radius: 9px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          box-shadow: 0 3px 8px rgba(10,102,194,0.35);
        ">Got it, let's start!</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Add CSS animations
  if (!document.getElementById('onboarding-styles')) {
    const style = document.createElement('style');
    style.id = 'onboarding-styles';
    style.textContent = `
      @keyframes fadeIn { from {opacity:0} to {opacity:1} }
      @keyframes fadeOut { from {opacity:1} to {opacity:0} }
      @keyframes scaleIn { from {transform:scale(0.9); opacity:0} to {transform:scale(1); opacity:1} }
      #close-onboarding:hover { transform: scale(1.02); }
      #ob-open-dashboard:hover { background: #f1f5ff; }
    `;
    document.head.appendChild(style);
  }

  async function dismiss() {
    try { await chrome.storage.local.set({ onboardingCompleted: true }); } catch (_) {}
    overlay.style.animation = 'fadeOut 0.3s ease-out';
    setTimeout(() => overlay.remove(), 300);
  }

  // Dashboard button — opens dashboard in new tab AND marks onboarding complete
  document.getElementById('ob-open-dashboard').addEventListener('click', async () => {
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: 'https://www.autoapplymax.com/dashboard' });
      } else {
        window.open('https://www.autoapplymax.com/dashboard', '_blank');
      }
    } catch (_) {}
    await dismiss();
  });

  // Close button
  document.getElementById('close-onboarding').addEventListener('click', dismiss);
}

// ==========================================
// EXPORT: Rendre disponibles globalement
// ==========================================

window.showToast = showToast;
window.validateField = validateField;
window.validateAllFields = validateAllFields;
window.setupValidation = setupValidation;
window.checkOnboarding = checkOnboarding;
