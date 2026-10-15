// Shared game types and saved progress.

/** Tools from the preparation list (GDD "Tools and UI"). */
export type ToolId = 'peta' | 'kompas' | 'busur' | 'penggaris' | 'pensil' | 'pena' | 'penghapus' | 'papan';

export const TOOLS: { id: ToolId; name: string; job: string }[] = [
  { id: 'peta', name: 'Peta', job: 'Membaca medan, menandai posisi' },
  { id: 'kompas', name: 'Kompas', job: 'Membidik azimut, mengunci arah' },
  { id: 'busur', name: 'Busur 360°', job: 'Memindahkan azimut ke peta' },
  { id: 'penggaris', name: 'Penggaris', job: 'Mengukur jarak di peta' },
  { id: 'pensil', name: 'Pensil', job: 'Menandai dan menggaris di peta' },
  { id: 'pena', name: 'Pena', job: 'Menulis catatan lapangan' },
  { id: 'penghapus', name: 'Penghapus', job: 'Menghapus coretan pensil' },
  { id: 'papan', name: 'Papan jalan', job: 'Menahan peta agar arahnya terkunci' },
];

export const ALL_TOOLS = new Set<ToolId>(TOOLS.map((t) => t.id));

/** A compass reading taken in the field. */
export interface Reading {
  /** Azimuth shown on the compass (whole degrees, magnetic). */
  azimuth: number;
  /** What was on the line of sight: landmark index, SMOKE_TARGET, or -1. */
  target: number;
  settled: boolean;
  /** Player position when the reading was taken (only used for the debrief, never shown in the field). */
  x: number;
  z: number;
  /** Landmark index the player paired this reading with on the map, or -1. */
  pairedWith: number;
  /** Back azimuth typed by the player, or null. */
  backTyped: number | null;
}

export const SMOKE_TARGET = 100;

/** Map drawings, in sheet (block) coordinates. */
export interface MapLine { x: number; z: number; az: number; len: number; pen: boolean }
export interface MapMark { x: number; z: number; label: string; pen: boolean }
export interface MapStroke { pts: number[]; pen: boolean }

// ------------------------------------------------------------------ progress (localStorage)

export interface Progress {
  /** Highest level number the player may start (1-based). */
  unlocked: number;
  best: Record<number, number>;
  /** Steps per 100 m from the pacing calibration, or null if not calibrated yet. */
  paceCount: number | null;
}

const KEY = 'navigame-progress-v1';

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Progress;
      if (typeof p.unlocked === 'number') return { unlocked: p.unlocked, best: p.best ?? {}, paceCount: p.paceCount ?? null };
    }
  } catch {
    // storage unavailable (private mode): play without saving
  }
  return { unlocked: 1, best: {}, paceCount: null };
}

export function saveProgress(p: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}
