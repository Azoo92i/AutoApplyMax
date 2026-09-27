# Indeed auto-apply hardening — feat/indeed-auto-apply-hardening

Two small but high-impact robustness fixes on top of v2.5.15. Both target the
"auto-apply hangs or wastes attempts on Indeed" failure mode.

## What changed

### 1. Skip "Apply on company site" jobs — `adapters/indeed-adapter.js`

Many Indeed listings only offer "Apply on company site" (the Apply CTA opens
the employer's own portal in a new tab). The extension can't fill those forms —
they run on arbitrary domains outside our adapter coverage. Before this fix,
the engine would still click the button, open a new tab, and hang the loop
waiting for a SmartApply page that never materialises.

New helper `isCompanySiteRedirect(btn)` returns true when:
- Button label matches `company site` / `employer site` / `sur le site` /
  `auf der Website` / `sitio de la empresa` / `sitio web del empleador`
- OR the `href` points off-Indeed (anything other than `indeed.*/…` or
  `smartapply.indeed.com/…`)

`getApplyButton()` now filters through this predicate at every fallback layer.
When only company-site buttons exist, it returns `null` — the engine already
handles that path by bumping `skippedCount` and moving to the next job.

### 2. Bail cleanly on SmartApply captcha — `core/engine.js`

Indeed occasionally injects a "Verify you're human" step or a Cloudflare/
reCAPTCHA challenge mid-flow. The engine's `formOnlyLoop` couldn't detect this
and would loop for the full 3-minute timeout clicking a Continue button that
never enabled.

New method `hasSmartApplyChallenge()` on the Indeed adapter checks for:
- `iframe[src*="recaptcha"]` / `iframe[src*="hcaptcha"]`
- `[data-testid*="challenge"]` / `.challenge-form` / `#challenge-form`
- Text-based fallback: "verify you're human", "are you a robot", FR variant

The form-only loop calls this on every step. On detection, it sends
`indeedSmartApplyChallenge` to background.js and breaks — instead of burning
3 minutes and then reporting "TIMEOUT". Users see the challenge, solve it,
and can resume manually.

## Tests

`tests/indeed-adapter-skip-company-site.test.js` (in AAM repo, not this one)
covers both helpers via Playwright + addScriptTag:

- ✓ isCompanySiteRedirect: EN "Apply on company site"
- ✓ isCompanySiteRedirect: FR "sur le site de l'entreprise"
- ✓ isCompanySiteRedirect: external href
- ✓ isCompanySiteRedirect: false for SmartApply button
- ✓ isCompanySiteRedirect: false for smartapply.indeed.com href
- ✓ hasSmartApplyChallenge: false on clean form
- ✓ hasSmartApplyChallenge: true on recaptcha iframe
- ✓ hasSmartApplyChallenge: true on "Verify you're human" text

8/8 passing.

## Version

Bump manifest to 2.5.16 when merged + zipped for CWS.

## Where the code lives

Since `chrome-store-release/` is gitignored on this repo, the actual JS edits
live in:
- `chrome-store-release/adapters/indeed-adapter.js` — new methods around
  line 280 (isCompanySiteRedirect) + line 355 (hasSmartApplyChallenge)
- `chrome-store-release/core/engine.js` — new challenge check around
  line 761 in `formOnlyLoop`

The patch file `indeed-adapter-patch.js` in this directory carries the
adapter snippet as reference in case chrome-store-release drifts.
