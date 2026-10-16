// Developer mode (/developer): all levels open, quick flow, panel, flight, teleport, map marker,
// mission inspector and bug report. Needs the dev server on :5173 (npm run dev).
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
await ctx.addInitScript(() => localStorage.setItem('navigame-progress-v2', JSON.stringify({ unlocked: 2, best: {}, paceCount: null })));
const page = await ctx.newPage();
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
check('all levels open in developer mode', (await page.locator('.level-card.locked').count()) === 0);
check('developer options on level select', await page.locator('.dev-levels').isVisible());
check('student progress untouched', (await g(() => JSON.parse(localStorage.getItem('navigame-progress-v2')).unlocked)) === 2);

// ---- quick flow into level 3 (intersection)
await page.locator('.dev-check input').check();
await page.locator('.level-card:nth-child(3)').click();
await page.waitForSelector('#hud:not([hidden])', { timeout: 60000 });
check('quick flow reaches the field', true);
await page.locator('.dev-toggle').click();
await page.waitForTimeout(400);
const panel = await page.locator('.dev-panel').textContent();
check('panel shows exact position', /Blok \(x, z\)/.test(panel) && /LS/.test(panel) && /BT/.test(panel));
check('panel shows mission inspector', /Azimut benar A → asap/.test(panel), '');
check('panel shows answer key', /az \d{3}° · back \d{3}°/.test(panel));

// teleport to Pos B via the mission point buttons
await page.locator('.dev-points button', { hasText: 'Pos B' }).click();
await page.waitForTimeout(300);
const near = await g(() => { const gm = window.__game; const m = gm.mission; return Math.hypot(gm.player.x - m.B[0], gm.player.z - m.B[1]); });
check('teleport to mission point', near < 2, `${near.toFixed(2)} blocks`);

// flight: F toggles, Space climbs
const y0 = await g(() => window.__game.player.footY);
await page.locator('#view').click({ position: { x: 600, y: 200 } }).catch(() => {});
await page.keyboard.press('Escape');
await page.locator('.dev-bar button', { hasText: 'Terbang' }).click();
await page.keyboard.down('Space');
await page.waitForTimeout(800);
await page.keyboard.up('Space');
const y1 = await g(() => window.__game.player.footY);
check('flying climbs', y1 > y0 + 3, `${y0.toFixed(1)} → ${y1.toFixed(1)}`);
await page.locator('.dev-bar button', { hasText: 'Terbang' }).click();
await page.waitForTimeout(1500);
const y2 = await g(() => window.__game.player.footY);
check('falls back to the ground after flight', y2 < y1 - 3, `${y1.toFixed(1)} → ${y2.toFixed(1)}`);

// map shows the developer position marker
await page.locator('#btn-map').dispatchEvent('pointerdown');
await page.waitForTimeout(300);
check('map has dev marker', await g(() => window.__game.map.devMarker !== null));
await page.locator('#map-close').click();

// shoot the smoke from B with the exact bearing and check the inspector picks it up
await g(() => {
  const gm = window.__game; const m = gm.mission;
  const az = Math.atan2(m.smoke[0] - gm.player.x, -(m.smoke[1] - gm.player.z)) * 180 / Math.PI;
  gm.player.yaw = -az * Math.PI / 180;
  gm.player.pitch = 0;
});
await page.waitForTimeout(200);
await page.keyboard.down('KeyC');
await page.waitForTimeout(2600);
await page.keyboard.up('KeyC');
await page.waitForTimeout(600);
const logText = await page.locator('.dev-log').textContent();
const obj = await g(() => window.__game.mission.objectives[2].done);
check('reading from B ticks objective (shown in log)', obj && /Objektif 3/.test(logText), logText.slice(0, 160));

// bug report
const rep = await g(() => window.__game.devtools.report());
check('report has mission state', rep.level === 3 && rep.mission.objectives.length === 5 && rep.readings.length >= 1);

// end the mission and check the result is logged
await page.locator('#btn-menu').dispatchEvent('pointerdown');
await page.waitForSelector('.score', { timeout: 10000 });
const logEnd = await page.locator('.dev-log').textContent();
check('mission end logged', /Level 3 selesai/.test(logEnd));
check('dev progress stored separately', (await g(() => localStorage.getItem('navigame-progress-dev'))) !== null);

check('no page errors', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: 'e2e/out/dev.png' });
await browser.close();
process.exit(failed ? 1 : 0);
