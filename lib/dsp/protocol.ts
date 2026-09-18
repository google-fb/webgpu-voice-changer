import type { VoiceFeatures } from "./features";
import type { F32, GpuInfo } from "./gpu-pipeline";

export type PitchSpec =
  | { mode: "semitones"; semitones: number }
  | { mode: "targetF0"; hz: number };

/**
 * User-facing controls. The DSP worker turns these into low-level
 * `TransformParams` per dispatch because some of them depend on the speaker's
 * live pitch estimate.
 */
export interface VoiceControls {
  pitch: PitchSpec;
  /** Extra manual pitch offset in semitones on top of the style's pitch. */
  pitchOffsetSemitones: number;
  formantRatio: number;
  timbreStrength: number;
  intonation: number;
  breath: number;
  gateDb: number;
  gateDepth: number;
  outputGain: number;
  /** Speaker's median F0 from calibration; 0 = estimate live. */
  userF0: number;
  bypass: boolean;
}

export const DEFAULT_CONTROLS: VoiceControls = {
  pitch: { mode: "semitones", semitones: 0 },
  pitchOffsetSemitones: 0,
  formantRatio: 1,
  timbreStrength: 0,
  intonation: 1,
  breath: 0,
  gateDb: -60,
  gateDepth: 0.05,
  outputGain: 1,
  userF0: 0,
  bypass: false,
};

export interface ShapePayload {
  shape: F32;
  /** Sample rate the shape was measured at (bins are re-mapped on upload). */
  sampleRate: number;
  /**
   * true  = the shape is a relative EQ curve applied as-is,
   * false = the shape is the target voice's absolute average spectrum and the
   *         speaker's own average spectrum is subtracted from it.
   */
  relative?: boolean;
}

export type MainToWorker =
  | { type: "init" }
  | { type: "connectAudio"; port: MessagePort; sampleRate: number }
  | { type: "disconnectAudio" }
  | { type: "setControls"; controls: VoiceControls }
  | { type: "setStyleShape"; payload: ShapePayload | null }
  | { type: "setUserShape"; payload: ShapePayload | null }
  | { type: "analyze"; id: number; samples: F32; sampleRate: number }
  | { type: "render"; id: number; samples: F32; sampleRate: number; controls: VoiceControls }
  | { type: "startRecording" }
  | { type: "stopRecording"; id: number }
  | { type: "resetState" };

export interface LiveStats {
  gpuMs: number;
  blocksPerDispatch: number;
  queueDepth: number;
  inputF0: number;
  inputRmsDb: number;
  liveMedianF0: number;
  targetF0: number;
  processedBlocks: number;
  droppedBlocks: number;
  adaptiveShapeFrames: number;
}

export type WorkerToMain =
  | { type: "ready"; info: GpuInfo }
  | { type: "error"; message: string; id?: number }
  | { type: "stats"; stats: LiveStats }
  | { type: "analyzeResult"; id: number; features: VoiceFeatures }
  | { type: "renderResult"; id: number; samples: F32; sampleRate: number }
  | { type: "recording"; id: number; samples: F32; sampleRate: number }
  | { type: "progress"; id: number; value: number };
