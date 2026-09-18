import { FFT_SIZE, FRAME_INFO_FLOATS, HALF_BINS, HOP_SIZE } from "./constants";
import type { F32 } from "./gpu-pipeline";

/** Natural-log magnitude -> dB. */
export const LN_TO_DB = 20 / Math.LN10;

/**
 * Aggregate voice features extracted from a clip. `shape` is the mean
 * log-magnitude spectral envelope over voiced frames, normalised to zero mean
 * over the 100 Hz .. 8 kHz band so that two shapes can be subtracted to form a
 * timbre-transfer curve.
 */
export interface VoiceFeatures {
  sampleRate: number;
  frameCount: number;
  voicedFrames: number;
  durationSec: number;
  /** Median F0 of voiced frames in Hz, 0 when nothing voiced was found. */
  medianF0: number;
  f0Low: number;
  f0High: number;
  /** HALF_BINS log-magnitude envelope (natural log), zero-mean over the voice band. */
  shape: F32;
  /** Energy balance 2-6 kHz vs 200-1000 Hz in dB (positive = bright). */
  brightnessDb: number;
  /** Per-frame F0 track (0 = unvoiced) for visualisation. */
  f0Track: F32;
  /** Per-frame RMS in dBFS for visualisation. */
  rmsTrackDb: F32;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function bandBins(sampleRate: number, lowHz: number, highHz: number): [number, number] {
  const binHz = sampleRate / FFT_SIZE;
  const lo = Math.max(1, Math.round(lowHz / binHz));
  const hi = Math.min(HALF_BINS - 1, Math.round(highHz / binHz));
  return [lo, Math.max(lo + 1, hi)];
}

/** Subtract the mean over the voice band so the curve only describes colour. */
export function normalizeShape(shape: Float32Array, sampleRate: number): F32 {
  const [lo, hi] = bandBins(sampleRate, 100, Math.min(8000, sampleRate / 2 - 100));
  let sum = 0;
  for (let k = lo; k <= hi; k++) sum += shape[k];
  const mean = sum / (hi - lo + 1);
  const out = new Float32Array(shape.length);
  for (let k = 0; k < shape.length; k++) out[k] = shape[k] - mean;
  return out;
}

export function brightnessDb(shape: Float32Array, sampleRate: number): number {
  const [l0, l1] = bandBins(sampleRate, 200, 1000);
  const [h0, h1] = bandBins(sampleRate, 2000, Math.min(6000, sampleRate / 2 - 100));
  let low = 0;
  for (let k = l0; k <= l1; k++) low += shape[k];
  low /= l1 - l0 + 1;
  let high = 0;
  for (let k = h0; k <= h1; k++) high += shape[k];
  high /= h1 - h0 + 1;
  return (high - low) * LN_TO_DB;
}

/**
 * Resample a HALF_BINS envelope measured at `fromRate` so that bin k still
 * refers to the same frequency in Hz at `toRate`.
 */
export function resampleShape(shape: F32, fromRate: number, toRate: number): F32 {
  if (fromRate === toRate) return shape;
  const out = new Float32Array(HALF_BINS);
  const scale = toRate / fromRate; // source bin per destination bin
  for (let k = 0; k < HALF_BINS; k++) {
    const p = Math.min(k * scale, HALF_BINS - 1);
    const i0 = Math.floor(p);
    const i1 = Math.min(i0 + 1, HALF_BINS - 1);
    out[k] = shape[i0] + (shape[i1] - shape[i0]) * (p - i0);
  }
  return normalizeShape(out, toRate);
}

export function computeVoiceFeatures(
  info: Float32Array,
  env: Float32Array,
  count: number,
  sampleRate: number,
): VoiceFeatures {
  const f0Track = new Float32Array(count);
  const rmsTrackDb = new Float32Array(count);
  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    const rms = info[i * FRAME_INFO_FLOATS + 1];
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    rmsTrackDb[i] = db;
    if (rms > 1e-5) levels.push(db);
  }
  levels.sort((a, b) => a - b);
  const peakDb = percentile(levels, 0.95);
  const gateDb = peakDb - 30;

  const voiced: number[] = [];
  const f0s: number[] = [];
  for (let i = 0; i < count; i++) {
    const f0 = info[i * FRAME_INFO_FLOATS];
    const clarity = info[i * FRAME_INFO_FLOATS + 2];
    const isVoiced = f0 > 0 && clarity > 0.6 && rmsTrackDb[i] > gateDb;
    f0Track[i] = isVoiced ? f0 : 0;
    if (isVoiced) {
      voiced.push(i);
      f0s.push(f0);
    }
  }

  // Fall back to every audible frame if the clip has almost no voiced speech
  // (e.g. whispering) so we still get a usable envelope.
  let shapeFrames = voiced;
  if (shapeFrames.length < 5) {
    shapeFrames = [];
    for (let i = 0; i < count; i++) if (rmsTrackDb[i] > gateDb) shapeFrames.push(i);
  }

  const shape = new Float32Array(HALF_BINS);
  if (shapeFrames.length > 0) {
    for (const i of shapeFrames) {
      const base = i * HALF_BINS;
      for (let k = 0; k < HALF_BINS; k++) shape[k] += env[base + k];
    }
    for (let k = 0; k < HALF_BINS; k++) shape[k] /= shapeFrames.length;
  }
  const normalized = normalizeShape(shape, sampleRate);

  const sortedF0 = f0s.slice().sort((a, b) => a - b);
  return {
    sampleRate,
    frameCount: count,
    voicedFrames: voiced.length,
    durationSec: (count * HOP_SIZE) / sampleRate,
    medianF0: percentile(sortedF0, 0.5),
    f0Low: percentile(sortedF0, 0.1),
    f0High: percentile(sortedF0, 0.9),
    shape: normalized,
    brightnessDb: brightnessDb(normalized, sampleRate),
    f0Track,
    rmsTrackDb,
  };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function hzToNoteName(hz: number): string {
  if (!(hz > 0)) return "--";
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export function semitonesBetween(fromHz: number, toHz: number): number {
  if (!(fromHz > 0) || !(toHz > 0)) return 0;
  return 12 * Math.log2(toHz / fromHz);
}
