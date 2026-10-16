// Mission pass rules, driven through developer mode (/developer, quick flow): shortcuts that skip a
// required step must not pass, and a line erased after drawing does not un-tick its objective.
// Needs the dev server on :5173 (npm run dev).
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 844, height: 390 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const g = (fn, arg) => page.evaluate(fn, arg);

await page.goto('http://localhost:5173/developer');
await page.locator('#btn-start').click({ timeout: 120000 });
await page.getByRole('button', { name: 'Mulai' }).click();
await page.waitForSelector('.level-grid');
await page.locator('.dev-check input').check();

async function enter(n) {
  await page.locator(`.level-card:nth-child(${n})`).click();
  await page.waitForSelector('#hud:not([hidden])', { timeout: 60000 });
}
async function debrief() {
  await page.waitForSelector('.score', { timeout: 15000 });
  const r = await g(() => ({ title: document.querySelector('h2').textContent, text: document.querySelector('.brief-text').textContent }));
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.waitForSelector('.level-grid');
  return r;
}
const teleport = (p) => g((p) => window.__game.devTeleport(p[0] + 0.5, p[1] + 0.5), p);

// ---- level 3: erasing a drawn line keeps the objective done
await enter(3);
await g(() => { const gm = window.__game, A = gm.mission.A; gm.map.lines.push({ x: A[0], z: A[1], az: 90, len: 50, pen: false }); });
await page.waitForTimeout(300);
const drawn = await g(() => window.__game.mission.objectives[1].done);
await g(() => { window.__game.map.lines.length = 0; });
await page.waitForTimeout(300);
const kept = await g(() => window.__game.mission.objectives[1].done);
check('L3 line objective stays done after erasing', drawn && kept, `${drawn} → ${kept}`);
await page.locator('#btn-menu').dispatchEvent('pointerdown');
await debrief();

// ---- level 4: all crossroads checked but no starting resection → not passed
await enter(4);
const dest = await g(() => {
  const m = window.__game.mission;
  m.checked = m.checked.map(() => 0);
  m.checked.forEach((_, k) => { m.objectives[3 + k].done = true; });
  return window.__game.sites.route.dest;
});
await teleport(dest);
await g(() => window.__game.mission.actions().find((a) => a.id === 'arrive').run());
let r = await debrief();
check('L4 without starting resection fails', /Belum lulus/.test(r.title), r.title);
check('L4 explains the missing resection', /Resection di titik awal tidak dilakukan/.test(r.text));

// Level 5 opens with the pace calibration: reuse a saved count to go straight to the forest edge.
const skipCalib = () => g(() => {
  const gm = window.__game;
  gm.progress.paceCount = 133;
  gm.mission.actions().find((a) => a.id === 'calib-skip').run();
});

// ---- level 5: walking straight to the post (no lock, no team) → not passed
await enter(5);
await skipCalib();
await teleport(await g(() => window.__game.mission.target));
r = await debrief();
check('L5 without lock/team fails', /Belum lulus/.test(r.title), r.title);
check('L5 explains the skipped flow', /tanpa alur navigasi tertutup/.test(r.text));

// ---- level 5: lock + team placed and the detour made, then reaching the post → passed
await enter(5);
await skipCalib();
await g(async () => {
  const m = window.__game.mission;
  m.detourDone = true;
  m.locked = 90;
  m.c.lockCompass(90);
  m.placeTeam();
  m.endLeg(); // while cutting, the team carries the player; stop to walk (and teleport) freely
});
await teleport(await g(() => window.__game.mission.target));
r = await debrief();
check('L5 with lock and team passes', /Berhasil/.test(r.title), r.title);

// ---- level 6: straight to the post → not passed, lessons name the skipped steps
await enter(6);
await teleport(await g(() => window.__game.mission.target));
r = await debrief();
check('L6 without the full flow fails', /Belum lulus/.test(r.title), r.title);
check('L6 names the skipped steps', /resection awal tidak dilakukan/.test(r.text) && /tanpa alur navigasi tertutup/.test(r.text));
check('L6 no misleading "meleset jauh" lesson', !/meleset jauh/.test(r.text));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(failed ? 1 : 0);
