# Match Score badge — integration notes

Feature spec + integration steps for `match-score-badge.js`.

## What it does

Injects a "78% match" badge next to the job title on LinkedIn, Indeed,
Glassdoor, and Welcome to the Jungle job pages. Colour-coded:
- **≥75** = green (Great match)
- **55-75** = yellow (Decent)
- **30-55** = orange (Weak)
- **<30** = red (Poor)

Click badge → panel opens (bottom-right) showing:
- Score + label + `matched/total` keyword count
- Missing keywords (red chips) — up to 15
- Matched keywords (green chips) — up to 12
- CTA: "Tailor CV for this job →" (opens dashboard CV gen)

100% client-side. No AI call, no server round-trip. Instant. Uses
`chrome.storage.local` for user CV text (falls back to profile fields
if `cvText` not stored).

## Simplify parity + differences

Matches Simplify's "Resume Score + Keyword Match on job page" concept.
Differences vs Simplify:
- Ours is keyword-only (Simplify uses their proprietary model)
- Ours is 100% client-side (Simplify calls their API)
- Ours updates instantly on SPA nav (Simplify sometimes lags)

## Integration into manifest.json

The current `manifest.json` v2.5.13 content_scripts block for
non-LinkedIn sites plus a NEW block for LinkedIn jobs pages:

```jsonc
{
  "matches": [
    "https://www.linkedin.com/jobs/view/*",
    "https://www.linkedin.com/jobs/collections/*",
    "https://www.linkedin.com/jobs/search/*",
    "https://*.indeed.com/viewjob*",
    "https://*.indeed.com/jobs*",
    "https://www.glassdoor.com/job-listing/*",
    "https://www.glassdoor.com/Job/*",
    "https://www.welcometothejungle.com/*/jobs/*"
  ],
  "js": [
    "core/match-score-badge.js"
  ],
  "run_at": "document_idle"
}
```

Match Score is standalone — no dependency on other EAM.* namespaces.
Can run before `ai-form.js` loads.

## Testing procedure

1. Load unpacked extension in Chrome (`chrome://extensions` → Load unpacked → chrome-store-release/)
2. Ensure your Smart Profile has CV text (or upload a CV so `cv_data.summary` etc. gets populated)
3. Visit any LinkedIn job:
   `https://www.linkedin.com/jobs/view/[JOB_ID]/`
4. Verify a badge like "72% match" appears next to the job title
5. Click badge → panel bottom-right shows matched + missing keywords
6. Change page (click next job in search) → badge re-renders for new job
7. Test on Indeed job page → same behavior
8. Test with no profile → badge does NOT show (silent fail-safe)

## Failure modes handled

- No matching DOM (site DOM changed) → no badge, no error
- User has no CV text stored → no badge
- Very short JD (<100 chars) → no badge
- No extractable keywords → no badge (silent)
- SPA navigation (LinkedIn) → observer rescan on DOM change, 700ms debounce
- URL change without full navigation → polling every 800ms detects it

## Analytics events to add (future)

- `match_score_shown` (per unique job)
- `match_score_panel_opened`
- `match_score_tailor_cv_clicked` (best proxy for conversion)
- `match_score_avg_computed` (distribution — sanity check keyword-match tuning)

## Known limitations

- Keyword matching is naive: no synonym detection ("developed" != "built" != "engineered").
  For semantic matching we'd need the full `ats-analyzer.js` port OR a
  server call (adds latency).
- Frequency-count trimmed to top 40 JD keywords. Could miss rare-but-critical ones.
- No language detection — STOP_WORDS list covers EN + FR only. ES/DE/etc. profiles get
  slightly worse scores due to unfiltered stop words in the JD.
