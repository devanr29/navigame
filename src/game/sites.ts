// Mission locations, chosen from the generated world so every seed gets working missions:
// spots where enough landmarks are visible for resection, an intersection setup where a smoke column
// can be seen from two known posts, the summit climb through the young forest, and a forest leg for the
// final mission.
// Deterministic: same seed, same sites. Runs in the generation worker.
import { BLOCK_M, Surface, Zone, type WorldData } from '../gen/constants';
import { hashString, makeRng } from '../gen/noise';
import { azimuthTo, angleDiff, Sight, smokeTarget } from '../tools/sight';

export type P = [number, number];

export interface Sites {
  /** Level 2: open spot off the trails where two landmarks cross at a good angle (a third in view if possible). */
  resection: P;
  /** Level 4: navter route along trails through two crossroads. */
  route: { start: P; dest: P; crossroads: P[] };
  /** Level 3: smoke column seen from two posts with known coordinates. */
  intersection: { a: P; b: P; smoke: P };
  /** Level 5: from the end of the footpath up through the summit forest to the top of Puncak Cadas. */
  summit: { start: P; target: P };
  /** Level 6: open start (resection), then through the forest to the target. */
  final: { start: P; target: P };
}

const EYE = 1.7 / BLOCK_M;
const RANGE = 420;

export function findSites(w: WorldData): Sites {
  const N = w.size;
  // Roads and footpaths alike: everything a mission can follow on foot.
  const ways = [...w.roads, ...w.trails];
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
      if (!inside(x + dx, z + dz, 0)) continue;
      const v = w.surface[idx(x + dx, z + dz)];
      // a road (and its shoulder) counts as a way too
      if (v === s || (s === Surface.Path && (v === Surface.Road || v === Surface.RoadEdge))) return true;
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
  // The summit forest belongs to level 5; the final mission uses the big forest only.
  const toForest = distTo((i) => w.zone[i] === Zone.Forest && !w.summitForest[i]);
  const toOpen = distTo((i) => w.zone[i] === Zone.Open || w.summitForest[i] === 1);

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

  // Prefer a spot with a third landmark in view, for the optional triangle-of-error check.
  const resection = pickSpot(
    (s) => s.q >= 45 && !nearSurface(s.x, s.z, 14, Surface.Path),
    (s) => s.q + (s.ids.length >= 3 ? 25 : 0) + rng() * 8,
    w.spawn,
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
        const L = 90 + rng() * 40;
        const t: P = [s[0] + Math.sin(ang) * L, s[1] - Math.cos(ang) * L];
        if (!inside(t[0], t[1], 10)) continue;
        const ti = idx(t[0], t[1]);
        if (w.zone[ti] !== Zone.Forest || w.summitForest[ti] || toOpen[ti] < 12 || w.water[ti] >= 0) continue;
        if (!legOk(s, t)) continue;
        out.push({ start: s, target: [Math.floor(t[0]) + 0.5, Math.floor(t[1]) + 0.5] });
        break;
      }
      if (out.length >= count) break;
    }
    return out;
  };

  // Level 6 start: open spot 50–130 blocks (125–325 m) from the forest with a good resection.
  const finalStart = pickSpot(
    (s) => { const d = toForest[idx(s.x, s.z)]; return d >= 50 && d <= 130 && s.q >= 40; },
    (s) => s.q + rng() * 8,
    resection,
  );
  // Level 6 target: deep in the forest, reached by a straight leg from the forest edge nearest the start.
  let finalTarget: P | null = null;
  {
    const edgesByDist = edgeCells
      .map((c) => ({ c, d: dist(c, finalStart) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 60);
    outer: for (const { c } of edgesByDist) {
      for (let k = 0; k < 20; k++) {
        const ang = rng() * Math.PI * 2;
        const L = 90 + rng() * 40;
        const t: P = [c[0] + Math.sin(ang) * L, c[1] - Math.cos(ang) * L];
        if (!inside(t[0], t[1], 10)) continue;
        const ti = idx(t[0], t[1]);
        if (w.zone[ti] !== Zone.Forest || w.summitForest[ti] || toOpen[ti] < 12 || w.water[ti] >= 0) continue;
        if (!legOk(c, t)) continue;
        finalTarget = [Math.floor(t[0]) + 0.5, Math.floor(t[1]) + 0.5];
        break outer;
      }
    }
  }

  // Fallback for the final target: any forest leg away from the start.
  const leg = finalTarget ? null : forestLegs(1, [finalStart])[0];

  // ---- summit climb: the exact end of the footpath at the summit forest, to the summit pillar
  let trailEnd: P = w.trailhead;
  for (const t of w.trails) if (dist([t[0], t[1]], w.trailhead) < 3) trailEnd = [t[0], t[1]];
  const top = w.landmarks.find((l) => l.name === 'Puncak Pasir Malang')!;
  const summit = { start: trailEnd, target: [top.x, top.z] as P };

  // ---- intersection: smoke in the open, seen from two trail posts at a good crossing angle
  const posts: P[] = [];
  for (const t of ways) {
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

  // ---- open-navigation route over both crossroads, kept short so a lesson fits in a class session
  // (about 650 m): start 50–110 blocks before the first crossroad, at the trail point with the best
  // resection, and end about 80 blocks past the second crossroad on the far trail.
  const pointAlong = (poly: number[], d: number): P => {
    let acc = 0;
    for (let k = 2; k < poly.length; k += 2) {
      const seg = Math.hypot(poly[k] - poly[k - 2], poly[k + 1] - poly[k - 1]);
      if (acc + seg >= d) {
        const t = seg > 0 ? (d - acc) / seg : 0;
        return [poly[k - 2] + (poly[k] - poly[k - 2]) * t, poly[k - 1] + (poly[k + 1] - poly[k - 1]) * t];
      }
      acc += seg;
    }
    return [poly[poly.length - 2], poly[poly.length - 1]];
  };
  const polyLen = (poly: number[]) => {
    let L = 0;
    for (let k = 2; k < poly.length; k += 2) L += Math.hypot(poly[k] - poly[k - 2], poly[k + 1] - poly[k - 1]);
    return L;
  };
  // The far side of the route: the road leaving the second crossroad (J2 → E3).
  const far = w.roads[w.roads.length - 1];
  const J1 = w.junctions[0];
  // The start needs two visible titik ekstrem for the opening resection. Candidates: points on any
  // trail that ends at the first crossroad, preferring 50–110 blocks before it (a small penalty per
  // extra block); failing that, an open spot near a trail 40–160 blocks from the crossroad.
  let routeStart: P = w.spawn, bestScore = -Infinity;
  for (const t of ways) {
    const L = polyLen(t);
    if (dist([t[t.length - 2], t[t.length - 1]], J1) > 3) continue;
    for (let back = 50; back <= L; back += 6) {
      const p = pointAlong(t, Math.max(0, L - back));
      const q = pairQuality(p[0], p[1], visible(p[0], p[1]));
      const score = q >= 20 ? q - 0.5 * Math.max(0, back - 110) : -Infinity;
      if (score > bestScore) { bestScore = score; routeStart = p; }
    }
  }
  if (bestScore === -Infinity) {
    routeStart = pickSpot(
      (s) => { const d = dist([s.x, s.z], J1); return d >= 40 && d <= 160 && s.q >= 20 && nearSurface(s.x, s.z, 10, Surface.Path); },
      (s) => s.q - 0.3 * dist([s.x, s.z], J1),
      w.spawn,
    );
  }
  const route = { start: routeStart, dest: pointAlong(far, Math.min(80, polyLen(far) * 0.6)), crossroads: w.junctions };

  return {
    resection,
    route,
    intersection,
    summit,
    final: { start: finalStart, target: finalTarget ?? leg?.target ?? [w.spawn[0] + 120, w.spawn[1]] },
  };
}
