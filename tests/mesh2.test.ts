import { expect, it } from 'vitest';
import { generateWorld } from '../src/gen/world';
import { buildTerrain, CHUNK } from '../src/world/chunks';

it('side faces cover every step and face outward', () => {
  const w = generateWorld('jamadagni');
  const N = w.size;
  const hAt = (x: number, z: number) => (x < 0 || z < 0 || x >= N || z >= N ? 0 : w.height[z * N + x]);
  const nC = Math.ceil(N / CHUNK);
  for (let cz = 0; cz < nC; cz++) for (let cx = 0; cx < nC; cx++) {
    const { terrain } = buildTerrain(w, cx, cz);
    const pos = terrain.getAttribute('position');
    const idx = terrain.getIndex()!;
    const got = [0, 0, 0, 0]; // +x -x +z -z
    let bad = 0;
    for (let q = 0; q < idx.count; q += 6) {
      const a = idx.getX(q), b = idx.getX(q + 1), c = idx.getX(q + 2);
      const A = [pos.getX(a), pos.getY(a), pos.getZ(a)], B = [pos.getX(b), pos.getY(b), pos.getZ(b)], C = [pos.getX(c), pos.getY(c), pos.getZ(c)];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[1] !== 0) continue;
      // which side is the face on? sample the cell just in front of the face centre
      const cxm = (A[0] + C[0]) / 2, czm = (A[2] + C[2]) / 2, ym = (A[1] + C[1]) / 2;
      const len = Math.hypot(n[0], n[2]);
      const fx = Math.floor(cxm + (n[0] / len) * 0.5), fz = Math.floor(czm + (n[2] / len) * 0.5);
      const bx = Math.floor(cxm - (n[0] / len) * 0.5), bz = Math.floor(czm - (n[2] / len) * 0.5);
      // the face must have open air in front (lower column) and solid behind (higher column)
      if (!(hAt(fx, fz) < ym && hAt(bx, bz) > ym)) {
        if (w.deck[bz * N + bx] < 0) bad++;
      }
      const area = len;
      if (n[0] > 0) got[0] += area; else if (n[0] < 0) got[1] += area; else if (n[2] > 0) got[2] += area; else got[3] += area;
    }
    const want = [0, 0, 0, 0];
    const sx = Math.min(CHUNK, N - cx * CHUNK), sz = Math.min(CHUNK, N - cz * CHUNK);
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      const X = cx * CHUNK + x, Z = cz * CHUNK + z, h = hAt(X, Z);
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dz], k) => { const nh = hAt(X + dx, Z + dz); if (nh < h) want[k] += h - nh; });
    }
    expect(bad, `inward faces in chunk ${cx},${cz}`).toBe(0);
    for (let k = 0; k < 4; k++) expect(Math.abs(got[k] - want[k]) < 30, `dir ${k} chunk ${cx},${cz}: got ${got[k]} want ${want[k]}`).toBe(true);
  }
});
