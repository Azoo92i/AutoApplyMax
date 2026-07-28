# AI Draft — integration notes

Feature spec + integration steps for `core/ai-draft-manual.js`.

## What it does

Injects a floating "✨ AI Draft" button next to every meaningful `<textarea>`
on job sites (Indeed, Glassdoor, Greenhouse, Workday, Lever, Ashby, WTTJ,
Monster, career sites). One click → the same AI form-answer path used
during auto-apply (via `EAM.aiForm.askAI`) pre-fills the textarea. User
reviews, edits, submits themselves.

Skipped domains:
- `linkedin.com/*` — the auto-apply engine already handles it there
- `autoapplymax.com` — nothing to draft on our own site

## Simplify feature parity

Matches Simplify's "AI Generate" button on form questions
(https://simplify.jobs/copilot §"Craft personalized responses with AI").
Users click into a textarea like "Why are you a good fit for this role?",
hit the AI button, get a draft in ~3-4s.

## Integration into manifest.json

The current `manifest.json` v2.5.13 has this content_scripts block for
non-LinkedIn sites — insert `core/ai-draft-manual.js` at the END of the
`js` array (order matters: it depends on `EAM.aiForm.askAI` from `ai-form.js`):

```jsonc
{
  "matches": ["<all_urls>"],
  "exclude_matches": [
    "https://*.linkedin.com/*",
    "https://autoapplymax.com/*",
    "https://www.autoapplymax.com/*"
  ],
  "js": [
    "core/utils.js",
    "core/job-board-strings.js",
    "core/site-registry.js",
    "core/autofill.js",
    "core/ai-autofill.js",
    "adapters/base-adapter.js",
    "core/ai-form.js",
    "core/form-filler.js",
    "adapters/indeed-adapter.js",
    "core/ai-draft-manual.js",   // ← ADD THIS LINE
    "core/engine.js"
  ],
  "run_at": "document_idle"
}
```

Also add to `web_accessible_resources` if any dynamic loading is needed
(probably not).

## Testing procedure

1. Load unpacked extension in Chrome (chrome://extensions → Load unpacked → chrome-store-release/)
2. Visit https://www.indeed.com/jobs and click any Apply with Indeed
3. Confirm "✨ AI Draft" button appears next to any `<textarea>` in the form
4. Sign in to AutoApplyMax first (else button will show ⚠ Error — auth
   required, same as auto-apply AI form-answer)
5. Click AI Draft → wait 3-5s → textarea should populate
6. Test on Greenhouse (boards.greenhouse.io), Workday, Lever

## Failure modes handled

- `EAM.aiForm` not loaded → retries 20× with 250ms backoff, then aborts silently
- User not signed in → `askAI` returns null via existing `premium_required`/`unauthorized` path
- Textarea already has 30+ chars typed → skip injection (user is mid-write)
- Textarea too small (< 200×40 px) → skip (probably a search box, not a question)
- No meaningful label found (< 8 chars) → skip
- Frameworks (React, Vue, Angular) → dispatches `input` + `change` events for state update

## Analytics events to add (future)

Wire PostHog when this ships:
- `ai_draft_shown` (per session, count of buttons injected)
- `ai_draft_clicked` (per click)
- `ai_draft_success` (answer received + inserted)
- `ai_draft_edited` (user modified the AI-inserted text before submit)
