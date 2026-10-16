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

/**
 * Items that sit near the kit at base camp but are not navigation tools in the material. A few are
 * mixed into the packing screen at random; packing one is a mistake explained in the debrief.
 */
export const DISTRACTORS: { name: string; job: string; why: string }[] = [
  { name: 'GPS', job: 'Menunjukkan posisi otomatis', why: 'GPS tidak dipakai: posisi harus ditemukan sendiri dengan peta dan kompas.' },
  { name: 'Senter', job: 'Penerangan saat gelap', why: 'Senter berguna untuk berkegiatan, tetapi bukan alat navigasi darat.' },
  { name: 'Spidol', job: 'Menebalkan garis di peta', why: 'Spidol merusak peta dan tidak bisa dihapus; menggaris memakai pensil.' },
  { name: 'Kalkulator', job: 'Menghitung jarak dan azimut', why: 'Back azimuth dan skala dihitung sendiri; kalkulator bukan alat navigasi darat.' },
  { name: 'Peluit', job: 'Memberi tanda darurat', why: 'Peluit adalah perlengkapan darurat, bukan alat navigasi darat.' },
  { name: 'Teropong', job: 'Melihat objek di kejauhan', why: 'Titik ekstrem dibidik dengan kompas; teropong bukan alat navigasi darat.' },
  { name: 'Jas hujan', job: 'Melindungi dari hujan', why: 'Jas hujan adalah perlengkapan pribadi, bukan alat navigasi darat.' },
  { name: 'Busur 180°', job: 'Mengukur sudut setengah lingkaran', why: 'Plotting azimut memakai busur 360°, bukan busur 180°.' },
];

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

const KEY = 'navigame-progress-v2';
/** Saves from the 10-level game, converted once to the 6-level numbering. */
const KEY_V1 = 'navigame-progress-v1';
/** Old level number → new level (2+3 merged; 6, 7, 8 and 9 merged into navigasi tertutup). */
const V1_TO_V2 = [0, 1, 2, 2, 3, 4, 5, 5, 5, 5, 6];
/** Developer mode keeps its own progress, so testing never touches a student's saved levels. */
export const DEV_KEY = 'navigame-progress-dev';

function fromV1(p: Progress): Progress {
  const best: Record<number, number> = {};
  for (const [k, v] of Object.entries(p.best ?? {})) {
    const n = V1_TO_V2[Number(k)];
    if (n) best[n] = Math.max(best[n] ?? 0, v);
  }
  return { unlocked: V1_TO_V2[Math.min(10, Math.max(1, p.unlocked))], best, paceCount: p.paceCount ?? null };
}

export function loadProgress(key = KEY): Progress {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw) as Progress;
      if (typeof p.unlocked === 'number') return { unlocked: p.unlocked, best: p.best ?? {}, paceCount: p.paceCount ?? null };
    }
    const old = key === KEY ? localStorage.getItem(KEY_V1) : null;
    if (old) {
      const p = JSON.parse(old) as Progress;
      if (typeof p.unlocked === 'number') {
        const q = fromV1(p);
        saveProgress(q, key);
        return q;
      }
    }
  } catch {
    // storage unavailable (private mode): play without saving
  }
  return { unlocked: 1, best: {}, paceCount: null };
}

export function saveProgress(p: Progress, key = KEY) {
  try {
    localStorage.setItem(key, JSON.stringify(p));
  } catch {
    // ignore
  }
}
