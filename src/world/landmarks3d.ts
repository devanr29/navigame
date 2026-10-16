// Blocky models for the titik ekstrem. Each one is a single merged mesh (one draw call).
import * as THREE from 'three';
import type { Landmark } from '../gen/constants';
import { WOOD } from './colors';
import { GeoBuilder } from './mesh';

const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
const rgb = (h: number) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export interface LandmarkObjects {
  group: THREE.Group;
  /** Call every frame for the tower's blinking light. */
  update(time: number): void;
}

export function buildLandmarks(list: Landmark[]): LandmarkObjects {
  const group = new THREE.Group();
  let towerLight: THREE.Mesh | null = null;

  for (const l of list) {
    const g = new GeoBuilder();
    const obj = new THREE.Group();
    switch (l.kind) {
      case 'peak': {
        // Triangulation pillar with a merah-putih flag on a pole.
        g.box(-0.2, 0, -0.2, 0.2, 0.45, 0.2, rgb(0xeeeeea));
        g.box(-0.03, 0, 0.25, 0.03, 3.2, 0.31, rgb(0xdddddd));
        g.box(0.03, 2.8, 0.26, 0.9, 3.15, 0.3, rgb(0xd0202a));
        g.box(0.03, 2.45, 0.26, 0.9, 2.8, 0.3, rgb(0xf4f4f4));
        break;
      }
      case 'tower': {
        // 60 m lattice tower in red and white bands, tapering upward.
        const segs = 6, segH = 4;
        for (let k = 0; k < segs; k++) {
          const wb = 1.3 - (k / segs) * 0.95;
          const col = rgb(k % 2 ? 0xf2f2f2 : 0xd23a2a);
          const y0 = k * segH, y1 = y0 + segH, t = 0.13;
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
            g.box(sx * wb - t, y0, sz * wb - t, sx * wb + t, y1, sz * wb + t, col);
          }
          g.box(-wb, y1 - 0.15, -wb - t, wb, y1, -wb + t, col);
          g.box(-wb, y1 - 0.15, wb - t, wb, y1, wb + t, col);
          g.box(-wb - t, y1 - 0.15, -wb, -wb + t, y1, wb, col);
          g.box(wb - t, y1 - 0.15, -wb, wb + t, y1, wb, col);
        }
        g.box(-0.06, segs * segH, -0.06, 0.06, segs * segH + 3, 0.06, rgb(0xcccccc));
        g.box(-0.5, 0, -0.5, 0.5, 0.3, 0.5, rgb(0x777777));
        const light = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
        light.position.y = segs * segH + 3.2;
        obj.add(light);
        towerLight = light;
        break;
      }
      case 'hut': {
        // 10 x 10 m wooden hut with a stepped roof; the footprint matches the solid cells.
        const wall = WOOD;
        g.box(-2, 0, -2, 2, 1.25, 2, wall);
        const roof = rgb(0x8c3b2a);
        g.box(-2.3, 1.25, -2.3, 2.3, 1.5, 2.3, roof);
        g.box(-1.7, 1.5, -1.7, 1.7, 1.75, 1.7, roof);
        g.box(-1.1, 1.75, -1.1, 1.1, 2.0, 1.1, roof);
        g.box(-0.5, 2.0, -0.5, 0.5, 2.2, 0.5, roof);
        const dark = rgb(0x2a1d12);
        g.box(-0.35, 0, 1.98, 0.35, 0.85, 2.04, dark);
        g.box(-1.6, 0.5, 1.98, -1.0, 0.9, 2.04, dark);
        g.box(1.0, 0.5, 1.98, 1.6, 0.9, 2.04, dark);
        break;
      }
      case 'bridge': {
        // The deck planks are part of the terrain mesh; this adds rails, posts and beams.
        const len = l.halfLen! + 1;
        const rail = rgb(0x6b4423);
        for (const s of [-1.35, 1.35]) {
          g.box(-len, 0.45, s - 0.06, len, 0.55, s + 0.06, rail);
          for (let t = -len; t <= len + 0.01; t += 2) g.box(t - 0.08, 0, s - 0.08, t + 0.08, 0.55, s + 0.08, rail);
        }
        g.box(-len, -0.6, -1.0, len, -0.25, -0.7, rgb(0x5a3a1e));
        g.box(-len, -0.6, 0.7, len, -0.25, 1.0, rgb(0x5a3a1e));
        break;
      }
      case 'monument': {
        // 11 m white obelisk on a stepped base with a red cap, standing alone on a bare hilltop.
        g.box(-1.1, 0, -1.1, 1.1, 0.4, 1.1, rgb(0x9a9a92));
        g.box(-0.75, 0.4, -0.75, 0.75, 0.8, 0.75, rgb(0xb4b4ac));
        g.box(-0.45, 0.8, -0.45, 0.45, 2.6, 0.45, rgb(0xf2f0e8));
        g.box(-0.35, 2.6, -0.35, 0.35, 4.0, 0.35, rgb(0xeae8e0));
        g.box(-0.22, 4.0, -0.22, 0.22, 4.5, 0.22, rgb(0xd0202a));
        break;
      }
    }
    obj.add(new THREE.Mesh(g.build(), mat));
    obj.position.set(l.x, l.y, l.z);
    if (l.kind === 'bridge' && l.dir) obj.rotation.y = -Math.atan2(l.dir[1], l.dir[0]);
    group.add(obj);
  }

  return {
    group,
    update(time: number) {
      if (towerLight) towerLight.visible = Math.floor(time * 1.2) % 2 === 0;
    },
  };
}
