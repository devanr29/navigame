import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/gen/world';
import { buildTerrain, CHUNK } from '../src/world/chunks';

describe('chunk mesher', () => {
  const w = generateWorld('jamadagni');
  it('every cell gets exactly one top face', () => {
    const N = w.size;
    const nC = Math.ceil(N / CHUNK);
    for (let cz = 0; cz < nC; cz++) for (let cx = 0; cx < nC; cx++) {
      const { terrain } = buildTerrain(w, cx, cz);
      const pos = terrain.getAttribute('position');
      const idx = terrain.getIndex()!;
      let area = 0;
      for (let q = 0; q < idx.count; q += 6) {
        const a = idx.getX(q), b = idx.getX(q + 1), c = idx.getX(q + 2);
        const ys = [pos.getY(a), pos.getY(b), pos.getY(c)];
        if (ys[0] !== ys[1] || ys[1] !== ys[2]) continue;
        // upward normal only
        const ux = pos.getX(b) - pos.getX(a), uz = pos.getZ(b) - pos.getZ(a);
        const vx = pos.getX(c) - pos.getX(a), vz = pos.getZ(c) - pos.getZ(a);
        const ny = uz * vx - ux * vz;
        if (ny > 0) area += ny;
      }
      let deck = 0;
      const sx = Math.min(CHUNK, N - cx * CHUNK), sz = Math.min(CHUNK, N - cz * CHUNK);
      for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) if (w.deck[(cz * CHUNK + z) * N + cx * CHUNK + x] >= 0) deck++;
      expect(area, `chunk ${cx},${cz}`).toBeCloseTo(sx * sz + deck, 3);
    }
  });
});
