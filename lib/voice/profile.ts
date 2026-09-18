import type { VoiceFeatures } from "@/lib/dsp/features";

/** The speaker's own voice fingerprint captured during calibration. */
export interface UserVoiceProfile {
  medianF0: number;
  f0Low: number;
  f0High: number;
  brightnessDb: number;
  shape: number[];
  sampleRate: number;
  durationSec: number;
  createdAt: number;
}

const STORAGE_KEY = "webgpu-voice-changer.profile.v1";

export function profileFromFeatures(features: VoiceFeatures): UserVoiceProfile {
  return {
    medianF0: features.medianF0,
    f0Low: features.f0Low,
    f0High: features.f0High,
    brightnessDb: features.brightnessDb,
    shape: Array.from(features.shape),
    sampleRate: features.sampleRate,
    durationSec: features.durationSec,
    createdAt: Date.now(),
  };
}

export function loadProfile(): UserVoiceProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as UserVoiceProfile;
    return p && Array.isArray(p.shape) && p.medianF0 >= 0 ? p : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: UserVoiceProfile | null) {
  if (typeof window === "undefined") return;
  if (!profile) window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}
