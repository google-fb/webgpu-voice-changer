import { FFT_SIZE, HOP_SIZE } from "@/lib/dsp/constants";
import type { VoiceFeatures } from "@/lib/dsp/features";
import type { F32, GpuInfo } from "@/lib/dsp/gpu-pipeline";
import {
  DEFAULT_CONTROLS,
  type LiveStats,
  type MainToWorker,
  type ShapePayload,
  type VoiceControls,
  type WorkerToMain,
} from "@/lib/dsp/protocol";
import { publicUrl } from "@/lib/audio/public-url";

export type GpuStatus = "idle" | "initializing" | "ready" | "unsupported" | "error";

export interface WorkletStats {
  underruns: number;
  bufferedBlocks: number;
  sentBlocks: number;
  receivedBlocks: number;
  inputPeak: number;
  outputPeak: number;
  connected: boolean;
}

export interface EngineState {
  gpuStatus: GpuStatus;
  gpuInfo: GpuInfo | null;
  gpuError: string | null;
  running: boolean;
  starting: boolean;
  micError: string | null;
  sampleRate: number;
  baseLatencySec: number;
  outputLatencySec: number;
  liveStats: LiveStats | null;
  workletStats: WorkletStats | null;
  recording: boolean;
  muted: boolean;
  outputVolume: number;
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  inputDeviceId: string;
  outputDeviceId: string;
  canSelectOutput: boolean;
  noiseSuppression: boolean;
  lastError: string | null;
}

export interface CapturedClip {
  samples: F32;
  sampleRate: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onProgress?: (value: number) => void;
}

const INITIAL_STATE: EngineState = {
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

/**
 * Main-thread facade. Owns the Web Audio graph and the DSP worker and exposes
 * an observable state object for React.
 */
export class VoiceEngine {
  private state: EngineState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  private ctx: AudioContext | null = null;
  private workletLoaded = false;
  private node: AudioWorkletNode | null = null;
  private mic: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private outGain: GainNode | null = null;
  private inAnalyserNode: AnalyserNode | null = null;
  private outAnalyserNode: AnalyserNode | null = null;
  private tapPending: { id: number; resolve: (clip: CapturedClip) => void } | null = null;
  private playback: AudioBufferSourceNode | null = null;

  private controls: VoiceControls = DEFAULT_CONTROLS;

  // ---- observable state ----------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private update(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get inAnalyser() {
    return this.inAnalyserNode;
  }

  get outAnalyser() {
    return this.outAnalyserNode;
  }

  get audioContext() {
    return this.ctx;
  }

  get currentControls() {
    return this.controls;
  }

  // ---- worker / GPU ----------------------------------------------------------

  init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      this.update({ gpuStatus: "unsupported", gpuError: "此瀏覽器沒有 WebGPU。請改用 Chrome、Edge（113 以上）或其他支援 WebGPU 的瀏覽器。" });
      this.readyPromise = Promise.reject(new Error("WebGPU unsupported"));
      this.readyPromise.catch(() => undefined);
      return this.readyPromise;
    }
    this.update({ gpuStatus: "initializing" });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      try {
        const worker = new Worker(new URL("../dsp/dsp.worker.ts", import.meta.url), { type: "module" });
        this.worker = worker;
        worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
          const msg = ev.data;
          if (msg.type === "ready") {
            this.update({ gpuStatus: "ready", gpuInfo: msg.info, gpuError: null });
            resolve();
          } else if (msg.type === "error" && this.state.gpuStatus === "initializing") {
            this.update({ gpuStatus: "error", gpuError: msg.message });
            reject(new Error(msg.message));
          } else {
            this.handleWorkerMessage(msg);
          }
        };
        worker.onerror = (ev) => {
          const message = ev.message || "DSP worker 發生錯誤";
          if (this.state.gpuStatus === "initializing") {
            this.update({ gpuStatus: "error", gpuError: message });
            reject(new Error(message));
          } else {
            this.update({ lastError: message });
          }
        };
        this.post({ type: "init" });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.update({ gpuStatus: "error", gpuError: message });
        reject(e);
      }
    });
    this.readyPromise.catch(() => undefined);
    void this.refreshDevices();
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener?.("devicechange", () => void this.refreshDevices());
    }
    this.update({
      canSelectOutput: typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype,
    });
    return this.readyPromise;
  }

  private post(msg: MainToWorker, transfer?: Transferable[]) {
    if (!this.worker) throw new Error("DSP worker 尚未建立");
    if (transfer) this.worker.postMessage(msg, transfer);
    else this.worker.postMessage(msg);
  }

  private call<T>(
    build: (id: number) => MainToWorker,
    transfer?: Transferable[],
    onProgress?: (value: number) => void,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      try {
        this.post(build(id), transfer);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private handleWorkerMessage(msg: WorkerToMain) {
    switch (msg.type) {
      case "stats":
        this.update({ liveStats: msg.stats });
        break;
      case "progress":
        this.pending.get(msg.id)?.onProgress?.(msg.value);
        break;
      case "analyzeResult":
        this.settle(msg.id, msg.features);
        break;
      case "renderResult":
        this.settle(msg.id, { samples: msg.samples, sampleRate: msg.sampleRate });
        break;
      case "recording":
        this.settle(msg.id, { samples: msg.samples, sampleRate: msg.sampleRate });
        break;
      case "error":
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          p.reject(new Error(msg.message));
        } else {
          this.update({ lastError: msg.message });
        }
        break;
      default:
        break;
    }
  }

  private settle(id: number, value: unknown) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(value);
  }

  clearError() {
    this.update({ lastError: null, micError: null });
  }

  // ---- controls -------------------------------------------------------------

  setControls(patch: Partial<VoiceControls>) {
    this.controls = { ...this.controls, ...patch };
    if (this.worker) this.post({ type: "setControls", controls: this.controls });
  }

  setStyleShape(payload: ShapePayload | null) {
    if (!this.worker) return;
    this.post({ type: "setStyleShape", payload });
  }

  setUserShape(payload: ShapePayload | null) {
    if (!this.worker) return;
    this.post({ type: "setUserShape", payload });
  }

  setMuted(muted: boolean) {
    this.update({ muted });
    this.applyOutputGain();
  }

  setOutputVolume(volume: number) {
    this.update({ outputVolume: volume });
    this.applyOutputGain();
  }

  private applyOutputGain() {
    if (!this.outGain || !this.ctx) return;
    const target = this.state.muted ? 0 : this.state.outputVolume;
    this.outGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  setNoiseSuppression(enabled: boolean) {
    this.update({ noiseSuppression: enabled });
    if (this.state.running) void this.restartInput();
  }

  // ---- devices --------------------------------------------------------------

  async refreshDevices() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.update({
        inputs: devices.filter((d) => d.kind === "audioinput"),
        outputs: devices.filter((d) => d.kind === "audiooutput"),
      });
    } catch {
      // Permission not granted yet; labels will appear after the first start.
    }
  }

  async setInputDevice(deviceId: string) {
    this.update({ inputDeviceId: deviceId });
    if (this.state.running) await this.restartInput();
  }

  async setOutputDevice(deviceId: string) {
    this.update({ outputDeviceId: deviceId });
    if (this.ctx && this.ctx.setSinkId) {
      try {
        await this.ctx.setSinkId(deviceId);
      } catch (e) {
        this.update({ lastError: `無法切換輸出裝置: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  // ---- live audio graph -----------------------------------------------------

  private async openMic(): Promise<MediaStream> {
    const constraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: this.state.noiseSuppression,
      autoGainControl: false,
      channelCount: 1,
    };
    if (this.state.inputDeviceId) constraints.deviceId = { exact: this.state.inputDeviceId };
    return navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
  }

  async start(): Promise<void> {
    if (this.state.running || this.state.starting) return;
    this.update({ starting: true, micError: null, lastError: null });
    try {
      await this.init();
      if (!this.ctx) {
        this.ctx = new AudioContext({ latencyHint: "interactive" });
        this.ctx.onstatechange = () => {
          if (this.ctx?.state === "closed") this.update({ running: false });
        };
      }
      const ctx = this.ctx;
      if (ctx.state === "suspended") await ctx.resume();
      if (!this.workletLoaded) {
        await ctx.audioWorklet.addModule(publicUrl("/worklets/voice-io-processor.js"));
        this.workletLoaded = true;
      }

      const mic = await this.openMic();
      this.mic = mic;
      mic.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (this.state.running) void this.stop();
      });

      const node = new AudioWorkletNode(ctx, "voice-io-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { hop: HOP_SIZE, prefillBlocks: 2, maxBufferedBlocks: 8 },
      });
      node.port.onmessage = (e: MessageEvent) => this.handleWorkletMessage(e.data);
      this.node = node;

      const inAnalyser = ctx.createAnalyser();
      inAnalyser.fftSize = 2048;
      inAnalyser.smoothingTimeConstant = 0.6;
      const outAnalyser = ctx.createAnalyser();
      outAnalyser.fftSize = 2048;
      outAnalyser.smoothingTimeConstant = 0.6;
      const outGain = ctx.createGain();
      outGain.gain.value = this.state.muted ? 0 : this.state.outputVolume;

      const source = ctx.createMediaStreamSource(mic);
      source.connect(inAnalyser);
      source.connect(node);
      node.connect(outAnalyser);
      outAnalyser.connect(outGain);
      outGain.connect(ctx.destination);

      this.source = source;
      this.inAnalyserNode = inAnalyser;
      this.outAnalyserNode = outAnalyser;
      this.outGain = outGain;

      const channel = new MessageChannel();
      node.port.postMessage({ type: "connect", port: channel.port1 }, [channel.port1]);
      this.post({ type: "connectAudio", port: channel.port2, sampleRate: ctx.sampleRate }, [channel.port2]);
      this.post({ type: "setControls", controls: this.controls });

      if (this.state.outputDeviceId && ctx.setSinkId) {
        try {
          await ctx.setSinkId(this.state.outputDeviceId);
        } catch {
          this.update({ outputDeviceId: "" });
        }
      }

      this.update({
        running: true,
        starting: false,
        sampleRate: ctx.sampleRate,
        baseLatencySec: ctx.baseLatency ?? 0,
        outputLatencySec: ctx.outputLatency ?? 0,
        liveStats: null,
        workletStats: null,
      });
      void this.refreshDevices();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.teardownGraph();
      this.update({
        starting: false,
        running: false,
        micError: message.includes("Permission") || message.includes("NotAllowed") ? "麥克風權限被拒絕，請允許瀏覽器使用麥克風。" : message,
      });
    }
  }

  private handleWorkletMessage(msg: unknown) {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string; id?: number; buffer?: ArrayBuffer } & Partial<WorkletStats>;
    if (m.type === "stats") {
      this.update({
        workletStats: {
          underruns: m.underruns ?? 0,
          bufferedBlocks: m.bufferedBlocks ?? 0,
          sentBlocks: m.sentBlocks ?? 0,
          receivedBlocks: m.receivedBlocks ?? 0,
          inputPeak: m.inputPeak ?? 0,
          outputPeak: m.outputPeak ?? 0,
          connected: m.connected ?? false,
        },
      });
    } else if (m.type === "tap" && m.buffer && this.tapPending && this.tapPending.id === m.id) {
      const pending = this.tapPending;
      this.tapPending = null;
      pending.resolve({ samples: new Float32Array(m.buffer), sampleRate: this.ctx?.sampleRate ?? 48000 });
    }
  }

  private async restartInput() {
    if (!this.ctx || !this.node || !this.inAnalyserNode) return;
    try {
      const mic = await this.openMic();
      this.source?.disconnect();
      this.mic?.getTracks().forEach((t) => t.stop());
      this.mic = mic;
      const source = this.ctx.createMediaStreamSource(mic);
      source.connect(this.inAnalyserNode);
      source.connect(this.node);
      this.source = source;
      void this.refreshDevices();
    } catch (e) {
      this.update({ micError: e instanceof Error ? e.message : String(e) });
    }
  }

  private teardownGraph() {
    if (this.node) {
      try {
        this.node.port.postMessage({ type: "disconnect" });
      } catch {
        // ignore
      }
      this.node.disconnect();
      this.node.port.onmessage = null;
    }
    this.source?.disconnect();
    this.inAnalyserNode?.disconnect();
    this.outAnalyserNode?.disconnect();
    this.outGain?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.source = null;
    this.mic = null;
    this.inAnalyserNode = null;
    this.outAnalyserNode = null;
    this.outGain = null;
    if (this.tapPending) this.tapPending = null;
  }

  async stop(): Promise<void> {
    if (!this.state.running && !this.state.starting) return;
    if (this.worker && this.state.gpuStatus === "ready") this.post({ type: "disconnectAudio" });
    this.teardownGraph();
    if (this.state.recording) {
      this.update({ recording: false });
    }
    this.update({ running: false, starting: false, liveStats: null, workletStats: null });
  }

  /** Capture raw microphone input (before processing) for `seconds`. */
  captureInput(seconds: number): Promise<CapturedClip> {
    if (!this.node || !this.ctx || !this.state.running) {
      return Promise.reject(new Error("請先啟動變聲器，麥克風開啟後才能錄音。"));
    }
    if (this.tapPending) {
      this.node.port.postMessage({ type: "cancelTap" });
      this.tapPending = null;
    }
    const id = this.nextId++;
    const samples = Math.round(seconds * this.ctx.sampleRate);
    return new Promise<CapturedClip>((resolve) => {
      this.tapPending = { id, resolve };
      this.node!.port.postMessage({ type: "tap", id, samples });
    });
  }

  cancelCapture() {
    if (this.node && this.tapPending) {
      this.node.port.postMessage({ type: "cancelTap" });
      this.tapPending = null;
    }
  }

  // ---- offline jobs -----------------------------------------------------------

  async analyzeClip(samples: Float32Array, sampleRate: number): Promise<VoiceFeatures> {
    await this.init();
    const copy = samples.slice();
    return this.call<VoiceFeatures>((id) => ({ type: "analyze", id, samples: copy, sampleRate }), [copy.buffer]);
  }

  async renderClip(
    samples: Float32Array,
    sampleRate: number,
    controls: VoiceControls,
    onProgress?: (value: number) => void,
  ): Promise<CapturedClip> {
    await this.init();
    const copy = samples.slice();
    return this.call<CapturedClip>(
      (id) => ({ type: "render", id, samples: copy, sampleRate, controls }),
      [copy.buffer],
      onProgress,
    );
  }

  // ---- recording ----------------------------------------------------------------

  startRecording() {
    if (!this.state.running) throw new Error("變聲器尚未啟動");
    this.post({ type: "startRecording" });
    this.update({ recording: true });
  }

  async stopRecording(): Promise<CapturedClip> {
    this.update({ recording: false });
    return this.call<CapturedClip>((id) => ({ type: "stopRecording", id }));
  }

  // ---- playback -----------------------------------------------------------------

  async play(samples: F32, sampleRate: number, onEnded?: () => void): Promise<void> {
    this.stopPlayback();
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    const ctx = this.ctx;
    if (ctx.state === "suspended") await ctx.resume();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (this.playback === src) this.playback = null;
      onEnded?.();
    };
    this.playback = src;
    src.start();
  }

  stopPlayback() {
    if (this.playback) {
      try {
        this.playback.stop();
      } catch {
        // already stopped
      }
      this.playback = null;
    }
  }

  /** Estimated end-to-end latency in milliseconds (algorithmic + buffering). */
  estimatedLatencyMs(): number {
    const sr = this.state.sampleRate || 48000;
    const algorithmic = FFT_SIZE / sr;
    const buffering = (HOP_SIZE * 3) / sr; // one input block + two blocks of jitter buffer
    const gpu = (this.state.liveStats?.gpuMs ?? 0) / 1000;
    const io = (this.state.baseLatencySec || 0) + (this.state.outputLatencySec || 0);
    return Math.round((algorithmic + buffering + gpu + io) * 1000);
  }
}

let singleton: VoiceEngine | null = null;

export function getVoiceEngine(): VoiceEngine {
  if (!singleton) singleton = new VoiceEngine();
  return singleton;
}
