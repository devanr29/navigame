// Flat colours for the voxel world. Lighting is baked into vertex colours (MeshBasicMaterial), the
// cheapest shading path on mobile GPUs.
import { Surface } from '../gen/constants';

type RGB = [number, number, number];

const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export const TOP: Record<number, RGB> = {
  [Surface.Grass]: hex(0x7cb35a),
  [Surface.ForestFloor]: hex(0x4f7a3a),
  [Surface.Stone]: hex(0x9a9a92),
  [Surface.Sand]: hex(0xd8c88e),
  [Surface.Path]: hex(0x8a643c),
  [Surface.RiverBed]: hex(0x7d7058),
  [Surface.Road]: hex(0x8c8474),
  [Surface.RoadEdge]: hex(0x584c40),
};

export const SIDE: Record<number, RGB> = {
  [Surface.Grass]: hex(0x8a6a48),
  [Surface.ForestFloor]: hex(0x6e5238),
  [Surface.Stone]: hex(0x86867e),
  [Surface.Sand]: hex(0xc9b77c),
  [Surface.Path]: hex(0x8a6a48),
  [Surface.RiverBed]: hex(0x6d6250),
  [Surface.Road]: hex(0x8f8574),
  [Surface.RoadEdge]: hex(0x6a5d4e),
};

export const WOOD = hex(0x8b5a2b);
export const PLANK = hex(0xb08050);

/** Shade multipliers per face direction: +y, -y, +x, -x, +z, -z. */
export const FACE_SHADE = [1.0, 0.5, 0.82, 0.72, 0.9, 0.66];

export const SKY_OPEN = 0xbfd8ea;
export const SKY_FOREST = 0x6f8a78;
export const WATER = 0x3d7fc4;
