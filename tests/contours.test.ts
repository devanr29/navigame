import { describe, expect, it } from 'vitest';
import { traceContours } from '../src/map/contours';
import { fmtDMS } from '../src/map/geo';

describe('contours', () => {
  it('traces a cone as closed circles at the right radius', () => {
    const n = 101;
    const h = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = 20 - Math.hypot(i - 50, j - 50) / 2;
    const lines = traceContours(h, n, 5, 5);
    const levels = lines.map((l) => l.level).sort((a, b) => a - b);
    expect(levels).toEqual([5, 10, 15, 20]);
    for (const l of lines) {
      expect(l.closed).toBe(true);
      const L = l.level - 0.5;
      const r = (20 - L) * 2;
      for (let k = 0; k < l.pts.length; k += 2) {
        expect(Math.abs(Math.hypot(l.pts[k] - 50.5, l.pts[k + 1] - 50.5) - r)).toBeLessThan(0.6);
      }
    }
    expect(lines.find((l) => l.level === 20)!.index).toBe(false);
  });

  it('formats coordinates latitude-style', () => {
    expect(fmtDMS(6 * 3600 + 37 * 60 + 40, false, 'LS')).toBe('37′40″ LS');
    expect(fmtDMS(107 * 3600 + 24 * 60 + 19, true, 'BT')).toBe('107°24′19″ BT');
  });
});
