/**
 * Line Balance — headless regression suite for index.html
 *
 * Exercises the rate-based backpressure sim through window.__game (the test API
 * exposed at the bottom of index.html): base chain, Splitter, Merger, Storage Room,
 * Extractor tier picker (T1/T2/T3), Belt tier caps (T1/T2), and save/load +
 * offline-earnings catch-up (via a REAL page.reload(), not just an in-memory call).
 *
 * Run:  node tests/regression.js
 * Requires: `playwright` (with a Chromium build available). If you're running this
 * inside the Claude Cowork cloud sandbox, Chromium is pre-installed at
 * /opt/pw-browsers/chromium and this script picks it up automatically — do not
 * run `playwright install` there. On a normal machine, `npm install playwright`
 * (and let it download its own Chromium) works fine too.
 *
 * Exit code is 0 if every check passes, 1 otherwise — safe to wire into CI later.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const launchOpts = fs.existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};
const INDEX = path.resolve(__dirname, '..', 'index.html');

let pass = 0, fail = 0, section = '';
function sect(name) { section = name; console.log(`\n== ${name} ==`); }
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''} (in "${section}")`); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol); }

async function freshPage(browser) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
  await page.goto('file://' + INDEX);
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => { window.__game.CFG.autoPower = true; window.__game.clearSave(); window.__game.reset(); window.__game.discoverAll(); });
  return { page, pageErrors };
}

async function main() {
  if (!fs.existsSync(INDEX)) { console.error('index.html not found next to tests/ — run from the repo root or check the path.'); process.exit(1); }
  const browser = await chromium.launch(launchOpts);
  try {

  // ---------------------------------------------------------------- build palette sanity — every BUILD-defined
  // placeable type must have a corresponding button in the palette, or the player has no way to ever place it
  // through the real UI even though window.__game.place() would happily build it via the data API. This exact
  // gap once let the Assembly Terminal quietly vanish from the palette during a buildPalette() rewrite (its
  // entry was left out of the items list) while every data-API test kept passing, since G.place('terminal',...)
  // bypasses the palette entirely — so this section exists specifically to catch that class of regression.
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const always = ['extractor', 'smelter', 'fabricator', 'terminal', 'generator', 'belt1', 'scan', 'delete'];
      const buttons = Array.from(document.querySelectorAll('.tool')).map(b => ({ t: b.dataset.t, disabled: b.disabled }));
      const present = (t) => buttons.find(b => b.t === t);
      return {
        allPresent: always.every(t => !!present(t)),
        allEnabledAtBoot: always.every(t => present(t) && !present(t).disabled),
        buttonCount: buttons.length,
        types: buttons.map(b => b.t),
      };
    });
    check('build palette: core always-available tools (incl. Assembly Terminal) are present as buttons', out.allPresent, out);
    check('build palette: those core tools are enabled (not disabled) at Tier 0', out.allEnabledAtBoot, out);
    check('build palette: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- base chain
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      // rich=2 deposit (3000/min at T1) matches fab_plate's own recipe-capped max throughput (also 3000/min) —
      // a rich=1 (1000/min) deposit would legitimately starve the fabricator, which isn't what this checks.
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2);
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 1, dep.y, 'smelt_ferrite');
      const fabId = G.place('fabricator', dep.x + 2, dep.y, 'fab_plate');
      const termId = G.place('terminal', dep.x + 3, dep.y);
      const c1 = G.connect(exId, smId), c2 = G.connect(smId, fabId), c3 = G.connect(fabId, termId);
      G.tickN(30);
      const st = G.state();
      return { connectsOk: !c1.err && !c2.err && !c3.err, lifetimeDelivered: st.lifetimeDelivered, fabUtil: st.nodes[fabId].util };
    });
    check('base chain: all connects ok', out.connectsOk, out);
    check('base chain: lifetimeDelivered > 0 after 30s (terminal accepted some ferrite_plate toward Tier 1)', out.lifetimeDelivered > 0, out);
    check('base chain: fabricator reaches healthy utilization (>0.9)', out.fabUtil > 0.9, out);
    check('base chain: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- splitter
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const spId = G.place('splitter', dep.x + 1, dep.y);
      const sm1 = G.place('smelter', dep.x + 2, dep.y - 1, 'smelt_ferrite');
      const sm2 = G.place('smelter', dep.x + 2, dep.y + 1, 'smelt_ferrite');
      const c1 = G.connect(exId, spId), c2 = G.connect(spId, sm1), c3 = G.connect(spId, sm2);
      G.tickN(20);
      const st = G.state();
      return { allOk: !c1.err && !c2.err && !c3.err,
        sm1In: st.nodes[sm1].inBuf['ferrite_ore'] || 0, sm2In: st.nodes[sm2].inBuf['ferrite_ore'] || 0 };
    });
    check('splitter: builds (1 source, 2 branches)', out.allOk, out);
    check('splitter: both branches received flow', out.sm1In > 0 && out.sm2In > 0, out);
    check('splitter: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- merger
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const dep1 = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 1); // 1000/min
      const dep2 = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2); // 3000/min
      const ex1 = G.place('extractor', dep1.x, dep1.y, null, 1);
      const ex2 = G.place('extractor', dep2.x, dep2.y, null, 1);
      const mgId = G.place('merger', 7, 5);
      // smelter's own recipe caps it at 3000 ore/min regardless of supply — that's the "downstream demand" the
      // merger's two inputs settle against. fabricator+terminal beyond it is a real sink so nothing saturates
      // into a permanent full-buffer stall before the steady-state utilizations are read.
      const smId = G.place('smelter', 10, 5, 'smelt_ferrite');
      const fabId = G.place('fabricator', 12, 5, 'fab_plate');
      const termId = G.place('terminal', 14, 5);
      // placed well clear of the merger's own neighbor cells (not boxing it in) so its own routing succeeds
      const badGood = G.place('smelter', 7, 9, 'smelt_cuprite'); // to test wrong-good rejection via a 3rd input
      const c1 = G.connect(ex1, mgId), c2 = G.connect(ex2, mgId);
      const c3 = G.connect(mgId, smId), c4 = G.connect(smId, fabId), c5 = G.connect(fabId, termId);
      const c6 = G.connect(badGood, mgId); // wrong good — cuprite into a ferrite merger, must be rejected
      G.tickN(40);
      const st = G.state();
      return { buildOk: !c1.err && !c2.err && !c3.err && !c4.err && !c5.err, wrongGoodRejected: !!c6.err,
        ex1Util: st.nodes[ex1].util, ex2Util: st.nodes[ex2].util, lifetimeDelivered: st.lifetimeDelivered };
    });
    check('merger: 2 same-good inputs + 1 output all connect', out.buildOk, out);
    check('merger: rejects a different-good 3rd input', out.wrongGoodRejected, out);
    check('merger: smaller producer (1000/min) saturates near 100% util', out.ex1Util > 0.95, out);
    check('merger: larger producer (3000/min) throttles to fill remaining demand (~0.6-0.75 util)', out.ex2Util > 0.55 && out.ex2Util < 0.8, out);
    check('merger: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- storage room
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const srId = G.place('storageroom', dep.x + 1, dep.y);
      const smId = G.place('smelter', dep.x + 2, dep.y, 'smelt_ferrite');
      const extraSm = G.place('smelter', dep.x + 2, dep.y + 1, 'smelt_ferrite');
      const c1 = G.connect(exId, srId), c2 = G.connect(srId, smId);
      const c3 = G.connect(srId, extraSm); // storage room is single-input/single-output — 2nd OUTPUT is fine, but 2nd INPUT should fail
      const c4 = G.connect(exId, srId); // 2nd belt into the SAME input port should fail
      G.tickN(20);
      return { firstConnectsOk: !c1.err && !c2.err, secondInputRejected: !!c4.err };
    });
    check('storage room: builds inline in a chain', out.firstConnectsOk, out);
    check('storage room: rejects a 2nd belt on its single input port', out.secondInputRejected, out);
    check('storage room: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- extractor tiers
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2); // richness=3000
      const results = [1, 2, 3].map(tier => {
        G.reset(); G.discoverAll();
        const d = G.deposits().find(x => x.good === 'ferrite_ore' && x.rich === 2);
        const exId = G.place('extractor', d.x, d.y, null, tier);
        return { tier, rate: G.node(exId).rate };
      });
      return results;
    });
    check('extractor T1 rate = richness × 1 = 3000', approx(out[0].rate, 3000), out[0]);
    check('extractor T2 rate = richness × 2 = 6000', approx(out[1].rate, 6000), out[1]);
    check('extractor T3 rate = richness × 4 = 12000', approx(out[2].rate, 12000), out[2]);
    check('extractor tiers: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- belt tiers
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      function flowAfter(tier, extractorTier) {
        G.reset(); G.discoverAll();
        const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2);
        const exId = G.place('extractor', dep.x, dep.y, null, extractorTier);
        const srId = G.place('storageroom', dep.x + 2, dep.y);
        const c = G.connect(exId, srId, tier);
        G.tickN(3); // short warmup, well before the storage buffer (cap 5000) fills
        const st = G.state();
        return { err: c.err, flow: Math.round(st.belts[0].flow), cap: st.belts[0].cap, beltTier: st.belts[0].tier };
      }
      return {
        t2BeltCapsHighSupply: flowAfter(2, 3),   // T3 extractor (12000) through a T2 belt (cap 6000) -> belt-bound
        t1BeltCapsHighSupply: flowAfter(1, 3),   // same extractor through a T1 belt (cap 3000) -> belt-bound, half of T2
        defaultBeltIsT1: flowAfter(undefined, 1), // connect() with no tier arg -> back-compat T1/3000
      };
    });
    check('belt T2 caps a high-supply extractor at 6000/min (scaled: 60)', approx(out.t2BeltCapsHighSupply.flow, 60, 2), out.t2BeltCapsHighSupply);
    check('belt T1 caps the same extractor at 3000/min (scaled: 30) — exactly half of T2', approx(out.t1BeltCapsHighSupply.flow, 30, 2), out.t1BeltCapsHighSupply);
    check('connect() with no tier arg defaults to T1 (cap 3000) for back-compat', out.defaultBeltIsT1.beltTier === 1 && out.defaultBeltIsT1.cap === 3000, out.defaultBeltIsT1);
    check('belt tiers: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- scanning / fog-of-war deposits
  {
    const { page, pageErrors } = await freshPage(browser); // freshPage calls discoverAll() — undo that for this section
    const out = await page.evaluate(() => {
      const G = window.__game;
      G.reset(); // back to the real default: only the starter deposit discovered
      const all = G.deposits();
      const undiscoveredBefore = all.filter(d => !d.discovered).length;
      const discoveredBefore = all.filter(d => d.discovered).length;
      const hidden = all.find(d => !d.discovered);
      const placeOnHiddenBlocked = G.place('extractor', hidden.x, hidden.y, null, 1) === null;
      const revealedCount = G.scanRegion(hidden.x, hidden.y, hidden.x, hidden.y); // 1x1 box exactly on the hidden deposit
      const nowDiscovered = G.deposits().find(d => d.x === hidden.x && d.y === hidden.y).discovered;
      const placeAfterReveal = G.place('extractor', hidden.x, hidden.y, null, 1) !== null;
      const rescanSameSpotFindsNothingNew = G.scanRegion(hidden.x, hidden.y, hidden.x, hidden.y) === 0;
      return { discoveredBefore, undiscoveredBefore, placeOnHiddenBlocked, revealedCount, nowDiscovered, placeAfterReveal, rescanSameSpotFindsNothingNew };
    });
    check('scanning: exactly one starter deposit is discovered by default', out.discoveredBefore === 1, out);
    check('scanning: the rest start undiscovered (fully hidden)', out.undiscoveredBefore > 0, out);
    check('scanning: placing an extractor on a hidden deposit is blocked', out.placeOnHiddenBlocked, out);
    check('scanning: scanRegion over a hidden deposit reveals exactly it', out.revealedCount === 1 && out.nowDiscovered, out);
    check('scanning: extractor placement succeeds once revealed', out.placeAfterReveal, out);
    check('scanning: re-scanning an already-discovered spot reveals nothing new', out.rescanSameSpotFindsNothingNew, out);
    check('scanning: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- manual belt drawing (driven through the
  // REAL pointer/canvas UI via page.mouse.click, not window.__game.connect — this is the actual click-by-click
  // path a player uses now that belts no longer auto-route between a tapped source and destination).
  {
    const { page, pageErrors } = await freshPage(browser);
    async function clickCell(x, y) {
      const pt = await page.evaluate(([gx, gy]) => window.__game.cellPx(gx, gy), [x, y]);
      const rect = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { left: r.left, top: r.top }; });
      await page.mouse.click(rect.left + pt.x, rect.top + pt.y);
    }
    const setup = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 1); // (2,3)
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 3, dep.y, 'smelt_ferrite'); // 3 cells away so the drawn path is non-trivial
      return { exId, smId, depX: dep.x, depY: dep.y };
    });
    await page.click('[data-t="belt1"]'); // select the Belt T1 tool
    await clickCell(setup.depX, setup.depY); // tap the source building
    const armed = await page.evaluate(() => window.__game.uiState());
    const sourceArmed = armed.beltSrc === setup.exId && armed.beltPath.length === 0;

    // re-tapping the source with nothing drawn yet cancels
    await clickCell(setup.depX, setup.depY);
    const cancelled = await page.evaluate(() => window.__game.uiState());
    const cancelWorked = cancelled.beltSrc === null;

    // re-arm, then tap a cell that ISN'T adjacent to the source — should be rejected, path stays empty
    await page.click('[data-t="belt1"]');
    await clickCell(setup.depX, setup.depY);
    await clickCell(setup.depX + 2, setup.depY); // 2 cells away, not adjacent
    const rejected = await page.evaluate(() => window.__game.uiState());
    const nonAdjacentRejected = rejected.beltPath.length === 0;

    // draw a real 2-cell path cell-by-cell
    await clickCell(setup.depX + 1, setup.depY);
    await clickCell(setup.depX + 2, setup.depY);
    const drawn = await page.evaluate(() => window.__game.uiState());
    const pathDrawn = drawn.beltPath.length === 2;

    // undo: tapping the last-placed cell again pops it
    await clickCell(setup.depX + 2, setup.depY);
    const undone = await page.evaluate(() => window.__game.uiState());
    const undoWorked = undone.beltPath.length === 1;

    // redo the undone cell, then tap the destination building to finish the belt
    await clickCell(setup.depX + 2, setup.depY);
    await clickCell(setup.depX + 3, setup.depY);
    const finished = await page.evaluate(() => ({ state: window.__game.state(), ui: window.__game.uiState() }));
    const beltBuilt = finished.state.belts.length === 1 && finished.state.belts[0].len === 2
      && finished.state.belts[0].src === setup.exId && finished.state.belts[0].dst === setup.smId;
    const uiResetAfterFinish = finished.ui.beltSrc === null && finished.ui.beltPath.length === 0;

    // belts can't cross: starting a fresh belt and stepping onto the belt cell just drawn is rejected
    await page.click('[data-t="belt1"]');
    await clickCell(setup.depX, setup.depY);
    await clickCell(setup.depX + 1, setup.depY); // now occupied by the belt above
    const crossingAttempt = await page.evaluate(() => window.__game.uiState());
    const crossingRejected = crossingAttempt.beltPath.length === 0;

    check('manual belt: tapping a building arms it as the belt source', sourceArmed, armed);
    check('manual belt: re-tapping the armed source with an empty path cancels', cancelWorked, cancelled);
    check('manual belt: tapping a non-adjacent cell is rejected (no auto-routing)', nonAdjacentRejected, rejected);
    check('manual belt: cell-by-cell taps extend the drawn path', pathDrawn, drawn);
    check('manual belt: tapping the last-drawn cell again undoes it', undoWorked, undone);
    check('manual belt: tapping the destination building finishes the belt along the exact drawn path', beltBuilt, finished);
    check('manual belt: UI resets (no armed source/path) after a belt completes', uiResetAfterFinish, finished);
    check("manual belt: stepping onto an existing belt cell is rejected (belts can't cross)", crossingRejected, crossingAttempt);
    check('manual belt: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- belt splicing (Splitter / Merger placed
  // directly onto an existing belt, splitting it into two segments instead of requiring a standalone node)
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      // Splitter spliced into a belt
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 1); // (2,3)
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 3, dep.y, 'smelt_ferrite');
      const c1 = G.connect(exId, smId); // auto-routed straight line
      const beltBefore = G.state().belts[0];
      const spliceX = beltBefore.path[0][0], spliceY = beltBefore.path[0][1]; // first cell of the belt's own path
      const spId = G.place('splitter', spliceX, spliceY); // splices, doesn't need an empty cell
      const afterSplice = G.state();
      const smId2 = G.place('smelter', dep.x + 3, dep.y - 2, 'smelt_ferrite'); // a 2nd destination for the splitter
      const c2 = G.connect(spId, smId2);
      G.tickN(3);
      const st1 = G.state();
      const splitterBranches = st1.belts.filter(b => b.src === spId);

      // Merger spliced into a belt
      const depB = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2); // (3,7)
      const exB1 = G.place('extractor', depB.x, depB.y, null, 1);
      const smB1 = G.place('smelter', depB.x + 3, depB.y, 'smelt_ferrite');
      const cB1 = G.connect(exB1, smB1);
      const beltB = G.state().belts.find(b => b.src === exB1);
      const mgX = beltB.path[0][0], mgY = beltB.path[0][1];
      const mgId = G.place('merger', mgX, mgY); // splices, doesn't need an empty cell
      const exB2 = G.place('extractor', 11, 8, null, 1); // a different ferrite_ore deposit feeding the merger's spare input
      const cB2 = G.connect(exB2, mgId);
      G.tickN(3);
      const st2 = G.state();
      const mergerInputs = st2.belts.filter(b => b.dst === mgId);
      const mergerOutput = st2.belts.find(b => b.src === mgId);

      return {
        c1Err: c1.err, spIdOk: spId != null, splitCount: afterSplice.belts.length,
        c2Err: c2.err, splitterBranchCount: splitterBranches.length, splitterFlowsOk: splitterBranches.every(b => b.flow > 0),
        cB1Err: cB1.err, mgIdOk: mgId != null, cB2Err: cB2.err,
        mergerInputCount: mergerInputs.length, mergerOutputFlowOk: !!mergerOutput && mergerOutput.flow > 0,
      };
    });
    check('splice: base belt connects cleanly before splicing', !out.c1Err, out);
    check('splice: placing a Splitter on an existing belt cell splices it in (no teardown needed)', out.spIdOk, out);
    check('splice: the original belt is split into two segments', out.splitCount === 2, out);
    check('splice: a 2nd output connects straight off the newly-spliced Splitter', !out.c2Err && out.splitterBranchCount === 2, out);
    check('splice: both splitter branches carry flow after ticking', out.splitterFlowsOk, out);
    check('splice: placing a Merger on an existing belt cell splices it in', out.mgIdOk, out);
    check('splice: a 2nd input connects straight into the newly-spliced Merger', !out.cB2Err && out.mergerInputCount === 2, out);
    check('splice: the merged output carries flow after ticking', out.mergerOutputFlowOk, out);
    check('splice: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- tech-tier gating end-to-end (Satisfactory-
  // style milestone schedule: TIERS/TOOL_UNLOCK_TIER/EXTRACTOR_TIER_UNLOCK in index.html). Note: the gate lives
  // in the UI layer (buildPalette() disables locked tool buttons, askExtractorTier() omits locked tiers from
  // the picker) rather than as a hard runtime check inside place() — same pattern as the rest of the build UI,
  // which doesn't re-validate things like power availability at the data layer either.
  //
  // Tier 1 is a SINGLE good (30 Ferrite Plate), reachable from just the one starter deposit with a plain
  // extractor->smelter->fabricator->terminal chain — mirrors Satisfactory's own HUB Upgrade 1 (10x Iron Rod,
  // one item, before copper is even reachable). This is a deliberate fix for a real softlock an earlier
  // version of this schedule had: it required Braided Cable (a Cuprite/copper-chain good) at Tier 1, but
  // Scanning — the only way to ever find a Cuprite deposit — was ALSO gated behind Tier 1, an unwinnable
  // circular dependency that a real player (Pavel) hit immediately when he tried to play the build. Scanning
  // is now always unlocked (see the "scan" checks below), matching how Satisfactory's own Resource Scanner is
  // available from the very start. Multi-good/multi-ore requirements only start at Tier 2, once Splitter/
  // Merger (unlocked at Tier 1) make it practical to branch one smelter's ingot output across two fabricators.
  {
    const { page, pageErrors } = await freshPage(browser);
    const btnDisabled = (t) => page.evaluate((t) => document.querySelector(`[data-t="${t}"]`).disabled, t);

    // Softlock guard: Tier 1 must be a single good, reachable from a plain extractor->smelter->fabricator
    // chain on the one deposit the player starts with. If a future rebalance makes Tier 1 need a second good
    // whose ore isn't the starter deposit's, the player would need to find that ore first — impossible unless
    // Scanning also stays unlocked from the start, which is a coupling this check can't fully verify by
    // itself, so it errs on the strict side: Tier 1 should just need ONE thing.
    const tier1ShapeIsSoftlockSafe = await page.evaluate(() => window.__game.TIERS[0].need.length === 1);

    const tier0 = {
      splitterLocked: !(await page.evaluate(() => window.__game.tierUnlocked('splitter'))),
      splitterBtnDisabled: await btnDisabled('splitter'),
      belt2BtnDisabled: await btnDisabled('belt2'),
      scanUnlockedFromStart: await page.evaluate(() => window.__game.tierUnlocked('scan')),
      scanBtnEnabledFromStart: !(await btnDisabled('scan')),
    };

    const afterTier1 = await page.evaluate(() => {
      const G = window.__game;
      const termId = G.place('terminal', 9, 9);
      G.deliverToTerminal(termId, 'ferrite_plate', 30); // Tier 1's entire quota — one good, no Splitter/2nd-ore needed
      G.tickN(1); // sim() processes the delivery and calls advanceTier() once the quota is met
      return { termId, techTier: G.state().techTier, splitterUnlocked: G.tierUnlocked('splitter'), mergerUnlocked: G.tierUnlocked('merger') };
    });
    const tier1Buttons = { splitterBtnDisabled: await btnDisabled('splitter'), belt2StillDisabled: await btnDisabled('belt2') };

    const afterTier2 = await page.evaluate((termId) => {
      const G = window.__game;
      G.deliverToTerminal(termId, 'castcrete', 20);
      G.deliverToTerminal(termId, 'ferrite_rod', 20);
      G.deliverToTerminal(termId, 'braided_cable', 20);
      G.tickN(1);
      return { techTier: G.state().techTier, belt2Unlocked: G.tierUnlocked('belt2'), storageroomUnlocked: G.tierUnlocked('storageroom') };
    }, afterTier1.termId);
    const tier2Buttons = { belt2BtnDisabled: await btnDisabled('belt2'), storageroomBtnDisabled: await btnDisabled('storageroom') };

    // extractor tier picker: at Tier 2, EXTRACTOR_TIER_UNLOCK gates T3 (needs techTier>=3) but not T1/T2
    const dep0 = await page.evaluate(() => window.__game.deposits().find(d => d.good === 'chalkstone'));
    const pt = await page.evaluate(([gx, gy]) => window.__game.cellPx(gx, gy), [dep0.x, dep0.y]);
    const rect = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { left: r.left, top: r.top }; });
    await page.click('[data-t="extractor"]');
    await page.mouse.click(rect.left + pt.x, rect.top + pt.y);
    const extractorOptionsAtTier2 = await page.evaluate(() => Array.from(document.querySelectorAll('#rpOpts .opt')).length);
    await page.click('#rpCancel');

    check('tier gating: Tier 1 is a single good (softlock guard — reachable from the starter deposit alone)', tier1ShapeIsSoftlockSafe, tier1ShapeIsSoftlockSafe);
    check('tier gating: Splitter/Belt T2 are locked at Tier 0', tier0.splitterLocked && tier0.splitterBtnDisabled && tier0.belt2BtnDisabled, tier0);
    check('tier gating: Scan is unlocked from the very start (not gated), so it can never softlock Tier 1', tier0.scanUnlockedFromStart && tier0.scanBtnEnabledFromStart, tier0);
    check("tier gating: delivering Tier 1's single-good quota (30 Ferrite Plate, from just the starter deposit) advances techTier to 1", afterTier1.techTier === 1, afterTier1);
    check('tier gating: Splitter/Merger unlock together at Tier 1', afterTier1.splitterUnlocked && afterTier1.mergerUnlocked, afterTier1);
    check('tier gating: Splitter tool button becomes enabled at Tier 1, Belt T2 stays locked', !tier1Buttons.splitterBtnDisabled && tier1Buttons.belt2StillDisabled, tier1Buttons);
    check("tier gating: delivering Tier 2's full quota (3 goods: Castcrete/Ferrite Rod/Braided Cable) advances techTier to 2", afterTier2.techTier === 2, afterTier2);
    check('tier gating: Belt T2/Storage Room unlock at Tier 2', afterTier2.belt2Unlocked && afterTier2.storageroomUnlocked, afterTier2);
    check('tier gating: Belt T2/Storage Room tool buttons become enabled at Tier 2', !tier2Buttons.belt2BtnDisabled && !tier2Buttons.storageroomBtnDisabled, tier2Buttons);
    check('tier gating: extractor tier picker offers only T1+T2 (not T3) at Tier 2', extractorOptionsAtTier2 === 2, extractorOptionsAtTier2);
    check('tier gating: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- save / load + offline earnings
  {
    const { page, pageErrors } = await freshPage(browser);
    const before = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'cuprite_ore');
      const exId = G.place('extractor', dep.x, dep.y, null, 3);
      const smId = G.place('smelter', dep.x + 1, dep.y, 'smelt_cuprite');
      G.connect(exId, smId, 2);
      window.__savedExId = exId;
      G.saveGame();
      return { exId, tier: G.node(exId).tier, rate: G.node(exId).rate };
    });
    await page.reload();
    await page.waitForFunction(() => window.__game);
    const afterReload = await page.evaluate((exId) => {
      const st = window.__game.state();
      return { nodeCount: Object.keys(st.nodes).length, beltCount: st.belts.length,
        tier: st.nodes[exId] && st.nodes[exId].tier, rate: st.nodes[exId] && st.nodes[exId].rate,
        beltCap: st.belts[0] && st.belts[0].cap };
    }, before.exId);
    check('save/load: state survives a real page.reload()', afterReload.nodeCount === 2 && afterReload.beltCount === 1, afterReload);
    check('save/load: extractor tier preserved across reload', afterReload.tier === before.tier && approx(afterReload.rate, before.rate), { before, afterReload });
    check('save/load: belt tier/cap preserved across reload', afterReload.beltCap === 6000, afterReload);
    await page.close();
  }
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      // Reproduces a realistic played-for-a-bit-then-left-running base: a Tier-1 chain (single good, from the
      // starter deposit alone) is built and connected first — this is the only chain that CAN be wired to the
      // terminal while Tier 0 is active, since the terminal only accepts goods in the *current* tier's need
      // list. It's ticked live until Tier 1 completes, at which point three more independent chains (Rod,
      // Cable, Castcrete — Tier 2's requirement) are connected, now that they're valid deliveries. Only then
      // is the game saved and offline catch-up simulated, so the 1-hour jump gets to carry the base through
      // Tier 1 -> Tier 2 for real, the way a player's session actually would.
      //
      // Every connection here uses an EXPLICIT path (this game's manual belt-drawing model, and the same 4th
      // argument the real UI always supplies) instead of relying on BFS auto-routing to guess a path through
      // an increasingly-congested grid — a prior version of this test that used auto-routing intermittently
      // failed with "No clear belt path" once enough belts had claimed cells near the shared terminal. Explicit
      // paths make the whole layout deterministic. Four independent chains (one per required good), each
      // rooted at its own fixed ore-deposit seed, all converge on one centrally-placed terminal.
      const depPlate = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 1); // (2,3)
      const depRod = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2 && d.x === 3); // (3,7)
      const depCable = G.deposits().find(d => d.good === 'cuprite_ore' && d.rich === 1 && d.x === 6); // (6,2)
      const depCast = G.deposits().find(d => d.good === 'chalkstone'); // (8,9)

      const exPlate = G.place('extractor', depPlate.x, depPlate.y, null, 1);
      const smPlate = G.place('smelter', depPlate.x, depPlate.y + 1, 'smelt_ferrite');
      const fabPlate = G.place('fabricator', depPlate.x, depPlate.y + 2, 'fab_plate');

      const exRod = G.place('extractor', depRod.x, depRod.y, null, 1);
      const smRod = G.place('smelter', depRod.x, depRod.y + 1, 'smelt_ferrite');
      const fabRod = G.place('fabricator', depRod.x, depRod.y + 2, 'fab_rod');

      const exCable = G.place('extractor', depCable.x, depCable.y, null, 1);
      const smCable = G.place('smelter', depCable.x, depCable.y + 1, 'smelt_cuprite');
      const fabFil = G.place('fabricator', depCable.x, depCable.y + 2, 'fab_filament');
      const fabCable = G.place('fabricator', depCable.x, depCable.y + 3, 'fab_cable');

      const exCast = G.place('extractor', depCast.x, depCast.y, null, 1); // Castcrete's fabricator eats raw
      const fabCast = G.place('fabricator', depCast.x + 1, depCast.y, 'fab_castcrete'); // Chalkstone directly, no smelter

      const termId = G.place('terminal', 8, 6);

      const c1 = G.connect(exPlate, smPlate, 1, []);   // [] = directly-adjacent, no belt cells needed
      const c2 = G.connect(smPlate, fabPlate, 1, []);
      const c3 = G.connect(exRod, smRod, 1, []);
      const c4 = G.connect(smRod, fabRod, 1, []);
      const c5 = G.connect(exCable, smCable, 1, []);
      const c6 = G.connect(smCable, fabFil, 1, []);
      const c7 = G.connect(fabFil, fabCable, 1, []);
      const c9 = G.connect(exCast, fabCast, 1, []);
      const c8 = G.connect(fabPlate, termId, 1, [[2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6]]); // Tier 0-valid

      let ticks = 0;
      while (G.state().techTier === 0 && ticks < 600) { G.tickN(1); ticks++; } // live-tick to Tier 1
      const techTierAfterLive = G.state().techTier;

      // Only valid to connect now that Tier 2 is the active tier and needs these goods:
      const c10 = G.connect(fabRod, termId, 1, [[4, 9], [5, 9], [6, 9], [7, 9], [7, 8], [7, 7], [8, 7]]);
      const c11 = G.connect(fabCable, termId, 1, [[7, 5], [8, 5]]);
      const c12 = G.connect(fabCast, termId, 1, [[9, 8], [9, 7], [9, 6]]);

      const allConnectsOk = [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12].every(c => !c.err);
      const deliveredBefore = G.state().lifetimeDelivered;
      G.saveGame();
      const raw = JSON.parse(localStorage.getItem('lineBalance_save_v2'));
      raw.savedAt = Date.now() - 3600 * 1000; // pretend 1 hour passed
      localStorage.setItem('lineBalance_save_v2', JSON.stringify(raw));
      const ok = window.__game.loadGame();
      const deliveredAfter = window.__game.state().lifetimeDelivered;
      const techTierAfter = window.__game.state().techTier;
      const noSaveFallback = (window.__game.clearSave(), window.__game.loadGame() === false);
      return { allConnectsOk, techTierAfterLive, ok, deliveredBefore, deliveredAfter, gained: deliveredAfter - deliveredBefore, techTierAfter, noSaveFallback };
    });
    check('offline catch-up: Tier-1 chain plus the three Tier-2 chains all connect cleanly (explicit paths)', out.allConnectsOk, out);
    check('offline catch-up: Tier 1 (single-good, starter-deposit-only) completes from live ticking before the save', out.techTierAfterLive === 1, out);
    check('offline catch-up: loadGame() returns true when a save exists', out.ok, out);
    check('offline catch-up: 1 simulated hour away increases lifetimeDelivered substantially', out.gained > 0, out);
    check('offline catch-up: Tier 2 (3 goods) completes during the offline window', out.techTierAfter >= 2, out);
    check('offline catch-up: loadGame() returns false with no save present (clean fallback to reset())', out.noSaveFallback, out);
    check('save/load: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- delete tool (buildings + belts)
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const ex = G.place('extractor', 2, 3, null, 1);
      const sm = G.place('smelter', 2, 4, 'smelt_ferrite');
      const c = G.connect(ex, sm, 1, []);
      const beltId = c.ok.id;
      G.tickN(1);
      const beltsBefore = G.state().belts.length;
      const beltDeleteOk = G.deleteBelt(beltId);
      const beltsAfterBeltDelete = G.state().belts.length;
      const exPortFreedAfterBeltDelete = Object.keys(G.node(ex).outBelt).length === 0;
      const reconnectAfterBeltDelete = G.connect(ex, sm, 1, []); // should succeed now the port is free again
      const nodesBeforeBldDelete = Object.keys(G.state().nodes).length;
      const bldDeleteOk = G.deleteBuilding(sm);
      const nodesAfterBldDelete = Object.keys(G.state().nodes).length;
      const beltsAfterBldDelete = G.state().belts.length; // deleting the smelter should cascade-delete its belt too
      const exPortFreedAfterBldDelete = Object.keys(G.node(ex).outBelt).length === 0;
      // deleting an extractor should return its cell to a placeable (undiscovered-but-known) deposit spot
      const canReplaceExtractor = G.deleteBuilding(ex) && G.place('extractor', 2, 3, null, 1) !== null;
      return {
        beltsBefore, beltDeleteOk, beltsAfterBeltDelete, exPortFreedAfterBeltDelete,
        reconnectErr: reconnectAfterBeltDelete.err || null,
        nodesBeforeBldDelete, bldDeleteOk, nodesAfterBldDelete, beltsAfterBldDelete, exPortFreedAfterBldDelete,
        canReplaceExtractor,
      };
    });
    check('delete: deleteBelt() removes the belt and frees the source port', out.beltDeleteOk && out.beltsBefore === 1 && out.beltsAfterBeltDelete === 0 && out.exPortFreedAfterBeltDelete, out);
    check('delete: the same pair can be reconnected immediately after its old belt is deleted', out.reconnectErr === null, out);
    check('delete: deleteBuilding() cascade-deletes every belt touching that building', out.bldDeleteOk && out.beltsAfterBldDelete === 0 && out.nodesAfterBldDelete === out.nodesBeforeBldDelete - 1, out);
    check('delete: deleting a building frees its neighbor\'s port too', out.exPortFreedAfterBldDelete, out);
    check('delete: deleting an extractor lets you place a new one on the same (still-known) deposit', out.canReplaceExtractor, out);
    check('delete: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // same coverage, but driven through the real pointer/canvas UI (Delete tool button + taps), not just the data API
    const { page, pageErrors } = await freshPage(browser);
    async function clickCell(page, x, y) {
      const p = await page.evaluate(([x, y]) => window.__game.cellPx(x, y), [x, y]);
      const rect = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { left: r.left, top: r.top }; });
      await page.mouse.click(rect.left + p.x, rect.top + p.y);
    }
    const ids = await page.evaluate(() => {
      const ex = window.__game.place('extractor', 2, 3, null, 1);
      const sm = window.__game.place('smelter', 2, 4, 'smelt_ferrite');
      const fab = window.__game.place('fabricator', 2, 8, 'fab_plate');
      window.__game.connect(ex, sm, 1, []);
      return { ex, sm, fab };
    });
    await page.click('[data-t="belt1"]');
    await clickCell(page, 2, 4); await clickCell(page, 2, 5); await clickCell(page, 2, 6); await clickCell(page, 2, 7); await clickCell(page, 2, 8);
    const beltsBefore = await page.evaluate(() => window.__game.state().belts.length);
    await page.click('[data-t="delete"]');
    await clickCell(page, 2, 6); // a mid-belt cell, not a building
    const afterBeltTapHint = await page.textContent('#hint');
    const beltsAfterCellDelete = await page.evaluate(() => window.__game.state().belts.length);
    await clickCell(page, 2, 4); // now the smelter building itself
    const afterBldTapHint = await page.textContent('#hint');
    const state = await page.evaluate(() => window.__game.state());
    check('delete (real UI): tapping a belt cell with the Delete tool removes just that belt', beltsBefore === 2 && beltsAfterCellDelete === 1, { beltsBefore, beltsAfterCellDelete, afterBeltTapHint });
    check('delete (real UI): tapping a building with the Delete tool removes it (and its remaining belt)', /removed/i.test(afterBldTapHint) && !state.nodes[ids.sm], { afterBldTapHint, nodes: Object.keys(state.nodes) });
    check('delete (real UI): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- recipe change in place (no rebuild)
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const sm = G.place('smelter', 2, 4, 'smelt_ferrite');
      const ex = G.place('extractor', 2, 3, null, 1);
      G.connect(ex, sm, 1, []);
      const blockedWhileConnected = G.changeRecipe(sm, 'smelt_cuprite'); // should be refused — belts still attached
      const recipeUnchanged = G.node(sm).recipeId === 'smelt_ferrite';
      G.deleteBuilding(ex); // frees the smelter's ports
      const changedOk = G.changeRecipe(sm, 'smelt_cuprite');
      const node = G.node(sm);
      const invalidType = G.changeRecipe(sm, 'fab_bolts'); // a fabricator recipe on a smelter — must be rejected
      return {
        blockedErr: blockedWhileConnected.err || null, recipeUnchanged,
        changedOk: !!(changedOk && changedOk.ok), newRecipeId: node.recipeId,
        newInBuf: node.inBuf, newOutBuf: node.outBuf,
        invalidTypeErr: invalidType.err || null,
      };
    });
    check('recipe change: refused while any belt is still connected (in or out)', out.blockedErr && out.recipeUnchanged, out);
    check('recipe change: succeeds once fully disconnected, and swaps to the new recipe', out.changedOk && out.newRecipeId === 'smelt_cuprite', out);
    check('recipe change: buffers reset to match the new recipe\'s goods (no stale ferrite left in a cuprite buffer)', 'cuprite_ore' in out.newInBuf && !('ferrite_ore' in out.newInBuf) && 'cuprite_ingot' in out.newOutBuf, out);
    check('recipe change: rejects a recipe belonging to the wrong building type', !!out.invalidTypeErr, out);
    check('recipe change: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- building info panel + tier progress panel (real UI)
  {
    const { page, pageErrors } = await freshPage(browser);
    async function clickCell(page, x, y) {
      const p = await page.evaluate(([x, y]) => window.__game.cellPx(x, y), [x, y]);
      const rect = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { left: r.left, top: r.top }; });
      await page.mouse.click(rect.left + p.x, rect.top + p.y);
    }
    await page.evaluate(() => window.__game.place('smelter', 2, 4, 'smelt_ferrite'));
    await clickCell(page, 2, 4); // no tool active — should open the building-info modal, not place/connect anything
    const infoShown = await page.evaluate(() => document.getElementById('infoModal').classList.contains('show'));
    const infoBody = await page.textContent('#infoBody');
    const changeBtnDisabled = await page.$eval('#infoActions .opt', b => b.disabled).catch(() => null);
    await page.click('#infoCancel');
    const infoHiddenAfterCancel = await page.evaluate(() => !document.getElementById('infoModal').classList.contains('show'));
    check('building info: tapping a building with no tool active opens the info panel', infoShown, { infoShown, infoBody });
    check('building info: panel shows the recipe name and live buffer/rate detail', infoBody.includes('Ferrite Ingot') && infoBody.includes('Recipe'), infoBody);
    check('building info: "Change recipe" is enabled for an unconnected machine', changeBtnDisabled === false, changeBtnDisabled);
    check('building info: cancel closes the panel', infoHiddenAfterCancel, infoHiddenAfterCancel);

    // Tier progress panel — toggled by tapping the header tier label
    let tpShown = await page.evaluate(() => document.getElementById('tierPanel').classList.contains('show'));
    await page.click('#tierLbl');
    tpShown = await page.evaluate(() => document.getElementById('tierPanel').classList.contains('show'));
    const tpBody = await page.textContent('#tierPanelBody');
    check('tier panel: tapping the header tier label opens it', tpShown, tpShown);
    check('tier panel: shows the current tier\'s exact remaining goods', tpBody.includes('Ferrite Plate') && tpBody.includes('0/30'), tpBody);
    check('tier panel: previews the next tier\'s requirements too', tpBody.includes('Tier 2') && tpBody.includes('Castcrete'), tpBody);
    check('building info + tier panel: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- Smart Splitter (multi-good combiner)
  // Scoped answer to "conveyors should carry multiple goods / smart splitters to detach a good": belts stay
  // single-good (no rewrite of the strict-port belt model), but this new building can hold up to 3 DIFFERENT
  // goods at once (unlike Merger, which is same-good-only) and lets you pick which one each output belt draws —
  // see mechanics-spec.md "Smart Splitter" for the full writeup, including why a plain Merger correctly refuses
  // to combine two different ores (that rejection is almost certainly what read as "mergers don't work").
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      G.deliverToTerminal(G.place('terminal', 8, 6), 'ferrite_plate', 30); // unlock Tier 1... but Smart Splitter needs Tier 2
      G.tickN(1);
      const lockedAtTier1 = !G.tierUnlocked('smart_splitter');
      return { lockedAtTier1 };
    });
    check('smart splitter: still locked right after Tier 1 (unlocks with Tier 2, alongside Storage Room/Belt T2)', out.lockedAtTier1, out);
    check('smart splitter: zero page errors (tier-lock check)', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Control: this is the behavior that's almost certainly behind "mergers don't work / can't connect a 2nd
    // conveyor lane" — a Merger accepts a 2nd input belt just fine as long as it's the SAME good (confirmed
    // repeatedly by direct reproduction — see work18_debug.js/work18_debug2.js in the session's debug history,
    // both of which connected a 2nd same-good input with zero errors). What a Merger correctly REFUSES is a 2nd
    // input of a DIFFERENT good — that's not a bug, it's the "same-good only" rule mechanics-spec.md documents,
    // and Smart Splitter (below) is the real answer for combining different goods at one node.
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const depF = G.deposits().find(d => d.good === 'ferrite_ore' && d.x === 2 && d.y === 3);
      const depC = G.deposits().find(d => d.good === 'cuprite_ore' && d.x === 6 && d.y === 2);
      const exF = G.place('extractor', depF.x, depF.y, null, 1), smF = G.place('smelter', depF.x, depF.y + 1, 'smelt_ferrite');
      G.connect(exF, smF, 1, []);
      const exC = G.place('extractor', depC.x, depC.y, null, 1), smC = G.place('smelter', depC.x, depC.y + 1, 'smelt_cuprite');
      G.connect(exC, smC, 1, []);
      const merger = G.place('merger', 4, 5);
      const r1 = G.connect(smF, merger, 1, [[3, 4], [3, 5]]);       // smF (2,4) -> merger (4,5)
      const r2 = G.connect(smC, merger, 1, [[6, 4], [5, 4], [5, 5]]); // smC (6,3) -> merger (4,5), DIFFERENT good
      return { r1Err: r1.err || null, r2Err: r2.err || null, mergerGood: G.node(merger).good };
    });
    check('control: a Merger accepts its first input and records the good it now carries', out.r1Err === null && out.mergerGood === 'ferrite_ingot', out);
    check('control: a Merger correctly REFUSES a 2nd input of a DIFFERENT good (by design — not the reported bug)', !!out.r2Err, out);
    check('control: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const term = G.place('terminal', 8, 6);
      G.deliverToTerminal(term, 'ferrite_plate', 30); G.tickN(1);
      G.deliverToTerminal(term, 'castcrete', 20); G.deliverToTerminal(term, 'ferrite_rod', 20); G.deliverToTerminal(term, 'braided_cable', 20); G.tickN(1);
      const unlockedAtTier2 = G.tierUnlocked('smart_splitter');

      const depF = G.deposits().find(d => d.good === 'ferrite_ore' && d.x === 2 && d.y === 3);
      const depC = G.deposits().find(d => d.good === 'cuprite_ore' && d.x === 6 && d.y === 2);
      const exF = G.place('extractor', depF.x, depF.y, null, 1), smF = G.place('smelter', depF.x, depF.y + 1, 'smelt_ferrite');
      G.connect(exF, smF, 1, []);
      const exC = G.place('extractor', depC.x, depC.y, null, 1), smC = G.place('smelter', depC.x, depC.y + 1, 'smelt_cuprite');
      G.connect(exC, smC, 1, []);
      const ss = G.place('smart_splitter', 4, 4);

      // Smart Splitter: BOTH different-good inputs must succeed (a Merger would refuse the 2nd — see control above).
      const r1 = G.connect(smF, ss, 1, [[3, 4]]);          // smF (2,4) -> ss (4,4)
      const r2 = G.connect(smC, ss, 1, [[5, 3], [5, 4]]);  // smC (6,3) -> ss (4,4), DIFFERENT good
      G.tickN(3);
      const buf = G.node(ss).buf;

      // Output side: ambiguous when 2+ goods are buffered; forcedGood resolves it; per-good dedup on a 2nd claim.
      const fabRod = G.place('fabricator', 4, 6, 'fab_rod'); // wants ferrite_ingot
      const ambiguous = G.connect(ss, fabRod, 1, [[4, 5]]);
      const outWithGood = G.connect(ss, fabRod, 1, [[4, 5]], 'ferrite_ingot');
      const dupSameGood = G.connect(ss, G.place('fabricator', 4, 3, 'fab_rod'), 1, [], 'ferrite_ingot'); // same good again -> refused (port already claimed); ss's only free neighbor left is (4,3), direct adjacency

      return {
        unlockedAtTier2,
        r1Err: r1.err || null, r2Err: r2.err || null, buf,
        ambiguousErr: ambiguous.err, ambiguousCandidates: ambiguous.candidates,
        outWithGoodOk: !!outWithGood.ok, outGood: outWithGood.ok ? outWithGood.ok.good : null,
        dupSameGoodErr: dupSameGood.err || null,
      };
    });
    check('smart splitter: unlocked at Tier 2', out.unlockedAtTier2, out);
    check('smart splitter: accepts two DIFFERENT-good inputs (ferrite_ingot + cuprite_ingot) that a Merger would refuse', out.r1Err === null && out.r2Err === null, out);
    check('smart splitter: buffers each input good separately', out.buf && out.buf.ferrite_ingot > 0 && out.buf.cuprite_ingot > 0, out.buf);
    check('smart splitter: connecting an output with 2+ buffered goods and no forced good is ambiguous', out.ambiguousErr === 'AMBIGUOUS_GOOD' && Array.isArray(out.ambiguousCandidates) && out.ambiguousCandidates.length === 2, out);
    check('smart splitter: supplying an explicit good resolves the connection and the belt carries exactly that good', out.outWithGoodOk && out.outGood === 'ferrite_ingot', out);
    check('smart splitter: a 2nd output of the SAME already-claimed good is refused (one output port per good)', !!out.dupSameGoodErr, out);
    check('smart splitter: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Real UI: place a Smart Splitter, wire two different-good chains into it by hand, and confirm the
    // good-picker modal actually appears (and works) when drawing an output belt out of it.
    const { page, pageErrors } = await freshPage(browser);
    async function clickCell(page, x, y) {
      const p = await page.evaluate(([x, y]) => window.__game.cellPx(x, y), [x, y]);
      const rect = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { left: r.left, top: r.top }; });
      await page.mouse.click(rect.left + p.x, rect.top + p.y);
    }
    await page.evaluate(() => {
      const G = window.__game;
      const term = G.place('terminal', 8, 6);
      G.deliverToTerminal(term, 'ferrite_plate', 30); G.tickN(1);
      G.deliverToTerminal(term, 'castcrete', 20); G.deliverToTerminal(term, 'ferrite_rod', 20); G.deliverToTerminal(term, 'braided_cable', 20); G.tickN(1);
    });
    await page.click('[data-t="smart_splitter"]');
    await clickCell(page, 6, 4);
    const ids = await page.evaluate(() => {
      const G = window.__game;
      const exC = G.place('extractor', 6, 2, null, 1), smC = G.place('smelter', 7, 2, 'smelt_cuprite');
      G.connect(exC, smC, 1, []);
      const exF = G.place('extractor', 3, 7, null, 1), smF = G.place('smelter', 4, 7, 'smelt_ferrite');
      G.connect(exF, smF, 1, []);
      return { smC, smF };
    });
    await page.click('[data-t="belt1"]');
    await clickCell(page, 7, 2); await clickCell(page, 7, 3); await clickCell(page, 6, 3); await clickCell(page, 6, 4);
    await page.click('[data-t="belt1"]');
    await clickCell(page, 4, 7); await clickCell(page, 5, 7); await clickCell(page, 5, 6); await clickCell(page, 5, 5); await clickCell(page, 6, 5); await clickCell(page, 6, 4);
    await page.evaluate(() => window.__game.tickN(3));
    await page.evaluate(() => window.__game.place('fabricator', 8, 4, 'fab_rod'));
    await page.click('[data-t="belt1"]');
    await clickCell(page, 6, 4); await clickCell(page, 7, 4); await clickCell(page, 8, 4);
    const modalShown = await page.evaluate(() => document.getElementById('goodPick').classList.contains('show'));
    const opts = await page.$$eval('#gpOpts .opt', els => els.map(e => e.textContent));
    const btns = await page.$$('#gpOpts .opt');
    const idx = opts.findIndex(o => o.includes('Ferrite Ingot'));
    if (idx >= 0) await btns[idx].click();
    const hint = await page.textContent('#hint');
    check('smart splitter (real UI): drawing an output belt with 2 buffered goods opens the good-picker modal', modalShown && opts.length === 2, { modalShown, opts });
    check('smart splitter (real UI): picking a good from the modal completes the belt carrying that good', /connected/i.test(hint) && /Ferrite Ingot/i.test(hint), hint);
    check('smart splitter (real UI): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  } finally {
    // always close the browser, even if a check above throws — an open browser process otherwise
    // keeps Node alive indefinitely instead of exiting, which looks like a hang rather than a failure.
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(e => { console.error('Regression suite crashed:', e); process.exitCode = 1; });
