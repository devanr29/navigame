// Automated playthrough of every level in a real (headless) Chrome, driving the game the way a player
// would: aim the compass at real targets, pair readings, type back azimuths, draw lines on the map,
// tap the map, walk. Usage: node e2e/play.mjs [level ...]   (dev server must run on :5173)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE ?? 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });

// Helpers installed in the page. `g` is the debug handle window.__game.
const HELPERS = () => {
  const g = window.__game;
  const DEG = Math.PI / 180;
  const T = {
    g,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    az(fx, fz, tx, tz) { return ((Math.atan2(tx - fx, -(tz - fz)) / DEG) % 360 + 360) % 360; },
    face(az, pitchDeg = 0) { g.player.yaw = -az * DEG; g.player.pitch = pitchDeg * DEG; },
    /** Aims at a sight target (id) and takes a settled compass reading. Returns the reading. */
    async sightTarget(id) {
      const t = g.sight.target(id);
      const p = g.player;
      const eyeY = g.camera.position.y;
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      const midY = t.y + (t.bottom + t.top) / 2;
      T.face(T.az(p.x, p.z, t.x, t.z), Math.atan2(midY - eyeY, d) / DEG);
      await T.sleep(100);
      g.raiseCompass();
      await T.sleep(3200); // let the needle settle
      g.releaseCompass();
      return g.notebook.readings[g.notebook.readings.length - 1];
    },
    visibleLandmarks() {
      const c = g.camera.position;
      return g.sight.visibleLandmarks(c.x, c.y, c.z, 420);
    },
    backAz(a) { return a < 180 ? a + 180 : a > 180 ? a - 180 : 0; },
    /** Screen (client) point of a sheet point on the open map. */
    sheetToScreen(x, z) {
      const m = g.map;
      const r = m.canvas.getBoundingClientRect();
      const dx = (x - m.cx) * m.zoom, dz = (z - m.cz) * m.zoom;
      const c = Math.cos(m.rot), s = Math.sin(m.rot);
      return [r.left + r.width / 2 + dx * c - dz * s, r.top + r.height / 2 + dx * s + dz * c];
    },
    /** Intersection of two map lines (origin + azimuth). */
    cross(a, b) {
      const ax = Math.sin(a.az * DEG), az = -Math.cos(a.az * DEG);
      const bx = Math.sin(b.az * DEG), bz = -Math.cos(b.az * DEG);
      const den = ax * bz - az * bx;
      const t = ((b.x - a.x) * bz - (b.z - a.z) * bx) / den;
      return [a.x + ax * t, a.z + az * t];
    },
    objectives() { return g.mission.objectives.map((o) => `${o.done ? '✓' : '○'} ${o.text}`); },
    result() { return g.mission?.result ?? null; },
    pos() { return [g.player.x, g.player.z]; },
  };
  window.T = T;
};

async function openLevel(browser, level, extra = '') {
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`); });
  await page.goto(`${BASE}?debug&autostart&level=${level}${extra}`);
  if (level === 1) await page.waitForSelector('.quiz-opts', { timeout: 120000 });
  else await page.waitForSelector('#hud:not([hidden])', { timeout: 120000 });
  await page.evaluate(HELPERS);
  return { page, errors };
}

/** Taps the map canvas at a sheet point, then presses Kirim (the map must have a mark request open). */
async function tapSheet(page, x, z) {
  // like a player panning the map so the point is in view
  await page.evaluate(([x, z]) => { const m = T.g.map; m.cx = x; m.cz = z; m.redraw(); }, [x, z]);
  await page.waitForTimeout(100);
  const [sx, sy] = await page.evaluate(([x, z]) => T.sheetToScreen(x, z), [x, z]);
  await page.mouse.click(sx, sy);
  await page.waitForTimeout(150);
}

async function clickAction(page, label) {
  await page.getByRole('button', { name: label, exact: true }).first().dispatchEvent('pointerdown');
  await page.waitForTimeout(250);
}

async function waitResult(page, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await page.evaluate(() => T.result());
    if (r) return r;
    await page.waitForTimeout(200);
  }
  return null;
}

// ------------------------------------------------------------------ levels

const levels = {
  async 1(page) {
    // Answer each quiz question by trying options until right (counts first-try correctness).
    for (let q = 0; q < 4; q++) {
      const opts = page.locator('.quiz-opt:not([disabled])');
      const n = await opts.count();
      for (let i = 0; i < n; i++) {
        const o = page.locator('.quiz-opt:not([disabled])').first();
        if (!(await o.count())) break;
        await o.click();
        await page.waitForTimeout(150);
        if ((await page.locator('.feedback.ok').count()) > 0) break;
      }
      await page.waitForTimeout(900);
    }
    await page.waitForSelector('.score', { timeout: 5000 });
    return { score: await page.locator('.score').textContent() };
  },

  async 2(page) {
    const vis = await page.evaluate(() => T.visibleLandmarks());
    for (const id of vis.slice(0, 3)) {
      await page.evaluate(async (id) => { const r = await T.sightTarget(id); r.pairedWith = r.target; }, id);
    }
    // orient the map: open it with the right rotation for where we face
    await page.evaluate(() => {
      const g = T.g;
      const facing = ((-g.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
      g.openMap(true);
      g.map.rot = (-facing * Math.PI) / 180;
      g.map.redraw();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => T.g.openMap(false));
    const r = await waitResult(page);
    return { visible: vis, objectives: await page.evaluate(() => T.objectives()), result: r };
  },

  async 3(page) {
    // step 1: orient the map (required)
    await page.evaluate(() => {
      const g = T.g;
      const facing = ((-g.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
      g.openMap(true);
      g.map.rot = (-facing * Math.PI) / 180;
      g.map.redraw();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => T.g.openMap(false));
    const vis = await page.evaluate(() => T.visibleLandmarks());
    const lines = [];
    for (const id of vis.slice(0, 2)) {
      const line = await page.evaluate(async (id) => {
        const r = await T.sightTarget(id);
        r.pairedWith = r.target;
        r.backTyped = T.backAz(r.azimuth);
        const l = T.g.w.landmarks[id];
        const ln = { x: l.x, z: l.z, az: r.backTyped, len: 1200, pen: false };
        T.g.map.lines.push(ln);
        return { ...ln, target: r.target, az0: r.azimuth };
      }, id);
      lines.push(line);
    }
    await page.waitForTimeout(400);
    const objectivesBefore = await page.evaluate(() => T.objectives());
    const x = await page.evaluate(([a, b]) => T.cross(a, b), lines);
    await clickAction(page, 'Tandai posisiku');
    await tapSheet(page, x[0], x[1]);
    await page.getByRole('button', { name: 'Kirim' }).click();
    const r = await waitResult(page);
    return { visible: vis, lines, cross: x, truth: await page.evaluate(() => T.pos()), objectivesBefore, result: r };
  },

  async 4(page) {
    const s = await page.evaluate(() => T.g.sites.intersection);
    const la = await page.evaluate(async () => {
      const r = await T.sightTarget(100);
      const A = T.g.sites.intersection.a;
      const ln = { x: A[0], z: A[1], az: r.azimuth, len: 1200, pen: false };
      T.g.map.lines.push(ln);
      return { ...ln, target: r.target };
    });
    // walk (teleport) to Pos B
    await page.evaluate(() => { const B = T.g.sites.intersection.b; T.g.player.teleport(B[0] + 1, B[1] + 1, 0); });
    await page.waitForTimeout(1500);
    const lb = await page.evaluate(async () => {
      const r = await T.sightTarget(100);
      const B = T.g.sites.intersection.b;
      const ln = { x: B[0], z: B[1], az: r.azimuth, len: 1200, pen: false };
      T.g.map.lines.push(ln);
      return { ...ln, target: r.target };
    });
    const x = await page.evaluate(([a, b]) => T.cross(a, b), [la, lb]);
    await clickAction(page, 'Laporkan letak asap');
    await tapSheet(page, x[0], x[1]);
    await page.getByRole('button', { name: 'Kirim' }).click();
    const r = await waitResult(page);
    return { sites: s, la, lb, cross: x, objectives: await page.evaluate(() => T.objectives()), result: r };
  },

  async 5(page) {
    const route = await page.evaluate(() => T.g.sites.route);
    const markHere = async () => {
      await clickAction(page, 'Tandai posisiku');
      const p = await page.evaluate(() => T.pos());
      await tapSheet(page, p[0], p[1]);
      await page.getByRole('button', { name: 'Kirim' }).click();
      await page.waitForTimeout(300);
    };
    await markHere();
    for (const j of route.crossroads) {
      await page.evaluate((j) => T.g.player.teleport(j[0] + 2, j[1] + 2, 0), j);
      await page.waitForTimeout(800);
      await clickAction(page, 'Cek persimpangan');
      await tapSheet(page, j[0], j[1]);
      await page.getByRole('button', { name: 'Kirim' }).click();
      await page.waitForTimeout(300);
    }
    // reporting arrival away from the post does not end the mission
    await clickAction(page, 'Lapor tiba');
    await page.evaluate((d) => T.g.player.teleport(d[0] + 1, d[1] + 1, 0), route.dest);
    await page.waitForTimeout(300);
    await clickAction(page, 'Lapor tiba');
    const r = await waitResult(page, 3000);
    return { objectives: await page.evaluate(() => T.objectives()), notes: await page.evaluate(() => T.g.notebook.notes), result: r };
  },

  async 6(page) {
    const s = await page.evaluate(() => T.g.sites.declination);
    const mag = await page.evaluate(() => {
      const { start, target } = T.g.sites.declination;
      const grid = T.az(start[0], start[1], target[0], target[1]);
      return { grid, mag: ((grid - 6) % 360 + 360) % 360 };
    });
    await clickAction(page, 'Kunci kompas');
    await page.locator('.dialog-box label:nth-of-type(1) input').fill(String(Math.round(mag.mag)));
    await page.getByRole('button', { name: 'Simpan' }).click();
    // walk the locked bearing: face it and hold forward until near the target (or 160 s)
    await page.evaluate((m) => { T.face((m.mag + 6) % 360); T.g.input.forceForward = true; }, mag);
    const t0 = Date.now();
    let d = 1e9, prev = null, stuck = 0, minD = 1e9;
    while (Date.now() - t0 < 160000) {
      d = await page.evaluate(() => { const t = T.g.sites.declination.target; return Math.hypot(T.g.player.x - t[0], T.g.player.z - t[1]); });
      if (d < 3) break;
      // walking briskly, the check can step past the post: stop once the distance grows again near it
      if (minD < 10 && d > minD + 1) break;
      minD = Math.min(minD, d);
      // like a player: keep the bearing, jump up steps, sidestep what cannot be climbed
      const p = await page.evaluate(() => T.pos());
      if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 0.3) {
        stuck++;
        await page.evaluate((k) => {
          T.g.input.jump();
          if (k > 1) T.face((((-T.g.player.yaw * 180) / Math.PI) + (k % 2 ? 70 : -70) + 360) % 360);
        }, stuck);
        await page.waitForTimeout(700);
      } else stuck = 0;
      prev = p;
      // back on the bearing, aiming at the (memorised) target point like following a compass line
      await page.evaluate((m) => T.face((m.mag + 6) % 360), mag);
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => { T.g.input.forceForward = false; });
    await clickAction(page, 'Selesai leg');
    const r = await waitResult(page);
    return { site: s, mag, endDistBlocks: d, result: r };
  },

  async 7(page) {
    const course = await page.evaluate(() => {
      const m = T.g.mission;
      return { start: m.startP, end: m.endP };
    });
    // walk to the red flag
    await page.evaluate((c) => { T.face(T.az(T.g.player.x, T.g.player.z, c.end[0], c.end[1])); T.g.input.forceForward = true; }, course);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const done = await page.evaluate(() => T.g.mission.objectives[0].done);
      if (done) break;
      await page.evaluate((c) => T.face(T.az(T.g.player.x, T.g.player.z, c.end[0], c.end[1])), course);
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => { T.g.input.forceForward = false; });
    const calib = await page.evaluate(() => T.g.progress.paceCount);
    await clickAction(page, 'Mulai 300 m');
    await page.evaluate(() => { T.g.input.forceForward = true; });
    const t1 = Date.now();
    let last = null;
    while (Date.now() - t1 < 240000) {
      const st = await page.evaluate(() => ({ m: T.g.pace.metres, p: T.pos() }));
      if (st.m >= 300) break;
      // walk straight; turn only when stuck against a step
      if (last && Math.hypot(st.p[0] - last[0], st.p[1] - last[1]) < 0.2) await page.evaluate(() => { T.g.player.yaw += 1.2; });
      last = st.p;
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => { T.g.input.forceForward = false; });
    await clickAction(page, 'Selesai');
    const r = await waitResult(page);
    return { course, calib, objectives: await page.evaluate(() => T.objectives()), result: r };
  },

  async 8(page) { return navtup(page, false); },
  async 9(page) { return navtup(page, true); },

  async 10(page) {
    const info = await page.evaluate(() => ({ start: T.g.sites.final.start, target: T.g.sites.final.target }));
    const markHere = async () => {
      await clickAction(page, 'Tandai posisiku');
      const p = await page.evaluate(() => T.pos());
      await tapSheet(page, p[0], p[1]);
      await page.getByRole('button', { name: 'Kirim' }).click();
      await page.waitForTimeout(400);
    };
    await markHere();
    // find an open cell near the forest edge on the way to the target and go there
    const edge = await page.evaluate(() => {
      const g = T.g, w = g.w, N = w.size;
      const t = g.sites.final.target;
      let best = null, bd = 1e9;
      for (let z = 5; z < N - 5; z += 2) for (let x = 5; x < N - 5; x += 2) {
        const i = z * N + x;
        if (w.zone[i] !== 0 || w.water[i] >= 0 || w.solid[i]) continue;
        let near = false;
        for (let dz = -4; dz <= 4 && !near; dz++) for (let dx = -4; dx <= 4; dx++) if (w.zone[(z + dz) * N + x + dx] === 1) { near = true; break; }
        if (!near) continue;
        const d = Math.hypot(x - t[0], z - t[1]);
        if (d < bd) { bd = d; best = [x + 0.5, z + 0.5]; }
      }
      g.player.teleport(best[0], best[1], 0);
      return best;
    });
    await page.waitForTimeout(800);
    await markHere();
    const lock = await page.evaluate(() => {
      const p = T.pos(), t = T.g.sites.final.target;
      return { az: Math.round(T.az(p[0], p[1], t[0], t[1])), legBlocks: Math.hypot(t[0] - p[0], t[1] - p[1]) };
    });
    const res = await cutTo(page, lock.az, Math.round((lock.legBlocks * 2.5 * 133) / 100), false);
    return { info, edge, lock, ...res };
  },
};

async function navtup(page, obstacle) {
  const lock = await page.evaluate(() => {
    const s = T.g.sites.forest.start, t = T.g.sites.forest.target;
    return { az: Math.round(T.az(s[0], s[1], t[0], t[1])), legBlocks: Math.hypot(t[0] - s[0], t[1] - s[1]) };
  });
  return { lock, ...(await cutTo(page, lock.az, Math.round((lock.legBlocks * 2.5 * 133) / 100), obstacle)) };
}

/** Locks the compass, places the team and cuts toward the target, steering like a compasman. */
async function cutTo(page, az, steps, obstacle) {
  await clickAction(page, 'Kunci kompas');
  await page.locator('.dialog-box label:nth-of-type(1) input').fill(String(az));
  await page.locator('.dialog-box label:nth-of-type(2) input').fill(String(steps));
  await page.getByRole('button', { name: 'Simpan' }).click();
  await page.waitForTimeout(200);
  await clickAction(page, 'Atur posisi tim');
  await page.evaluate(() => { T.g.input.forceForward = true; });
  const t0 = Date.now();
  let detour = 'none';
  let blockedSeen = false;
  const log = [];
  let minD = Infinity;
  while (Date.now() - t0 < 300000) {
    const st = await page.evaluate(() => {
      const g = T.g, tm = g.team;
      const tgt = g.mission.target;
      return {
        dev: tm.deviation(), blocked: tm.blocked, cutting: tm.cutting, heading: tm.heading,
        d: Math.hypot(g.player.x - tgt[0], g.player.z - tgt[1]), steps: g.pace.steps, result: !!g.mission.result,
      };
    });
    if (st.result) break;
    if (st.blocked) blockedSeen = true;
    // compasman: steer back toward the bearing
    await page.evaluate((dev) => { T.g.team.steer = dev === null || Math.abs(dev) < 0.5 ? 0 : dev > 0 ? -1 : 1; }, st.dev);
    if (obstacle && st.blocked && detour === 'none') {
      // detour by distance, like counting paces: right 90° for 14 blocks, back on the bearing for 10,
      // left 90° for 14 to return to the line, then resume the bearing.
      detour = 'side';
      const leg = async (turn, blocks) => {
        await page.evaluate((turn) => { const tm = T.g.team; tm.turn90(turn); tm.locked = (tm.locked + 90 * turn + 360) % 360; }, turn);
        const p0 = await page.evaluate(() => [T.g.team.lead.x, T.g.team.lead.y]);
        const until = Date.now() + 90000;
        while (Date.now() < until) {
          const p = await page.evaluate(() => [T.g.team.lead.x, T.g.team.lead.y]);
          if (Math.hypot(p[0] - p0[0], p[1] - p0[1]) >= blocks) break;
          await page.evaluate(() => { const dev = T.g.team.deviation(); T.g.team.steer = dev === null || Math.abs(dev) < 0.5 ? 0 : dev > 0 ? -1 : 1; });
          await page.waitForTimeout(150);
        }
      };
      await leg(1, 14);
      await leg(-1, 10);
      await leg(-1, 14);
      await page.evaluate(() => { const tm = T.g.team; tm.turn90(1); tm.locked = (tm.locked + 90) % 360; });
      detour = 'done';
    }
    // End the leg at the post, or once it is clearly past it (the distance grows again near the
    // post): then search around the end point, as the GDD's end-of-leg search.
    minD = Math.min(minD, st.d);
    if (st.cutting && (st.d < 6 || (minD < 20 && st.d > minD + 2))) {
      await page.evaluate(() => { T.g.input.forceForward = false; });
      await clickAction(page, 'Selesai leg');
      // walk the last few blocks to the post
      await page.evaluate(() => {
        const g = T.g, t = g.mission.target;
        T.face(T.az(g.player.x, g.player.z, t[0], t[1]));
        g.input.forceForward = true;
      });
    }
    if (log.length < 400) log.push([Math.round(st.d), Math.round(st.steps), st.dev === null ? null : Math.round(st.dev), st.blocked]);
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => { T.g.input.forceForward = false; });
  const r = await waitResult(page, 3000);
  return { blockedSeen, detour, objectives: await page.evaluate(() => T.objectives()), lastLog: log.slice(-6), result: r };
}

// ------------------------------------------------------------------ run

const which = process.argv.slice(2).map(Number);
const list = which.length ? which : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const results = await Promise.all(list.map(async (lv) => {
  // one browser per level so no page is a throttled background tab
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let page, errors = [];
  try {
    ({ page, errors } = await openLevel(browser, lv));
    const out = await levels[lv](page);
    await page.screenshot({ path: `${OUT}level${lv}.png` });
    return { level: lv, ok: true, out, errors };
  } catch (e) {
    if (page) await page.screenshot({ path: `${OUT}level${lv}-fail.png` }).catch(() => {});
    return { level: lv, ok: false, error: String(e?.stack ?? e).slice(0, 600), errors };
  } finally {
    await browser.close();
  }
}));
for (const r of results) {
  const res = r.out?.result;
  console.log(`=== Level ${r.level}: ${r.ok ? 'ran' : 'CRASHED'} ${res ? (res.passed ? 'PASSED' : 'FAILED') + ' score ' + res.score : r.ok ? '(no result)' : ''}`);
  if (r.error) console.log(r.error);
  if (r.errors.length) console.log('page errors:', r.errors);
  const { result, ...rest } = r.out ?? {};
  void result;
  console.log(JSON.stringify(rest));
  if (res) console.log('stats:', JSON.stringify(res.stats));
  if (res) console.log('lessons:', JSON.stringify(res.lessons));
}
