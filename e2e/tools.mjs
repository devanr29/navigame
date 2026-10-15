// Exercises the map tools and the notebook through real taps/drags on the map canvas.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/?debug&autostart&level=3');
await page.waitForSelector('#hud:not([hidden])', { timeout: 120000 });
const g = (fn, arg) => page.evaluate(fn, arg);
const toScreen = (x, z) => g(([x, z]) => {
  const m = window.__game.map, r = m.canvas.getBoundingClientRect();
  const dx = (x - m.cx) * m.zoom, dz = (z - m.cz) * m.zoom, c = Math.cos(m.rot), s = Math.sin(m.rot);
  return [r.left + r.width / 2 + dx * c - dz * s, r.top + r.height / 2 + dx * s + dz * c];
}, [x, z]);
const check = (name, ok, extra = '') => console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`);
const tool = (label) => page.locator('.map-tools button', { hasText: label }).click();

// --- take a reading of a visible landmark and pair it through the notebook UI
const lm = await g(async () => {
  const G = window.__game, c = G.camera.position;
  const id = G.sight.visibleLandmarks(c.x, c.y, c.z, 420)[0];
  const t = G.sight.target(id), p = G.player;
  const az = ((Math.atan2(t.x - p.x, -(t.z - p.z)) * 180 / Math.PI) % 360 + 360) % 360;
  p.yaw = -az * Math.PI / 180;
  p.pitch = Math.atan2(t.y + (t.bottom + t.top) / 2 - c.y, Math.hypot(t.x - p.x, t.z - p.z));
  await new Promise((r) => setTimeout(r, 100));
  G.raiseCompass();
  await new Promise((r) => setTimeout(r, 3200));
  G.releaseCompass();
  return { id, x: G.w.landmarks[id].x, z: G.w.landmarks[id].z, reading: G.notebook.readings[0] };
});
check('reading hits the landmark', lm.reading.target === lm.id, JSON.stringify(lm.reading));
await page.locator('#btn-notebook').dispatchEvent('pointerdown');
await page.getByRole('button', { name: 'Pasangkan…' }).click();
await page.waitForTimeout(300);
let [sx, sy] = await toScreen(lm.x, lm.z);
await page.mouse.click(sx, sy);
await page.waitForTimeout(300);
const paired = await g(() => window.__game.notebook.readings[0].pairedWith);
check('pairing by tapping the symbol', paired === lm.id, `paired=${paired}`);
check('notebook reopened after pairing', await g(() => window.__game.notebook.isOpen()));
// type the back azimuth, wrong then right
const back = lm.reading.azimuth < 180 ? lm.reading.azimuth + 180 : lm.reading.azimuth > 180 ? lm.reading.azimuth - 180 : 0;
await page.locator('.nb-input').fill(String((back + 10) % 360));
await page.locator('.nb-input').dispatchEvent('change');
check('wrong back azimuth marked ✗', (await page.locator('.nb-check').textContent()) === '✗');
await page.locator('.nb-input').fill(String(back));
await page.locator('.nb-input').dispatchEvent('change');
check('right back azimuth marked ✓', (await page.locator('.nb-check').textContent()) === '✓');
await page.locator('#notebook-close').click();

// --- open the map and use the tools
await page.locator('#btn-map').dispatchEvent('pointerdown');
await page.waitForTimeout(300);
await tool('Busur');
[sx, sy] = await toScreen(lm.x + 1, lm.z + 1); // near the symbol: should snap onto it
await page.mouse.click(sx, sy);
const prot = await g(() => window.__game.map.protractor);
check('protractor snaps to symbol', prot && prot.x === lm.x && prot.z === lm.z, JSON.stringify(prot));
await page.locator('.prot-input').fill(String(back));
await page.locator('.prot-input').dispatchEvent('input');
await page.getByRole('button', { name: 'Gariskan' }).click();
const line = await g(() => window.__game.map.lines[0]);
check('protractor draws a line at the typed angle', line && Math.abs(line.az - back) < 0.01 && line.x === lm.x, JSON.stringify(line));
await page.getByRole('button', { name: '+1°' }).click();
check('+1° nudges', (await g(() => window.__game.map.protractor.az)) === (back + 1) % 360);

await tool('Penggaris');
const [ax, ay] = await toScreen(100, 100), [bx, by] = await toScreen(500, 100);
await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps: 8 }); await page.mouse.up();
const ro = await page.locator('.map-readout').textContent();
check('ruler: 400 blocks = 1 km = 4 cm at 1:25.000', /4,0\d cm|3,9\d cm/.test(ro), ro);
// phone way: pan so the point is under the centre crosshair, then press Titik awal / Titik akhir
const centreOn = (x, z) => g(([x, z]) => { const m = window.__game.map; m.cx = x; m.cz = z; m.redraw(); }, [x, z]);
check('Titik akhir disabled before a start', await page.getByRole('button', { name: 'Titik akhir' }).isDisabled());
await centreOn(150, 300);
await page.getByRole('button', { name: 'Titik awal' }).click();
await centreOn(350, 300);
await page.waitForFunction(() => !/ 0,00 cm/.test(document.querySelector('.map-readout').textContent), null, { timeout: 8000 }).catch(() => {});
check('ruler end follows the crosshair', /2,0\d cm|1,9\d cm/.test(await page.locator('.map-readout').textContent()), await page.locator('.map-readout').textContent());
await page.getByRole('button', { name: 'Titik akhir' }).click();
await centreOn(600, 600);
await page.waitForTimeout(100);
const ro2 = await page.locator('.map-readout').textContent();
check('ruler buttons: 200 blocks = 2 cm, end stays after Titik akhir', /2,0\d cm|1,9\d cm/.test(ro2), ro2);
check('map notes list the paired reading with its back azimuth', /balik/.test(await page.locator('.map-notes').textContent()), await page.locator('.map-notes').textContent());

await tool('Pensil');
await page.mouse.move(ax, ay + 40); await page.mouse.down(); await page.mouse.move(bx, by + 40, { steps: 10 }); await page.mouse.up();
check('pencil stroke drawn', (await g(() => window.__game.map.strokes.length)) === 1);
await tool('Titik');
await page.mouse.click(ax, ay + 80);
check('point mark placed', (await g(() => window.__game.map.marks.length)) === 1);
await tool('Hapus');
const [mx, my] = [(ax + bx) / 2, ay + 40];
await page.mouse.move(mx - 30, my); await page.mouse.down(); await page.mouse.move(mx + 30, my, { steps: 6 }); await page.mouse.up();
check('eraser removes the pencil stroke', (await g(() => window.__game.map.strokes.length)) === 0);

// lock orientation then try to rotate with Q
await page.locator('.map-tools button', { hasText: 'Kunci arah' }).click();
const r0 = await g(() => window.__game.map.rot);
await page.keyboard.press('KeyE');
check('locked map does not rotate', (await g(() => window.__game.map.rot)) === r0);
await page.locator('.map-tools button', { hasText: 'Kunci arah' }).click();
await page.keyboard.press('KeyE');
check('unlocked map rotates', (await g(() => window.__game.map.rot)) !== r0);

// objectives should reflect the work
const obj = await g(() => window.__game.mission.objectives.map((o) => `${o.done ? '✓' : '○'} ${o.text}`));
console.log(obj.join('\n'));
console.log('page errors:', errors);
await page.screenshot({ path: 'e2e/out/tools.png' });
await browser.close();
