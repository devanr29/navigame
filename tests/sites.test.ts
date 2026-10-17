import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/gen/world';
import { findSites } from '../src/game/sites';
import { Surface, Zone } from '../src/gen/constants';
import { Sight, smokeTarget } from '../src/tools/sight';

describe.each(['jamadagni', 'navter', '42'])('mission sites for seed %s', (seed) => {
  const w = generateWorld(seed);
  const t0 = performance.now();
  const s = findSites(w);
  const ms = performance.now() - t0;
  const N = w.size;
  const at = (p: [number, number]) => Math.floor(p[1]) * N + Math.floor(p[0]);
  const eye = (p: [number, number]) => w.height[at(p)] + 0.68;
  const sight = new Sight(w);

  it('finds them quickly', () => {
    expect(ms).toBeLessThan(6000);
  });

  it('resection spots see at least two landmarks', () => {
    for (const p of [s.resection, s.final.start]) {
      expect(w.zone[at(p)]).toBe(Zone.Open);
      expect(sight.visibleLandmarks(p[0], eye(p), p[1], 420).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('the final target is inside the big forest', () => {
    expect(w.zone[at(s.final.target)]).toBe(Zone.Forest);
    expect(w.summitForest[at(s.final.target)]).toBe(0);
  });

  it('level 5: the summit is hidden from the path end, resection works there, the climb is walkable', () => {
    const { start, target } = s.summit;
    expect(w.zone[at(start)]).toBe(Zone.Open);
    expect(w.surface[at(start)]).toBe(Surface.Path);
    const seen = sight.visibleLandmarks(start[0], eye(start), start[1], 420);
    const summit = w.landmarks.findIndex((l) => l.name === 'Puncak Pasir Malang');
    expect(seen).not.toContain(summit);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const L = Math.hypot(target[0] - start[0], target[1] - start[1]);
    let prev = w.height[at(start)], forest = 0, n = 0;
    for (let t = 0.5; t < L - 1; t += 0.5) {
      const p: [number, number] = [start[0] + ((target[0] - start[0]) * t) / L, start[1] + ((target[1] - start[1]) * t) / L];
      expect(w.water[at(p)]).toBe(-1);
      expect(Math.abs(w.height[at(p)] - prev)).toBeLessThanOrEqual(2);
      prev = w.height[at(p)];
      n++;
      if (w.summitForest[at(p)]) forest++;
    }
    expect(forest / n).toBeGreaterThan(0.75);
  });

  it('the smoke is visible from both intersection posts', () => {
    const { a, b, smoke } = s.intersection;
    const t = smokeTarget(smoke[0], w.height[at(smoke)], smoke[1], 0);
    expect(sight.visible(t, a[0], eye(a), a[1], 420)).toBe(true);
    expect(sight.visible(t, b[0], eye(b), b[1], 420)).toBe(true);
  });
});
