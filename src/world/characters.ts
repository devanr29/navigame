// Blocky (Minecraft-style) people in the PPA Jamadagni field outfit: plaid flannel shirt, denim jeans,
// and the blue scarf with yellow border, worn as a triangle over the shoulders with the logo badge on
// the back point and the two ends knotted at the chest. Roles are told apart by what they carry.
import * as THREE from 'three';
import { BLOCK_M } from '../gen/constants';
import { FACE_SHADE } from './colors';

export type Role = 'compasman' | 'penerabas' | 'sweeper' | 'stringlineman';

const U = 1 / BLOCK_M; // 1 metre in blocks

// Palette from the GDD (sampled from the reference photos).
const SCARF = '#1e8fd5';
const SCARF_BORDER = '#f5d21e';
const JEANS = '#3e5f8a';
const JEANS_DARK = '#2f4a6d';
const SKIN = '#c98f68';
const HAIR = '#2a1c14';

/** Flannel colours: everyone wears plaid; a slightly different colour per role helps on small screens. */
const FLANNEL: Record<Role, [string, string]> = {
  compasman: ['#b5232b', '#2a1416'],
  penerabas: ['#a83a1c', '#2b1a12'],
  sweeper: ['#3b6e3a', '#1a2a18'],
  stringlineman: ['#8a6a1c', '#2a2212'],
};

const texCache = new Map<string, THREE.CanvasTexture>();

function canvasTex(key: string, size: number, paint: (g: CanvasRenderingContext2D, s: number) => void) {
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  paint(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

function plaid(base: string, line: string) {
  return canvasTex(`plaid-${base}`, 16, (g, s) => {
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    g.globalAlpha = 0.55;
    g.fillStyle = line;
    for (const p of [2, 3, 10, 11]) {
      g.fillRect(p, 0, 1, s);
      g.fillRect(0, p, s, 1);
    }
    g.globalAlpha = 0.25;
    g.fillStyle = '#ffffff';
    g.fillRect(6, 0, 1, s);
    g.fillRect(0, 6, s, 1);
  });
}

function denim() {
  return canvasTex('denim', 16, (g, s) => {
    g.fillStyle = JEANS;
    g.fillRect(0, 0, s, s);
    g.fillStyle = JEANS_DARK;
    for (let y = 0; y < s; y += 2) g.fillRect((y * 3) % s, y, 3, 1);
    g.fillRect(s / 2 - 1, 0, 1, s); // seam
  });
}

function scarfTex() {
  return canvasTex('scarf', 16, (g, s) => {
    g.fillStyle = SCARF_BORDER;
    g.fillRect(0, 0, s, s);
    g.fillStyle = SCARF;
    g.fillRect(2, 2, s - 4, s - 4);
  });
}

/** Simplified pixel badge: orange pentagon, red-and-yellow ring, blue triangle with a white V. */
export function badgeTex() {
  return canvasTex('badge', 32, (g, s) => {
    g.clearRect(0, 0, s, s);
    const c = s / 2;
    g.fillStyle = '#ef8a1c';
    g.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
      g.lineTo(c + Math.cos(a) * 15, c + 1 + Math.sin(a) * 15);
    }
    g.fill();
    g.fillStyle = '#e0242b';
    g.beginPath(); g.arc(c, c + 1, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f7e61a';
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      g.beginPath(); g.arc(c + Math.cos(a) * 7, c + 1 + Math.sin(a) * 7, 2, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#2f8fd8';
    g.beginPath(); g.moveTo(c, c - 4); g.lineTo(c + 5, c + 5); g.lineTo(c - 5, c + 5); g.closePath(); g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(c - 2, c); g.lineTo(c, c + 3); g.lineTo(c + 2, c); g.stroke();
  });
}

/** Box with baked per-face shading (vertex colours), so it reads as 3D under MeshBasicMaterial. */
function shadedBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const n = g.getAttribute('normal');
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    const f = ny > 0.5 ? 0 : ny < -0.5 ? 1 : nx > 0.5 ? 2 : nx < -0.5 ? 3 : nz > 0.5 ? 4 : 5;
    const s = FACE_SHADE[f];
    col[i * 3] = s; col[i * 3 + 1] = s; col[i * 3 + 2] = s;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const matCache = new Map<string, THREE.Material>();
function mat(key: string, make: () => THREE.Material) {
  let m = matCache.get(key);
  if (!m) { m = make(); matCache.set(key, m); }
  return m;
}
const colorMat = (c: string) => mat(`c${c}`, () => new THREE.MeshBasicMaterial({ color: c, vertexColors: true }));
const texMat = (key: string, t: THREE.Texture) => mat(`t${key}`, () => new THREE.MeshBasicMaterial({ map: t, vertexColors: true }));

function part(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(shadedBox(w * U, h * U, d * U), m);
  mesh.position.set(x * U, y * U, z * U);
  return mesh;
}

export interface Character {
  group: THREE.Group;
  /** Advances the walk animation; `speed` in blocks per second. */
  animate(dt: number, speed: number): void;
  /** Work instead of walking: the penerabas chops with the golok, the sweeper rakes side to side. */
  work(dt: number): void;
}

/**
 * Builds one person. Units are metres converted to blocks; origin at the feet, facing −z.
 * Body ~1.7 m tall: legs 0.75, torso 0.65, head 0.3.
 */
export function makeCharacter(role: Role): Character {
  const group = new THREE.Group();
  const [fl, fd] = FLANNEL[role];
  const shirt = texMat(`shirt-${role}`, plaid(fl, fd));
  const jeans = texMat('jeans', denim());
  const skin = colorMat(SKIN);
  const scarf = texMat('scarf', scarfTex());

  // legs (pivot at the hip)
  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(-0.1 * U, 0.75 * U, 0);
  legR.position.set(0.1 * U, 0.75 * U, 0);
  legL.add(part(0.19, 0.75, 0.2, jeans, 0, -0.375, 0));
  legR.add(part(0.19, 0.75, 0.2, jeans, 0, -0.375, 0));
  legL.add(part(0.2, 0.08, 0.26, colorMat('#4a3828'), 0, -0.71, -0.03)); // boots
  legR.add(part(0.2, 0.08, 0.26, colorMat('#4a3828'), 0, -0.71, -0.03));

  // torso and head
  const torso = part(0.42, 0.62, 0.22, shirt, 0, 1.06, 0);
  const head = part(0.28, 0.3, 0.28, skin, 0, 1.55, 0);
  const hair = part(0.3, 0.09, 0.3, colorMat(HAIR), 0, 1.68, 0.01);

  // Face on the front (−z) of the head: eyes, brows, nose, mouth; hair at the back and sides.
  const face = new THREE.Group();
  const hairM = colorMat(HAIR);
  for (const sx of [-1, 1]) {
    face.add(part(0.075, 0.05, 0.01, colorMat('#f4f1e8'), sx * 0.065, 1.575, -0.145)); // eye white
    face.add(part(0.035, 0.05, 0.012, colorMat('#2b2a3a'), sx * 0.047, 1.575, -0.146)); // pupil
    face.add(part(0.085, 0.022, 0.012, hairM, sx * 0.065, 1.618, -0.146)); // brow
    face.add(part(0.02, 0.13, 0.2, hairM, sx * 0.145, 1.6, 0.04)); // side hair
  }
  face.add(part(0.05, 0.05, 0.025, colorMat('#b57d58'), 0, 1.53, -0.152)); // nose
  face.add(part(0.11, 0.026, 0.01, colorMat('#7a3b2e'), 0, 1.475, -0.145)); // mouth
  face.add(part(0.3, 0.045, 0.02, hairM, 0, 1.655, -0.148)); // fringe
  face.add(part(0.3, 0.2, 0.03, hairM, 0, 1.58, 0.152)); // back of the head

  // arms (pivot at the shoulder), flannel sleeves with a visible cuff and a hand
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.29 * U, 1.33 * U, 0);
  armR.position.set(0.29 * U, 1.33 * U, 0);
  for (const a of [armL, armR]) {
    a.add(part(0.15, 0.52, 0.17, shirt, 0, -0.26, 0));
    a.add(part(0.16, 0.05, 0.18, colorMat(fd), 0, -0.5, 0)); // cuff
    a.add(part(0.13, 0.12, 0.14, skin, 0, -0.58, 0));
  }

  // scarf: band over the shoulders, back point with the badge, two front ends knotted at the chest
  const scarfG = new THREE.Group();
  scarfG.add(part(0.46, 0.08, 0.26, scarf, 0, 1.38, 0)); // around the neck / over the shoulders
  scarfG.add(part(0.38, 0.12, 0.04, scarf, 0, 1.28, 0.13)); // back, wide part
  scarfG.add(part(0.26, 0.12, 0.04, scarf, 0, 1.16, 0.13));
  scarfG.add(part(0.14, 0.12, 0.04, scarf, 0, 1.04, 0.13)); // back point
  const badge = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12 * U, 0.12 * U),
    mat('badge', () => new THREE.MeshBasicMaterial({ map: badgeTex(), transparent: true, alphaTest: 0.5 })),
  );
  badge.position.set(0, 1.08 * U, 0.155 * U);
  scarfG.add(badge);
  scarfG.add(part(0.1, 0.08, 0.05, scarf, 0, 1.24, -0.13)); // knot at the chest
  scarfG.add(part(0.05, 0.36, 0.03, scarf, -0.04, 1.02, -0.13)); // two ends hang to the belt
  scarfG.add(part(0.05, 0.32, 0.03, scarf, 0.05, 1.04, -0.13));

  // what the role carries (in the right hand)
  const item = new THREE.Group();
  item.position.set(0, -0.62 * U, -0.04 * U);
  if (role === 'penerabas') {
    item.add(part(0.04, 0.12, 0.04, colorMat('#5a3a1e'), 0, 0, 0)); // golok handle
    item.add(part(0.03, 0.05, 0.42, colorMat('#c8ccd0'), 0, -0.02, -0.25)); // blade
  } else if (role === 'sweeper') {
    item.add(part(0.04, 0.04, 1.1, colorMat('#8a6a3a'), 0, 0, -0.3)); // rake handle
    item.add(part(0.36, 0.08, 0.04, colorMat('#6a6a6a'), 0, -0.04, -0.85));
  } else if (role === 'stringlineman') {
    item.add(part(0.16, 0.16, 0.16, colorMat('#e8e2d0'), 0, 0, -0.06)); // spool
    item.add(part(0.17, 0.05, 0.17, colorMat('#d33a2c'), 0, 0, -0.06));
  } else {
    item.add(part(0.12, 0.03, 0.16, colorMat('#20252a'), 0, 0.02, -0.08)); // compass
  }
  armR.add(item);

  group.add(legL, legR, torso, head, hair, face, armL, armR, scarfG);
  // The body faces −z, so a positive x rotation swings the hanging arm forward (a negative one would
  // swing it backward, over the scarf's back point).
  if (role === 'compasman') armR.rotation.x = 1.2; // compass raised toward the eye
  if (role === 'stringlineman') armR.rotation.x = 0.5;

  let phase = 0;
  return {
    group,
    animate(dt, speed) {
      phase += dt * speed * 9;
      const swing = Math.min(1, speed * 2) * 0.6 * Math.sin(phase);
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      armL.rotation.x = -swing * 0.8;
      if (role !== 'compasman' && role !== 'stringlineman') armR.rotation.x = swing * 0.8;
      armR.rotation.z = 0;
    },
    work(dt) {
      phase += dt * 7;
      legL.rotation.x = legR.rotation.x = 0;
      if (role === 'penerabas') {
        // raise the golok over the shoulder, then strike down and across
        const c = (phase % (Math.PI * 2)) / (Math.PI * 2);
        armR.rotation.x = c < 0.6 ? 0.4 + (c / 0.6) * 2.4 : 2.8 - ((c - 0.6) / 0.4) * 2.6;
        armR.rotation.z = 0.25;
        armL.rotation.x = 0.3;
      } else {
        armR.rotation.x = armL.rotation.x = 0.9;
        armR.rotation.z = 0.45 * Math.sin(phase);
      }
    },
  };
}

/** First-person right sleeve and hand, attached to the camera. */
export function makeFirstPersonArm(): THREE.Group {
  const g = new THREE.Group();
  const shirt = texMat('shirt-compasman', plaid(FLANNEL.compasman[0], FLANNEL.compasman[1]));
  const sleeve = new THREE.Mesh(shadedBox(0.09, 0.09, 0.42), shirt);
  sleeve.position.set(0, 0, 0.1);
  const cuff = new THREE.Mesh(shadedBox(0.095, 0.095, 0.03), colorMat(FLANNEL.compasman[1]));
  cuff.position.set(0, 0, -0.11);
  const hand = new THREE.Mesh(shadedBox(0.08, 0.07, 0.09), colorMat(SKIN));
  hand.position.set(0, 0, -0.17);
  g.add(sleeve, cuff, hand);
  g.scale.setScalar(0.24);
  g.position.set(0.08, -0.072, -0.14);
  g.rotation.set(0.3, 0.05, 0);
  return g;
}
