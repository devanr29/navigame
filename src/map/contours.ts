// Contour lines from the heightmap by marching squares, chained into polylines.
// Contours sit at level L - 0.5 blocks, which is exactly the boundary where the voxel column height
// (round(heightF)) reaches L, so every map contour matches a block step in the world.

export interface ContourLine {
  /** Contour height in blocks (a multiple of the interval). */
  level: number;
  index: boolean;
  /** Flat [x0, z0, x1, z1, ...] in block units (cell centres at +0.5). */
  pts: number[];
  closed: boolean;
}

export function traceContours(
  h: Float32Array, n: number, interval: number, indexEvery: number,
): ContourLine[] {
  // Collect, per level, the edge-to-edge connections of every square.
  // Edge ids: horizontal edge from sample (i,j) to (i+1,j) = (j*n+i)*2, vertical (i,j)-(i,j+1) = (j*n+i)*2+1.
  const byLevel = new Map<number, Map<number, number[]>>();
  const pointOf = new Map<number, Map<number, [number, number]>>();

  const link = (lvl: number, e1: number, p1: [number, number], e2: number, p2: [number, number]) => {
    let adj = byLevel.get(lvl);
    let pts = pointOf.get(lvl);
    if (!adj || !pts) {
      adj = new Map();
      pts = new Map();
      byLevel.set(lvl, adj);
      pointOf.set(lvl, pts);
    }
    (adj.get(e1) ?? adj.set(e1, []).get(e1)!).push(e2);
    (adj.get(e2) ?? adj.set(e2, []).get(e2)!).push(e1);
    pts.set(e1, p1);
    pts.set(e2, p2);
  };

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = h[j * n + i];
      const b = h[j * n + i + 1];
      const c = h[(j + 1) * n + i + 1];
      const d = h[(j + 1) * n + i];
      const lo = Math.min(a, b, c, d);
      const hi = Math.max(a, b, c, d);
      const kMin = Math.ceil((lo + 0.5) / interval);
      const kMax = Math.floor((hi + 0.5) / interval);
      for (let k = Math.max(1, kMin); k <= kMax; k++) {
        const L = k * interval - 0.5;
        const A = a >= L, B = b >= L, C = c >= L, D = d >= L;
        if (A === B && B === C && C === D) continue;
        const x = i + 0.5, z = j + 0.5;
        const eT = (j * n + i) * 2, eB = ((j + 1) * n + i) * 2;
        const eL = (j * n + i) * 2 + 1, eR = (j * n + i + 1) * 2 + 1;
        const pT: [number, number] = [x + (L - a) / (b - a), z];
        const pB: [number, number] = [x + (L - d) / (c - d), z + 1];
        const pL: [number, number] = [x, z + (L - a) / (d - a)];
        const pR: [number, number] = [x + 1, z + (L - b) / (c - b)];
        const cross: [number, [number, number]][] = [];
        if (A !== B) cross.push([eT, pT]);
        if (B !== C) cross.push([eR, pR]);
        if (D !== C) cross.push([eB, pB]);
        if (A !== D) cross.push([eL, pL]);
        if (cross.length === 2) {
          link(k, cross[0][0], cross[0][1], cross[1][0], cross[1][1]);
        } else {
          // Saddle square: resolve with the centre value.
          const centreHigh = (a + b + c + d) / 4 >= L;
          if (A === centreHigh) {
            // A and C are joined through the centre: cut off B and D
            link(k, eT, pT, eR, pR);
            link(k, eL, pL, eB, pB);
          } else {
            link(k, eT, pT, eL, pL);
            link(k, eR, pR, eB, pB);
          }
        }
      }
    }
  }

  const out: ContourLine[] = [];
  for (const [k, adj] of byLevel) {
    const pts = pointOf.get(k)!;
    const seen = new Set<number>();
    const walk = (start: number): { pts: number[]; closed: boolean } => {
      const line: number[] = [];
      let prev = -1;
      let cur = start;
      for (;;) {
        seen.add(cur);
        const p = pts.get(cur)!;
        line.push(p[0], p[1]);
        const nb = adj.get(cur)!;
        const next = nb.find((e) => e !== prev && !seen.has(e));
        if (next === undefined) {
          const closed = nb.length === 2 && nb.includes(start) && line.length > 4;
          if (closed) line.push(line[0], line[1]);
          return { pts: line, closed };
        }
        prev = cur;
        cur = next;
      }
    };
    // Open lines first (they start at the map edge), then closed loops.
    for (const [e, nb] of adj) if (nb.length === 1 && !seen.has(e)) out.push({ level: k * interval, index: k % indexEvery === 0, ...walk(e) });
    for (const e of adj.keys()) if (!seen.has(e)) out.push({ level: k * interval, index: k % indexEvery === 0, ...walk(e) });
  }
  return out;
}
