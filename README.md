# Line Balance (working title)

A mobile idle factory-puzzle game — Satisfactory's throughput-math satisfaction, minimized to 2D and a phone screen. Place production buildings on a grid, connect them with conveyor belts, and fix throughput bottlenecks. Backpressure makes jams visible; idle income accrues offline.

Built with plain HTML5 + Canvas + JavaScript (no build step, no dependencies) so it runs instantly in any browser and wraps to Android via Capacitor.

## Run it

Open `index.html` in a browser. That's it — it's fully self-contained. Progress autosaves to the browser (`localStorage`) and picks up where you left off, including catching up on offline earnings.

## What's here (Act 1 vertical slice)

`index.html` is the current playable slice, driven by the game's own recipe data:

- **Grid map** seeded with ore deposits (faint until scanned; richness shown as pips).
- **Buildings:** Extractor (goes on a deposit — choose its tier, T1/T2/T3, at placement), Smelting Furnace, Fabricator (pick its recipe), Splitter (1→3), Merger (up to 3→1, same-good only), Storage Room (large inline buffer), Assembly Terminal (delivery goal), Generator (tap for power).
- **Strict ports:** one belt per port, one port per distinct good — combine streams with a Merger, split with a Splitter.
- **Belts:** two tiers, Belt T1 (3000/min) and Belt T2 (6000/min) — tap a source building then a destination; the belt auto-routes on the grid and **cannot cross** another belt.
- **Hybrid sim:** authoritative rate-based backpressure math with item sprites riding the belts. Overfeed a machine and the line backs up to a stalled source — exactly the bottleneck you have to solve. Every belt enforces its own tier's throughput cap.
- **Analyze panel** shows per-machine rate / utilization / buffers.
- **Save / offline earnings:** autosaves every 5s and on tab-close; reloading fast-forwards the same sim over real elapsed time (capped at 8h) and reports what you earned while away. A "New" button in the header clears the save and starts over.

Play: tap **Extractor** → tap an ore deposit → pick a tier; add a **Smelting Furnace** and **Fabricator**; wire them together with a **Belt**; deliver to the **Assembly Terminal**.

Note: none of the above is gated behind progression yet — every building/tier is freely buildable from the start. The Assembly-Terminal tech-tier unlock schedule is fully specced (see the mechanics spec in the Claude project) but not yet wired up to actually lock the build palette.

## Design notes

- Recipe **ratios and timings** are derived from Satisfactory's production tree and then re-skinned to original names/materials (grounded-industrial theme) — the mechanics are generic, the names/art are original. A single `RATE_SCALE` (×100) maps the source's small per-machine rates onto this game's 3000/min belt world while preserving every ratio.
- Full machine-readable dataset (100 materials, 204 recipes incl. alternates) lives in `data/line_balance_game_data.json` — the sim kernel is written to be driven by it, though the playable slice still uses a small hand-authored recipe subset day to day.
- Tunable constants are read from `window.__config` (storage cap, belt caps, richness, extractor multipliers, rate scale, battery, offline-earnings cap) so tests and balancing can override them.
- `window.__game` exposes a test API (`reset`, `place`, `connect`, `tickN`, `node`, `state`, `deposits`, `findDeposit`, `saveGame`/`loadGame`/`clearSave`) — see `tests/regression.js` for how it's used.
- `prototypes/` holds earlier mechanic proofs, kept for reference.

## Tests

`tests/regression.js` is a headless Playwright suite covering the base chain, Splitter, Merger, Storage Room, extractor/belt tiers, and save/load + offline earnings. Run with `node tests/regression.js` — see `tests/README.md` for details (including how to get Playwright/Chromium set up). Worth running after any change to `index.html`'s sim or connection logic.

## Repo layout

```
index.html                         # Act 1 playable slice
data/line_balance_game_data.json   # full re-skinned recipe/material dataset
prototypes/                        # earlier standalone mechanic prototypes
tests/regression.js                # headless Playwright regression suite
bolted-sheets-chain.html           # standalone mechanic-proof prototype (multi-input combiner chain, backpressure math)
```

Design docs (GDD, materials tree, mechanics spec, pre-production plan) live in the Claude project for this game.
