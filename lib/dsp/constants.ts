/**
 * Shared DSP constants. These must stay in sync with the WGSL prelude in
 * `shaders.ts` (N, LOGN, HALF, WG) because the workgroup memory layout of
 * the compute kernels is derived from them.
 */
export const FFT_SIZE = 2048;
export const LOG2_FFT_SIZE = 11;
export const HALF_BINS = FFT_SIZE / 2 + 1; // 1025 real-spectrum bins
export const HOP_SIZE = 512; // 4x overlap (75%)
export const OVERSAMPLE = FFT_SIZE / HOP_SIZE;
export const WORKGROUP_SIZE = 256;

/** Max frames processed per dispatch by the low-latency live path. */
export const LIVE_MAX_FRAMES = 8;
/** Max frames processed per dispatch by the offline (analysis / render) path. */
export const OFFLINE_MAX_FRAMES = 64;

/** Pitch-tracking search range (Hz). */
export const F0_MIN = 55;
export const F0_MAX = 900;

/** Phase-vocoder state layout in the `pvState` storage buffer (in f32 elements). */
export const PV_STATE_FLOATS = HALF_BINS * 2 + 4;

/** Floats per entry in the `frameInfo` buffer: (f0, rms, clarity, lifter). */
export const FRAME_INFO_FLOATS = 4;
