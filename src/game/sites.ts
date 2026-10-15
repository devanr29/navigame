// Mission locations, chosen from the generated world so every seed gets working missions:
// spots where enough landmarks are visible for resection, an intersection setup where a smoke column
// can be seen from two known posts, forest legs for navtup, and a flat trail stretch for pacing.
// Deterministic: same seed, same sites. Runs in the generation worker.
import { BLOCK_M, Surface, Zone, type WorldData } from '../gen/constants';
import { hashString, makeRng } from '../gen/noise';
import { azimuthTo, angleDiff, Sight, smokeTarget } from '../tools/sight';

export type P = [number, number];

export interface Sites {
  /** Level 2: open spot where at least three landmarks are visible. */
  orient: P;
  /** Level 3: open spot off the trails where two landmarks cross at a good angle. */
  resection: P;
  /** Level 5: navter route along trails through two crossroads. */
  route: { start: P; dest: P; crossroads: P[] };
  /** Level 4: smoke column seen from two posts with known coordinates. */
  intersection: { a: P; b: P; smoke: P };
  /** Level 6: straight bearing leg in open terrain. */
  declination: { start: P; target: P };
  /** Level 7: a 100 m stretch of flat trail. */
  pace: { start: P; end: P };
  /** Levels 8 and 9: from the forest edge through the forest. */
  forest: { start: P; target: P; obstacle: P };
  /** Level 10: open start (resection), then through the forest to the target. */
  final: { start: P; target: P };
}

const EYE = 1.7 / BLOCK_M;
const RANGE = 420;

export function findSites(w: WorldData): Sites {
  const N = w.size;
  const sight = new Sight(w);
  const rng = makeRng(hashString(w.seed + ':sites'));
  const idx = (x: number, z: number) => Math.floor(z) * N + Math.floor(x);
  const inside = (x: number, z: number, m = 6) => x >= m && z >= m && x < N - m && z < N - m;
  const isOpen = (x: number, z: number) => {
    if (!inside(x, z, 2)) return false;
    const i = idx(x, z);
    return w.zone[i] === Zone.Open && w.water[i] < 0 && !w.solid[i] && w.deck[i] < 0;
  };
  const eye = (x: number, z: number) => w.height[idx(x, z)] + EYE;
  const visible = (x: number, z: number) => sight.visibleLandmarks(x + 0.5, eye(x, z), z + 0.5, RANGE);
  /** Best crossing angle (closest to 90°) between two visible landmarks; 0 if fewer than two. */
  const pairQuality = (x: number, z: number, ids: number[]) => {
    let best = 0;
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const la = w.landmarks[ids[a]], lb = w.landmarks[ids[b]];
        const ang = Math.abs(angleDiff(azimuthTo(x, z, la.x, la.z), azimuthTo(x, z, lb.x, lb.z)));
        const q = 90 - Math.abs(90 - ang);
        if (q > best) best = q;
      }
    }
    return best;
  };
  const nearSurface = (x: number, z: number, r: number, s: number) => {
    for (let dz = -r; dz <= r; dz += 2) for (let dx = -r; dx <= r; dx += 2) {
      if (inside(x + dx, z + dz, 0) && w.surface[idx(x + dx, z + dz)] === s) return true;
    }
    return false;
  };

  // Distance (in blocks, 8-connected BFS) from every cell to the nearest forest cell and to the nearest open cell.
  const distTo = (pred: (i: number) => boolean) => {
    const d = new Int16Array(N * N).fill(-1);
    const q = new Int32Array(N * N);
    let head = 0, tail = 0;
    for (let i = 0; i < N * N; i++) if (pred(i)) { d[i] = 0; q[tail++] = i; }
    while (head < tail) {
      const c = q[head++];
      const cx = c % N, cz = (c - cx) / N;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const n = nz * N + nx;
        if (d[n] < 0) { d[n] = d[c] + 1; q[tail++] = n; }
      }
    }
    return d;
  };
  const toForest = distTo((i) => w.zone[i] === Zone.Forest);
  const toOpen = distTo((i) => w.zone[i] === Zone.Open);

  // ---- scan open spots once (every 16 blocks) for visible landmarks
  interface Spot { x: number; z: number; ids: number[]; q: number }
  const spots: Spot[] = [];
  for (let z = 24; z < N - 24; z += 16) {
    for (let x = 24; x < N - 24; x += 16) {
      if (!isOpen(x, z)) continue;
      const ids = visible(x, z);
      if (ids.length < 2) continue;
      spots.push({ x: x + 0.5, z: z + 0.5, ids, q: pairQuality(x, z, ids) });
    }
  }
  const pickSpot = (ok: (s: Spot) => boolean, score: (s: Spot) => number, fallback: P): P => {
    let best: Spot | null = null;
    let bs = -Infinity;
    for (const s of spots) {
      if (!ok(s)) continue;
      const v = score(s);
      if (v > bs) { bs = v; best = s; }
    }
    return best ? [best.x, best.z] : fallback;
  };
  const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  const resection = pickSpot(
    (s) => s.q >= 45 && !nearSurface(s.x, s.z, 14, Surface.Path),
    (s) => s.q + rng() * 8,
    w.spawn,
  );
  const orient = pickSpot(
    (s) => s.ids.length >= 3 && dist([s.x, s.z], resection) > 120,
    (s) => s.ids.length * 30 + s.q + rng() * 8,
    resection,
  );

  // ---- forest legs: start at the forest edge, target deep inside, a walkable straight line between
  const legOk = (a: P, b: P) => {
    const len = dist(a, b);
    let forestCells = 0, n = 0;
    let prevH = w.height[idx(a[0], a[1])];
    for (let t = 1; t < len; t += 1) {
      const x = a[0] + ((b[0] - a[0]) * t) / len, z = a[1] + ((b[1] - a[1]) * t) / len;
      if (!inside(x, z, 3)) return false;
      const i = idx(x, z);
      if (w.water[i] >= 0) return false;
      const h = w.height[i];
      if (Math.abs(h - prevH) > 1) return false;
      prevH = h;
      n++;
      if (w.zone[i] === Zone.Forest) forestCells++;
    }
    return forestCells / Math.max(1, n) > 0.75;
  };
  const edgeCells: P[] = [];
  for (let z = 10; z < N - 10; z += 3) {
    for (let x = 10; x < N - 10; x += 3) {
      const i = idx(x, z);
      if (isOpen(x, z) && toForest[i] > 0 && toForest[i] <= 3) edgeCells.push([x + 0.5, z + 0.5]);
    }
  }
  const forestLegs = (count: number, avoid: P[]): { start: P; target: P }[] => {
    const out: { start: P; target: P }[] = [];
    const order = edgeCells.map((c) => ({ c, r: rng() })).sort((p, q) => p.r - q.r).map((p) => p.c);
    for (const s of order) {
      if (avoid.some((a) => dist(a, s) < 120) || out.some((o) => dist(o.start, s) < 120)) continue;
      for (let k = 0; k < 24; k++) {
        const ang = rng() * Math.PI * 2;
        const L = 110 + rng() * 50;
        const t: P = [s[0] + Math.sin(ang) * L, s[1] - Math.cos(ang) * L];
        if (!inside(t[0], t[1], 10)) continue;
        const ti = idx(t[0], t[1]);
        if (w.zone[ti] !== Zone.Forest || toOpen[ti] < 12 || w.water[ti] >= 0) continue;
        if (!legOk(s, t)) continue;
        out.push({ start: s, target: [Math.floor(t[0]) + 0.5, Math.floor(t[1]) + 0.5] });
        break;
      }
      if (out.length >= count) break;
    }
    return out;
  };

  // Level 10 start: open spot 120–240 blocks from the forest with a good resection.
  const finalStart = pickSpot(
    (s) => { const d = toForest[idx(s.x, s.z)]; return d >= 120 && d <= 240 && s.q >= 40; },
    (s) => s.q + rng() * 8,
    resection,
  );
  // Level 10 target: deep in the forest, reached by a straight leg from the forest edge nearest the start.
  let finalTarget: P | null = null;
  {
    const edgesByDist = edgeCells
      .map((c) => ({ c, d: dist(c, finalStart) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 60);
    outer: for (const { c } of edgesByDist) {
      for (let k = 0; k < 20; k++) {
        const ang = rng() * Math.PI * 2;
        const L = 100 + rng() * 50;
        const t: P = [c[0] + Math.sin(ang) * L, c[1] - Math.cos(ang) * L];
        if (!inside(t[0], t[1], 10)) continue;
        const ti = idx(t[0], t[1]);
        if (w.zone[ti] !== Zone.Forest || toOpen[ti] < 12 || w.water[ti] >= 0) continue;
        if (!legOk(c, t)) continue;
        finalTarget = [Math.floor(t[0]) + 0.5, Math.floor(t[1]) + 0.5];
        break outer;
      }
    }
  }

  const legs = forestLegs(1, [finalStart]);
  const leg = legs[0] ?? { start: w.spawn, target: [w.spawn[0] + 120, w.spawn[1]] as P };
  const obstacle: P = [leg.start[0] + (leg.target[0] - leg.start[0]) * 0.45, leg.start[1] + (leg.target[1] - leg.start[1]) * 0.45];

  // ---- intersection: smoke in the open, seen from two trail posts at a good crossing angle
  const posts: P[] = [];
  for (const t of w.trails) {
    for (let k = 0; k < t.length / 2; k += 30) {
      const x = t[k * 2], z = t[k * 2 + 1];
      if (isOpen(x, z) && inside(x, z, 20)) posts.push([x, z]);
    }
  }
  let inter: Sites['intersection'] | null = null;
  let interScore = -Infinity;
  for (let k = 0; k < 60 && interScore < 85; k++) {
    const sx = 40 + rng() * (N - 80), sz = 40 + rng() * (N - 80);
    if (!inside(sx, sz, 30) || w.water[idx(sx, sz)] >= 0) continue;
    const smoke = smokeTarget(sx, w.height[idx(sx, sz)], sz, 0);
    const seeing = posts.filter((p) => {
      const d = dist(p, [sx, sz]);
      return d >= 110 && d <= 340 && sight.visible(smoke, p[0], eye(p[0], p[1]), p[1], RANGE);
    });
    for (let a = 0; a < seeing.length; a++) {
      for (let b = a + 1; b < seeing.length; b++) {
        if (dist(seeing[a], seeing[b]) < 90) continue;
        const ang = Math.abs(angleDiff(azimuthTo(seeing[a][0], seeing[a][1], sx, sz), azimuthTo(seeing[b][0], seeing[b][1], sx, sz)));
        const q = 90 - Math.abs(90 - ang);
        if (q > interScore) { interScore = q; inter = { a: seeing[a], b: seeing[b], smoke: [sx, sz] }; }
      }
    }
  }
  const intersection = inter ?? { a: w.spawn, b: [w.spawn[0], w.spawn[1] + 100] as P, smoke: [w.spawn[0] + 150, w.spawn[1] + 50] as P };

  // ---- declination leg: straight, open, dry, 170–210 blocks (425–525 m)
  let decl: Sites['declination'] | null = null;
  for (let k = 0; k < 400 && !decl; k++) {
    const s: P = [30 + rng() * (N - 60), 30 + rng() * (N - 60)];
    if (!isOpen(s[0], s[1]) || nearSurface(s[0], s[1], 4, Surface.Path)) continue;
    const ang = rng() * Math.PI * 2;
    const L = 170 + rng() * 40;
    const t: P = [s[0] + Math.sin(ang) * L, s[1] - Math.cos(ang) * L];
    if (!isOpen(t[0], t[1])) continue;
    // Walkable on foot along the straight line: no water, no step over one block, modest total climb.
    let ok = true, open = 0;
    let prevH = w.height[idx(s[0], s[1])], lo = prevH, hi = prevH;
    for (let d = 1; d < L && ok; d += 1) {
      const x = s[0] + ((t[0] - s[0]) * d) / L, z = s[1] + ((t[1] - s[1]) * d) / L;
      if (!inside(x, z, 3) || w.water[idx(x, z)] >= 0) { ok = false; break; }
      const h = w.height[idx(x, z)];
      if (Math.abs(h - prevH) > 1) ok = false;
      prevH = h;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      if (w.zone[idx(x, z)] === Zone.Open) open++;
    }
    if (hi - lo > 24) ok = false;
    if (ok && open / L > 0.9) decl = { start: s, target: t };
  }
  const declination = decl ?? { start: w.spawn, target: [w.spawn[0] + 180, w.spawn[1]] as P };

  // ---- pace course: 40 blocks (100 m) of trail with little climb
  let pace: Sites['pace'] | null = null;
  for (const t of w.trails) {
    const n = t.length / 2;
    for (let k = 0; k < n && !pace; k += 4) {
      let len = 0, j = k, lo = Infinity, hi = -Infinity, dry = true;
      while (j < n - 1 && len < 40) {
        len += Math.hypot(t[j * 2 + 2] - t[j * 2], t[j * 2 + 3] - t[j * 2 + 1]);
        const i = idx(t[j * 2], t[j * 2 + 1]);
        lo = Math.min(lo, w.height[i]); hi = Math.max(hi, w.height[i]);
        if (w.water[i] >= 0 || w.deck[i] >= 0) dry = false;
        j++;
      }
      if (len >= 40 && dry && hi - lo <= 2) pace = { start: [t[k * 2], t[k * 2 + 1]], end: [t[j * 2], t[j * 2 + 1]] };
    }
    if (pace) break;
  }
  const paceCourse = pace ?? { start: w.spawn, end: [w.spawn[0] + 40, w.spawn[1]] as P };

  // ---- navter route: from the trail start, over both crossroads, to a point on the far trail
  const far = w.trails[w.trails.length - 1];
  const fk = Math.floor((far.length / 2) * 0.6);
  const route = { start: w.spawn, dest: [far[fk * 2], far[fk * 2 + 1]] as P, crossroads: w.junctions };

  return {
    orient,
    resection,
    route,
    intersection,
    declination,
    pace: paceCourse,
    forest: { start: leg.start, target: leg.target, obstacle },
    final: { start: finalStart, target: finalTarget ?? leg.target },
  };
}
