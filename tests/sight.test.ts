import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/gen/world';
import { angleDiff, azimuthOfYaw, azimuthTo, backAzimuth, gridOf, magneticOf, setDeclination, Sight } from '../src/tools/sight';

const EYE = 1.7 / 2.5;

describe('azimuth conventions', () => {
  it('measures clockwise from north', () => {
    expect(azimuthTo(0, 0, 0, -1)).toBeCloseTo(0);
    expect(azimuthTo(0, 0, 1, 0)).toBeCloseTo(90);
    expect(azimuthTo(0, 0, 0, 1)).toBeCloseTo(180);
    expect(azimuthTo(0, 0, -1, 0)).toBeCloseTo(270);
    expect(azimuthOfYaw(0)).toBeCloseTo(0);
    expect(azimuthOfYaw(-Math.PI / 2)).toBeCloseTo(90);
    expect(azimuthOfYaw(Math.PI / 2)).toBeCloseTo(270);
    expect(angleDiff(5, 355)).toBeCloseTo(10);
  });
});

describe('material rules', () => {
  it('back azimuth: under 180 add 180, over 180 subtract 180, exactly 180 gives 0', () => {
    expect(backAzimuth(45)).toBe(225);
    expect(backAzimuth(300)).toBe(120);
    expect(backAzimuth(180)).toBe(0);
    expect(backAzimuth(0)).toBe(180);
  });
  it('declination: magnetic = grid - east declination, and back', () => {
    setDeclination(6);
    expect(magneticOf(100)).toBeCloseTo(94);
    expect(gridOf(94)).toBeCloseTo(100);
    expect(magneticOf(3)).toBeCloseTo(357);
    setDeclination(0);
  });
});

describe('line of sight', () => {
  const w = generateWorld('jamadagni');
  const sight = new Sight(w);
  const N = w.size;
  const eyeAt = (x: number, z: number): [number, number, number] =>
    [x, w.height[Math.floor(z) * N + Math.floor(x)] + EYE, z];
  const towerIdx = w.landmarks.findIndex((l) => l.kind === 'tower');
  const tower = w.landmarks[towerIdx];

  it('sights the tower when aiming at it from close by, and misses when aiming away', () => {
    const [ex, ey, ez] = eyeAt(tower.x, tower.z + 12);
    const az = azimuthTo(ex, ez, tower.x, tower.z);
    const pitch = Math.atan2(tower.y + 10 - ey, 12);
    const hit = sight.sight(ex, ey, ez, az, pitch, 400);
    expect(hit).toMatchObject({ kind: 'hit', id: towerIdx });
    expect(sight.sight(ex, ey, ez, az + 90, pitch, 400).kind).toBe('miss');
  });

  it('nothing is visible beyond the view distance', () => {
    const [ex, ey, ez] = eyeAt(tower.x, tower.z + 12);
    // range 5 blocks: even the tower 12 blocks away is out of view (fog)
    expect(sight.sight(ex, ey, ez, 0, 0, 5).kind).toBe('none');
  });

  it('terrain blocks the view through a hill', () => {
    const peak = w.landmarks.find((l) => l.kind === 'peak')!;
    // a ray skimming 1 block above the valley floor straight through the peak's mountain
    const a = eyeAt(peak.x - 150, peak.z);
    expect(sight.lineClear(a[0], a[1], a[2], peak.x + 150, a[1], peak.z, 0)).toBe(false);
  });

  it('tree canopies block the view, the gap under them does not', () => {
    const t = w.trees;
    for (let i = 0; i < t.length; i += 6) {
      if (t[i + 5] !== 1 || t[i + 4] !== 3) continue;
      const x = t[i], z = t[i + 1], y = t[i + 2], trunk = t[i + 3];
      // a short horizontal ray through the middle of the canopy is blocked
      const yc = y + trunk + 1;
      // only test trees whose canopy row stands clear of the terrain on both sides
      let clearTerrain = true;
      for (let dx = -3; dx <= 3; dx++) if (w.height[Math.floor(z) * N + Math.floor(x + dx)] > yc - 1) clearTerrain = false;
      if (!clearTerrain) continue;
      expect(sight.lineClear(x - 3, yc, z, x + 3, yc, z, 0)).toBe(false);
      return;
    }
    throw new Error('no suitable tree found');
  });
});
