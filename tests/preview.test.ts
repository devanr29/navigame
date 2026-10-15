// Writes a top-down PNG of a generated world for eyeballing. Only runs with PREVIEW_OUT set.
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateWorld } from '../src/gen/world';

it.runIf(!!process.env.PREVIEW_OUT)('preview', () => {
  const t0 = performance.now();
  const w = generateWorld(process.env.PREVIEW_SEED ?? 'jamadagni');
  console.log('gen ms', Math.round(performance.now() - t0), 'trees', w.trees.length / 6);
  const N = w.size;
  const px = Buffer.alloc((N * 3 + 1) * N);
  for (let z = 0; z < N; z++) {
    px[z * (N * 3 + 1)] = 0;
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      const h = w.height[i];
      const l = 60 + h * 1.2;
      let c = [l * 0.8, l, l * 0.7];
      if (w.zone[i] === 1) c = [l * 0.4, l * 0.7, l * 0.4];
      if (w.surface[i] === 4) c = [200, 60, 40];
      if (w.water[i] >= 0) c = [40, 90, 220];
      if (w.deck[i] >= 0) c = [255, 220, 0];
      if (h % 5 === 0 && x > 0 && w.height[i - 1] !== h) c = c.map((v) => v * 0.6);
      const o = z * (N * 3 + 1) + 1 + x * 3;
      px[o] = Math.min(255, c[0]); px[o + 1] = Math.min(255, c[1]); px[o + 2] = Math.min(255, c[2]);
    }
  }
  for (const l of w.landmarks) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    const o = (Math.floor(l.z) + dz) * (N * 3 + 1) + 1 + (Math.floor(l.x) + dx) * 3;
    px[o] = 255; px[o + 1] = 0; px[o + 2] = 255;
  }
  const crc = (b: Buffer) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(process.env.PREVIEW_OUT!, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
});
