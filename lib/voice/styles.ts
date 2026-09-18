import { FFT_SIZE, HALF_BINS } from "@/lib/dsp/constants";
import { LN_TO_DB, normalizeShape } from "@/lib/dsp/features";
import type { F32 } from "@/lib/dsp/gpu-pipeline";
import type { PitchSpec } from "@/lib/dsp/protocol";

export interface StoredShape {
  data: number[];
  sampleRate: number;
}

export interface StyleFeatures {
  medianF0: number;
  f0Low: number;
  f0High: number;
  brightnessDb: number;
  durationSec: number;
  voicedFrames: number;
  sourceName: string;
}

export interface VoiceStyle {
  id: string;
  name: string;
  description: string;
  /** Accent colour used for the style card (any CSS colour). */
  color: string;
  kind: "preset" | "extracted";
  pitch: PitchSpec;
  formantRatio: number;
  timbreStrength: number;
  intonation: number;
  breath: number;
  /**
   * Spectral envelope shape. For extracted styles this is the character's
   * average spectrum (absolute); for presets it is a relative EQ curve.
   */
  shape?: StoredShape;
  shapeRelative?: boolean;
  /** Descriptor used by presets to synthesise a tilt curve at runtime. */
  tilt?: { pivotHz: number; dbPerOctave: number; maxDb: number };
  features?: StyleFeatures;
  createdAt: number;
}

export const PRESET_STYLES: VoiceStyle[] = [
  {
    id: "preset-anime-girl",
    name: "動漫少女",
    description: "高亢明亮的少女聲線，語調起伏略為誇張。",
    color: "#f472b6",
    kind: "preset",
    pitch: { mode: "targetF0", hz: 285 },
    formantRatio: 1.18,
    timbreStrength: 0.6,
    intonation: 1.15,
    breath: 0.12,
    tilt: { pivotHz: 1200, dbPerOctave: 2.5, maxDb: 6 },
    shapeRelative: true,
    createdAt: 0,
  },
  {
    id: "preset-shonen",
    name: "元氣少年",
    description: "偏高但仍保有中性厚度的少年聲。",
    color: "#fb923c",
    kind: "preset",
    pitch: { mode: "targetF0", hz: 215 },
    formantRatio: 1.1,
    timbreStrength: 0.5,
    intonation: 1.1,
    breath: 0.05,
    tilt: { pivotHz: 1500, dbPerOctave: 1.5, maxDb: 4 },
    shapeRelative: true,
    createdAt: 0,
  },
  {
    id: "preset-onee",
    name: "成熟御姐",
    description: "低沉柔和的成熟女聲，帶一點氣音。",
    color: "#c084fc",
    kind: "preset",
    pitch: { mode: "targetF0", hz: 185 },
    formantRatio: 1.08,
    timbreStrength: 0.5,
    intonation: 0.9,
    breath: 0.25,
    tilt: { pivotHz: 2500, dbPerOctave: -1.5, maxDb: 4 },
    shapeRelative: true,
    createdAt: 0,
  },
  {
    id: "preset-demon-lord",
    name: "低沉魔王",
    description: "壓迫感十足的低音，共振峰下移。",
    color: "#ef4444",
    kind: "preset",
    pitch: { mode: "targetF0", hz: 82 },
    formantRatio: 0.84,
    timbreStrength: 0.6,
    intonation: 0.85,
    breath: 0.1,
    tilt: { pivotHz: 800, dbPerOctave: -3, maxDb: 8 },
    shapeRelative: true,
    createdAt: 0,
  },
  {
    id: "preset-uncle",
    name: "沙啞大叔",
    description: "略低且粗糙的中年男聲。",
    color: "#a3a3a3",
    kind: "preset",
    pitch: { mode: "targetF0", hz: 108 },
    formantRatio: 0.93,
    timbreStrength: 0.4,
    intonation: 0.95,
    breath: 0.35,
    tilt: { pivotHz: 1000, dbPerOctave: -1.5, maxDb: 5 },
    shapeRelative: true,
    createdAt: 0,
  },
  {
    id: "preset-chipmunk",
    name: "花栗鼠",
    description: "整整高一個八度的卡通聲。",
    color: "#facc15",
    kind: "preset",
    pitch: { mode: "semitones", semitones: 12 },
    formantRatio: 1.3,
    timbreStrength: 0,
    intonation: 1.2,
    breath: 0,
    createdAt: 0,
  },
  {
    id: "preset-giant",
    name: "巨人",
    description: "低一個八度、共振峰大幅下移的巨大身形。",
    color: "#22c55e",
    kind: "preset",
    pitch: { mode: "semitones", semitones: -12 },
    formantRatio: 0.74,
    timbreStrength: 0,
    intonation: 0.9,
    breath: 0,
    createdAt: 0,
  },
  {
    id: "preset-robot",
    name: "機器人",
    description: "鎖定單一音高、毫無語調起伏的合成聲。",
    color: "#38bdf8",
    kind: "preset",
    pitch: { mode: "targetF0", hz: 140 },
    formantRatio: 1,
    timbreStrength: 0,
    intonation: 0,
    breath: 0,
    createdAt: 0,
  },
  {
    id: "preset-ghost",
    name: "幽靈",
    description: "氣音濃厚、略低的耳語感。",
    color: "#94a3b8",
    kind: "preset",
    pitch: { mode: "semitones", semitones: -3 },
    formantRatio: 0.96,
    timbreStrength: 0.3,
    intonation: 1,
    breath: 0.85,
    tilt: { pivotHz: 3000, dbPerOctave: 2, maxDb: 5 },
    shapeRelative: true,
    createdAt: 0,
  },
];

const STORAGE_KEY = "webgpu-voice-changer.styles.v1";

export function loadCustomStyles(): VoiceStyle[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as VoiceStyle[];
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.id && s.pitch) : [];
  } catch {
    return [];
  }
}

export function saveCustomStyles(styles: VoiceStyle[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(styles));
}

/** Build a relative tilt curve (natural-log magnitude) for a preset style. */
export function tiltShape(
  tilt: { pivotHz: number; dbPerOctave: number; maxDb: number },
  sampleRate: number,
): F32 {
  const shape = new Float32Array(HALF_BINS);
  const binHz = sampleRate / FFT_SIZE;
  for (let k = 0; k < HALF_BINS; k++) {
    const hz = Math.max(k * binHz, 40);
    const db = Math.max(-tilt.maxDb, Math.min(tilt.maxDb, tilt.dbPerOctave * Math.log2(hz / tilt.pivotHz)));
    shape[k] = db / LN_TO_DB;
  }
  return normalizeShape(shape, sampleRate);
}

export function styleShapePayload(style: VoiceStyle): { shape: F32; sampleRate: number; relative: boolean } | null {
  if (style.shape) {
    return {
      shape: Float32Array.from(style.shape.data),
      sampleRate: style.shape.sampleRate,
      relative: !!style.shapeRelative,
    };
  }
  if (style.tilt) {
    return { shape: tiltShape(style.tilt, 48000), sampleRate: 48000, relative: true };
  }
  return null;
}

export function describePitch(style: VoiceStyle): string {
  if (style.pitch.mode === "semitones") {
    const s = style.pitch.semitones;
    return `${s > 0 ? "+" : ""}${s} 半音`;
  }
  return `${Math.round(style.pitch.hz)} Hz`;
}

export function newStyleId() {
  return `style-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const STYLE_COLORS = ["#f472b6", "#fb923c", "#facc15", "#22c55e", "#38bdf8", "#818cf8", "#c084fc", "#ef4444", "#2dd4bf", "#a3a3a3"];
