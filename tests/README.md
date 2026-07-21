# Regression tests

`regression.js` drives `index.html` headlessly through Playwright and exercises the parts of
the sim and UI that are easy to break silently: the base extractor→smelter→fabricator→terminal
chain, the Splitter, the Merger (build rules + the supply-weighted pull equilibrium), the Storage
Room, the Extractor tier picker (T1/T2/T3 rate math), the per-belt Belt tier caps (T1/T2),
Scanning (fog-of-war deposit discovery), manual belt drawing (driven through the real
pointer/canvas UI, not just the data API), belt splicing (Splitter/Merger placed directly onto
an existing belt), tech-tier gating end-to-end (unlocking tools and extractor tiers by delivering
to the Assembly Terminal), and save/load with offline-earnings catch-up (via a real
`page.reload()`, not just an in-memory function call).

It talks to the game mostly through `window.__game`, the test API exposed at the bottom of
`index.html`'s script — the same hook used to build and verify every feature in this file so far.
The manual-belt-drawing and extractor-tier-picker sections additionally drive the **real** canvas
via `page.mouse.click()`, using a small `cellPx(x,y)` helper on the test API (plus the canvas
element's own `getBoundingClientRect()`) to translate grid coordinates into real page pixel
coordinates — this exercises the actual click-by-click UI a player uses, not just the underlying
data model.

If a future change removes or renames something on `window.__game`, or changes the pointer-event
handling in `index.html`, this suite is what should catch it.

## Running it

```
node tests/regression.js
```

Run from anywhere — it resolves `index.html` relative to its own location (one directory up), not
the current working directory.

**Requires `playwright`** (with a Chromium build reachable). Two ways to get that:

- **Inside the Claude Cowork cloud sandbox:** Chromium is already installed at
  `/opt/pw-browsers/chromium` and this script picks it up automatically — do **not** run
  `playwright install` there, it isn't needed and the sandbox blocks the download anyway.
- **On a normal machine (e.g. Pavel's own):** `npm install playwright` and let its own postinstall
  download a Chromium build; the script falls back to Playwright's default launch (no
  `executablePath` override) whenever the sandbox path above doesn't exist.

Exit code is `0` if every check passes, non-zero otherwise, so this is safe to wire into a CI step
later without extra plumbing.

## Why this exists

Every feature built into `index.html` this project has been verified with a one-off Playwright
script that lived only in Claude's temporary cloud workspace and was never committed — meaning
each new session either had to trust old chat history or rebuild verification from scratch. This
file is the first attempt to break that pattern: a single, committed, cumulative regression suite
that grows as features are added, so "does this still work" has one command to answer it instead
of a session digging through prior conversations. It has already paid off once: extending it for
the tech-tier gating feature surfaced a real bug in the offline-catch-up test itself (a
too-early "before" measurement was masking genuine progress), which wouldn't have been obvious
without a single suite to run end to end and compare against.

When you add a new building type, sim rule, or UI flow to `index.html`, add a section here for it
before considering the feature done — same spirit as the Playwright verification that's already
been happening ad hoc all along, just kept around this time. If the new UI flow involves real
pointer interaction (not just calling something on `window.__game` directly), prefer driving it
through actual `page.mouse.click()` calls the way the manual-belt-drawing section does, rather
than only testing the underlying data function — that's the only way to catch bugs in the pointer
event handling itself.
