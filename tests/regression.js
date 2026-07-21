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
  {
    const { page, pageErrors } = await freshPage(browser);
    const btnDisabled = (t) => page.evaluate((t) => document.querySelector(`[data-t="${t}"]`).disabled, t);

    const tier0 = {
      splitterLocked: !(await page.evaluate(() => window.__game.tierUnlocked('splitter'))),
      splitterBtnDisabled: await btnDisabled('splitter'),
      belt2BtnDisabled: await btnDisabled('belt2'),
      scanBtnDisabled: await btnDisabled('scan'),
    };

    const afterTier1 = await page.evaluate(() => {
      const G = window.__game;
      const termId = G.place('terminal', 9, 9);
      G.deliverToTerminal(termId, 'ferrite_plate', 15);
      G.deliverToTerminal(termId, 'ferrite_rod', 15);
      G.deliverToTerminal(termId, 'braided_cable', 20);
      G.tickN(1); // sim() processes the delivery and calls advanceTier() once the quota is met
      return { termId, techTier: G.state().techTier, splitterUnlocked: G.tierUnlocked('splitter'), mergerUnlocked: G.tierUnlocked('merger'), scanUnlocked: G.tierUnlocked('scan') };
    });
    const tier1Buttons = { splitterBtnDisabled: await btnDisabled('splitter'), scanBtnDisabled: await btnDisabled('scan'), belt2StillDisabled: await btnDisabled('belt2') };

    const afterTier2 = await page.evaluate((termId) => {
      const G = window.__game;
      G.deliverToTerminal(termId, 'castcrete', 20);
      G.deliverToTerminal(termId, 'ferrite_rod', 20);
      G.deliverToTerminal(termId, 'ferrite_plate', 20);
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

    check('tier gating: locked tools are disabled at Tier 0', tier0.splitterLocked && tier0.splitterBtnDisabled && tier0.belt2BtnDisabled && tier0.scanBtnDisabled, tier0);
    check('tier gating: delivering Tier 1\'s full quota (all 3 goods) advances techTier to 1', afterTier1.techTier === 1, afterTier1);
    check('tier gating: Splitter/Merger/Scan unlock together at Tier 1', afterTier1.splitterUnlocked && afterTier1.mergerUnlocked && afterTier1.scanUnlocked, afterTier1);
    check('tier gating: Splitter/Scan tool buttons become enabled at Tier 1, Belt T2 stays locked', !tier1Buttons.splitterBtnDisabled && !tier1Buttons.scanBtnDisabled && tier1Buttons.belt2StillDisabled, tier1Buttons);
    check('tier gating: delivering Tier 2\'s full quota advances techTier to 2', afterTier2.techTier === 2, afterTier2);
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
      // Build ALL THREE of Tier 1's required goods (ferrite_plate, ferrite_rod, braided_cable), not just one —
      // a single-good chain plateaus at that good's own per-tier cap almost immediately (by design: once a
      // good's tier-requirement is met, further units of it don't count further until the tier advances), so
      // it can't demonstrate a full hour of genuine offline progress. This mirrors what a real player's base
      // would look like while working toward Tier 1.
      // Three spatially-independent, single-purpose chains (one per required Tier-1 good), each rooted
      // at a different fixed ore-deposit seed, all converging on a centrally-placed terminal. This avoids
      // grid congestion from BFS auto-routed belts winding through a shared cluster (a splitter-based
      // single-cluster layout was tried first and failed with "No clear belt path" on the third connection
      // once the first two belts had already consumed most of the grid).
      const depPlate = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 1);
      const depRod = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2);
      const depCable = G.deposits().find(d => d.good === 'cuprite_ore' && d.rich === 1);

      const exPlate = G.place('extractor', depPlate.x, depPlate.y, null, 1);
      const smPlate = G.place('smelter', depPlate.x, depPlate.y + 1, 'smelt_ferrite');
      const fabPlate = G.place('fabricator', depPlate.x, depPlate.y + 2, 'fab_plate');

      const exRod = G.place('extractor', depRod.x, depRod.y, null, 1);
      const smRod = G.place('smelter', depRod.x + 1, depRod.y, 'smelt_ferrite');
      const fabRod = G.place('fabricator', depRod.x + 2, depRod.y, 'fab_rod');

      const exCable = G.place('extractor', depCable.x, depCable.y, null, 1);
      const smCable = G.place('smelter', depCable.x, depCable.y + 1, 'smelt_cuprite');
      const fabFil = G.place('fabricator', depCable.x, depCable.y + 2, 'fab_filament');
      const fabCable = G.place('fabricator', depCable.x, depCable.y + 3, 'fab_cable');

      const termId = G.place('terminal', 8, 6);
      const cks = [
        G.connect(exPlate, smPlate), G.connect(smPlate, fabPlate),
        G.connect(exRod, smRod), G.connect(smRod, fabRod),
        G.connect(exCable, smCable), G.connect(smCable, fabFil), G.connect(fabFil, fabCable),
        G.connect(fabPlate, termId), G.connect(fabRod, termId), G.connect(fabCable, termId),
      ];
      const allConnectsOk = cks.every(c => !c.err);
      // Save immediately after wiring, before any production has accumulated (deliveredBefore === 0).
      // Production rates are scaled way up (RATE_SCALE) for this game's fast-idle feel, so a chain like
      // this one blows through Tier 1's whole quota within a couple of *simulated* seconds — pre-ticking
      // even a few seconds in real time before saving would already bank most of the progress this test
      // is trying to attribute to the offline window, making "gained" look artificially small or even zero.
      // Saving at t=0 and letting the full offline hour (simulated in the reload below) do all the work
      // isolates exactly what offline catch-up contributes.
      const deliveredBefore = G.state().lifetimeDelivered;
      G.saveGame();
      const raw = JSON.parse(localStorage.getItem('lineBalance_save_v2'));
      raw.savedAt = Date.now() - 3600 * 1000; // pretend 1 hour passed
      localStorage.setItem('lineBalance_save_v2', JSON.stringify(raw));
      const ok = window.__game.loadGame();
      const deliveredAfter = window.__game.state().lifetimeDelivered;
      const techTierAfter = window.__game.state().techTier;
      const noSaveFallback = (window.__game.clearSave(), window.__game.loadGame() === false);
      return { allConnectsOk, ok, deliveredBefore, deliveredAfter, gained: deliveredAfter - deliveredBefore, techTierAfter, noSaveFallback };
    });
    check('offline catch-up: full Tier-1 chain (3 goods) connects cleanly', out.allConnectsOk, out);
    check('offline catch-up: loadGame() returns true when a save exists', out.ok, out);
    check('offline catch-up: 1 simulated hour away increases lifetimeDelivered substantially', out.gained > out.deliveredBefore, out);
    check('offline catch-up: Tier 1 completes during the offline window (all 3 goods kept flowing)', out.techTierAfter >= 1, out);
    check('offline catch-up: loadGame() returns false with no save present (clean fallback to reset())', out.noSaveFallback, out);
    check('save/load: zero page errors', pageErrors.length === 0, pageErrors);
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
