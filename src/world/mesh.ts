// Geometry helpers: a growable vertex/colour/index buffer and baked-shade boxes.
import * as THREE from 'three';
import { FACE_SHADE } from './colors';

export class GeoBuilder {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  /** Adds a quad a-b-c-d (counter-clockwise seen from the front) with one colour per corner. */
  quad(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    top: readonly number[], bottom: readonly number[] = top,
    /** which corners are "bottom" (darkened): bitmask a=1 b=2 c=4 d=8 */
    bottomMask = 0,
  ) {
    const base = this.pos.length / 3;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let k = 0; k < 4; k++) {
      const c = bottomMask & (1 << k) ? bottom : top;
      this.col.push(c[0], c[1], c[2]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box from (x0,y0,z0) to (x1,y1,z1) with per-face shading. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, rgb: readonly number[]) {
    const s = (f: number) => [rgb[0] * FACE_SHADE[f], rgb[1] * FACE_SHADE[f], rgb[2] * FACE_SHADE[f]];
    this.quad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, s(0)); // +y
    this.quad(x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1, s(1)); // -y
    this.quad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, s(2)); // +x
    this.quad(x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, s(3)); // -x
    this.quad(x1, y0, z1, x1, y1, z1, x0, y1, z1, x0, y0, z1, s(4)); // +z
    this.quad(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0, s(5)); // -z
  }

  get empty() { return this.idx.length === 0; }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    const c = new Uint8Array(this.col.length);
    for (let i = 0; i < c.length; i++) c[i] = Math.max(0, Math.min(255, Math.round(this.col[i] * 255)));
    g.setAttribute('color', new THREE.BufferAttribute(c, 3, true));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Unit box (x,z in [-0.5,0.5], y in [0,1]) with baked shade and white base colour, for instancing. */
export function unitBox(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(-0.5, 0, -0.5, 0.5, 1, 0.5, [1, 1, 1]);
  return b.build();
}
