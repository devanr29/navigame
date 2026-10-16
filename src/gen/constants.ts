// World scale and map conventions. Values marked "GDD" come from docs/GDD.md.

/**
 * World edge length in blocks. The GDD started from 800 x 800 blocks (2 x 2 km); playtests showed a
 * lesson must fit a 45-minute class, so the world is 600 x 600 blocks = 1.5 x 1.5 km.
 */
export const WORLD_SIZE = 600;

/** Metres per block, horizontally and vertically (GDD). */
export const BLOCK_M = 2.5;

/** Contour interval in metres (GDD: 12.5 m = 5 blocks). */
export const CONTOUR_M = 12.5;
export const CONTOUR_BLOCKS = CONTOUR_M / BLOCK_M; // 5

/** Every 5th contour is an index contour (drawn thicker). */
export const INDEX_EVERY = 5;

/** Map scale denominator (GDD: 1:25,000). */
export const MAP_SCALE = 25000;

/** Elevation of block height 0, in metres above sea level. Not in the GDD. */
export const BASE_ELEVATION_M = 1000;

/**
 * Geographic placement of the world's north-west corner, in arc-seconds.
 * Southern latitude (LS) and eastern longitude (BT), near Bandung. Not in the GDD; fictional terrain.
 */
export const LAT0_S_SEC = 6 * 3600 + 49 * 60 + 47; // 6°49′47″ LS
export const LON0_E_SEC = 107 * 3600 + 35 * 60 + 52; // 107°35′52″ BT

/** Metres per arc-second of latitude (1 nautical mile per minute). */
export const M_PER_SEC_LAT = 1852 / 60;
/** Metres per arc-second of longitude at about 6.83° S (cos 6.83° = 0.99290). */
export const M_PER_SEC_LON = M_PER_SEC_LAT * 0.9929;

/** Magnetic declination in degrees, east positive. GDD: early levels use 0°. */
export const DECLINATION_DEG = 0;

/** Karvak grid spacing in arc-seconds. Not in the GDD. */
export const KARVAK_SEC = 10;

export const Surface = {
  Grass: 0,
  ForestFloor: 1,
  Stone: 2,
  Sand: 3,
  Path: 4,
  RiverBed: 5,
} as const;

export const Zone = {
  Open: 0,
  Forest: 1,
} as const;

export type LandmarkKind = 'peak' | 'tower' | 'hut' | 'bridge' | 'lonetree' | 'monument';

export interface Landmark {
  kind: LandmarkKind;
  name: string;
  /** Block coordinates of the landmark's centre (x east, z south). */
  x: number;
  z: number;
  /** Ground height (top of column) in blocks. */
  y: number;
  /** For the bridge: direction across the river (unit vector). */
  dir?: [number, number];
  /** For the bridge: half-length in blocks. */
  halfLen?: number;
}

export type Polyline = number[]; // flat [x0, z0, x1, z1, ...] in block units

export interface WorldData {
  seed: string;
  size: number;
  /** Continuous height field in blocks (used for contours). */
  heightF: Float32Array;
  /** Integer column height in blocks: the column fills y in [0, H). */
  height: Int16Array;
  /** Water surface level in blocks, or -1 when the cell is dry. */
  water: Int16Array;
  /** Walkable deck height (bridge), or -1. */
  deck: Int16Array;
  /** 1 where a cell is blocked (tree trunk, building). */
  solid: Uint8Array;
  surface: Uint8Array;
  zone: Uint8Array;
  /** Trees: [x, z, groundY, trunkH, canopy, kind] per tree. kind 0 = open, 1 = forest, 2 = bush. */
  trees: Float32Array;
  rivers: Polyline[];
  trails: Polyline[];
  junctions: [number, number][];
  landmarks: Landmark[];
  spawn: [number, number];
}
