"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getVoiceEngine, type EngineState, type VoiceEngine } from "@/lib/audio/engine";

const SERVER_SNAPSHOT: EngineState = {
  gpuStatus: "idle",
  gpuInfo: null,
  gpuError: null,
  running: false,
  starting: false,
  micError: null,
  sampleRate: 48000,
  baseLatencySec: 0,
  outputLatencySec: 0,
  liveStats: null,
  workletStats: null,
  recording: false,
  muted: false,
  outputVolume: 1,
  inputs: [],
  outputs: [],
  inputDeviceId: "",
  outputDeviceId: "",
  canSelectOutput: false,
  noiseSuppression: false,
  lastError: null,
};

export function useVoiceEngine(): { engine: VoiceEngine; state: EngineState } {
  const engine = useMemo(() => getVoiceEngine(), []);
  const state = useSyncExternalStore(engine.subscribe, engine.getState, () => SERVER_SNAPSHOT);

  useEffect(() => {
    engine.init().catch(() => undefined);
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __voiceEngine?: VoiceEngine }).__voiceEngine = engine;
    }
  }, [engine]);

  return { engine, state };
}
