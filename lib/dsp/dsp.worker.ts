/**
 * Dedicated worker that owns the WebGPU device. It serves three jobs:
 *   - the live low-latency loop (audio blocks arrive directly from the
 *     AudioWorklet over a transferred MessagePort),
 *   - offline analysis of reference clips (style extraction / calibration),
 *   - offline rendering of a clip with the current style (audition).
 */
import {
  FFT_SIZE,
  FRAME_INFO_FLOATS,
  HALF_BINS,
  HOP_SIZE,
  LIVE_MAX_FRAMES,
  OFFLINE_MAX_FRAMES,
} from "./constants";
import { bandBins, computeVoiceFeatures, resampleShape, type VoiceFeatures } from "./features";
import { GpuContext, VoicePipeline, type F32, type TransformParams } from "./gpu-pipeline";
import {
  DEFAULT_CONTROLS,
  type LiveStats,
  type MainToWorker,
  type ShapePayload,
  type VoiceControls,
  type WorkerToMain,
} from "./protocol";
import { StreamProcessor } from "./stream-processor";

const scope = self as unknown as WorkerScopeLike;

function post(msg: WorkerToMain, transfer?: Transferable[]) {
  scope.postMessage(msg, transfer);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

let ctx: GpuContext | null = null;
let livePipeline: VoicePipeline | null = null;
let offlinePipeline: VoicePipeline | null = null;

let controls: VoiceControls = DEFAULT_CONTROLS;
let styleShape: ShapePayload | null = null;
let userShape: ShapePayload | null = null;

// ---- live state -----------------------------------------------------------
let audioPort: MessagePort | null = null;
let stream: StreamProcessor | null = null;
let liveRate = 48000;
let queue: Float32Array[] = [];
let pumping = false;
let recording: Float32Array[] | null = null;

let liveLogF0 = 0;
let liveF0Count = 0;
const adaptiveShape = new Float32Array(HALF_BINS);
let adaptiveFrames = 0;
let adaptiveDirty = 0;
let lastStatsPost = 0;

const stats: LiveStats = {
  gpuMs: 0,
  blocksPerDispatch: 0,
  queueDepth: 0,
  inputF0: 0,
  inputRmsDb: -100,
  liveMedianF0: 0,
  targetF0: 0,
  processedBlocks: 0,
  droppedBlocks: 0,
  adaptiveShapeFrames: 0,
};

function getOffline(): VoicePipeline {
  if (!ctx) throw new Error("GPU 尚未初始化");
  if (!offlinePipeline) offlinePipeline = new VoicePipeline(ctx, OFFLINE_MAX_FRAMES);
  return offlinePipeline;
}

function effectiveUserF0(): number {
  if (controls.userF0 > 0) return controls.userF0;
  if (liveF0Count >= 8) return Math.pow(2, liveLogF0);
  return 150;
}

/**
 * Absolute (extracted) style shapes are applied as "style minus speaker".
 * Until a speaker reference exists (calibration profile or enough live frames
 * for the adaptive estimate) the timbre transfer is held off so the first
 * second of speech is not coloured by a half-defined curve.
 */
function speakerReferenceReady(): boolean {
  if (!styleShape || styleShape.relative) return true;
  return !!userShape || adaptiveFrames >= 20;
}

function deriveParams(c: VoiceControls, userF0: number, timbreReady = true): TransformParams {
  if (c.bypass) {
    return {
      pitchRatio: 1,
      formantRatio: 1,
      timbreStrength: 0,
      intonation: 1,
      styleF0: 0,
      userF0,
      gateDb: -200,
      gateDepth: 1,
      outputGain: c.outputGain,
      breath: 0,
    };
  }
  const offset = Math.pow(2, c.pitchOffsetSemitones / 12);
  let styleF0: number;
  let ratio: number;
  if (c.pitch.mode === "semitones") {
    const r = Math.pow(2, c.pitch.semitones / 12);
    styleF0 = userF0 * r * offset;
    ratio = r * offset;
  } else {
    styleF0 = c.pitch.hz * offset;
    ratio = (c.pitch.hz / userF0) * offset;
  }
  return {
    pitchRatio: clamp(ratio, 0.25, 4),
    formantRatio: clamp(c.formantRatio, 0.5, 2),
    timbreStrength: timbreReady ? clamp(c.timbreStrength, 0, 1.5) : 0,
    intonation: clamp(c.intonation, 0, 2),
    styleF0,
    userF0,
    gateDb: c.gateDb,
    gateDepth: clamp(c.gateDepth, 0, 1),
    outputGain: clamp(c.outputGain, 0, 4),
    breath: clamp(c.breath, 0, 1),
  };
}

function uploadShapes(pipeline: VoicePipeline, rate: number, userOverride?: F32 | null) {
  pipeline.setStyleShape(styleShape ? resampleShape(styleShape.shape, styleShape.sampleRate, rate) : null);
  if (styleShape?.relative) {
    // Relative curves are applied directly; no speaker reference needed.
    pipeline.setUserShape(null);
  } else if (userOverride !== undefined) {
    pipeline.setUserShape(userOverride);
  } else if (userShape) {
    pipeline.setUserShape(resampleShape(userShape.shape, userShape.sampleRate, rate));
  } else if (adaptiveFrames >= 20) {
    pipeline.setUserShape(adaptiveShape);
  } else {
    pipeline.setUserShape(null);
  }
}

function resetLiveTracking() {
  liveLogF0 = 0;
  liveF0Count = 0;
  adaptiveShape.fill(0);
  adaptiveFrames = 0;
  adaptiveDirty = 0;
  stats.processedBlocks = 0;
  stats.droppedBlocks = 0;
  stats.gpuMs = 0;
  stats.adaptiveShapeFrames = 0;
}

function updateTracking(info: Float32Array, env: Float32Array, count: number, params: TransformParams) {
  const [lo, hi] = bandBins(liveRate, 100, Math.min(8000, liveRate / 2 - 100));
  for (let i = 0; i < count; i++) {
    const f0 = info[i * FRAME_INFO_FLOATS];
    const rms = info[i * FRAME_INFO_FLOATS + 1];
    const clarity = info[i * FRAME_INFO_FLOATS + 2];
    const rmsDb = 20 * Math.log10(Math.max(rms, 1e-6));
    stats.inputRmsDb = rmsDb;
    const voiced = f0 > 0 && clarity > 0.6 && rmsDb > controls.gateDb + 6 && rmsDb > -55;
    stats.inputF0 = voiced ? f0 : 0;
    if (!voiced) continue;

    const logF0 = Math.log2(f0);
    const aF0 = Math.max(0.02, 1 / (liveF0Count + 1));
    liveLogF0 = liveF0Count === 0 ? logF0 : liveLogF0 + (logF0 - liveLogF0) * aF0;
    liveF0Count++;

    const base = i * HALF_BINS;
    let mean = 0;
    for (let k = lo; k <= hi; k++) mean += env[base + k];
    mean /= hi - lo + 1;
    const aS = Math.max(0.01, 1 / (adaptiveFrames + 1));
    for (let k = 0; k < HALF_BINS; k++) {
      const v = env[base + k] - mean;
      adaptiveShape[k] += (v - adaptiveShape[k]) * aS;
    }
    adaptiveFrames++;
    adaptiveDirty++;
  }
  stats.liveMedianF0 = liveF0Count >= 8 ? Math.pow(2, liveLogF0) : 0;
  stats.targetF0 = params.styleF0;
  stats.adaptiveShapeFrames = adaptiveFrames;

  if (!userShape && !styleShape?.relative && livePipeline && adaptiveFrames >= 20 && adaptiveDirty >= 16) {
    livePipeline.setUserShape(adaptiveShape);
    adaptiveDirty = 0;
  }
}

function maybePostStats(force = false) {
  const now = performance.now();
  if (!force && now - lastStatsPost < 150) return;
  lastStatsPost = now;
  stats.queueDepth = queue.length;
  post({ type: "stats", stats: { ...stats } });
}

function onAudioBlock(ev: MessageEvent) {
  const data = ev.data;
  let block: Float32Array | null = null;
  if (data instanceof ArrayBuffer) block = new Float32Array(data);
  else if (data instanceof Float32Array) block = data;
  if (!block) return;
  queue.push(block);
  // Bound the backlog after a stall so latency cannot creep up unboundedly.
  const maxBacklog = LIVE_MAX_FRAMES * 2;
  if (queue.length > maxBacklog) {
    const drop = queue.length - LIVE_MAX_FRAMES;
    queue.splice(0, drop);
    stats.droppedBlocks += drop;
  }
  void pump();
}

async function pump() {
  if (pumping || !stream) return;
  pumping = true;
  try {
    while (queue.length > 0 && stream && audioPort) {
      const blocks = queue.splice(0, stream.maxBlocks);
      const t0 = performance.now();
      const params = deriveParams(controls, effectiveUserF0(), speakerReferenceReady());
      const res = await stream.process(blocks, params);
      const dt = performance.now() - t0;
      stats.gpuMs = stats.gpuMs > 0 ? stats.gpuMs * 0.9 + dt * 0.1 : dt;
      stats.blocksPerDispatch = blocks.length;
      if (!audioPort) break;
      for (const out of res.outputs) {
        if (recording) recording.push(out.slice());
        audioPort.postMessage(out, [out.buffer]);
      }
      stats.processedBlocks += blocks.length;
      updateTracking(res.info, res.env, blocks.length, params);
      maybePostStats();
    }
  } catch (e) {
    post({ type: "error", message: `即時處理錯誤: ${errorMessage(e)}` });
  } finally {
    pumping = false;
  }
}

// ---- offline jobs ---------------------------------------------------------

async function analyzeSamples(samples: F32, sampleRate: number): Promise<VoiceFeatures> {
  const pipeline = getOffline();
  const padded =
    samples.length >= FFT_SIZE
      ? samples
      : (() => {
          const p = new Float32Array(FFT_SIZE);
          p.set(samples);
          return p;
        })();
  const count = Math.floor((padded.length - FFT_SIZE) / HOP_SIZE) + 1;
  const info = new Float32Array(count * FRAME_INFO_FLOATS);
  const env = new Float32Array(count * HALF_BINS);
  const frames = new Float32Array(OFFLINE_MAX_FRAMES * FFT_SIZE);
  for (let start = 0; start < count; start += OFFLINE_MAX_FRAMES) {
    const n = Math.min(OFFLINE_MAX_FRAMES, count - start);
    for (let i = 0; i < n; i++) {
      const t = (start + i) * HOP_SIZE;
      frames.set(padded.subarray(t, t + FFT_SIZE), i * FFT_SIZE);
    }
    const res = await pipeline.analyze(frames, n, sampleRate);
    info.set(res.info, start * FRAME_INFO_FLOATS);
    env.set(res.env, start * HALF_BINS);
  }
  return computeVoiceFeatures(info, env, count, sampleRate);
}

async function renderSamples(
  id: number,
  samples: F32,
  sampleRate: number,
  c: VoiceControls,
): Promise<F32> {
  const pipeline = getOffline();
  let userF0 = c.userF0;
  let userOverride: F32 | null | undefined = undefined;
  if (!(userF0 > 0) || !userShape) {
    // Use the clip itself as the speaker reference when no calibration exists.
    const feats = await analyzeSamples(samples, sampleRate);
    if (!(userF0 > 0)) userF0 = feats.medianF0 > 0 ? feats.medianF0 : 150;
    if (!userShape) userOverride = feats.shape;
  }
  uploadShapes(pipeline, sampleRate, userOverride);
  const params = deriveParams(c, userF0);

  const proc = new StreamProcessor(pipeline, sampleRate);
  proc.reset();
  const totalBlocks = Math.ceil((samples.length + FFT_SIZE) / HOP_SIZE);
  const out = new Float32Array(totalBlocks * HOP_SIZE);
  for (let b = 0; b < totalBlocks; b += OFFLINE_MAX_FRAMES) {
    const n = Math.min(OFFLINE_MAX_FRAMES, totalBlocks - b);
    const blocks: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      const block = new Float32Array(HOP_SIZE);
      const t = (b + i) * HOP_SIZE;
      if (t < samples.length) block.set(samples.subarray(t, Math.min(t + HOP_SIZE, samples.length)));
      blocks.push(block);
    }
    const res = await proc.process(blocks, params);
    res.outputs.forEach((o, i) => out.set(o, (b + i) * HOP_SIZE));
    post({ type: "progress", id, value: Math.min(1, (b + n) / totalBlocks) });
  }
  // Remove the algorithmic delay so the result lines up with the input: the
  // first emitted hop of a frame covers samples that entered FFT_SIZE - HOP_SIZE
  // samples earlier.
  const delay = FFT_SIZE - HOP_SIZE;
  return out.slice(delay, delay + samples.length);
}

// ---- message handling -----------------------------------------------------

async function handle(msg: MainToWorker) {
  switch (msg.type) {
    case "init": {
      try {
        ctx = await GpuContext.create();
        livePipeline = new VoicePipeline(ctx, LIVE_MAX_FRAMES);
        ctx.device.lost.then((info) => {
          post({ type: "error", message: `WebGPU 裝置遺失: ${info.message}` });
        });
        post({ type: "ready", info: ctx.info });
      } catch (e) {
        post({ type: "error", message: errorMessage(e) });
      }
      return;
    }
    case "connectAudio": {
      if (!livePipeline) throw new Error("GPU 尚未初始化");
      audioPort?.close();
      queue = [];
      liveRate = msg.sampleRate;
      resetLiveTracking();
      stream = new StreamProcessor(livePipeline, liveRate);
      stream.reset();
      uploadShapes(livePipeline, liveRate);
      audioPort = msg.port;
      audioPort.onmessage = onAudioBlock;
      maybePostStats(true);
      return;
    }
    case "disconnectAudio": {
      audioPort?.close();
      audioPort = null;
      stream = null;
      queue = [];
      maybePostStats(true);
      return;
    }
    case "setControls": {
      controls = msg.controls;
      return;
    }
    case "setStyleShape": {
      styleShape = msg.payload;
      if (livePipeline && stream) uploadShapes(livePipeline, liveRate);
      return;
    }
    case "setUserShape": {
      userShape = msg.payload;
      if (livePipeline && stream) uploadShapes(livePipeline, liveRate);
      return;
    }
    case "analyze": {
      try {
        const features = await analyzeSamples(msg.samples, msg.sampleRate);
        post({ type: "analyzeResult", id: msg.id, features }, [
          features.shape.buffer,
          features.f0Track.buffer,
          features.rmsTrackDb.buffer,
        ]);
      } catch (e) {
        post({ type: "error", id: msg.id, message: `分析失敗: ${errorMessage(e)}` });
      }
      return;
    }
    case "render": {
      try {
        const samples = await renderSamples(msg.id, msg.samples, msg.sampleRate, msg.controls);
        post({ type: "renderResult", id: msg.id, samples, sampleRate: msg.sampleRate }, [samples.buffer]);
      } catch (e) {
        post({ type: "error", id: msg.id, message: `渲染失敗: ${errorMessage(e)}` });
      }
      return;
    }
    case "startRecording": {
      recording = [];
      return;
    }
    case "stopRecording": {
      const chunks = recording ?? [];
      recording = null;
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const samples = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) {
        samples.set(c, offset);
        offset += c.length;
      }
      post({ type: "recording", id: msg.id, samples, sampleRate: liveRate }, [samples.buffer]);
      return;
    }
    case "resetState": {
      stream?.reset();
      return;
    }
  }
}

scope.onmessage = (ev: MessageEvent<MainToWorker>) => {
  handle(ev.data).catch((e) => post({ type: "error", message: errorMessage(e) }));
};
