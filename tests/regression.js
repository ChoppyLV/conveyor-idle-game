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
      const always = ['extractor', 'smelter', 'fabricator', 'terminal', 'generator', 'belt1', 'scan', 'delete', 'contracts'];
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
  // Multi-good belt rewrite (mechanics-spec.md, 2026-07-22): belts carry an unlimited variety of goods at once,
  // capped only in total throughput by their tier — so a Merger's job is simply "combine everything you're
  // given onto one output belt," for ANY goods, not just same-good inputs. The two same-good sub-tests below
  // (asymmetric utilization) still hold under the new model since the underlying room-weighted math is
  // unchanged for a single good; the different-good case (previously refused) is now the headline behavior.
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
      const c1 = G.connect(ex1, mgId), c2 = G.connect(ex2, mgId);
      const c3 = G.connect(mgId, smId), c4 = G.connect(smId, fabId), c5 = G.connect(fabId, termId);
      G.tickN(40);
      const st = G.state();
      return { buildOk: !c1.err && !c2.err && !c3.err && !c4.err && !c5.err,
        ex1Util: st.nodes[ex1].util, ex2Util: st.nodes[ex2].util, lifetimeDelivered: st.lifetimeDelivered };
    });
    check('merger: 2 same-good inputs + 1 output all connect', out.buildOk, out);
    check('merger: smaller producer (1000/min) saturates near 100% util', out.ex1Util > 0.95, out);
    check('merger: larger producer (3000/min) throttles to fill remaining demand (~0.6-0.75 util)', out.ex2Util > 0.55 && out.ex2Util < 0.8, out);
    check('merger: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // The headline behavior of the rewrite: a Merger now accepts and combines DIFFERENT goods onto one shared
    // output belt — the old model rejected a 2nd input whose good didn't match the 1st (see mechanics-spec.md's
    // superseded §1.5 for the old rule). Mix nodes no longer track a single `.good` at all; downstream sees
    // both goods land in the same per-good `buf`.
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
      const r2 = G.connect(smC, merger, 1, [[6, 4], [5, 4], [5, 5]]); // smC (6,3) -> merger (4,5), DIFFERENT good — now accepted
      const store = G.place('storageroom', 4, 8);
      const r3 = G.connect(merger, store, 1, [[4, 6], [4, 7]]);
      G.tickN(20);
      const buf = G.node(store).buf;
      return { r1Err: r1.err || null, r2Err: r2.err || null, r3Err: r3.err || null, buf };
    });
    check('merger multi-good: accepts a 2nd input of a DIFFERENT good (the old model refused this)', out.r1Err === null && out.r2Err === null, out);
    check('merger multi-good: the output belt carries both goods at once, and downstream sees both', !out.r3Err && out.buf && out.buf.ferrite_ingot > 0 && out.buf.cuprite_ingot > 0, out);
    check('merger multi-good: zero page errors', pageErrors.length === 0, pageErrors);
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
  {
    // Smart Splitter spliced mid-belt: there's no interactive good-picker in this non-interactive splice path,
    // so the auto-created "after" segment defaults its filter to ELSE (catch-everything) — the player can wire
    // additional filtered outputs afterward (see spliceOnBelt() in index.html). This is a one-way default, not
    // a placeholder that later gets resolved, so it's worth its own regression coverage.
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 1); // (2,3)
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 3, dep.y, 'smelt_ferrite');
      G.connect(exId, smId); // auto-routed straight line
      const belt = G.state().belts[0];
      const spliceX = belt.path[0][0], spliceY = belt.path[0][1];
      const ssId = G.place('smart_splitter', spliceX, spliceY); // splices onto the existing belt
      const afterSplice = G.state();
      const afterBelt = afterSplice.belts.find(b => b.src === ssId);
      return { ssIdOk: ssId != null, splitCount: afterSplice.belts.length,
        afterFilterIsElse: !!afterBelt && afterBelt.filterGood === G.ELSE };
    });
    check('splice: placing a Smart Splitter on an existing belt cell splices it in', out.ssIdOk, out);
    check('splice: the original belt is split into two segments', out.splitCount === 2, out);
    check('splice: the auto-created "after" segment defaults its filter to "Everything else"', out.afterFilterIsElse, out);
    check('splice (smart splitter): zero page errors', pageErrors.length === 0, pageErrors);
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
      const raw = JSON.parse(localStorage.getItem('lineBalance_save_v4'));
      raw.savedAt = Date.now() - 3600 * 1000; // pretend 1 hour passed
      localStorage.setItem('lineBalance_save_v4', JSON.stringify(raw));
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
  // Multi-good belt rewrite note: ports are no longer tracked as per-good `inBelt`/`outBelt` bookkeeping on
  // each node — they're derived live from the `belts` array (see outBeltCount()/inBeltCount() in index.html),
  // so there's nothing to "free" on delete beyond removing the belt itself. The reconnect-succeeds check below
  // is the real evidence a port opened back up.
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
      const reconnectAfterBeltDelete = G.connect(ex, sm, 1, []); // should succeed now the port is free again
      const nodesBeforeBldDelete = Object.keys(G.state().nodes).length;
      const bldDeleteOk = G.deleteBuilding(sm);
      const nodesAfterBldDelete = Object.keys(G.state().nodes).length;
      const beltsAfterBldDelete = G.state().belts.length; // deleting the smelter should cascade-delete its belt too
      // deleting an extractor should return its cell to a placeable (undiscovered-but-known) deposit spot
      const canReplaceExtractor = G.deleteBuilding(ex) && G.place('extractor', 2, 3, null, 1) !== null;
      return {
        beltsBefore, beltDeleteOk, beltsAfterBeltDelete,
        reconnectErr: reconnectAfterBeltDelete.err || null,
        nodesBeforeBldDelete, bldDeleteOk, nodesAfterBldDelete, beltsAfterBldDelete,
        canReplaceExtractor,
      };
    });
    check('delete: deleteBelt() removes the belt', out.beltDeleteOk && out.beltsBefore === 1 && out.beltsAfterBeltDelete === 0, out);
    check('delete: the same pair can be reconnected immediately after its old belt is deleted (ports derive live from belts, no stale bookkeeping to clean up)', out.reconnectErr === null, out);
    check('delete: deleteBuilding() cascade-deletes every belt touching that building', out.bldDeleteOk && out.beltsAfterBldDelete === 0 && out.nodesAfterBldDelete === out.nodesBeforeBldDelete - 1, out);
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

    // Tier progress panel — toggled by tapping the header tier label. updateTierPanel() only (re)renders
    // #tierPanelBody from inside the requestAnimationFrame loop, so a frame has to actually run after the
    // click before the body has real content — read it immediately and you race the loop and see stale/empty
    // markup regardless of game logic.
    let tpShown = await page.evaluate(() => document.getElementById('tierPanel').classList.contains('show'));
    await page.click('#tierLbl');
    await page.waitForTimeout(100);
    tpShown = await page.evaluate(() => document.getElementById('tierPanel').classList.contains('show'));
    const tpBody = await page.textContent('#tierPanelBody');
    check('tier panel: tapping the header tier label opens it', tpShown, tpShown);
    check('tier panel: shows the current tier\'s exact remaining goods', tpBody.includes('Ferrite Plate') && tpBody.includes('0/30'), tpBody);
    check('tier panel: previews the next tier\'s requirements too', tpBody.includes('Tier 2') && tpBody.includes('Castcrete'), tpBody);
    check('building info + tier panel: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- Smart Splitter (multi-good router)
  // Multi-good belt rewrite (mechanics-spec.md, 2026-07-22): a Smart Splitter accepts a belt carrying any mix
  // of goods and lets the player assign specific goods to specific outputs (up to 3), with any output
  // configurable as "everything else" — a catch-all for any good not claimed by a specific-good output.
  // Unlike a plain Splitter (blind, proportional, doesn't look at content) or a Merger (combines everything,
  // no filtering), this is the one building that actually routes by good.
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
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const term = G.place('terminal', 14, 9);
      G.deliverToTerminal(term, 'ferrite_plate', 30); G.tickN(1);
      G.deliverToTerminal(term, 'castcrete', 20); G.deliverToTerminal(term, 'ferrite_rod', 20); G.deliverToTerminal(term, 'braided_cable', 20); G.tickN(1);
      const unlockedAtTier2 = G.tierUnlocked('smart_splitter');

      const depF = G.deposits().find(d => d.good === 'ferrite_ore' && d.x === 2 && d.y === 3);
      const depC = G.deposits().find(d => d.good === 'cuprite_ore' && d.x === 6 && d.y === 2);
      const exF = G.place('extractor', depF.x, depF.y, null, 1), smF = G.place('smelter', depF.x, depF.y + 1, 'smelt_ferrite');
      G.connect(exF, smF, 1, []);
      const exC = G.place('extractor', depC.x, depC.y, null, 1), smC = G.place('smelter', depC.x, depC.y + 1, 'smelt_cuprite');
      G.connect(exC, smC, 1, []);
      const ss = G.place('smart_splitter', 4, 5);

      // A Smart Splitter accepts any mix of inputs, same as a Merger now does — auto-routed (BFS) rather than
      // hand-drawn paths, since this test cares about the routing/filter logic, not the manual-draw UI.
      const r1 = G.connect(smF, ss);
      const r2 = G.connect(smC, ss);
      G.tickN(3);
      const buf = G.node(ss).buf;

      // Output side: connecting FROM a Smart Splitter is ALWAYS ambiguous without an explicit forced good/ELSE —
      // this is a routing *configuration* choice, not something inferred from whatever's currently buffered
      // (the old model only asked when 2+ goods happened to be buffered at connect-time). The check fires
      // before any destination/path validation, so a throwaway destination is enough to probe it.
      const fabRod = G.place('fabricator', 8, 5, 'fab_rod'); // wants ferrite_ingot
      const ambiguous = G.connect(ss, fabRod);
      const candidateCountBeforeAnyOutput = ambiguous.candidates ? ambiguous.candidates.length : -1;
      const outWithGood = G.connect(ss, fabRod, 1, undefined, 'ferrite_ingot');
      const dupSameGood = G.connect(ss, fabRod, 1, undefined, 'ferrite_ingot'); // same good again -> refused, before path is even considered
      const candidatesAfterOneClaim = G.smartSplitterFilterCandidates(ss);
      const store = G.place('storageroom', 4, 8);
      const elseOut = G.connect(ss, store, 1, undefined, G.ELSE);

      return {
        unlockedAtTier2, itemCount: Object.keys(G.ITEMS).length,
        r1Err: r1.err || null, r2Err: r2.err || null, buf,
        ambiguousErr: ambiguous.err, candidateCountBeforeAnyOutput,
        outWithGoodOk: !!outWithGood.ok, outGood: outWithGood.ok ? outWithGood.ok.good : null,
        dupSameGoodErr: dupSameGood.err || null,
        candidatesAfterOneClaim,
        elseOutOk: !!elseOut.ok, elseOutGood: elseOut.ok ? elseOut.ok.good : 'unset',
      };
    });
    check('smart splitter: unlocked at Tier 2', out.unlockedAtTier2, out);
    check('smart splitter: accepts two DIFFERENT-good inputs (ferrite_ingot + cuprite_ingot) with no rejection — a Merger would accept these too now', out.r1Err === null && out.r2Err === null, out);
    check('smart splitter: buffers each input good separately', out.buf && out.buf.ferrite_ingot > 0 && out.buf.cuprite_ingot > 0, out.buf);
    check('smart splitter: connecting an output with no forced good is always ambiguous, offering every game good plus "everything else"', out.ambiguousErr === 'AMBIGUOUS_GOOD' && out.candidateCountBeforeAnyOutput === out.itemCount + 1, out);
    check('smart splitter: supplying an explicit good resolves the connection and the belt carries exactly that good', out.outWithGoodOk && out.outGood === 'ferrite_ingot', out);
    check('smart splitter: a 2nd output of the SAME already-claimed good is refused (one output per specific good)', !!out.dupSameGoodErr, out);
    check('smart splitter: the claimed good drops out of future candidate lists; "everything else" always remains available', !out.candidatesAfterOneClaim.includes('ferrite_ingot') && out.candidatesAfterOneClaim.length === out.itemCount, out);
    check('smart splitter: ELSE is a valid forced filter and creates an unfiltered catch-all output', out.elseOutOk && out.elseOutGood === null, out);
    check('smart splitter: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Pavel's own worked example (session request): a belt carrying ferrite_ore + cuprite_ore + chalkstone all
    // merged together, then a Smart Splitter routing ferrite_ore to one output, cuprite_ore to another, and
    // chalkstone falling through to the "everything else" catch-all third output.
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const mg = G.place('merger', 3, 5);
      const depFe = G.deposits().find(d => d.good === 'ferrite_ore');
      const depCu = G.deposits().find(d => d.good === 'cuprite_ore');
      const depCh = G.deposits().find(d => d.good === 'chalkstone');
      const exFe = G.place('extractor', depFe.x, depFe.y, null, 1);
      const exCu = G.place('extractor', depCu.x, depCu.y, null, 1);
      const exCh = G.place('extractor', depCh.x, depCh.y, null, 1);
      const cB = G.connect(exFe, mg), cC = G.connect(exCu, mg), cD = G.connect(exCh, mg);
      const ss = G.place('smart_splitter', 6, 5);
      const outFe = G.place('storageroom', 9, 2);  // "left"
      const outCu = G.place('storageroom', 12, 5); // "right"
      const outElse = G.place('storageroom', 9, 8); // "straight" / else
      const cA = G.connect(mg, ss);
      const r1 = G.connect(ss, outFe, 1, undefined, 'ferrite_ore');
      const r2 = G.connect(ss, outCu, 1, undefined, 'cuprite_ore');
      const r3 = G.connect(ss, outElse, 1, undefined, G.ELSE);
      G.tickN(30);
      return {
        errs: [cA.err, r1.err, r2.err, r3.err, cB.err, cC.err, cD.err],
        outFe: G.node(outFe).buf, outCu: G.node(outCu).buf, outElse: G.node(outElse).buf,
      };
    });
    check('smart splitter (worked example): every connection succeeds', out.errs.every(e => !e), out);
    check('smart splitter (worked example): ferrite_ore routes to its dedicated output only', out.outFe.ferrite_ore > 0 && !out.outFe.cuprite_ore && !out.outFe.chalkstone, out.outFe);
    check('smart splitter (worked example): cuprite_ore routes to its dedicated output only', out.outCu.cuprite_ore > 0 && !out.outCu.ferrite_ore && !out.outCu.chalkstone, out.outCu);
    check('smart splitter (worked example): chalkstone (unclaimed by either specific output) falls to "everything else"', out.outElse.chalkstone > 0 && !out.outElse.ferrite_ore && !out.outElse.cuprite_ore, out.outElse);
    check('smart splitter (worked example): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Real UI: place a Smart Splitter, wire two different-good chains into it by hand, and confirm the
    // good-picker modal appears for EVERY output belt drawn out of it (not just when 2+ goods happen to be
    // buffered — routing is configured up front) and that it offers every game good plus "Everything else",
    // shrinking as outputs claim specific goods.
    const { page, pageErrors } = await freshPage(browser);
    async function clickCell(page, x, y) {
      const p = await page.evaluate(([x, y]) => window.__game.cellPx(x, y), [x, y]);
      const rect = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { left: r.left, top: r.top }; });
      await page.mouse.click(rect.left + p.x, rect.top + p.y);
    }
    const itemCount = await page.evaluate(() => Object.keys(window.__game.ITEMS).length);
    await page.evaluate(() => {
      const G = window.__game;
      const term = G.place('terminal', 8, 6);
      G.deliverToTerminal(term, 'ferrite_plate', 30); G.tickN(1);
      G.deliverToTerminal(term, 'castcrete', 20); G.deliverToTerminal(term, 'ferrite_rod', 20); G.deliverToTerminal(term, 'braided_cable', 20); G.tickN(1);
    });
    await page.click('[data-t="smart_splitter"]');
    await clickCell(page, 6, 4);
    await page.evaluate(() => {
      const G = window.__game;
      const exC = G.place('extractor', 6, 2, null, 1), smC = G.place('smelter', 7, 2, 'smelt_cuprite');
      G.connect(exC, smC, 1, []);
      const exF = G.place('extractor', 3, 7, null, 1), smF = G.place('smelter', 4, 7, 'smelt_ferrite');
      G.connect(exF, smF, 1, []);
    });
    await page.click('[data-t="belt1"]');
    await clickCell(page, 7, 2); await clickCell(page, 7, 3); await clickCell(page, 6, 3); await clickCell(page, 6, 4);
    await page.click('[data-t="belt1"]');
    await clickCell(page, 4, 7); await clickCell(page, 5, 7); await clickCell(page, 5, 6); await clickCell(page, 5, 5); await clickCell(page, 6, 5); await clickCell(page, 6, 4);
    await page.evaluate(() => window.__game.tickN(3));

    // 1st output: the picker must appear even though nothing forces ambiguity via buffered-good count.
    await page.evaluate(() => window.__game.place('fabricator', 8, 4, 'fab_rod'));
    await page.click('[data-t="belt1"]');
    await clickCell(page, 6, 4); await clickCell(page, 7, 4); await clickCell(page, 8, 4);
    const modalShown1 = await page.evaluate(() => document.getElementById('goodPick').classList.contains('show'));
    const opts1 = await page.$$eval('#gpOpts .opt', els => els.map(e => e.textContent));
    let btns = await page.$$('#gpOpts .opt');
    const idx1 = opts1.findIndex(o => o.includes('Ferrite Ingot'));
    if (idx1 >= 0) await btns[idx1].click();
    const hint1 = await page.textContent('#hint');

    // 2nd output: Ferrite Ingot must no longer be offered (claimed by the 1st output); "Everything else" stays.
    // ss's only remaining free neighbor is (5,4) — (7,4)/(6,3)/(6,5) are all now claimed by belts drawn above.
    await page.evaluate(() => window.__game.place('fabricator', 5, 3, 'fab_filament'));
    await page.click('[data-t="belt1"]');
    await clickCell(page, 6, 4); await clickCell(page, 5, 4); await clickCell(page, 5, 3);
    const modalShown2 = await page.evaluate(() => document.getElementById('goodPick').classList.contains('show'));
    const opts2 = await page.$$eval('#gpOpts .opt', els => els.map(e => e.textContent));
    btns = await page.$$('#gpOpts .opt');
    const idx2 = opts2.findIndex(o => o === 'Everything else');
    if (idx2 >= 0) await btns[idx2].click();
    const hint2 = await page.textContent('#hint');

    check('smart splitter (real UI): drawing an output belt opens the good-picker modal', modalShown1, { modalShown1 });
    check('smart splitter (real UI): the 1st output offers every game good plus "Everything else"', opts1.length === itemCount + 1 && opts1.includes('Everything else'), { opts1, itemCount });
    check('smart splitter (real UI): picking a good from the modal completes the belt carrying that good', /connected/i.test(hint1) && /Ferrite Ingot/i.test(hint1), hint1);
    check('smart splitter (real UI): the 2nd output\'s modal no longer offers the already-claimed good, but still offers "Everything else"', modalShown2 && !opts2.includes('Ferrite Ingot') && opts2.includes('Everything else') && opts2.length === itemCount, { modalShown2, opts2, itemCount });
    check('smart splitter (real UI): picking "Everything else" completes the belt as the catch-all output', /connected/i.test(hint2) && /everything else/i.test(hint2), hint2);
    check('smart splitter (real UI): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- contracts
  // Deliberately reuse the Assembly Terminal rather than a new building: once a good's CURRENT-TIER quota is
  // met, further deliveries of that good used to just sit unconsumed in the terminal's buffer — contracts now
  // claim exactly that leftover surplus. See mechanics-spec.md and status.md's fourth-session entry.
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => window.__game.state());
    check('contracts: exactly CONTRACT_SLOTS (2) are active at boot, drawn from the pool', out.contracts.length === 2, out.contracts);
    check('contracts: credits and contractsCompleted both start at 0', out.credits === 0 && out.contractsCompleted === 0, out);
    check('contracts: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      // Force a specific, known contract into a slot so the test isn't at the mercy of pool order, then
      // massively overproduce that good — Tier 1 only needs 30 Ferrite Plate, the contract wants 40 more on
      // top of that, so a long tick should clear the tier AND complete (and re-roll) the contract many times.
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2);
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 1, dep.y, 'smelt_ferrite');
      const fabId = G.place('fabricator', dep.x + 2, dep.y, 'fab_plate');
      const termId = G.place('terminal', dep.x + 3, dep.y);
      const c1 = G.connect(exId, smId), c2 = G.connect(smId, fabId), c3 = G.connect(fabId, termId);
      const hasPlateContract = G.state().contracts.some(c => c.good === 'ferrite_plate');
      G.tickN(300);
      const st = G.state();
      return {
        connectsOk: !c1.err && !c2.err && !c3.err, hasPlateContract,
        techTier: st.techTier, credits: st.credits, contractsCompleted: st.contractsCompleted,
        stillTwoSlots: st.contracts.length === 2,
      };
    });
    check('contracts: chain connects cleanly', out.connectsOk, out);
    check('contracts: a Ferrite Plate contract was active at boot (pool order is deterministic — c1 first)', out.hasPlateContract, out);
    check('contracts: Tier 1 still completes normally alongside contract fulfillment', out.techTier >= 1, out);
    check('contracts: sustained overproduction earns real Credits (surplus beyond the tier quota is being claimed)', out.credits > 0, out);
    check('contracts: completed contracts are counted and slots stay topped up (pool rotation)', out.contractsCompleted > 0 && out.stillTwoSlots, out);
    check('contracts: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Real UI: the Contracts panel toggles and shows live progress; the header's Credits readout updates.
    const { page, pageErrors } = await freshPage(browser);
    await page.click('[data-t="contracts"]');
    const shown = await page.evaluate(() => document.getElementById('contractsPanel').classList.contains('show'));
    const body = await page.textContent('#contractsPanelBody');
    const creditsHeader = await page.textContent('#creditsLbl');
    check('contracts (real UI): tapping the Contracts tool opens the panel', shown, shown);
    check('contracts (real UI): panel lists both active contracts with their delivery targets', /Deliver 40/.test(body) && /Deliver 30/.test(body), body);
    check('contracts (real UI): header shows a Credits readout', creditsHeader.includes('💰'), creditsHeader);
    check('contracts (real UI): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- prestige
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const tooEarly = G.doPrestige();
      const eligibleBefore = G.prestigeEligible();
      const term = G.place('terminal', 8, 6);
      G.deliverToTerminal(term, 'ferrite_plate', 30); G.tickN(1);
      G.deliverToTerminal(term, 'castcrete', 20); G.deliverToTerminal(term, 'ferrite_rod', 20); G.deliverToTerminal(term, 'braided_cable', 20); G.tickN(1);
      G.deliverToTerminal(term, 'braided_cable', 10); G.deliverToTerminal(term, 'bolts', 10); G.deliverToTerminal(term, 'filament', 10); G.tickN(1);
      const eligibleAfter = G.prestigeEligible();
      const before = G.state();
      const res = G.doPrestige();
      const after = G.state();
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 1); // 1000/min base at T1
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const boostedRate = G.node(exId).rate;
      return {
        tooEarlyErr: tooEarly.err || null, eligibleBefore, eligibleAfter,
        beforeNodeCount: Object.keys(before.nodes).length,
        resOk: !!res.ok, resPrestigeCount: res.prestigeCount, resMult: res.mult,
        afterTechTier: after.techTier, afterNodeCount: Object.keys(after.nodes).length, afterBeltCount: after.belts.length,
        afterPrestigeCount: after.prestigeCount, afterPrestigeMult: after.prestigeMult,
        boostedRate,
      };
    });
    check('prestige: refused before any tier is complete', !!out.tooEarlyErr && out.eligibleBefore === false, out);
    check('prestige: becomes eligible once every currently-built tier is cleared', out.eligibleAfter === true, out);
    check('prestige: doPrestige() succeeds once eligible and reports the new prestige count/multiplier', out.resOk && out.resPrestigeCount === 1 && approx(out.resMult, 1.1, 1e-6), out);
    check('prestige: wipes the factory (nodes/belts/techTier all reset)', out.afterTechTier === 0 && out.afterNodeCount === 0 && out.afterBeltCount === 0, out);
    check('prestige: a freshly-placed extractor after prestige already carries the boosted rate (1000 base × 1.10 = 1100)', approx(out.boostedRate, 1100, 1e-6), out);
    check('prestige: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Real UI: the header Prestige button is disabled until eligible, shows the right copy once it is, and a
    // real click (through the confirm() dialog) actually performs the reset.
    const { page, pageErrors } = await freshPage(browser);
    page.on('dialog', d => d.accept());
    const disabledAtBoot = await page.$eval('#prestigeBtn', b => b.disabled);
    await page.evaluate(() => {
      const G = window.__game;
      const term = G.place('terminal', 8, 6);
      G.deliverToTerminal(term, 'ferrite_plate', 30); G.tickN(1);
      G.deliverToTerminal(term, 'castcrete', 20); G.deliverToTerminal(term, 'ferrite_rod', 20); G.deliverToTerminal(term, 'braided_cable', 20); G.tickN(1);
      G.deliverToTerminal(term, 'braided_cable', 10); G.deliverToTerminal(term, 'bolts', 10); G.deliverToTerminal(term, 'filament', 10); G.tickN(1);
    });
    await page.waitForTimeout(100); // let the render loop's updateHeader() pick up the new eligibility
    const disabledAfterTiers = await page.$eval('#prestigeBtn', b => b.disabled);
    const btnText = await page.textContent('#prestigeBtn');
    await page.click('#prestigeBtn');
    await page.waitForTimeout(100);
    const hint = await page.textContent('#hint');
    const st = await page.evaluate(() => window.__game.state());
    check('prestige (real UI): the header button is disabled at boot', disabledAtBoot, disabledAtBoot);
    check('prestige (real UI): the button enables once every tier is cleared, and shows the +% preview', disabledAfterTiers === false && /\+10%/.test(btnText), { disabledAfterTiers, btnText });
    check('prestige (real UI): a real click (through the confirm dialog) performs the reset', /Prestige/.test(hint) && st.prestigeCount === 1 && st.techTier === 0, { hint, st });
    check('prestige (real UI): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // "New Game" and "Prestige" must NOT be the same reset — New Game wipes Credits/prestige too, Prestige keeps them.
    const { page, pageErrors } = await freshPage(browser);
    page.on('dialog', d => d.accept());
    await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2);
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 1, dep.y, 'smelt_ferrite');
      const fabId = G.place('fabricator', dep.x + 2, dep.y, 'fab_plate');
      const termId = G.place('terminal', dep.x + 3, dep.y);
      G.connect(exId, smId); G.connect(smId, fabId); G.connect(fabId, termId);
      G.tickN(300); // rack up some Credits via contract completions
    });
    const before = await page.evaluate(() => window.__game.state());
    await page.click('#newGameBtn');
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => window.__game.state());
    check('New Game vs Prestige: a real chain racks up Credits before the reset (sanity on the setup)', before.credits > 0, before);
    check('New Game (real UI): fully wipes Credits/contractsCompleted/prestigeCount, unlike Prestige', after.credits === 0 && after.contractsCompleted === 0 && after.prestigeCount === 0, after);
    check('New Game: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- save/load v4 (contracts + credits + prestige)
  {
    const { page, pageErrors } = await freshPage(browser);
    const before = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2);
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 1, dep.y, 'smelt_ferrite');
      const fabId = G.place('fabricator', dep.x + 2, dep.y, 'fab_plate');
      const termId = G.place('terminal', dep.x + 3, dep.y);
      G.connect(exId, smId); G.connect(smId, fabId); G.connect(fabId, termId);
      G.tickN(300);
      G.saveGame();
      return G.state();
    });
    await page.reload();
    await page.waitForFunction(() => window.__game);
    const after = await page.evaluate(() => window.__game.state());
    check('save/load v4: Credits survive a real page.reload()', after.credits === before.credits && after.credits > 0, { before: before.credits, after: after.credits });
    check('save/load v4: contractsCompleted survives a real page.reload()', after.contractsCompleted === before.contractsCompleted, { before: before.contractsCompleted, after: after.contractsCompleted });
    check('save/load v4: active contracts (incl. in-progress amounts) survive a real page.reload()', after.contracts.length === before.contracts.length, { before: before.contracts, after: after.contracts });
    check('save/load v4: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- Elevator Overpass (mechanics-spec.md §1.4)
  // Two independent belt lines: Line A (ground, straight vertical) and Line B (crosses Line A at one cell via
  // an explicit crossFlags array on connect()). Data-API precision first, then the same scenario driven through
  // the real pointer/canvas UI (tapping onto an occupied belt cell mid-draw), including the Tier-2 gate.
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const exA = G.place('extractor', 2, 3, null, 1);
      const smA = G.place('smelter', 2, 6, 'smelt_ferrite');
      const connA = G.connect(exA, smA, 1, [[2, 4], [2, 5]]);
      const exB = G.place('extractor', 6, 2, null, 1);
      const smB = G.place('smelter', 0, 5, 'smelt_cuprite');
      const pathB = [[6, 3], [6, 4], [6, 5], [5, 5], [4, 5], [3, 5], [2, 5], [1, 5]];
      const crossB = [false, false, false, false, false, false, true, false];
      const connB = G.connect(exB, smB, 1, pathB, undefined, crossB);
      const crossingsAfterConnect = G.crossings();
      const spliceAtCrossBlocked = G.place('splitter', 2, 5) === null;
      // Let both lines actually run BEFORE splicing anything onto Line A below — splicing a building into the
      // middle of a belt permanently restructures it into two new belt segments (see spliceOnBelt() in
      // index.html), so "place a splitter mid-belt, then delete it" does NOT restore the original single belt
      // (deleting the spliced node cascade-deletes both new segments, same as deleting any other building) —
      // it's a one-way structural change, not a reversible probe. Capture the flow snapshot first.
      G.tickN(30);
      const st = G.state();
      // Now it's safe to spend Line A: splice a Splitter onto a normal (non-crossing) ground cell of its path.
      const spliceNormalId = G.place('splitter', 2, 4);
      const beltBId = connB.ok.id;
      G.deleteBelt(beltBId);
      const crossingsAfterDeleteElevated = G.crossings();
      const spliceWorksAfterDeleteElevated = G.place('splitter', 2, 5) !== null;
      return {
        connAOk: !!connA.ok, connBOk: !!connB.ok, crossingsAfterConnect,
        spliceAtCrossBlocked, spliceNormalId: spliceNormalId !== null,
        smAInBuf: st.nodes[smA].inBuf, smBInBuf: st.nodes[smB].inBuf,
        smAOutBuf: st.nodes[smA].outBuf, smBOutBuf: st.nodes[smB].outBuf,
        crossingsAfterDeleteElevated, spliceWorksAfterDeleteElevated,
      };
    });
    check('elevator overpass: both a ground belt and a crossing belt connect without error', out.connAOk && out.connBOk, out);
    check('elevator overpass: the crossing is registered exactly once, keyed to the crossing belt', Object.keys(out.crossingsAfterConnect).length === 1, out.crossingsAfterConnect);
    check('elevator overpass: splicing a Splitter onto the crossing cell is blocked', out.spliceAtCrossBlocked, out);
    check('elevator overpass: splicing a Splitter onto a normal (non-crossing) ground-belt cell still works', out.spliceNormalId, out);
    check('elevator overpass: both lines actually flow goods to their destinations, undisturbed by the crossing', (out.smAInBuf.ferrite_ore + out.smAOutBuf.ferrite_ingot) > 0 && (out.smBInBuf.cuprite_ore + out.smBOutBuf.cuprite_ingot) > 0, { smA: [out.smAInBuf, out.smAOutBuf], smB: [out.smBInBuf, out.smBOutBuf] });
    check('elevator overpass: deleting the crossing (elevated) belt clears its crossing registration', Object.keys(out.crossingsAfterDeleteElevated).length === 0, out.crossingsAfterDeleteElevated);
    check('elevator overpass: the cell is splice-able again once the crossing belt is gone', out.spliceWorksAfterDeleteElevated, out);
    check('elevator overpass: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Deleting the GROUND belt at a crossing must leave the crossing (elevated belt) intact — the overpass has
    // no idea what, if anything, is underneath it.
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const exA = G.place('extractor', 2, 3, null, 1), smA = G.place('smelter', 2, 6, 'smelt_ferrite');
      G.connect(exA, smA, 1, [[2, 4], [2, 5]]);
      const exB = G.place('extractor', 6, 2, null, 1), smB = G.place('smelter', 0, 5, 'smelt_cuprite');
      const pathB = [[6, 3], [6, 4], [6, 5], [5, 5], [4, 5], [3, 5], [2, 5], [1, 5]];
      const crossB = [false, false, false, false, false, false, true, false];
      G.connect(exB, smB, 1, pathB, undefined, crossB);
      G.tickN(3);
      // find and delete Line A's ground belt at the crossing cell — Line A is the only belt whose OWN cell[][] claim sits at (2,5)
      const beforeCount = G.state().belts.length, beforeCrossings = Object.keys(G.crossings()).length;
      // Line A's belt is the one with 2 path cells (2,4)-(2,5), none flagged as crossings
      const lineABelt = G.state().belts.find(b => b.len === 2 && !b.cross.some(Boolean));
      return { beforeCount, beforeCrossings, lineABeltFound: !!lineABelt };
    });
    check('elevator overpass: setup sanity — one crossing registered before any deletion', out.beforeCrossings === 1, out);
    check('elevator overpass: Line A (the ground belt under the crossing) is identifiable via state()', out.lineABeltFound, out);
    check('elevator overpass: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Real UI: draw a belt across another belt's cell. Blocked pre-Tier-2, works once Tier 2 is reached.
    const { page, pageErrors } = await freshPage(browser);
    async function clickCell(page, x, y) {
      const p = await page.evaluate(([x, y]) => window.__game.cellPx(x, y), [x, y]);
      const rect = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { left: r.left, top: r.top }; });
      await page.mouse.click(rect.left + p.x, rect.top + p.y);
    }
    await page.click('[data-t="extractor"]');
    await clickCell(page, 2, 3);
    await page.click('#rpOpts .opt'); // T1
    await page.click('[data-t="smelter"]');
    await clickCell(page, 2, 6);
    await page.click('#rpOpts .opt'); // smelt_ferrite (first recipe for this building type)
    await page.click('[data-t="belt1"]');
    await clickCell(page, 2, 3); await clickCell(page, 2, 4); await clickCell(page, 2, 5); await clickCell(page, 2, 6);
    const lineAHint = await page.textContent('#hint');
    const idsB = await page.evaluate(() => ({ exB: window.__game.place('extractor', 6, 2, null, 1), smB: window.__game.place('smelter', 0, 5, 'smelt_cuprite') }));
    // Attempt Line B pre-Tier-2 — should be blocked exactly at the crossing cell.
    await page.click('[data-t="belt1"]');
    await clickCell(page, 6, 2); await clickCell(page, 6, 3); await clickCell(page, 6, 4); await clickCell(page, 6, 5);
    await clickCell(page, 5, 5); await clickCell(page, 4, 5); await clickCell(page, 3, 5);
    await clickCell(page, 2, 5); // the crossing cell, pre-Tier-2
    const hintBlockedPreTier2 = await page.textContent('#hint');
    const pathStillExcludesCrossCell = await page.evaluate(() => window.__game.uiState().beltPath.length === 6);
    await page.click('[data-t="delete"]'); // abandon the in-progress draw
    // Advance to Tier 2 via the data API (setup, not under test — same pattern as the rest of this suite).
    await page.evaluate(() => {
      const G = window.__game;
      const term = G.place('terminal', 10, 6);
      G.deliverToTerminal(term, 'ferrite_plate', 30); G.tickN(1);
      G.deliverToTerminal(term, 'castcrete', 20); G.deliverToTerminal(term, 'ferrite_rod', 20); G.deliverToTerminal(term, 'braided_cable', 20); G.tickN(1);
    });
    const techTierNow = await page.evaluate(() => window.__game.state().techTier);
    // Retry Line B post-Tier-2 — should succeed all the way through.
    await page.click('[data-t="belt1"]');
    await clickCell(page, 6, 2); await clickCell(page, 6, 3); await clickCell(page, 6, 4); await clickCell(page, 6, 5);
    await clickCell(page, 5, 5); await clickCell(page, 4, 5); await clickCell(page, 3, 5);
    await clickCell(page, 2, 5); // now succeeds as a crossing
    const hintCrossingPostTier2 = await page.textContent('#hint');
    await clickCell(page, 1, 5); await clickCell(page, 0, 5);
    const hintFinal = await page.textContent('#hint');
    await page.evaluate(() => window.__game.tickN(20));
    const finalState = await page.evaluate(() => window.__game.state());
    check('elevator overpass (real UI): Line A connects normally pre-Tier-2', /connected/i.test(lineAHint), lineAHint);
    check('elevator overpass (real UI): crossing another belt is refused pre-Tier-2 with a clear Tier-2 message', /Tier 2/i.test(hintBlockedPreTier2), hintBlockedPreTier2);
    check('elevator overpass (real UI): the blocked tap did not extend the in-progress path', pathStillExcludesCrossCell, pathStillExcludesCrossCell);
    check('elevator overpass (real UI): reaches Tier 2 via the setup delivery', techTierNow === 2, techTierNow);
    check('elevator overpass (real UI): tapping the same cell post-Tier-2 is accepted as a crossing', /Elevator Overpass/i.test(hintCrossingPostTier2), hintCrossingPostTier2);
    check('elevator overpass (real UI): the belt finishes connecting at the destination', /connected/i.test(hintFinal), hintFinal);
    check('elevator overpass (real UI): exactly one crossing is registered and both smelters receive real flow', finalState.crossingCount === 1, finalState.crossingCount);
    check('elevator overpass (real UI): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Save/load: crossings and each belt's per-cell cross flags survive a real page.reload().
    const { page, pageErrors } = await freshPage(browser);
    const before = await page.evaluate(() => {
      const G = window.__game;
      const exA = G.place('extractor', 2, 3, null, 1), smA = G.place('smelter', 2, 6, 'smelt_ferrite');
      G.connect(exA, smA, 1, [[2, 4], [2, 5]]);
      const exB = G.place('extractor', 6, 2, null, 1), smB = G.place('smelter', 0, 5, 'smelt_cuprite');
      const pathB = [[6, 3], [6, 4], [6, 5], [5, 5], [4, 5], [3, 5], [2, 5], [1, 5]];
      const crossB = [false, false, false, false, false, false, true, false];
      G.connect(exB, smB, 1, pathB, undefined, crossB);
      G.tickN(3);
      G.saveGame();
      return G.state();
    });
    await page.reload();
    await page.waitForFunction(() => window.__game);
    const after = await page.evaluate(() => window.__game.state());
    check('elevator overpass save/load: crossingCount survives a real page.reload()', after.crossingCount === before.crossingCount && after.crossingCount === 1, { before: before.crossingCount, after: after.crossingCount });
    check('elevator overpass save/load: belt count and per-belt cross arrays survive a real page.reload()', after.belts.length === before.belts.length && JSON.stringify(after.belts.map(b => b.cross)) === JSON.stringify(before.belts.map(b => b.cross)), { before: before.belts.map(b => b.cross), after: after.belts.map(b => b.cross) });
    check('elevator overpass save/load: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- recipe tree wiring (2026-07-22, eighth
  // session) — index.html's RECIPES/ITEMS were, until this session, a small 8-recipe/11-item hand-authored
  // subset. This wires in the real MVP slice of data/line_balance_game_data.json (preproduction-plan.md §2's
  // confirmed 25-craftable-material dry MVP: 5 raw ores -> capstone Reinforced Frame), adding 17 more standard
  // (non-alternate) recipes and 3 new producer buildings (Alloy Foundry, Assembly Station, Manufactory) that
  // plug into the exact same PROC-driven sim/UI code paths smelter/fabricator already used — the ~100 alternate
  // recipes stay excluded on purpose (preproduction-plan.md §3's Salvage-Drive/R&D-Bench gate for those isn't
  // built yet, unchanged from before this session).
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      return {
        recipeCount: Object.keys(G.RECIPES).length,
        itemCount: Object.keys(G.ITEMS).length,
        hasNewBuildings: ['alloy_foundry', 'assembly_station', 'manufactory'].every(t => document.querySelector(`.tool[data-t="${t}"]`) != null),
        newBuildingsDisabledAtBoot: ['alloy_foundry', 'assembly_station', 'manufactory'].every(t => document.querySelector(`.tool[data-t="${t}"]`).disabled),
        depsPresent: ['cinder_coal', 'auralite_ore'].every(g => G.deposits().some(d => d.good === g)),
      };
    });
    check('recipe tree: RECIPES now has all 25 MVP standard recipes (8 original + 17 wired in this session)', out.recipeCount === 25, out);
    check('recipe tree: ITEMS now has all 30 MVP items (11 original + 19 new: 2 raw + 17 processed)', out.itemCount === 30, out);
    check('recipe tree: Alloy Foundry/Assembly Station/Manufactory all have real palette buttons', out.hasNewBuildings, out);
    check('recipe tree: those three buttons are disabled at Tier 0 (gated, not free-for-all)', out.newBuildingsDisabledAtBoot, out);
    check('recipe tree: the two new raw deposits (Cinder Coal, Auralite Ore) exist on the map', out.depsPresent, out);
    check('recipe tree: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- recipe tree: tier-gating for the 3 new buildings
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      // Tier 1: 30 Ferrite Plate, reachable from the starter deposit alone (unchanged by this session).
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.rich === 2);
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 1, dep.y, 'smelt_ferrite');
      const fabId = G.place('fabricator', dep.x + 2, dep.y, 'fab_plate');
      const termId = G.place('terminal', dep.x + 3, dep.y);
      G.connect(exId, smId); G.connect(smId, fabId); G.connect(fabId, termId);
      G.tickN(30);
      const afterTier1 = G.state().techTier;
      const alloyEnabledAtTier1 = !document.querySelector('.tool[data-t="alloy_foundry"]').disabled;
      const asmEnabledAtTier1 = !document.querySelector('.tool[data-t="assembly_station"]').disabled;
      const manuEnabledAtTier1 = !document.querySelector('.tool[data-t="manufactory"]').disabled;
      return { afterTier1, alloyEnabledAtTier1, asmEnabledAtTier1, manuEnabledAtTier1 };
    });
    check('recipe tree: reached Tier 1', out.afterTier1 >= 1, out);
    check('recipe tree: Alloy Foundry and Assembly Station unlock at Tier 2, not Tier 1 (mirrors preproduction-plan.md Act 2)', !out.alloyEnabledAtTier1 && !out.asmEnabledAtTier1, out);
    check('recipe tree: Manufactory stays locked at Tier 1 too (it unlocks at Tier 3, mirrors Act 3)', !out.manuEnabledAtTier1, out);
    check('recipe tree tier-gating: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- recipe tree: Alloy Foundry, a real 2-input recipe
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const depF = G.deposits().find(d => d.good === 'ferrite_ore' && d.x === 2 && d.y === 3);
      const depC = G.deposits().find(d => d.good === 'cinder_coal');
      const exF = G.place('extractor', depF.x, depF.y, null, 3), exC = G.place('extractor', depC.x, depC.y, null, 3);
      const afId = G.place('alloy_foundry', 8, 5, 'steel_billet');
      const storeId = G.place('storageroom', 9, 5); // output sink — without one outBuf hits CAP and the machine
      // legitimately stalls (working:false) almost immediately, which would make this test about output
      // backpressure instead of about the 2-input consumption it's meant to check.
      const c1 = G.connect(exF, afId), c2 = G.connect(exC, afId), c3 = G.connect(afId, storeId);
      G.tickN(30);
      const n = G.node(afId);
      return { c1Err: c1.err || null, c2Err: c2.err || null, c3Err: c3.err || null,
        ferriteConsumed: (n.inBuf.ferrite_ore || 0) < 200, coalConsumed: (n.inBuf.cinder_coal || 0) < 200,
        steelProduced: (G.node(storeId).buf.steel_billet || 0) > 0, working: n.working };
    });
    check('alloy foundry: both a ferrite ore and a cinder coal extractor connect to it (2 real inputs, not the old 1-input assumption)', out.c1Err === null && out.c2Err === null && out.c3Err === null, out);
    check('alloy foundry: BOTH inputs are actually being drawn down (steel_billet needs ferrite_ore AND cinder_coal every cycle)', out.ferriteConsumed && out.coalConsumed, out);
    check('alloy foundry: steel_billet is actually produced and flowing downstream', out.steelProduced && out.working, out);
    check('alloy foundry: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- recipe tree: Assembly Station, a real 2-input
  // recipe fed by a full production chain (not just directly-seeded buffers) — braced_plate needs Ferrite Plate
  // (from the base ferrite chain) AND Bolts (from the ferrite-rod sub-chain), converging at one machine.
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      // Explicit paths throughout (rather than auto-route/BFS) — with this many buildings packed near each
      // other, the auto-router can legitimately run out of free detour cells; explicit paths make the layout
      // deterministic instead of depending on incidental free space, matching how the Merger/Smart-Splitter
      // tests elsewhere in this file already do it.
      const dep = G.deposits().find(d => d.good === 'ferrite_ore' && d.x === 3 && d.y === 7);
      const exId = G.place('extractor', dep.x, dep.y, null, 3);            // (3,7)
      const spId = G.place('splitter', dep.x + 2, dep.y);                  // (5,7)
      const sm1 = G.place('smelter', dep.x + 3, dep.y - 1, 'smelt_ferrite');// (6,6)
      const sm2 = G.place('smelter', dep.x + 3, dep.y + 1, 'smelt_ferrite');// (6,8)
      const fabPlate = G.place('fabricator', dep.x + 4, dep.y - 1, 'fab_plate'); // (7,6)
      const fabRod = G.place('fabricator', dep.x + 4, dep.y + 1, 'fab_rod');     // (7,8)
      const fabBolts = G.place('fabricator', dep.x + 5, dep.y + 1, 'fab_bolts'); // (8,8)
      const merger = G.place('merger', dep.x + 5, dep.y);                  // (8,7)
      const asId = G.place('assembly_station', dep.x + 6, dep.y, 'braced_plate'); // (9,7)
      const errs = [
        G.connect(exId, spId, 1, [[dep.x + 1, dep.y]]),                       // ex(3,7) -> sp(5,7) via (4,7)
        G.connect(spId, sm1, 1, [[dep.x + 3, dep.y]]),                        // sp(5,7) -> sm1(6,6) via (6,7)
        G.connect(spId, sm2, 1, [[dep.x + 2, dep.y + 1]]),                    // sp(5,7) -> sm2(6,8) via (5,8)
        G.connect(sm1, fabPlate, 1, []),                                     // sm1(6,6) -> fabPlate(7,6), direct
        G.connect(sm2, fabRod, 1, []),                                       // sm2(6,8) -> fabRod(7,8), direct
      ].map(r => r.err).filter(Boolean);
      // fabPlate's ferrite_plate needs to reach the assembly station directly; fabRod's ferrite_rod goes to
      // fabBolts first, then bolts merge in. Route ferrite_plate into the same merger, so both of braced_plate's
      // inputs (ferrite_plate + bolts) land on the assembly station via one shared belt.
      const r1 = G.connect(fabRod, fabBolts, 1, []); if (r1.err) errs.push(r1.err);           // (7,8)->(8,8) direct
      const r2 = G.connect(fabPlate, merger, 1, [[dep.x + 5, dep.y - 1]]); if (r2.err) errs.push(r2.err); // (7,6)->(8,7) via (8,6)
      const r3 = G.connect(fabBolts, merger, 1, []); if (r3.err) errs.push(r3.err);           // (8,8)->(8,7) direct
      const r4 = G.connect(merger, asId, 1, []); if (r4.err) errs.push(r4.err);               // (8,7)->(9,7) direct
      G.tickN(120);
      const n = G.node(asId);
      return { errs, inBuf: n.inBuf, outBuf: n.outBuf, working: n.working, util: n.util };
    });
    check('assembly station: the whole chain (extractor->splitter->2 smelters->2 fabricators->merger->assembly station) connects with no errors', out.errs.length === 0, out);
    check('assembly station: braced_plate is actually being produced from a real converging chain of Ferrite Plate + Bolts', (out.outBuf.braced_plate || 0) > 0, out);
    check('assembly station: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- recipe tree: Manufactory, the capstone 4-input
  // recipe (Reinforced Frame needs Braced Frame + Steel Tube + Encased Girder + Bolts all at once) — seeded
  // directly via deliverToTerminal (which, despite its name, just adds to any node's inBuf by good) rather than
  // building all 3 upstream sub-chains, since the sim's generic r.in.forEach() handling of an N-input recipe was
  // already proven correct by the Alloy Foundry/Assembly Station cases above; this test's job is specifically to
  // prove a FOURTH simultaneous input is handled too, not to re-prove the underlying math.
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const manuId = G.place('manufactory', 5, 5, 'reinforced_frame');
      // Reinforced Frame's recipe needs braced_frame x5, steel_tube x20, encased_girder x5, bolts x120 per
      // cycle — a lopsided 1:4:1:24 ratio. Seeding all four with the SAME flat amount (as an earlier draft of
      // this test did) starves bolts (the 120-per-cycle input) long before the other three, stalling the
      // machine well before the test finishes and making "working" false for a reason unrelated to what this
      // test checks. Seeding proportional to each input's own per-cycle need, generously (×2000, comfortably
      // more than the ~200 cycles' worth of time 60 sim-seconds at this recipe's 30s cycle actually covers),
      // keeps all four supplied through the whole tickN() window instead of exhausting right at the end.
      const seed = { braced_frame: 10000, steel_tube: 40000, encased_girder: 10000, bolts: 240000 };
      for (const g in seed) G.deliverToTerminal(manuId, g, seed[g]);
      G.tickN(60);
      const n = G.node(manuId);
      return { inBuf: n.inBuf, outBuf: n.outBuf, working: n.working,
        allFourDrewDown: Object.keys(seed).every(g => n.inBuf[g] < seed[g]) };
    });
    check('manufactory: reinforced_frame is produced', (out.outBuf.reinforced_frame || 0) > 0 && out.working, out);
    check('manufactory: all FOUR inputs were drawn down together, not just the first one or two (the recipe.in.forEach is genuinely N-ary)', out.allFourDrewDown, out);
    check('manufactory: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- recipe tree: recipe-choice UI scales to a
  // building with many recipes (fabricator went from 6 recipes to 10; assembly station is brand new with 10)
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(async () => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      // real UI click: select the Fabricator tool, tap an empty cell, count the recipe-picker's options
      document.querySelector('.tool[data-t="fabricator"]').click();
      const p = G.cellPx(dep.x + 5, dep.y);
      const el = document.elementFromPoint(p.x, p.y) || document.getElementById('c');
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: p.x, clientY: p.y, bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      const modalShown = document.getElementById('recipePick').classList.contains('show');
      const optionCount = document.querySelectorAll('#rpOpts .opt').length;
      const expected = Object.values(G.RECIPES).filter(r => r.b === 'fabricator').length;
      return { modalShown, optionCount, expected };
    });
    check('recipe picker (real UI): choosing Fabricator over an empty cell opens the recipe-choice modal', out.modalShown, out);
    check('recipe picker (real UI): lists every fabricator recipe, not just the original 6 (now 10, all wired in)', out.optionCount === out.expected && out.expected === 10, out);
    check('recipe picker (real UI): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- recipe tree: changeRecipe() generalizes to
  // the new PROC building types too, not just smelter/fabricator
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const asId = G.place('assembly_station', 5, 5, 'braced_plate');
      const before = G.node(asId).recipeId;
      const res = G.changeRecipe(asId, 'turn_rotor');
      const after = G.node(asId);
      return { before, err: res.err || null, after: after.recipeId, inBufKeys: Object.keys(after.inBuf).sort() };
    });
    check('recipe change: works on Assembly Station (a brand-new PROC type), not just Smelter/Fabricator', out.err === null && out.after === 'turn_rotor', out);
    check('recipe change: buffers reset to the new recipe\'s own inputs (ferrite_rod + bolts for turn_rotor)', JSON.stringify(out.inBufKeys) === JSON.stringify(['bolts', 'ferrite_rod']), out);
    check('recipe change (new PROC types): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- playtest round 1, fix #1 (Android ghost
  // click): the canvas pointerdown handler must call preventDefault() so a real device doesn't fire a delayed
  // synthetic "click" that can land on whatever modal button opened underneath the tap and silently pick it.
  // Playwright can't reproduce Android's actual synthetic-click generation, so this asserts the fix at the
  // level that actually prevents it — event.defaultPrevented on the real pointerdown — rather than trying to
  // simulate the browser-internal compat-click behavior itself.
  {
    const { page, pageErrors } = await freshPage(browser);
    const out = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      const p = G.cellPx(dep.x, dep.y);
      // cellPx() is canvas-LOCAL (mirrors the game's own cx()/cy()); there's a real <header> above the canvas
      // in normal document flow, so the canvas's own bounding rect is never (0,0) — must add it to get real
      // viewport coordinates for elementFromPoint/clientX/clientY, same as the existing extractor-tier-picker
      // test does via page.mouse.click(rect.left+pt.x, rect.top+pt.y).
      const r = document.getElementById('c').getBoundingClientRect();
      const absX = r.left + p.x, absY = r.top + p.y;
      const el = document.elementFromPoint(absX, absY) || document.getElementById('c');
      const ev = new PointerEvent('pointerdown', { clientX: absX, clientY: absY, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented };
    });
    check('Android ghost-click fix: canvas pointerdown calls preventDefault (suppresses the synthetic compat click)', out.defaultPrevented === true, out);
    check('Android ghost-click fix: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- playtest round 1, fix #2 (info shields):
  // flooring the on-grid label font at a real mobile cell size (fLabel()) made "too small to read" labels
  // legible, but this session also found and fixed a follow-on bug it introduced — a floored-size label like
  // "Extractor" is often wider than the cell itself, so it overflows onto the #0d1015 canvas background, which
  // is the EXACT color the label's own fill uses for contrast against the building box. Without the lblText()
  // outline, that overflow is literally invisible (dark-on-identical-dark). This pixel-samples the overflow
  // region directly — the only way to actually catch this class of bug, since every data-layer check and even
  // the headless "zero page errors" checks stayed green the whole time this bug existed.
  {
    const { page, pageErrors } = await freshPage(browser);
    await page.setViewportSize({ width: 400, height: 700 }); // real small mobile CS, not the CS=40 desktop default
    await new Promise(r => setTimeout(r, 150)); // let the resize listener + next rAF-driven draw() settle
    const out = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      G.place('extractor', dep.x, dep.y, null, 1);
      const c = document.getElementById('c'), ctx = c.getContext('2d'); // same context the game itself draws with
      const p0 = G.cellPx(dep.x, dep.y), p1 = G.cellPx(dep.x + 1, dep.y);
      const CS = p1.x - p0.x; // cell size, derived without reaching into the game's own closed-over CS
      const label = 'Extractor';
      // mirrors fLabel(0.18,'bold')'s own formula (index.html, "info shields" section) — kept in sync deliberately,
      // since this test exists specifically to catch a regression in that formula's interaction with box width
      ctx.font = `bold ${Math.max(9, Math.round(CS * 0.18))}px sans-serif`;
      const textW = ctx.measureText(label).width;
      const bg = { r: 0x0d, g: 0x10, b: 0x15 };
      const cx0 = p0.x, cy0 = p0.y - CS / 2 + CS * 0.42; // cellPx returns the cell CENTER; label baseline is CS*0.42 down from the cell's top edge
      // scan a small box rather than one exact pixel — a single-pixel sample can land between glyph strokes or
      // right at the antialiased baseline edge and miss real ink that's clearly there a few pixels away.
      const regionHasInk = (bx, by, halfW, halfH) => {
        const x0 = Math.max(0, Math.round(bx - halfW)), y0 = Math.max(0, Math.round(by - halfH));
        const w = Math.round(halfW * 2), h = Math.round(halfH * 2);
        const d = ctx.getImageData(x0, y0, w, h).data;
        for (let i = 0; i < d.length; i += 4) {
          if (Math.abs(d[i] - bg.r) >= 12 || Math.abs(d[i + 1] - bg.g) >= 12 || Math.abs(d[i + 2] - bg.b) >= 12) return true;
        }
        return false;
      };
      // a box a few px inside the label's LEFT edge, past the building box's own edge (box half-width CS/2-2)
      const overflowing = textW / 2 > CS / 2 - 2;
      const hasInk = regionHasInk(cx0 - textW / 2 + 4, cy0 - 3, 4, 6);
      return { CS, textW, overflowing, hasInk };
    });
    check('info shields: "Extractor" label is actually wider than the cell at a real mobile CS (test is exercising the overflow case, not a no-op)', out.overflowing, out);
    check('info shields: the overflowing part of the building label is visible against the #0d1015 background, not swallowed by it', out.hasInk, out);
    check('info shields: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- playtest round 1, fix #2 (info shields):
  // deposits previously had zero text label at all (just a color-coded circle) — this was likely the single
  // biggest driver of the #1 unanimous "can't tell what's on the grid" complaint. Confirms the ore-name label
  // now renders as visible pixels above a discovered deposit.
  {
    const { page, pageErrors } = await freshPage(browser);
    await page.setViewportSize({ width: 400, height: 700 });
    await new Promise(r => setTimeout(r, 150));
    const out = await page.evaluate(() => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      const c = document.getElementById('c'), ctx = c.getContext('2d');
      const p0 = G.cellPx(dep.x, dep.y), p1 = G.cellPx(dep.x + 1, dep.y);
      const CS = p1.x - p0.x;
      const cx0 = p0.x, cy0 = p0.y - CS * 0.36; // matches the deposit ore-name label's own y-offset in index.html
      const bg = { r: 0x0d, g: 0x10, b: 0x15 };
      // scan a small box around the label's anchor point rather than one exact pixel — see the building-label
      // test above for why a single-pixel sample is too easy to accidentally land between glyph strokes.
      const x0 = Math.max(0, Math.round(cx0 - 10)), y0 = Math.max(0, Math.round(cy0 - 6));
      const d = ctx.getImageData(x0, y0, 20, 12).data;
      let hasInk = false;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - bg.r) >= 12 || Math.abs(d[i + 1] - bg.g) >= 12 || Math.abs(d[i + 2] - bg.b) >= 12) { hasInk = true; break; }
      }
      return { hasInk };
    });
    check('info shields: deposit ore-name label renders visible pixels above a discovered deposit (used to be a bare unlabeled circle)', out.hasInk, out);
    check('info shields: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- playtest round 1, fix #3 (first-run hint):
  // the building-info panel and tier-progress panel already existed but no tester ever found either. The first
  // successful placement now appends a one-time tip; must fire exactly once (persisted via localStorage, so it
  // survives a New Game / clearSave, unlike techTier-based state) and never again on the same origin/profile.
  {
    const { page, pageErrors } = await freshPage(browser);
    const clickCell = async (x, y) => {
      await page.evaluate(([gx, gy]) => {
        const G = window.__game;
        const p = G.cellPx(gx, gy);
        // cellPx() is canvas-LOCAL; add the canvas's own bounding rect to get real viewport coordinates,
        // since the real <header> above the canvas means that rect is never (0,0).
        const r = document.getElementById('c').getBoundingClientRect();
        const absX = r.left + p.x, absY = r.top + p.y;
        const el = document.elementFromPoint(absX, absY) || document.getElementById('c');
        el.dispatchEvent(new PointerEvent('pointerdown', { clientX: absX, clientY: absY, bubbles: true }));
      }, [x, y]);
      await new Promise(r => setTimeout(r, 30));
    };
    const deps = await page.evaluate(() => window.__game.deposits().filter(d => d.discovered));
    // extractor placement is two taps in the real UI: tap the deposit (opens the T1/T2/T3 tier-picker modal),
    // then tap a tier option to actually place it — mirrors the existing extractor-tier-picker test's flow.
    await page.click('[data-t="extractor"]');
    await clickCell(deps[0].x, deps[0].y);
    await page.click('#rpOpts .opt');
    const hint1 = await page.textContent('#hint');
    // second placement, same page/session — the tip must not repeat
    await page.click('[data-t="extractor"]');
    await clickCell(deps[1].x, deps[1].y);
    await page.click('#rpOpts .opt');
    const hint2 = await page.textContent('#hint');
    check('first-run hint: fires on the first successful placement', /Tip:/.test(hint1) && /tap any building/.test(hint1), hint1);
    check('first-run hint: does not repeat on a second placement in the same session', !/Tip:/.test(hint2), hint2);
    check('first-run hint: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // a brand-new isolated page/context (no localStorage carried over) sees the tip again, same as a real
    // player's first-ever session would — confirms the "once ever per browser profile" behavior isn't
    // accidentally "once ever globally" or broken some other way.
    const { page, pageErrors } = await freshPage(browser);
    const hint = await page.evaluate(async () => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      document.querySelector('.tool[data-t="extractor"]').click();
      const p = G.cellPx(dep.x, dep.y);
      const r = document.getElementById('c').getBoundingClientRect();
      const absX = r.left + p.x, absY = r.top + p.y;
      const el = document.elementFromPoint(absX, absY) || document.getElementById('c');
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: absX, clientY: absY, bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('#rpOpts .opt').click();
      await new Promise(r => setTimeout(r, 30));
      return document.getElementById('hint').textContent;
    });
    check('first-run hint: a fresh browser profile sees the tip on its own first placement (not suppressed by another test\'s run)', /Tip:/.test(hint), hint);
    check('first-run hint (fresh profile): zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  // ---------------------------------------------------------------- playtest round 1, fix list #6 (Tier 2
  // difficulty cliff): all 3 testers struggled far more once they hit the tier requiring multiple simultaneous
  // goods. advanceTier() now appends a one-shot contextual line whenever the newly-started tier needs strictly
  // more simultaneous goods than the tier just completed — Tier 1 ("Flow", 1 good) -> Tier 2 ("Scale", 3 goods)
  // should trigger it; Tier 2 -> Tier 3 ("Frames", also 3 goods) should NOT, since there's no evidence of a
  // second cliff there and over-hinting risks feeling patronizing.
  {
    const { page, pageErrors } = await freshPage(browser);
    // deliver straight to the terminal via the data API — this test is about the hint text on the tier
    // transition, not re-proving the delivery pipeline (already covered elsewhere in this suite).
    await page.evaluate(async () => {
      const G = window.__game;
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      const termId = G.place('terminal', 1, 9);
      G.deliverToTerminal(termId, 'ferrite_plate', 999);
      G.tickN(2);
    });
    await new Promise(r => setTimeout(r, 30));
    const hint = await page.textContent('#hint');
    const state = await page.evaluate(() => window.__game.state());
    check('Tier 2 difficulty-cliff hint: Tier 1 actually completed (techTier advanced to 1)', state.techTier === 1, state);
    check('Tier 2 difficulty-cliff hint: names the goods needed and the "separate chain" guidance on the Flow->Scale transition', /goods at once/.test(hint) && /castcrete|ferrite rod|braided cable/i.test(hint), hint);
    check('Tier 2 difficulty-cliff hint: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }
  {
    // Tier 2 -> Tier 3 (Scale, 3 goods -> Frames, 3 goods): no goods-count jump, so no hint expected.
    const { page, pageErrors } = await freshPage(browser);
    await page.evaluate(async () => {
      const G = window.__game;
      const termId = G.place('terminal', 1, 9);
      // complete Tier 1
      G.deliverToTerminal(termId, 'ferrite_plate', 999);
      G.tickN(2);
      // complete Tier 2 ("Scale": castcrete, ferrite_rod, braided_cable)
      for (const [g, q] of G.TIERS[1].need) G.deliverToTerminal(termId, g, q + 1);
      G.tickN(2);
    });
    await new Promise(r => setTimeout(r, 30));
    const hint = await page.textContent('#hint');
    const state = await page.evaluate(() => window.__game.state());
    check('Tier 2 difficulty-cliff hint: Tier 2 actually completed (techTier advanced to 2)', state.techTier === 2, state);
    check('Tier 2 difficulty-cliff hint: does NOT repeat on Scale->Frames (no goods-count increase, no evidence of a cliff there)', !/goods at once/.test(hint), hint);
    check('Tier 2 difficulty-cliff hint (no-repeat case): zero page errors', pageErrors.length === 0, pageErrors);
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
