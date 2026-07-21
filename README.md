# Line Balance (working title)

A mobile idle factory-puzzle game — Satisfactory's throughput-math satisfaction, minimized to 2D and a phone screen. Place production buildings on a grid, connect them with conveyor belts, and fix throughput bottlenecks. Backpressure makes jams visible; idle income accrues offline.

Built with plain HTML5 + Canvas + JavaScript (no build step, no dependencies) so it runs instantly in any browser and wraps to Android via Capacitor.

## Run it

Open `index.html` in a browser. That's it — it's fully self-contained.

## What's here (Act 1 vertical slice)

`index.html` is the current playable slice, driven by the game's own recipe data:

- **Grid map** seeded with ore deposits (faint until scanned; richness shown as pips).
- **Buildings:** Extractor (goes on a deposit), Smelting Furnace, Fabricator (pick its recipe), Splitter (1→3), Assembly Terminal (delivery goal), Generator (tap for power).
- **Strict ports:** one belt per port, one port per distinct good — combine streams with a Merger (coming), split with a Splitter.
- **Belts:** tap a source building then a destination; the belt auto-routes on the grid and **cannot cross** another belt.
- **Hybrid sim:** authoritative rate-based backpressure math with item sprites riding the belts. Overfeed a machine and the line backs up to a stalled source — exactly the bottleneck you have to solve.
- **Analyze panel** shows per-machine rate / utilization / buffers.

Play: tap **Extractor** → tap an ore deposit; add a **Smelting Furnace** and **Fabricator**; wire them together with **Belt**; deliver to the **Assembly Terminal**.

## Design notes

- Recipe **ratios and timings** are derived from Satisfactory's production tree and then re-skinned to original names/materials (grounded-industrial theme) — the mechanics are generic, the names/art are original. A single `RATE_SCALE` (×100) maps the source's small per-machine rates onto this game's 3000/min belt world while preserving every ratio.
- Full machine-readable dataset (100 materials, 204 recipes incl. alternates) lives in `data/line_balance_game_data.json` — the sim kernel is written to be driven by it.
- Tunable constants are read from `window.__config` (storage cap, belt caps, richness, extractor multipliers, rate scale, battery) so tests and balancing can override them.
- `prototypes/` holds earlier mechanic proofs, kept for reference.

## Repo layout

```
index.html                         # Act 1 playable slice
data/line_balance_game_data.json   # full re-skinned recipe/material dataset
prototypes/                        # earlier standalone mechanic prototypes
```

Design docs (GDD, materials tree, mechanics spec, pre-production plan) live in the Claude project for this game.
