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
  await page.evaluate(() => { window.__game.CFG.autoPower = true; window.__game.clearSave(); window.__game.reset(); });
  return { page, pageErrors };
}

async function main() {
  if (!fs.existsSync(INDEX)) { console.error('index.html not found next to tests/ — run from the repo root or check the path.'); process.exit(1); }
  const browser = await chromium.launch(launchOpts);

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
      return { connectsOk: !c1.err && !c2.err && !c3.err, delivered: st.delivered, fabUtil: st.nodes[fabId].util };
    });
    check('base chain: all connects ok', out.connectsOk, out);
    check('base chain: delivered > 0 after 30s', out.delivered > 0, out);
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
        ex1Util: st.nodes[ex1].util, ex2Util: st.nodes[ex2].util, delivered: st.delivered };
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
        G.reset();
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
        G.reset();
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
      const dep = G.deposits().find(d => d.good === 'ferrite_ore');
      const exId = G.place('extractor', dep.x, dep.y, null, 1);
      const smId = G.place('smelter', dep.x + 1, dep.y, 'smelt_ferrite');
      const fabId = G.place('fabricator', dep.x + 2, dep.y, 'fab_plate');
      const termId = G.place('terminal', dep.x + 3, dep.y);
      G.connect(exId, smId); G.connect(smId, fabId); G.connect(fabId, termId);
      G.tickN(5);
      const deliveredBefore = G.state().delivered;
      G.saveGame();
      const raw = JSON.parse(localStorage.getItem('lineBalance_save_v1'));
      raw.savedAt = Date.now() - 3600 * 1000; // pretend 1 hour passed
      localStorage.setItem('lineBalance_save_v1', JSON.stringify(raw));
      const ok = window.__game.loadGame();
      const deliveredAfter = window.__game.state().delivered;
      const noSaveFallback = (window.__game.clearSave(), window.__game.loadGame() === false);
      return { ok, deliveredBefore, deliveredAfter, gained: deliveredAfter - deliveredBefore, noSaveFallback };
    });
    check('offline catch-up: loadGame() returns true when a save exists', out.ok, out);
    check('offline catch-up: 1 simulated hour away increases delivered substantially', out.gained > out.deliveredBefore, out);
    check('offline catch-up: loadGame() returns false with no save present (clean fallback to reset())', out.noSaveFallback, out);
    check('save/load: zero page errors', pageErrors.length === 0, pageErrors);
    await page.close();
  }

  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch(e => { console.error('Regression suite crashed:', e); process.exitCode = 1; });
