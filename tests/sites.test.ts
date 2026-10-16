import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/gen/world';
import { findSites } from '../src/game/sites';
import { Zone } from '../src/gen/constants';
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

  it('forest targets are inside the forest', () => {
    expect(w.zone[at(s.forest.target)]).toBe(Zone.Forest);
    expect(w.zone[at(s.final.target)]).toBe(Zone.Forest);
    expect(w.zone[at(s.forest.start)]).toBe(Zone.Open);
  });

  it('the smoke is visible from both intersection posts', () => {
    const { a, b, smoke } = s.intersection;
    const t = smokeTarget(smoke[0], w.height[at(smoke)], smoke[1], 0);
    expect(sight.visible(t, a[0], eye(a), a[1], 420)).toBe(true);
    expect(sight.visible(t, b[0], eye(b), b[1], 420)).toBe(true);
  });
});
