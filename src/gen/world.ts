// World generator: one seeded heightmap is the single source for the voxel world and the topographic map.
// Pure function, no DOM: runs in a Web Worker in the game and directly under Node in the tests.

import {
  WORLD_SIZE, Surface, Zone,
  type Landmark, type Polyline, type WorldData,
} from './constants';
import { bump, cellRand, fbm, hashString, makeRng, makeSimplex, ridged, smoothstep } from './noise';

export type Progress = (stage: string, frac: number) => void;

type P = [number, number];

/** Names for the smaller hilltops (fictional, in the style of West Java place names). */
const HILL_NAMES = ['Bukit Pasir Angin', 'Bukit Tenjo', 'Bukit Cikoneng', 'Bukit Batu Kuda', 'Bukit Lingga', 'Bukit Pangparang'];

const MAIN_HALF_W = 3; // main river channel half-width in blocks (about 15 m wide)
const TRIB_HALF_W = 1.5;

export function generateWorld(seed: string, onProgress: Progress = () => {}): WorldData {
  const N = WORLD_SIZE;
  const NN = N * N;
  const rng = makeRng(hashString(seed));
  const nBase = makeSimplex(rng);
  const nRidge = makeSimplex(rng);
  const nWarp = makeSimplex(rng);
  const nForest = makeSimplex(rng);
  const J = (s: number) => (rng() * 2 - 1) * s;
  // Horizontal sizes below were tuned for an 800-block world; S scales them to the current size.
  const S = N / 800;

  // The layout is a fixed template (river on one side, two mountains joined by a ridge on the other,
  // forest in a corner) that each seed mirrors / transposes and jitters, so every world has every feature.
  const flipX = rng() < 0.5;
  const flipZ = rng() < 0.5;
  const swap = rng() < 0.5;
  const T = (u: number, v: number): P => {
    let a = flipX ? 1 - u : u;
    let b = flipZ ? 1 - v : v;
    if (swap) { const t = a; a = b; b = t; }
    return [a * N, b * N];
  };

  // ---------------------------------------------------------------- 1. Base heightmap
  onProgress('Membentuk relief', 0);
  const mA = T(0.7 + J(0.04), 0.27 + J(0.04)); // main peak
  const mB = T(0.72 + J(0.04), 0.74 + J(0.04)); // second peak (radio tower)
  const hills: { c: P; r2: number; a: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const r = (55 + rng() * 45) * S;
    hills.push({ c: T(0.05 + rng() * 0.16, 0.1 + i * 0.22 + J(0.05)), r2: r * r, a: 16 + rng() * 18 });
  }
  hills.push({ c: T(0.47 + J(0.03), 0.05 + rng() * 0.25), r2: (70 * S) ** 2, a: 14 + rng() * 10 });

  const heightF = new Float32Array(NN);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      let h = 14;
      h += 80 * bump(d2(x, z, mA), (215 * S) ** 2);
      h += 66 * bump(d2(x, z, mB), (185 * S) ** 2);
      h += 40 * bump(d2seg(x, z, mA, mB), (85 * S) ** 2);
      for (const hl of hills) h += hl.a * bump(d2(x, z, hl.c), hl.r2);
      const m = clamp01((h - 14) / 80);
      h += fbm(nBase, x / 190, z / 190, 5) * 12;
      const wx = fbm(nWarp, x / 300, z / 300, 2) * 40;
      const wz = fbm(nWarp, (x + 913) / 300, z / 300, 2) * 40;
      h += (ridged(nRidge, (x + wx) / 150, (z + wz) / 150, 4) - 0.45) * (8 + 24 * m);
      heightF[z * N + x] = h < 2 ? 2 : h;
    }
    if ((z & 63) === 0) onProgress('Membentuk relief', z / N);
  }

  // ---------------------------------------------------------------- 2. Rivers (carve valleys)
  onProgress('Mengalirkan sungai', 0);
  const water = new Int16Array(NN).fill(-1);
  const riverId = new Uint8Array(NN); // 1 = main river, 2 = tributary
  const surface = new Uint8Array(NN);
  const sandMask = new Uint8Array(NN);

  const mainCtrl: P[] = [];
  const mu = 0.3 + J(0.04);
  for (let k = 0; k <= 7; k++) mainCtrl.push(T(mu + J(0.05), -0.05 + k * 0.157));
  const mainPath = catmullRom(mainCtrl);
  const mainLevels = carveRiver(mainPath, MAIN_HALF_W, 1, -Infinity);

  // Tributary: from the saddle's flank down to the main river, making a river junction.
  const tribStart = T(0.6 + J(0.03), 0.51 + J(0.03));
  const jIdx = nearestIndex(mainPath, T(mu, 0.52));
  const junction: P = [mainPath[jIdx * 2], mainPath[jIdx * 2 + 1]];
  const tdx = junction[0] - tribStart[0];
  const tdz = junction[1] - tribStart[1];
  const tlen = Math.sqrt(tdx * tdx + tdz * tdz);
  const bend = (t: number, off: number): P =>
    [tribStart[0] + tdx * t - (tdz / tlen) * off, tribStart[1] + tdz * t + (tdx / tlen) * off];
  const tribPath = catmullRom([tribStart, bend(0.33, J(40)), bend(0.66, J(40)), junction]);
  carveRiver(tribPath, TRIB_HALF_W, 2, mainLevels[jIdx]);
  onProgress('Mengalirkan sungai', 1);

  // ---------------------------------------------------------------- 3. Forest zone
  const zone = new Uint8Array(NN);
  const fc = T(0.17 + J(0.03), 0.75 + J(0.03));
  const fr = N * 0.19;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      const d = Math.sqrt(d2(x, z, fc)) / fr + fbm(nForest, x / 90, z / 90, 3) * 0.35;
      if (d < 1 && water[i] < 0) zone[i] = Zone.Forest;
    }
  }

  // ---------------------------------------------------------------- 4. Landmarks
  onProgress('Menempatkan titik ekstrem', 0);
  const height = new Int16Array(NN);
  const syncHeight = () => { for (let i = 0; i < NN; i++) height[i] = Math.floor(heightF[i] + 0.5); };
  syncHeight();
  const deck = new Int16Array(NN).fill(-1);
  const solid = new Uint8Array(NN);

  const peak = argmaxNear(mA, 60);
  const tower = argmaxNear(mB, 60);

  // Bridge across the main river, upstream of the junction.
  const bIdx = nearestIndex(mainPath, T(mu, 0.4 + J(0.03)));
  const bc: P = [Math.floor(mainPath[bIdx * 2]) + 0.5, Math.floor(mainPath[bIdx * 2 + 1]) + 0.5];
  const tx = mainPath[(bIdx + 4) * 2] - mainPath[(bIdx - 4) * 2];
  const tz = mainPath[(bIdx + 4) * 2 + 1] - mainPath[(bIdx - 4) * 2 + 1];
  const tl = Math.sqrt(tx * tx + tz * tz);
  let dir: P = [-tz / tl, tx / tl]; // perpendicular to the river
  if (dir[0] * (mA[0] - bc[0]) + dir[1] * (mA[1] - bc[1]) < 0) dir = [-dir[0], -dir[1]];
  const bLevel = mainLevels[bIdx];
  const halfLen = MAIN_HALF_W + 3;
  for (let t = -halfLen; t <= halfLen; t += 0.25) {
    for (let s = -1; s <= 1; s += 0.25) {
      const cx = Math.floor(bc[0] + dir[0] * t - dir[1] * s);
      const cz = Math.floor(bc[1] + dir[1] * t + dir[0] * s);
      if (inside(cx, cz)) deck[cz * N + cx] = bLevel + 1;
    }
  }
  const bEndA: P = [bc[0] - dir[0] * (halfLen + 1), bc[1] - dir[1] * (halfLen + 1)];
  const bEndB: P = [bc[0] + dir[0] * (halfLen + 1), bc[1] + dir[1] * (halfLen + 1)];
  const J1: P = [bc[0] - dir[0] * (halfLen + 45), bc[1] - dir[1] * (halfLen + 45)];
  const J2: P = [bc[0] + dir[0] * (halfLen + 50), bc[1] + dir[1] * (halfLen + 50)];

  // Hut on the forest edge, facing the crossroad J1.
  let hut: P = fc;
  {
    const hx = J1[0] - fc[0];
    const hz = J1[1] - fc[1];
    const hl = Math.sqrt(hx * hx + hz * hz);
    for (let t = 0; t < hl; t += 1) {
      const px = Math.floor(fc[0] + (hx / hl) * t);
      const pz = Math.floor(fc[1] + (hz / hl) * t);
      if (inside(px, pz) && zone[pz * N + px] === Zone.Open && water[pz * N + px] < 0) {
        hut = [px + (hx / hl) * 6, pz + (hz / hl) * 6];
        break;
      }
    }
  }
  const hutC: P = [Math.floor(hut[0]), Math.floor(hut[1])];
  flatten(hutC, 3);
  for (let dz = -2; dz <= 1; dz++) for (let dx = -2; dx <= 1; dx++) markSolid(hutC[0] + dx, hutC[1] + dz);
  const hutDoor: P = [hutC[0] + Math.sign(J1[0] - hutC[0]) * 4, hutC[1] + Math.sign(J1[1] - hutC[1]) * 4];

  flatten(tower, 2);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) markSolid(tower[0] + dx, tower[1] + dz);
  markSolid(peak[0], peak[1]);

  // Lone tree on an open hilltop in the far corner from the forest.
  let lone: P = T(0.12, 0.25);
  {
    let best = -Infinity;
    for (let v = 0.12; v <= 0.38; v += 0.005) {
      for (let u = 0.04; u <= 0.22; u += 0.005) {
        const [x, z] = T(u, v);
        const xi = Math.floor(x);
        const zi = Math.floor(z);
        if (!inside(xi, zi)) continue;
        const i = zi * N + xi;
        if (zone[i] !== Zone.Open || water[i] >= 0) continue;
        if (heightF[i] > best) { best = heightF[i]; lone = [xi, zi]; }
      }
    }
  }
  markSolid(lone[0], lone[1]);

  // Stone monument (tugu) on top of the hill between the river and the main peak.
  const tugu = clampIn(argmaxNear(hills[hills.length - 1].c, 45), 8) as P;
  flatten(tugu, 1);
  markSolid(tugu[0], tugu[1]);

  // Every other open hilltop gets a triangulation pillar too, so each hill seen in the field is a
  // titik ekstrem on the map. Hilltops: highest point within 26 blocks, standing at least 7 blocks
  // (17.5 m) above the ground 34 blocks around it, away from the other landmarks.
  const hilltops: P[] = [];
  {
    const taken: P[] = [peak, tower, hutC, lone, tugu];
    const cands: { p: P; prom: number }[] = [];
    for (let z = 20; z < N - 20; z += 4) {
      for (let x = 20; x < N - 20; x += 4) {
        const h0 = heightF[z * N + x];
        if (h0 < sampleH(x + 4, z) || h0 < sampleH(x - 4, z) || h0 < sampleH(x, z + 4) || h0 < sampleH(x, z - 4)) continue;
        const p = argmaxNear([x, z], 6);
        const top = argmaxNear(p, 26);
        if (top[0] !== p[0] || top[1] !== p[1]) continue;
        const i = p[1] * N + p[0];
        if (zone[i] !== Zone.Open || water[i] >= 0) continue;
        let ring = 0;
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          ring += sampleH(p[0] + Math.cos(a) * 34, p[1] + Math.sin(a) * 34);
        }
        const prom = heightF[i] - ring / 24;
        if (prom >= 7) cands.push({ p, prom });
      }
    }
    cands.sort((a, b) => b.prom - a.prom);
    for (const c of cands) {
      if (hilltops.length >= 6) break;
      if ([...taken, ...hilltops].some((t) => d2(c.p[0], c.p[1], t) < 70 * 70)) continue;
      hilltops.push(c.p);
    }
    for (const h of hilltops) { flatten(h, 1); markSolid(h[0], h[1]); }
  }
  syncHeight();
  onProgress('Menempatkan titik ekstrem', 1);

  // ---------------------------------------------------------------- 5. Trails (A* over terrain)
  onProgress('Membuka jalan setapak', 0);
  const trailMask = new Uint8Array(NN);
  const trails: Polyline[] = [];
  const E1 = clampIn(T(0.0, 0.43 + J(0.04)), 3);
  const E2 = clampIn(T(0.2 + J(0.03), 0.0), 3);
  const E3 = clampIn(T(0.56 + J(0.04), 1.0), 3);
  const routes: [P, P][] = [
    [E1, J1],
    [J1, bEndA],
    [bEndB, J2],
    [E2, J1],
    [J1, hutDoor],
    [J2, [peak[0] + 0.5, peak[1] + 2.5]],
    [J2, [tower[0] + 0.5, tower[1] + 3.5]],
    [J2, E3],
  ];
  routes.forEach(([a, b], k) => {
    const cells = astar(a, b);
    if (cells.length < 2) return;
    const poly = smoothCells(cells);
    if (k === 1) poly.push(bc[0], bc[1]); // continue onto the bridge
    if (k === 2) poly.unshift(bc[0], bc[1]);
    trails.push(poly);
    rasterTrail(poly);
    onProgress('Membuka jalan setapak', (k + 1) / routes.length);
  });

  // ---------------------------------------------------------------- 6. Surfaces
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      let s: number = zone[i] === Zone.Forest ? Surface.ForestFloor : Surface.Grass;
      const h = height[i];
      let slope = 0;
      if (x > 0) slope = Math.max(slope, Math.abs(h - height[i - 1]));
      if (x < N - 1) slope = Math.max(slope, Math.abs(h - height[i + 1]));
      if (z > 0) slope = Math.max(slope, Math.abs(h - height[i - N]));
      if (z < N - 1) slope = Math.max(slope, Math.abs(h - height[i + N]));
      if (slope >= 3 || h > height[peak[1] * N + peak[0]] - 8) s = Surface.Stone;
      if (sandMask[i]) s = Surface.Sand;
      if (water[i] >= 0) s = Surface.RiverBed;
      if (trailMask[i] === 1) s = Surface.Path;
      surface[i] = s;
    }
  }

  // ---------------------------------------------------------------- 7. Trees (deterministic per cell)
  onProgress('Menanam pohon', 0);
  const landmarkPts: P[] = [peak, tower, hutC, lone, tugu, [Math.floor(bc[0]), Math.floor(bc[1])], ...hilltops];
  const treeList: number[] = [];
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      const i = z * N + x;
      if (water[i] >= 0 || deck[i] >= 0 || trailMask[i] || solid[i]) continue;
      if (landmarkPts.some((p) => d2(x, z, p) < 49)) continue;
      const r = cellRand(x, z, 11);
      const y = height[i];
      if (zone[i] === Zone.Forest) {
        if (r < 0.1) {
          const big = cellRand(x, z, 12) < 0.25;
          treeList.push(x + 0.5, z + 0.5, y, 2 + Math.floor(cellRand(x, z, 13) * 2) + (big ? 1 : 0), big ? 5 : 3, 1);
          solid[i] = 1;
        } else if (r < 0.24) {
          treeList.push(x + 0.5, z + 0.5, y, 0, 1, 2);
        }
      } else if (r < 0.005 && surface[i] === Surface.Grass) {
        treeList.push(x + 0.5, z + 0.5, y, 2, 3, 0);
        solid[i] = 1;
      }
    }
  }
  onProgress('Menanam pohon', 1);

  const landmarks: Landmark[] = [
    { kind: 'peak', name: 'Puncak Cadas', x: peak[0] + 0.5, z: peak[1] + 0.5, y: height[peak[1] * N + peak[0]] },
    { kind: 'tower', name: 'Menara Radio', x: tower[0] + 0.5, z: tower[1] + 0.5, y: height[tower[1] * N + tower[0]] },
    { kind: 'hut', name: 'Pondok', x: hutC[0], z: hutC[1], y: height[hutC[1] * N + hutC[0]] },
    { kind: 'bridge', name: 'Jembatan', x: bc[0], z: bc[1], y: bLevel + 1, dir, halfLen },
    { kind: 'lonetree', name: 'Pohon Beringin', x: lone[0] + 0.5, z: lone[1] + 0.5, y: height[lone[1] * N + lone[0]] },
    { kind: 'monument', name: 'Tugu Batas', x: tugu[0] + 0.5, z: tugu[1] + 0.5, y: height[tugu[1] * N + tugu[0]] },
    ...hilltops.map((h, k): Landmark => ({ kind: 'peak', name: HILL_NAMES[k], x: h[0] + 0.5, z: h[1] + 0.5, y: height[h[1] * N + h[0]] })),
  ];

  const spawnPoly = trails[0];
  const si = Math.min(12, spawnPoly.length / 2 - 1);
  const spawn: P = [spawnPoly[si * 2], spawnPoly[si * 2 + 1]];

  return {
    seed, size: N, heightF, height, water, deck, solid, surface, zone,
    trees: new Float32Array(treeList),
    rivers: [mainPath, tribPath],
    trails,
    junctions: [J1, J2],
    landmarks,
    spawn,
  };

  // ================================================================ helpers (closures over the grids)

  function inside(x: number, z: number) { return x >= 0 && z >= 0 && x < N && z < N; }

  function clampIn(p: P, m: number): P {
    return [Math.min(N - 1 - m, Math.max(m, p[0])), Math.min(N - 1 - m, Math.max(m, p[1]))];
  }

  function sampleH(x: number, z: number) {
    const xi = Math.min(N - 1, Math.max(0, Math.floor(x)));
    const zi = Math.min(N - 1, Math.max(0, Math.floor(z)));
    return heightF[zi * N + xi];
  }

  /** Carves a river along a path. Water level only ever falls downstream. Returns the level per sample. */
  function carveRiver(path: Polyline, halfW: number, id: number, minLevel: number): Int16Array {
    const n = path.length / 2;
    const levels = new Int16Array(n);
    const valley = new Float32Array(n);
    let run = Infinity;
    for (let k = 0; k < n; k++) {
      // Lowest ground across the channel and its banks, so the water never sits above a bank.
      let h = Infinity;
      const rr = halfW + 4;
      for (let oz = -rr; oz <= rr; oz += 2) {
        for (let ox = -rr; ox <= rr; ox += 2) {
          if (ox * ox + oz * oz <= rr * rr) h = Math.min(h, sampleH(path[k * 2] + ox, path[k * 2 + 1] + oz));
        }
      }
      run = Math.min(run, h - 1);
      const lvl = Math.max(Math.floor(run), minLevel);
      levels[k] = lvl;
      valley[k] = Math.min(70, 30 + 1.5 * Math.max(0, h - lvl));
    }
    const bestD = new Float32Array(NN).fill(Infinity);
    const bestK = new Int32Array(NN).fill(-1);
    for (let k = 0; k < n; k++) {
      const px = path[k * 2];
      const pz = path[k * 2 + 1];
      const R = halfW + valley[k];
      const x0 = Math.max(0, Math.floor(px - R));
      const x1 = Math.min(N - 1, Math.ceil(px + R));
      const z0 = Math.max(0, Math.floor(pz - R));
      const z1 = Math.min(N - 1, Math.ceil(pz + R));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - px;
          const dz = z + 0.5 - pz;
          const dd = Math.sqrt(dx * dx + dz * dz);
          const i = z * N + x;
          if (dd <= R && dd < bestD[i]) { bestD[i] = dd; bestK[i] = k; }
        }
      }
    }
    for (let i = 0; i < NN; i++) {
      const k = bestK[i];
      if (k < 0) continue;
      const dd = bestD[i];
      const lvl = levels[k];
      if (dd <= halfW) {
        heightF[i] = Math.min(heightF[i], lvl - 1);
        water[i] = water[i] < 0 ? lvl : Math.min(water[i], lvl);
        if (!riverId[i]) riverId[i] = id;
      } else {
        const orig = heightF[i];
        const target = lvl + (orig - lvl) * smoothstep((dd - halfW) / valley[k]);
        if (target < orig) heightF[i] = target;
        if (dd <= halfW + 2.5 && water[i] < 0) sandMask[i] = 1;
      }
    }
    return levels;
  }

  function argmaxNear(c: P, r: number): P {
    let best = -Infinity;
    let bp: P = [Math.floor(c[0]), Math.floor(c[1])];
    for (let z = Math.floor(c[1] - r); z <= c[1] + r; z++) {
      for (let x = Math.floor(c[0] - r); x <= c[0] + r; x++) {
        if (!inside(x, z) || d2(x, z, c) > r * r) continue;
        const h = heightF[z * N + x];
        if (h > best) { best = h; bp = [x, z]; }
      }
    }
    return bp;
  }

  /** Levels a square pad of radius r around a cell to the cell's own height. */
  function flatten(c: P, r: number) {
    const h = Math.floor(heightF[c[1] * N + c[0]] + 0.5);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = c[0] + dx;
        const z = c[1] + dz;
        if (inside(x, z) && water[z * N + x] < 0) heightF[z * N + x] = h;
      }
    }
  }

  function markSolid(x: number, z: number) { if (inside(x, z)) solid[z * N + x] = 1; }

  /** A* across the grid. Slopes and forest cost more; the main river can only be crossed on the bridge. */
  function astar(a: P, b: P): number[] {
    const sx = Math.floor(a[0]);
    const sz = Math.floor(a[1]);
    const gx = Math.floor(b[0]);
    const gz = Math.floor(b[1]);
    const start = sz * N + sx;
    const goal = gz * N + gx;
    const g = new Float32Array(NN).fill(Infinity);
    const parent = new Int32Array(NN).fill(-1);
    const closed = new Uint8Array(NN);
    const heap = new MinHeap();
    g[start] = 0;
    heap.push(start, 0);
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % N;
      const cz = (cur - cx) / N;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const nz = cz + DZ[k];
        if (!inside(nx, nz)) continue;
        const ni = nz * N + nx;
        if (closed[ni]) continue;
        if (solid[ni] && ni !== goal) continue;
        const onDeck = deck[ni] >= 0;
        if (water[ni] >= 0 && !onDeck && riverId[ni] === 1) continue;
        const len = k < 4 ? 1 : 1.41421356;
        const slope = Math.abs(heightF[ni] - heightF[cur]) / len;
        let c = len * (1 + 50 * slope * slope + (zone[ni] === Zone.Forest ? 4 : 0));
        if (slope > 1.2) c += 200;
        if (water[ni] >= 0 && !onDeck) c += 30; // ford across the tributary
        if (trailMask[ni]) c *= 0.6;
        const ng = g[cur] + c;
        if (ng < g[ni]) {
          g[ni] = ng;
          parent[ni] = cur;
          const hx = nx - gx;
          const hz = nz - gz;
          heap.push(ni, ng + Math.sqrt(hx * hx + hz * hz));
        }
      }
    }
    if (parent[goal] < 0 && goal !== start) return [];
    const out: number[] = [];
    for (let c = goal; c >= 0; c = parent[c]) out.push(c);
    return out.reverse();
  }

  /** Turns A* cells into a smooth polyline with natural bends (Chaikin corner cutting). */
  function smoothCells(cells: number[]): Polyline {
    let pts: number[] = [];
    for (let k = 0; k < cells.length; k++) {
      if (k % 4 !== 0 && k !== cells.length - 1) continue;
      const x = cells[k] % N;
      pts.push(x + 0.5, (cells[k] - x) / N + 0.5);
    }
    for (let it = 0; it < 2; it++) {
      const out: number[] = [pts[0], pts[1]];
      for (let k = 0; k < pts.length / 2 - 1; k++) {
        const ax = pts[k * 2], az = pts[k * 2 + 1], bx = pts[k * 2 + 2], bz = pts[k * 2 + 3];
        out.push(0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz, 0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz);
      }
      out.push(pts[pts.length - 2], pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  /** Marks trail cells (about 2 blocks wide); where the trail fords water it gets a plank crossing. */
  function rasterTrail(poly: Polyline) {
    const dense = resample(poly, 0.4);
    for (let k = 0; k < dense.length / 2; k++) {
      const px = dense[k * 2];
      const pz = dense[k * 2 + 1];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = Math.floor(px + dx);
          const z = Math.floor(pz + dz);
          if (!inside(x, z)) continue;
          const ddx = x + 0.5 - px;
          const ddz = z + 0.5 - pz;
          const i = z * N + x;
          const dd = ddx * ddx + ddz * ddz;
          if (dd <= 0.85) {
            if (water[i] >= 0 && deck[i] < 0 && riverId[i] === 2) deck[i] = water[i];
            if (water[i] < 0) trailMask[i] = 1;
          } else if (dd <= 2.6 && !trailMask[i]) {
            trailMask[i] = 2; // verge: keeps trees off the trail edge
          }
        }
      }
    }
  }
}

// ================================================================== pure helpers

function d2(x: number, z: number, c: P) {
  const dx = x - c[0];
  const dz = z - c[1];
  return dx * dx + dz * dz;
}

function d2seg(x: number, z: number, a: P, b: P) {
  const vx = b[0] - a[0];
  const vz = b[1] - a[1];
  let t = ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = a[0] + vx * t - x;
  const pz = a[1] + vz * t - z;
  return px * px + pz * pz;
}

function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function nearestIndex(path: Polyline, p: P): number {
  let best = Infinity;
  let bi = 0;
  for (let k = 0; k < path.length / 2; k++) {
    const dx = path[k * 2] - p[0];
    const dz = path[k * 2 + 1] - p[1];
    const dd = dx * dx + dz * dz;
    if (dd < best) { best = dd; bi = k; }
  }
  return Math.min(Math.max(bi, 4), path.length / 2 - 5);
}

/** Catmull-Rom spline through control points, resampled to 1-block spacing. */
function catmullRom(ctrl: P[]): Polyline {
  const pts = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  const raw: number[] = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    for (let s = 0; s < 24; s++) {
      const t = s / 24;
      const t2 = t * t;
      const t3 = t2 * t;
      for (let c = 0; c < 2; c++) {
        raw.push(0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 +
          (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3));
      }
    }
  }
  const last = pts[pts.length - 2];
  raw.push(last[0], last[1]);
  return resample(raw, 1);
}

/** Resamples a polyline to points spaced `step` apart along its length. */
export function resample(poly: Polyline, step: number): Polyline {
  const out: number[] = [poly[0], poly[1]];
  let carry = 0;
  for (let k = 0; k < poly.length / 2 - 1; k++) {
    const ax = poly[k * 2], az = poly[k * 2 + 1], bx = poly[k * 2 + 2], bz = poly[k * 2 + 3];
    const segLen = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
    let t = step - carry;
    while (t <= segLen) {
      out.push(ax + ((bx - ax) * t) / segLen, az + ((bz - az) * t) / segLen);
      t += step;
    }
    carry = segLen - (t - step);
  }
  return out;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, key: number) {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] < key || (keys[p] === key && ids[p] <= id)) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop(): number {
    const ids = this.ids, keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        let m = l;
        if (r < n && (keys[r] < keys[l] || (keys[r] === keys[l] && ids[r] < ids[l]))) m = r;
        if (keys[m] > lastKey || (keys[m] === lastKey && ids[m] >= lastId)) break;
        ids[i] = ids[m]; keys[i] = keys[m];
        i = m;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return top;
  }
}
