# v2.5.16 — 2026-08-01

## What's shipping

Roll-up of the `feat/indeed-auto-apply-hardening` branch. Bump from v2.5.15.

### Feature: unified "Tailor CV · N% match" button (retired old badge)

Retired the loud stacked pair (colour-coded % match badge + separate blue
Generate CV pill) that shipped in v2.5.15. Replaced by ONE sober blue button:

```
[✨ Tailor CV │ 22% match]
```

- Left region: main action — stores JD in `chrome.storage.local.aam_pending_jd`
  and opens `autoapplymax.com/dashboard#cv-generator`
- Right region: score toggle — opens a fixed panel with matched + missing
  keywords + Tailor CV CTA. Small colored dot (green ≥75, yellow 55-75,
  orange 30-55, red <30) hints at fit strength without being loud.
- Match score renders only when a CV is present in extension storage;
  otherwise the button shows just "✨ Tailor CV".

Files:
- `core/generate-cv-button.js` — now 420 lines, computes score inline
  (extractKeywords + computeMatch ported from ats-analyzer keyword branch)
- `core/match-score-badge.js` — no longer registered in `content_scripts`.
  Still ships as a file (harmless, prune next release)
- Renamed BTN_ID `aam-generate-cv-btn` → `aam-tailor-cv-btn`

### Feature: Indeed SmartApply hardening

- `IndeedAdapter.isCompanySiteRedirect(btn)` — filters out "Apply on
  company site" buttons (EN/FR/DE/ES + external href detection). Prevents
  the engine hanging on jobs whose only Apply CTA opens the employer's own
  portal in a new tab
- `IndeedAdapter.hasSmartApplyChallenge()` — detects iframe reCAPTCHA,
  Cloudflare challenge markers, and "Verify you're human" text on
  smartapply.indeed.com. `engine.formOnlyLoop` breaks cleanly + signals
  background via `indeedSmartApplyChallenge` instead of burning the 3-min
  timeout looping on a never-clickable Continue button
- `IndeedAdapter.getApplyButton()` uses the new filter at every fallback
  layer; when only company-site buttons exist, returns null → engine skips
  cleanly (`skippedCount++; continue;`)

### Fix: Glassdoor + WTTJ selectors + country domains

Selectors refreshed after 2026-08 DOM refactors:

**Glassdoor** (`.com` + `.co.uk` + `.fr` + `.de` + `.ca` + `.com.au` now
in manifest match_patterns):
- Title: `[data-test="job-title"]` on the `<h1>` was dropped — moved to
  the JobCard `<a>`. Added `a[data-test="job-title"]` first, then
  `[class*="JobDetails_employerAndJobTitle__"] h1` (new hash pattern),
  legacy selectors kept as last-resort fallbacks
- JD: `[class*="JobDetails_jobDescription"]` (testid gone)
- Company: `[class*="EmployerProfile_employerNameHeading__"]` (new class)

**WTTJ**:
- Title: `[data-testid="job-title"]` was dropped from the h2 — now `section h2.wui-text`
- JD: tag changed `<section>` → `<div>`, kept the testid so
  `[data-testid="job-section-description"]` still works but without the tag prefix
- Company: `a[href^="/en/companies/"]:not([href*="/jobs"]):not([href*="/reviews"])`
  parses the URL slug (best available since testid was dropped and no stable class)

### Tests (in AAM repo)

- `tests/tailor-cv-button.test.js` — new, **10/10 passing**
  - injects on all 4 sites (fixture DOMs matching current + legacy shapes:
    linkedin, indeed, glassdoor, glassdoor_new, wttj, wttj_new)
  - keyword scoring produces >=40% on strong-overlap CV/JD
  - Tailor CV click stores JD in storage + opens dashboard
  - % match click opens the detail panel + closes on second click
  - button still injects when CV storage is empty (just no score region)
- `tests/indeed-adapter-skip-company-site.test.js` — 8/8 passing (unchanged
  from v2.5.15 shipping window; carried forward)
- `tests/linkedin.test.js` — pre-existing test-harness bug at l.225 fixed
  (`injectScripts()` was omitting `core/job-board-strings.js`)

Overall extension suite: **36/37 → 37/37** after the harness fix.

## Upload checklist

1. Zip built + verified: `C:/CleanExt/chrome-store-release/AutoApplyMax-v2.5.16.zip` (187 KB, 30 entries)
2. Follow `C:/CleanExt/chrome-store-release/UPLOAD_PROCEDURE.md` step-by-step
3. Screenshots for CWS listing don't need to change — layout unchanged, just badge design
4. Update CWS "What's new" text: "Cleaner in-page badge (one button instead of two). Better handling of Apply-on-company-site jobs (skipped cleanly). Glassdoor + Welcome-to-the-Jungle DOM refactor support."
5. Post-upload: reload extension in your Chrome (`chrome://extensions` → click Update button on AutoApplyMax) + visit an Indeed detail page — verify `[✨ Tailor CV │ N% match]` appears (may take ~5s for MutationObserver + async CV load).
