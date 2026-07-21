# Line Balance (working title)

A mobile idle factory-puzzle game — Satisfactory's throughput-math satisfaction, minimized to 2D and a phone screen. Place production buildings on a grid, connect them with conveyor belts, and fix throughput bottlenecks. Backpressure makes jams visible; idle income accrues offline.

Built with plain HTML5 + Canvas + JavaScript (no build step, no dependencies) so it runs instantly in any browser and wraps to Android via Capacitor.

## Run it

Open `index.html` in a browser. That's it — it's fully self-contained. Progress autosaves to the browser (`localStorage`) and picks up where you left off, including catching up on offline earnings.

## What's here (Act 1 vertical slice)

`index.html` is the current playable slice, driven by the game's own recipe data:

- **Grid map** seeded with ore deposits — **fully invisible until scanned** (only one starter deposit is visible at boot). Select the **Scan** tool and drag a rectangle over the grid to reveal every deposit inside it (type, richness, exact position), permanently.
- **Buildings:** Extractor (goes on a discovered deposit — choose its tier, T1/T2/T3, at placement, tiers T2/T3 gated behind tech progress), Smelting Furnace, Fabricator (pick its recipe), Splitter (1→3), Merger (up to 3→1, same-good only), Storage Room (large inline buffer), Assembly Terminal (multi-good, multi-tier delivery goal), Generator (tap for power).
- **Splitter and Merger can be spliced directly onto an existing belt** — place either one on a belt cell instead of an empty one and it splices in, cutting the belt into a before/after segment automatically, instead of requiring a standalone node wired up from scratch.
- **Strict ports:** one belt per port, one port per distinct good — combine streams with a Merger, split with a Splitter.
- **Belts are drawn manually, cell by cell** — two tiers, Belt T1 (3000/min, always available) and Belt T2 (6000/min, unlocks with tech progress). Tap a source building to arm it, then tap each adjacent empty cell in turn to lay the belt, then tap an adjacent destination to finish. Tap the last-placed cell again to undo it; re-tap the armed source with nothing drawn to cancel. Belts **cannot cross** each other — you route around by hand. (There is no auto-route/BFS pathing in the UI anymore — that's a deliberate design choice, so the player decides how the conveyor layout fits together.)
- **Tech-tier progression:** deliver a bundle of finished goods to the Assembly Terminal to complete the current tier and unlock the next set of tools — Tier 1 unlocks Splitter/Merger/Scanning, Tier 2 unlocks Belt T2/Storage Room/Extractor T2, Tier 3 unlocks Extractor T3. Locked tools show disabled in the build palette; the extractor tier picker only offers tiers you've actually unlocked. The turn-in schedule's shape is adapted from Satisfactory's own Milestone tree — the specific quantities are a placeholder pending a rebalancing pass.
- **Hybrid sim:** authoritative rate-based backpressure math with item sprites riding the belts. Overfeed a machine and the line backs up to a stalled source — exactly the bottleneck you have to solve. Every belt enforces its own tier's throughput cap.
- **Analyze panel** shows per-machine rate / utilization / buffers.
- **Save / offline earnings:** autosaves every 5s and on tab-close; reloading fast-forwards the same sim over real elapsed time (capped at 8h) and reports what you earned while away. A "New" button in the header clears the save and starts over.

Play: tap **Scan** and drag over the map to reveal deposits → tap **Extractor** → tap a revealed deposit → pick a tier; add a **Smelting Furnace** and **Fabricator**; wire them together by tapping out a **Belt** cell by cell; deliver to the **Assembly Terminal** to unlock more tools.

## Design notes

- Recipe **ratios and timings** are derived from Satisfactory's production tree and then re-skinned to original names/materials (grounded-industrial theme) — the mechanics are generic, the names/art are original. A single `RATE_SCALE` (×100) maps the source's small per-machine rates onto this game's 3000/min belt world while preserving every ratio.
- The tech-tier turn-in schedule (which goods gate which tier, which tools unlock together) is likewise adapted from Satisfactory's real Milestone tree, re-skinned and scaled down — an explicit placeholder for the numbers, not the system, pending a rebalancing pass.
- Full machine-readable dataset (100 materials, 204 recipes incl. alternates) lives in `data/line_balance_game_data.json` — the sim kernel is written to be driven by it, though the playable slice still uses a small hand-authored recipe subset day to day.
- Tunable constants are read from `window.__config` (storage cap, belt caps, richness, extractor multipliers, rate scale, battery, offline-earnings cap) so tests and balancing can override them.
- `window.__game` exposes a test API (`reset`, `place`, `connect` (accepts an optional explicit path as its 4th argument), `tickN`, `node`, `state`, `deposits`, `findDeposit`, `scanRegion`, `discoverAll`, `tierUnlocked`, `TIERS`, `deliverToTerminal`, `cellPx`, `uiState`, `saveGame`/`loadGame`/`clearSave`) — see `tests/regression.js` for how it's used, including driving the real pointer/canvas UI (not just the data model) for the belt-drawing tests.
- `prototypes/` holds earlier mechanic proofs, kept for reference.

## Tests

`tests/regression.js` is a headless Playwright suite (66 checks as of the last update) covering the base chain, Splitter, Merger, Storage Room, extractor/belt tiers, Scanning, manual belt drawing (driven through the real pointer/canvas UI, not just the data API), belt splicing (Splitter and Merger spliced onto an existing belt), tech-tier gating end-to-end, and save/load + offline earnings. Run with `node tests/regression.js` — see `tests/README.md` for details (including how to get Playwright/Chromium set up). Worth running after any change to `index.html`'s sim, connection, or gating logic.

## Repo layout

```
index.html                         # Act 1 playable slice
data/line_balance_game_data.json   # full re-skinned recipe/material dataset
prototypes/                        # earlier standalone mechanic prototypes
tests/regression.js                # headless Playwright regression suite
bolted-sheets-chain.html           # standalone mechanic-proof prototype (multi-input combiner chain, backpressure math)
```

Design docs (GDD, materials tree, mechanics spec, pre-production plan) live in the Claude project for this game.
