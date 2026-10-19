// popup-to-complete.js — popup UI of "To complete" (2026-10-19). Data + rules live in to-complete.js (service worker).
// Tab "To complete": distinct unanswered questions (one input per question, profile-field questions grouped), the
// saved jobs, "Apply to these jobs now". Run card: pre-run banner when the settings behind most skips are empty.
// Labels come from job forms (untrusted page text) → DOM APIs + textContent only, never innerHTML.
(function () {
  'use strict';
  const TC = window.AAMToComplete;
  if (!TC || typeof chrome === 'undefined' || !chrome.runtime) return;
  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise(res => { try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || null); }); } catch (_) { res(null); } });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const FIELD_LABEL = {
    expectedSalary: 'Expected salary per year', currentSalary: 'Current salary / CTC per year', city: 'Current city',
    nationality: 'Nationality', postalCode: 'Postal / ZIP code', noticePeriod: 'Notice period', dateOfBirth: 'Date of birth',
    gender: 'Gender', phone: 'Phone number', legallyAuthorized: 'Authorized to work in the job’s country?',
    visaSponsorship: 'Need visa sponsorship?', willingToRelocate: 'Willing to relocate?',
  };
  // Neutral placeholders: a greyed example value could be read as an answer already set.
  const PLACEHOLDER = { expectedSalary: 'Amount per year', currentSalary: 'Amount per year', city: 'City, province / state', nationality: 'Your nationality', postalCode: 'Postal code', phone: 'Phone with country code' };
  const HINT = { expectedSalary: 'Per year, in your currency. "8 LPA" and "85k" work too.', currentSalary: 'Your current / last drawn pay per year, in your currency ("8 LPA" works too). Not your expected salary.' };
  const NOTICE = ['Immediately', '15 days', '1 month', '2 months', '3 months', '6 months'];
  const MISS_WORD = { expectedSalary: 'expected salary', city: 'city', currentSalary: 'current CTC' };

  let data = { items: [], answers: {}, settings: {}, reapply: null };
  let countryHint = '';
  let showMissing = false;

  async function loadCountryHint() {
    try {
      const s = await chrome.storage.sync.get(['country', 'phoneCountryCode']);
      const l = await chrome.storage.local.get(['accountProfile']);
      const c = String(s.country || (l.accountProfile && l.accountProfile.country) || '').trim().toUpperCase();
      countryHint = c.length === 2 ? c : (String(s.phoneCountryCode || '').replace(/[^\d]/g, '') === '91' ? 'IN' : '');
    } catch (_) { countryHint = ''; }
  }

  async function refresh() {
    const r = await send({ type: 'toCompleteList' });
    if (r && r.ok) data = r;
    render();
  }

  function ctx() { return { settings: data.settings || {}, custom: data.answers || {} }; }

  function render() {
    const items = data.items || [];
    const open = TC.openItems(items);
    const badge = $('tc-badge');
    const nOpen = open.filter(x => x.status !== 'queued').length;
    if (badge) { badge.textContent = String(nOpen); badge.hidden = nOpen === 0; }
    renderPrerun();
    renderReapplyStatus();
    renderQuestions(open);
    renderReady();
    renderJobs(open);
    const empty = $('tc-empty'); if (empty) empty.hidden = open.length > 0;
  }

  function renderPrerun() {
    const box = $('tc-prerun'); if (!box) return;
    const miss = TC.missingKeySettings(data.settings || {}, countryHint);
    if (!miss.length) { box.hidden = true; return; }
    const words = miss.map(k => MISS_WORD[k] || k);
    const list = words.length > 1 ? words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1] : words[0];
    $('tc-prerun-text').textContent = `${miss.length} answer${miss.length > 1 ? 's' : ''} missing (${list}) — jobs that ask for ${miss.length > 1 ? 'them' : 'it'} are saved to “To complete”, not lost.`;
    box.hidden = false;
  }

  function renderReapplyStatus() {
    const box = $('tc-reapply-status'); if (!box) return;
    const re = data.reapply;
    if (re && re.active) {
      $('tc-reapply-text').textContent = `Applying ${Math.min((re.idx || 0) + 1, re.queue.length)} of ${re.queue.length}… keep the LinkedIn tab open.`;
      $('tc-reapply-cancel').hidden = false;
      box.hidden = false;
    } else if (re && re.finishedAt && Date.now() - re.finishedAt < 30 * 60e3) {
      const vals = Object.values(re.results || {});
      const ok = vals.filter(v => v === 'applied' || v === 'already_applied').length;
      $('tc-reapply-text').textContent = `Last re-apply: ${ok} of ${re.queue.length} applied${re.end === 'stopped' ? ' (stopped)' : re.end === 'cancelled' ? ' (cancelled)' : ''}.`;
      $('tc-reapply-cancel').hidden = true;
      box.hidden = false;
    } else box.hidden = true;
  }

  function inputFor(g) {
    const id = 'tcq-' + g.id.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    let input;
    const intent = g.intent;
    const yesno = intent === 'legallyAuthorized' || intent === 'visaSponsorship' || intent === 'willingToRelocate';
    const opts = (labels) => { const s = el('select'); s.appendChild(new Option('Choose…', '')); for (const [v, t] of labels) s.appendChild(new Option(t, v)); return s; };
    if (yesno) input = opts([['yes', 'Yes'], ['no', 'No']]);
    else if (intent === 'gender') input = opts([['female', 'Female'], ['male', 'Male'], ['non_binary', 'Non-binary'], ['other', 'Other']]);
    else if (intent === 'noticePeriod') input = opts(NOTICE.map(n => [n, n]));
    else if (intent === 'custom' && g.options && g.options.length) input = opts(g.options.map(o => [o, o]));
    else if (intent === 'dateOfBirth') { input = el('input'); input.type = 'date'; }
    else if (intent === 'custom' && g.kind === 'textarea') { input = el('textarea'); input.rows = 3; input.maxLength = 500; }
    else { input = el('input'); input.type = intent === 'phone' ? 'tel' : 'text'; input.maxLength = intent === 'custom' ? 500 : 80; if (PLACEHOLDER[intent]) input.placeholder = PLACEHOLDER[intent]; if (/salary/i.test(intent)) input.inputMode = 'numeric'; }
    input.id = id;
    input.dataset.intent = intent;
    if (intent === 'custom') { input.dataset.key = g.key; input.dataset.question = g.labels[0] || ''; }
    // Prefill: current setting / saved answer (never a guessed value).
    const cur = intent === 'custom' ? ((data.answers || {})[g.key] || {}).a : (data.settings || {})[intent];
    if (cur) input.value = String(cur);
    return input;
  }

  function renderQuestions(open) {
    const wrap = $('tc-questions'); const group = $('tc-questions-group'); if (!wrap || !group) return;
    wrap.textContent = '';
    const groups = TC.pendingQuestions(open, ctx());
    if (showMissing) {
      for (const k of TC.missingKeySettings(data.settings || {}, countryHint)) {
        if (!groups.some(g => g.intent === k)) groups.unshift({ id: k, intent: k, key: k, labels: [], jobs: 0 });
      }
    }
    for (const g of groups) {
      const row = el('div', 'form-group tc-q');
      const input = inputFor(g);
      const lab = el('label', null, g.intent === 'custom' ? (g.labels[0] || 'Question') : FIELD_LABEL[g.intent] || g.intent);
      lab.htmlFor = input.id;
      row.appendChild(lab);
      row.appendChild(input);
      const meta = [];
      if (g.intent !== 'custom' && g.labels.length) meta.push('Asked as: “' + g.labels.join('”, “') + '”');
      if (g.jobs) meta.push(g.jobs === 1 ? '1 job' : g.jobs + ' jobs');
      if (HINT[g.intent]) meta.unshift(HINT[g.intent]);
      if (!g.jobs) meta.push('Not set yet — asked by many forms');
      if (meta.length) row.appendChild(el('small', 'tc-q-meta', meta.join(' · ')));
      row.appendChild(el('small', 'field-error tc-err', ''));
      wrap.appendChild(row);
    }
    group.hidden = groups.length === 0;
  }

  function renderReady() {
    const ready = TC.readyItems(data.items || [], ctx());
    const box = $('tc-ready'); if (!box) return;
    const running = data.reapply && data.reapply.active;
    box.hidden = !ready.length || running;
    // 2.5.122: right after LinkedIn's daily limit the button waits (the service worker refuses too).
    const dl = Number(data.dailyLimitAt) || 0;
    const blocked = !!dl && Date.now() - dl < (Number(data.dailyLimitBlockMs) || 12 * 3600e3);
    const btn = $('tc-reapply'); if (btn) btn.disabled = blocked;
    $('tc-reapply-label').textContent = blocked ? 'LinkedIn daily limit reached — apply again tomorrow'
      : ready.length === 1 ? 'Apply to this job now' : `Apply to these ${ready.length} jobs now`;
  }

  function renderJobs(open) {
    const ul = $('tc-jobs'); const head = $('tc-jobs-head'); if (!ul) return;
    ul.textContent = '';
    head.hidden = open.length === 0;
    $('tc-jobs-count').textContent = open.length ? String(open.length) : '';
    for (const it of open.slice(0, 30)) {
      const li = el('li', 'tc-job');
      const top = el('div', 'tc-job-top');
      const a = el('a', 'tc-job-title', it.title || 'LinkedIn job');
      a.href = it.url; a.title = 'Open this job on LinkedIn';
      a.addEventListener('click', (e) => { e.preventDefault(); try { chrome.tabs.create({ url: it.url }); } catch (_) {} });
      top.appendChild(a);
      const x = el('button', 'tc-dismiss'); x.type = 'button'; x.title = 'Remove from the list'; x.setAttribute('aria-label', 'Remove ' + (it.title || 'job') + ' from the list');
      x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
      x.addEventListener('click', async () => { await send({ type: 'toCompleteDismiss', jobId: it.jobId }); refresh(); });
      top.appendChild(x);
      li.appendChild(top);
      li.appendChild(el('div', 'tc-job-sub', [it.company, it.location].filter(Boolean).join(' · ')));
      const chips = el('div', 'tc-chips');
      const left = TC.openQuestions(it, ctx());
      if (it.status === 'queued') chips.appendChild(el('span', 'tc-chip tc-chip-info', 'In the re-apply queue'));
      else if (it.status === 'not_found') chips.appendChild(el('span', 'tc-chip tc-chip-warn', 'Not found last time — open it to check'));
      if (!left.length && it.status !== 'queued') chips.appendChild(el('span', 'tc-chip tc-chip-ok', 'Ready'));
      const seenChip = new Set();
      for (const q of left) {
        const t = q.intent === 'custom' ? q.label : FIELD_LABEL[q.intent] || q.label;
        if (seenChip.has(t) || seenChip.size >= 4) continue;
        seenChip.add(t); chips.appendChild(el('span', 'tc-chip', t));
      }
      li.appendChild(chips);
      ul.appendChild(li);
    }
  }

  async function save() {
    const btn = $('tc-save'); const st = $('tc-status');
    const settings = {}; const custom = [];
    for (const input of document.querySelectorAll('#tc-questions [data-intent]')) {
      const v = String(input.value || '').trim();
      const errEl = input.parentElement.querySelector('.tc-err'); if (errEl) errEl.textContent = '';
      input.removeAttribute('aria-invalid');
      if (!v) continue;
      if (input.dataset.intent === 'custom') custom.push({ key: input.dataset.key, question: input.dataset.question, answer: v });
      else settings[input.dataset.intent] = v;
    }
    if (!Object.keys(settings).length && !custom.length) { st.textContent = 'Type at least one answer.'; st.className = 'tc-status tc-status-err'; return; }
    btn.disabled = true;
    const r = await send({ type: 'toCompleteSaveAnswers', settings, custom });
    btn.disabled = false;
    // Keep what the user typed in the invalid fields (the re-render below rebuilds the inputs from saved values).
    const typed = {};
    for (const input of document.querySelectorAll('#tc-questions [data-intent]')) typed[input.dataset.intent === 'custom' ? input.dataset.key : input.dataset.intent] = input.value;
    const errs = (r && r.errors) || {};
    if (Object.keys(errs).length) showMissing = true; else showMissing = false;
    await refresh();
    for (const input of document.querySelectorAll('#tc-questions [data-intent]')) {
      const k = input.dataset.intent === 'custom' ? input.dataset.key : input.dataset.intent;
      if (!errs[k]) continue;
      input.value = typed[k] || '';
      input.setAttribute('aria-invalid', 'true');
      const e = input.parentElement.querySelector('.tc-err');
      if (e) e.textContent = /salary/i.test(k) ? 'Numbers only, per year (e.g. 60000, 85k, 8 LPA).' : k === 'dateOfBirth' ? 'Pick a real date.' : 'This answer can’t be used — check the format.';
    }
    const ready = TC.readyItems(data.items || [], ctx()).length;
    st.textContent = r && r.saved ? `Saved — reused on every form${ready ? ` · ${ready} job${ready > 1 ? 's' : ''} ready` : ''}.` : 'Nothing saved.';
    st.className = 'tc-status' + (r && r.saved ? ' tc-status-ok' : ' tc-status-err');
  }

  async function reapply() {
    const btn = $('tc-reapply'); btn.disabled = true;
    const r = await send({ type: 'toCompleteReapply' });
    btn.disabled = false;
    const st = $('tc-status');
    if (r && r.ok) { await refresh(); }
    else if (st) { st.textContent = r && r.reason === 'already_running' ? 'A re-apply is already running.' : r && r.reason === 'daily_limit' ? 'LinkedIn’s daily Easy Apply limit was reached. Your answers are saved — apply again tomorrow.' : 'Nothing ready to apply — answer the questions first.'; st.className = 'tc-status tc-status-err'; }
  }

  function openTab() {
    const btn = document.querySelector('.tab[data-tab="tocomplete"]');
    if (btn) btn.click();
  }

  function init() {
    $('tc-save')?.addEventListener('click', save);
    $('tc-reapply')?.addEventListener('click', reapply);
    $('tc-reapply-cancel')?.addEventListener('click', async () => { await send({ type: 'toCompleteReapplyCancel' }); refresh(); });
    $('tc-prerun-add')?.addEventListener('click', (e) => { e.preventDefault(); showMissing = true; openTab(); render(); setTimeout(() => { const f = document.querySelector('#tc-questions [data-intent]'); if (f) f.focus(); }, 50); });
    $('tc-open-dashboard')?.addEventListener('click', (e) => { e.preventDefault(); try { chrome.tabs.create({ url: 'https://www.autoapplymax.com/dashboard#applications' }); } catch (_) {} });
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if ((area === 'local' && (ch[TC.LIST_KEY] || ch[TC.REAPPLY_KEY] || ch[TC.ANS_KEY])) || (area === 'sync' && TC.SETTING_KEYS.some(k => ch[k]))) {
          // Do not wipe what the user is typing in the tab.
          if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#tc-questions')) { renderPrerun(); renderReapplyStatus(); renderReady(); return; }
          refresh();
        }
      });
    } catch (_) {}
    loadCountryHint().then(refresh);
    // Pull answers / jobs saved on the dashboard (account), then repaint.
    send({ type: 'toCompleteSync' }).then((r) => { if (r && r.changed) refresh(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.AAMPopupToComplete = { refresh, render, save, _state: () => data };
})();
