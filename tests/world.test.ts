import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/gen/world';
import { Zone, type WorldData } from '../src/gen/constants';

function fingerprint(w: WorldData): string {
  let h = 2166136261;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; };
  for (let i = 0; i < w.height.length; i++) { mix(w.height[i]); mix(w.water[i]); mix(w.surface[i]); }
  for (let i = 0; i < w.heightF.length; i += 7) mix(Math.round(w.heightF[i] * 1000));
  for (const t of [...w.roads, ...w.trails]) for (const v of t) mix(Math.round(v * 1000));
  for (let i = 0; i < w.trees.length; i++) mix(Math.round(w.trees[i] * 100));
  return h.toString(16);
}

describe('world generation', () => {
  const a = generateWorld('jamadagni');

  it('same seed gives the same world', () => {
    const b = generateWorld('jamadagni');
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('different seeds give different worlds', () => {
    expect(fingerprint(generateWorld('another-seed'))).not.toBe(fingerprint(a));
  });

  it.each(['jamadagni', 'navter', '42', 'seed-x'])('seed %s has every required feature', (seed) => {
    const w = seed === 'jamadagni' ? a : generateWorld(seed);
    const N = w.size;
    const kinds = [...new Set(w.landmarks.map((l) => l.kind))].sort();
    expect(kinds).toEqual(['bridge', 'hut', 'monument', 'peak', 'tower']);
    // the main landmarks keep their indices; extra hilltops follow, each with its own name
    expect(w.landmarks.slice(0, 6).map((l) => l.kind)).toEqual(['peak', 'tower', 'hut', 'bridge', 'peak', 'monument']);
    const hills = w.landmarks.slice(6);
    expect(hills.length).toBeGreaterThanOrEqual(1);
    expect(hills.every((l) => l.kind === 'peak')).toBe(true);
    expect(new Set(w.landmarks.map((l) => l.name)).size).toBe(w.landmarks.length);
    for (const l of w.landmarks) {
      expect(l.x).toBeGreaterThan(0);
      expect(l.x).toBeLessThan(N);
      expect(l.z).toBeGreaterThan(0);
      expect(l.z).toBeLessThan(N);
    }
    let waterCells = 0, forest = 0, deckOverWater = 0;
    for (let i = 0; i < N * N; i++) {
      if (w.water[i] >= 0) waterCells++;
      if (w.zone[i] === Zone.Forest) forest++;
      if (w.deck[i] >= 0 && w.water[i] >= 0) deckOverWater++;
    }
    expect(waterCells).toBeGreaterThan(3000);
    expect(forest / (N * N)).toBeGreaterThan(0.04);
    expect(forest / (N * N)).toBeLessThan(0.3);
    expect(deckOverWater).toBeGreaterThan(10); // the bridge spans the river
    expect(w.roads.length).toBe(4); // every route was found: the through-road ...
    expect(w.trails.length).toBe(5); // ... and the footpaths, the summit spur included
    let road = 0;
    for (let i = 0; i < N * N; i++) if (w.surface[i] === 6) road++;
    expect(road).toBeGreaterThan(1000); // the road is in the world, not only on the map
    // the peak is the highest landmark and stands well above the river
    const peak = w.landmarks.find((l) => l.kind === 'peak')!;
    expect(peak.y).toBeGreaterThan(60);
  });
});
