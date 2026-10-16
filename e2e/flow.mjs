// Full menu flow without debug shortcuts: packing (with missing tools), quiz, briefing, destination
// marking, quitting a mission, debrief buttons.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
await ctx.addInitScript(() => localStorage.setItem('navigame-progress-v2', JSON.stringify({ unlocked: 6, best: {}, paceCount: null })));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const check = (name, ok, extra = '') => console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
const g = (fn, arg) => page.evaluate(fn, arg);

async function answerQuiz() {
  while (await page.locator('.quiz-opts').count()) {
    const opt = page.locator('.quiz-opt:not([disabled])').first();
    if (!(await opt.count())) { await page.waitForTimeout(300); continue; }
    await opt.click();
    await page.waitForTimeout(900);
  }
}

await page.goto('http://localhost:5173/?debug'); // debug only exposes the handle; no shortcuts
await page.locator('#btn-start').click({ timeout: 120000 });
await page.getByRole('button', { name: 'Mulai' }).click();

// ---- level 2 (resection) with only map + compass packed
await page.locator('.level-card:nth-child(2)').click();
// match the item name exactly: descriptions mention other tools (e.g. "Menahan peta…")
for (const name of ['Peta', 'Kompas']) await page.locator('.pack-items .pack-item').filter({ has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) }).click();
// a decoy (not a navigation tool) packed by mistake shows up in the debrief
await page.locator('.pack-items .pack-item').filter({ has: page.locator('b', { hasText: /^(GPS|Senter|Spidol|Kalkulator|Peluit|Teropong|Jas hujan|Busur 180°)$/ }) }).first().click();
await page.getByRole('button', { name: 'Berangkat' }).click();
check('missing-tools warning shown', /Belum dikemas/.test(await page.locator('.warn').first().textContent()));
await page.getByRole('button', { name: 'Berangkat' }).click();
await answerQuiz();
check('briefing mentions missing tools', /Alat tertinggal/.test(await page.locator('.brief-text').textContent()));
await page.getByRole('button', { name: 'Lanjut' }).click();
await page.waitForSelector('#hud:not([hidden])', { timeout: 60000 });
check('field reached', true);
await page.locator('#btn-map').dispatchEvent('pointerdown');
const tools = await page.locator('.map-tools button:not([hidden])').allTextContents();
check('palette only offers packed tools', tools.join(',') === 'Geser', tools.join(','));
await page.locator('#map-close').click();
await page.getByRole('button', { name: 'Tandai posisiku' }).dispatchEvent('pointerdown');
await page.waitForTimeout(300);
check('marking without pencil/pen is refused', /alat tulis/i.test(await page.locator('#toast').textContent()), await page.locator('#toast').textContent());
await page.locator('#btn-menu').dispatchEvent('pointerdown');
await page.waitForSelector('.score', { timeout: 10000 });
check('quitting shows the debrief', /Belum lulus/.test(await page.locator('h2').textContent()));
check('debrief lists missing tools', /Alat yang tertinggal/.test(await page.locator('.brief-text').textContent()));
check('debrief explains the decoy', /bukan alat navigasi/.test(await page.locator('.brief-text').textContent()));
await page.getByRole('button', { name: 'Menu' }).click();
await page.waitForSelector('.level-grid');
check('back to level select', true);

// ---- level 4 (route) with all tools: destination marking from coordinates
await page.locator('.level-card:nth-child(4)').click();
await page.getByRole('button', { name: 'Kemas alat navigasi' }).click();
await page.getByRole('button', { name: 'Berangkat' }).click();
await answerQuiz();
await page.getByRole('button', { name: 'Lanjut' }).click();
await page.waitForSelector('.map-banner:not([hidden])', { timeout: 60000 });
check('destination prompt shows coordinates', /LS, .* BT/.test(await page.locator('.map-banner').textContent()), await page.locator('.map-banner').textContent());
// first a wrong tap far away, then the right place
const tapAt = async (x, z) => {
  await g(([x, z]) => { const m = window.__game.map; m.cx = x; m.cz = z; m.redraw(); }, [x, z]);
  await page.waitForTimeout(150);
  const [sx, sy] = await g(([x, z]) => {
    const m = window.__game.map, r = m.canvas.getBoundingClientRect();
    const dx = (x - m.cx) * m.zoom, dz = (z - m.cz) * m.zoom, c = Math.cos(m.rot), s = Math.sin(m.rot);
    return [r.left + r.width / 2 + dx * c - dz * s, r.top + r.height / 2 + dx * s + dz * c];
  }, [x, z]);
  await page.mouse.click(sx, sy);
  await page.getByRole('button', { name: 'Kirim' }).click();
  await page.waitForTimeout(400);
};
const dest = await g(() => window.__game.sites.route.dest);
await tapAt(dest[0] + 120, dest[1]);
check('wrong destination is rejected', /Belum tepat/.test(await page.locator('#toast').textContent()), await page.locator('#toast').textContent());
await tapAt(dest[0] + 2, dest[1] - 2);
await page.waitForSelector('#hud:not([hidden])', { timeout: 20000 });
check('destination accepted, field starts', /Tujuan ditandai/.test(await page.locator('#toast').textContent()), await page.locator('#toast').textContent());
check('destination mark stays on the map', await g(() => window.__game.map.marks.some((m) => m.label === 'Tujuan')));

// ---- finish level 4 quickly (teleports) and use "next level"
await g(async () => {
  const G = window.__game, r = G.sites.route;
  for (const j of r.crossroads) {
    G.player.teleport(j[0] + 1, j[1] + 1, 0);
    await new Promise((res) => setTimeout(res, 300));
    G.mission.checked = G.mission.checked.map(() => 0);
  }
  // the starting resection (objective 2) is required to pass, like the crossroads checks
  G.mission.objectives.forEach((o, k) => { if (k === 1 || k >= 3) o.done = true; });
  G.player.teleport(r.dest[0] + 1, r.dest[1] + 1, 0);
  G.mission.actions().find((a) => a.id === 'arrive').run();
});
await page.waitForSelector('.score', { timeout: 15000 });
check('level 4 debrief', /Berhasil/.test(await page.locator('h2').textContent()), await page.locator('h2').textContent());
await page.getByRole('button', { name: 'Level berikutnya' }).click();
await page.waitForSelector('.pack-items, .pouch', { timeout: 10000 });
check('next level goes to packing for level 5', /Level 5/.test(await page.locator('h2').textContent()));
const saved = await g(() => JSON.parse(localStorage.getItem('navigame-progress-v2')));
check('progress saved', saved.best[4] !== undefined, JSON.stringify(saved));
console.log('page errors:', errors);
await browser.close();
