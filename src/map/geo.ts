// Block coordinates <-> geographic coordinates (arc-seconds), and DMS formatting.
// Blocks: x grows east, z grows south. Latitude is south (LS), so it grows with z.
import { BASE_ELEVATION_M, BLOCK_M, LAT0_S_SEC, LON0_E_SEC, M_PER_SEC_LAT, M_PER_SEC_LON } from '../gen/constants';

export const latSecAt = (z: number) => LAT0_S_SEC + (z * BLOCK_M) / M_PER_SEC_LAT;
export const lonSecAt = (x: number) => LON0_E_SEC + (x * BLOCK_M) / M_PER_SEC_LON;
export const zAtLatSec = (s: number) => ((s - LAT0_S_SEC) * M_PER_SEC_LAT) / BLOCK_M;
export const xAtLonSec = (s: number) => ((s - LON0_E_SEC) * M_PER_SEC_LON) / BLOCK_M;

export const elevationM = (blocks: number) => BASE_ELEVATION_M + blocks * BLOCK_M;

/** Indonesian decimal comma: 1062.5 -> "1062,5". */
export const fmtNum = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

/** Formats arc-seconds as D°M′S″ (full) or M′S″ (short), with the hemisphere suffix when given. */
export function fmtDMS(totalSec: number, full: boolean, hemi = ''): string {
  let s = Math.round(totalSec);
  const d = Math.floor(s / 3600);
  s -= d * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const ms = `${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″`;
  const body = full ? `${d}°${ms}` : ms;
  return hemi ? `${body} ${hemi}` : body;
}
