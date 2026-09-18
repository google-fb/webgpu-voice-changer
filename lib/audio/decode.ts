export interface DecodedClip {
  samples: Float32Array<ArrayBuffer>;
  sampleRate: number;
  durationSec: number;
  name: string;
}

/** Longest clip we analyse/render, to keep GPU memory and UI latency bounded. */
export const MAX_CLIP_SECONDS = 30;

/**
 * Decode an audio file to mono float samples. Decoding goes through an
 * OfflineAudioContext at the requested rate so the result matches whatever the
 * live AudioContext runs at.
 */
export async function decodeAudioFile(file: File | Blob, sampleRate = 48000, name = "clip"): Promise<DecodedClip> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const audio = await ctx.decodeAudioData(arrayBuffer);
  return mixdown(audio, name);
}

export function mixdown(audio: AudioBuffer, name: string): DecodedClip {
  const maxLength = Math.min(audio.length, Math.floor(MAX_CLIP_SECONDS * audio.sampleRate));
  const samples = new Float32Array(maxLength);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < maxLength; i++) samples[i] += data[i];
  }
  if (audio.numberOfChannels > 1) {
    const g = 1 / audio.numberOfChannels;
    for (let i = 0; i < maxLength; i++) samples[i] *= g;
  }
  return { samples, sampleRate: audio.sampleRate, durationSec: maxLength / audio.sampleRate, name };
}

/** Peak-normalise to -1 dBFS (in place) and return the applied gain. */
export function normalizePeak(samples: Float32Array, targetPeak = 0.89): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-6) return 1;
  const g = targetPeak / peak;
  if (g < 1 || g > 1.05) {
    for (let i = 0; i < samples.length; i++) samples[i] *= g;
    return g;
  }
  return 1;
}
