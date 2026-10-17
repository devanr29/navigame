// Mission objects placed in the world for one mission: posts with known coordinates, target markers,
// a rising smoke column, the stringline the team leaves behind, and the trees it
// fells and the lane it clears.
import * as THREE from 'three';
import { GeoBuilder } from './mesh';

const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
const rgb = (h: number) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/** Pole with a coloured flag: observation posts and calibration markers. Visible from far. */
export function flagPost(color: number, tall = 3): THREE.Mesh {
  const g = new GeoBuilder();
  g.box(-0.05, 0, -0.05, 0.05, tall, 0.05, rgb(0xe6e2d8));
  g.box(0.05, tall - 0.7, -0.02, 0.85, tall - 0.15, 0.02, rgb(color));
  g.box(-0.25, 0, -0.25, 0.25, 0.25, 0.25, rgb(0x8a8a82));
  return new THREE.Mesh(g.build(), mat);
}

/** Small concrete survey marker (patok) with a red top: hard to see from far, like the real thing. */
export function patok(): THREE.Mesh {
  const g = new GeoBuilder();
  g.box(-0.08, 0, -0.08, 0.08, 0.32, 0.08, rgb(0xd8d6cc));
  g.box(-0.085, 0.32, -0.085, 0.085, 0.4, 0.085, rgb(0xc8302a));
  return new THREE.Mesh(g.build(), mat);
}

/** Target post inside the forest (pos sasaran): orange flag on a short pole. */
export function targetPost(): THREE.Mesh {
  return flagPost(0xf08a1c, 1.6);
}

/** A rising smoke column; call `update` every frame. */
export function smokeColumn(): { group: THREE.Group; update(t: number): void } {
  const group = new THREE.Group();
  const puffs: THREE.Mesh[] = [];
  const m = new THREE.MeshBasicMaterial({ color: 0x8c8c88, transparent: true, opacity: 0.55, depthWrite: false });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let k = 0; k < 18; k++) {
    const p = new THREE.Mesh(geo, m);
    group.add(p);
    puffs.push(p);
  }
  const fire = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 1.2), new THREE.MeshBasicMaterial({ color: 0xd2541c }));
  fire.position.y = 0.2;
  group.add(fire);
  return {
    group,
    update(t) {
      puffs.forEach((p, k) => {
        const f = ((t * 0.12 + k / puffs.length) % 1);
        const y = f * 42;
        const s = 1.5 + f * 6;
        p.position.set(Math.sin(k * 1.7 + t * 0.3) * f * 3, y, Math.cos(k * 2.3) * f * 2);
        p.scale.set(s, s * 0.8, s);
      });
    },
  };
}

/** Stringline: thin red/white posts joined by a line, growing as the team advances. */
export class Stringline {
  readonly group = new THREE.Group();
  private pts: THREE.Vector3[] = [];
  private line: THREE.Line;
  private posts: THREE.InstancedMesh;
  private count = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4000), 3));
    geo.setDrawRange(0, 0);
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff3b2f }));
    this.line.frustumCulled = false;
    const pg = new GeoBuilder();
    pg.box(-0.03, 0, -0.03, 0.03, 0.5, 0.03, [1, 1, 1]);
    pg.box(-0.035, 0.38, -0.035, 0.035, 0.5, 0.035, rgb(0xff3b2f));
    this.posts = new THREE.InstancedMesh(pg.build(), mat, 2000);
    this.posts.count = 0;
    this.posts.frustumCulled = false;
    this.group.add(this.line, this.posts);
  }

  get length() { return this.count; }

  /** Adds a post at ground point (x, y, z). */
  add(x: number, y: number, z: number) {
    if (this.count >= 2000) return;
    this.pts.push(new THREE.Vector3(x, y + 0.45, z));
    const m = new THREE.Matrix4().makeTranslation(x, y, z);
    this.posts.setMatrixAt(this.count, m);
    this.count++;
    this.posts.count = this.count;
    this.posts.instanceMatrix.needsUpdate = true;
    const pos = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const i = this.pts.length - 1;
    pos.setXYZ(i, x, y + 0.45, z);
    pos.needsUpdate = true;
    this.line.geometry.setDrawRange(0, this.pts.length);
  }

  last(): THREE.Vector3 | null {
    return this.pts.length ? this.pts[this.pts.length - 1] : null;
  }
}

/** A young tree felled by the penerabas: trunk and canopy, origin at the foot of the trunk. */
export function youngTree(trunk: number): THREE.Mesh {
  const g = new GeoBuilder();
  g.box(-0.2, 0, -0.2, 0.2, trunk + 0.2, 0.2, rgb(0x6b4a2b));
  g.box(-1.5, trunk, -1.5, 1.5, trunk + 2, 1.5, rgb(0x34622e));
  return new THREE.Mesh(g.build(), mat);
}

/** The lane the team cuts: a strip of bare, swept earth growing behind the sweeper, back to the path. */
export class Lane {
  readonly mesh: THREE.InstancedMesh;
  private count = 0;

  constructor() {
    const g = new GeoBuilder();
    g.box(-0.7, 0, -0.35, 0.7, 0.06, 0.35, rgb(0x8a643c));
    this.mesh = new THREE.InstancedMesh(g.build(), mat, 3000);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  /** Adds a piece of lane at ground point (x, y, z), across the heading (grid degrees). */
  add(x: number, y: number, z: number, heading: number) {
    if (this.count >= 3000) return;
    const m = new THREE.Matrix4().makeRotationY((-heading * Math.PI) / 180).setPosition(x, y, z);
    this.mesh.setMatrixAt(this.count++, m);
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
