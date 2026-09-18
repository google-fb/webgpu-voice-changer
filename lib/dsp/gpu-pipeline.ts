import {
  F0_MAX,
  F0_MIN,
  FFT_SIZE,
  FRAME_INFO_FLOATS,
  HALF_BINS,
  HOP_SIZE,
  PV_STATE_FLOATS,
} from "./constants";
import { ANALYZE_SHADER, SYNTHESIZE_SHADER, TRANSFORM_SHADER } from "./shaders";

/** Float32Array backed by a plain (non-shared) ArrayBuffer, as required by WebGPU uploads. */
export type F32 = Float32Array<ArrayBuffer>;

export interface GpuInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter: boolean;
}

export interface TransformParams {
  /** Base pitch ratio = styleF0 / userF0 * manual offset. */
  pitchRatio: number;
  /** Frequency-axis scale applied to the speaker's spectral envelope. */
  formantRatio: number;
  /** 0 = keep the speaker's timbre, 1 = fully impose the style envelope. */
  timbreStrength: number;
  /** 1 = natural pitch movement, 0 = monotone at styleF0, >1 = exaggerated. */
  intonation: number;
  /** Target median pitch (Hz). 0 disables dynamic pitch mapping. */
  styleF0: number;
  /** Speaker's median pitch (Hz). */
  userF0: number;
  /** Noise-gate threshold in dBFS (RMS per frame). */
  gateDb: number;
  /** Residual gain below the gate threshold (linear). */
  gateDepth: number;
  /** Output gain (linear). */
  outputGain: number;
  /** 0..1 breathiness amount. */
  breath: number;
}

export interface AnalyzeResult {
  count: number;
  /** count * 4 floats: (f0, rms, clarity, lifter) per frame. */
  info: F32;
  /** count * HALF_BINS log-magnitude envelopes. */
  env: F32;
}

export interface ProcessResult extends AnalyzeResult {
  /** count * FFT_SIZE windowed output frames ready for overlap-add. */
  out: F32;
}

async function compileModule(device: GPUDevice, code: string, label: string) {
  const shaderModule = device.createShaderModule({ code, label });
  const info = await shaderModule.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length > 0) {
    const text = errors
      .map((m) => `  line ${m.lineNum}:${m.linePos} ${m.message}`)
      .join("\n");
    throw new Error(`WGSL 編譯失敗 (${label}):\n${text}`);
  }
  return shaderModule;
}

/**
 * Owns the WebGPU device and the three compute pipelines. One context is
 * shared by every `VoicePipeline` instance (live and offline).
 */
export class GpuContext {
  private constructor(
    readonly device: GPUDevice,
    readonly info: GpuInfo,
    readonly analyzePipeline: GPUComputePipeline,
    readonly transformPipeline: GPUComputePipeline,
    readonly synthesizePipeline: GPUComputePipeline,
    readonly twiddles: GPUBuffer,
  ) {}

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.gpu;
  }

  static async create(): Promise<GpuContext> {
    if (!GpuContext.isSupported()) {
      throw new Error("此瀏覽器不支援 WebGPU。請使用 Chrome / Edge 113+ 或其他支援 WebGPU 的瀏覽器。");
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      throw new Error("找不到可用的 WebGPU 適配器（GPU 可能被停用或不支援）。");
    }
    const device = await adapter.requestDevice({ label: "voice-changer" });

    const rawInfo = adapter.info;
    const info: GpuInfo = {
      vendor: rawInfo?.vendor ?? "",
      architecture: rawInfo?.architecture ?? "",
      device: rawInfo?.device ?? "",
      description: rawInfo?.description ?? "",
      isFallbackAdapter: Boolean(
        (rawInfo as unknown as { isFallbackAdapter?: boolean })?.isFallbackAdapter ??
          (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter,
      ),
    };

    const [analyzeModule, transformModule, synthesizeModule] = await Promise.all([
      compileModule(device, ANALYZE_SHADER, "analyze"),
      compileModule(device, TRANSFORM_SHADER, "transform"),
      compileModule(device, SYNTHESIZE_SHADER, "synthesize"),
    ]);

    const [analyzePipeline, transformPipeline, synthesizePipeline] = await Promise.all([
      device.createComputePipelineAsync({
        label: "analyze",
        layout: "auto",
        compute: { module: analyzeModule, entryPoint: "main" },
      }),
      device.createComputePipelineAsync({
        label: "transform",
        layout: "auto",
        compute: { module: transformModule, entryPoint: "main" },
      }),
      device.createComputePipelineAsync({
        label: "synthesize",
        layout: "auto",
        compute: { module: synthesizeModule, entryPoint: "main" },
      }),
    ]);

    const tw = new Float32Array(FFT_SIZE);
    for (let k = 0; k < FFT_SIZE / 2; k++) {
      const a = (2 * Math.PI * k) / FFT_SIZE;
      tw[2 * k] = Math.cos(a);
      tw[2 * k + 1] = -Math.sin(a);
    }
    const twiddles = device.createBuffer({
      label: "twiddles",
      size: tw.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(twiddles, 0, tw);

    return new GpuContext(device, info, analyzePipeline, transformPipeline, synthesizePipeline, twiddles);
  }
}

/**
 * A set of GPU buffers sized for up to `maxFrames` STFT frames per dispatch,
 * plus the persistent phase-vocoder state. Calls are serialised internally so
 * one instance can be driven from async code without races on the staging
 * buffer.
 */
export class VoicePipeline {
  private readonly device: GPUDevice;
  private readonly frames: GPUBuffer;
  private readonly analyzeParams: GPUBuffer;
  private readonly mag: GPUBuffer;
  private readonly phase: GPUBuffer;
  private readonly env: GPUBuffer;
  private readonly frameInfo: GPUBuffer;
  private readonly transformParams: GPUBuffer;
  private readonly styleShape: GPUBuffer;
  private readonly userShape: GPUBuffer;
  private readonly pvState: GPUBuffer;
  private readonly outSpec: GPUBuffer;
  private readonly outFrames: GPUBuffer;
  private readonly staging: GPUBuffer;
  private readonly analyzeBindGroup: GPUBindGroup;
  private readonly transformBindGroup: GPUBindGroup;
  private readonly synthesizeBindGroup: GPUBindGroup;

  private readonly infoOffset: number;
  private readonly envOffset: number;
  private readonly analyzeParamsData = new ArrayBuffer(16);
  private readonly transformParamsData = new ArrayBuffer(64);
  private lock: Promise<unknown> = Promise.resolve();
  private hasStyleShape = false;
  private hasUserShape = false;
  private destroyed = false;

  constructor(
    private readonly ctx: GpuContext,
    readonly maxFrames: number,
  ) {
    const device = ctx.device;
    this.device = device;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const frameBytes = maxFrames * FFT_SIZE * 4;
    const specBytes = maxFrames * HALF_BINS * 4;
    const infoBytes = maxFrames * FRAME_INFO_FLOATS * 4;

    this.frames = device.createBuffer({ label: "frames", size: frameBytes, usage: storage });
    this.analyzeParams = device.createBuffer({
      label: "analyzeParams",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.mag = device.createBuffer({ label: "mag", size: specBytes, usage: storage });
    this.phase = device.createBuffer({ label: "phase", size: specBytes, usage: storage });
    this.env = device.createBuffer({ label: "env", size: specBytes, usage: storage | GPUBufferUsage.COPY_SRC });
    this.frameInfo = device.createBuffer({
      label: "frameInfo",
      size: infoBytes,
      usage: storage | GPUBufferUsage.COPY_SRC,
    });
    this.transformParams = device.createBuffer({
      label: "transformParams",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.styleShape = device.createBuffer({ label: "styleShape", size: HALF_BINS * 4, usage: storage });
    this.userShape = device.createBuffer({ label: "userShape", size: HALF_BINS * 4, usage: storage });
    this.pvState = device.createBuffer({ label: "pvState", size: PV_STATE_FLOATS * 4, usage: storage });
    this.outSpec = device.createBuffer({ label: "outSpec", size: maxFrames * HALF_BINS * 8, usage: storage });
    this.outFrames = device.createBuffer({
      label: "outFrames",
      size: frameBytes,
      usage: storage | GPUBufferUsage.COPY_SRC,
    });

    this.infoOffset = frameBytes;
    this.envOffset = frameBytes + infoBytes;
    this.staging = device.createBuffer({
      label: "staging",
      size: frameBytes + infoBytes + specBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    this.analyzeBindGroup = device.createBindGroup({
      label: "analyze",
      layout: ctx.analyzePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ctx.twiddles } },
        { binding: 1, resource: { buffer: this.analyzeParams } },
        { binding: 2, resource: { buffer: this.frames } },
        { binding: 3, resource: { buffer: this.mag } },
        { binding: 4, resource: { buffer: this.phase } },
        { binding: 5, resource: { buffer: this.env } },
        { binding: 6, resource: { buffer: this.frameInfo } },
      ],
    });
    this.transformBindGroup = device.createBindGroup({
      label: "transform",
      layout: ctx.transformPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: this.transformParams } },
        { binding: 2, resource: { buffer: this.mag } },
        { binding: 3, resource: { buffer: this.phase } },
        { binding: 4, resource: { buffer: this.env } },
        { binding: 5, resource: { buffer: this.frameInfo } },
        { binding: 6, resource: { buffer: this.styleShape } },
        { binding: 7, resource: { buffer: this.userShape } },
        { binding: 8, resource: { buffer: this.pvState } },
        { binding: 9, resource: { buffer: this.outSpec } },
      ],
    });
    this.synthesizeBindGroup = device.createBindGroup({
      label: "synthesize",
      layout: ctx.synthesizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ctx.twiddles } },
        { binding: 1, resource: { buffer: this.outSpec } },
        { binding: 2, resource: { buffer: this.outFrames } },
      ],
    });

    this.resetState();
  }

  /** Zero the phase-vocoder state (call when the input stream restarts). */
  resetState() {
    this.device.queue.writeBuffer(this.pvState, 0, new Float32Array(PV_STATE_FLOATS));
  }

  setStyleShape(shape: F32 | null) {
    this.hasStyleShape = !!shape && shape.length === HALF_BINS;
    if (shape && this.hasStyleShape) this.device.queue.writeBuffer(this.styleShape, 0, shape);
  }

  setUserShape(shape: F32 | null) {
    this.hasUserShape = !!shape && shape.length === HALF_BINS;
    if (shape && this.hasUserShape) this.device.queue.writeBuffer(this.userShape, 0, shape);
  }

  private writeAnalyzeParams(count: number, sampleRate: number) {
    const u = new Uint32Array(this.analyzeParamsData);
    const f = new Float32Array(this.analyzeParamsData);
    u[0] = count;
    f[1] = sampleRate;
    f[2] = F0_MIN;
    f[3] = F0_MAX;
    this.device.queue.writeBuffer(this.analyzeParams, 0, this.analyzeParamsData);
  }

  private writeTransformParams(count: number, sampleRate: number, p: TransformParams) {
    const u = new Uint32Array(this.transformParamsData);
    const f = new Float32Array(this.transformParamsData);
    u[0] = count;
    u[1] = HOP_SIZE;
    f[2] = p.pitchRatio;
    f[3] = p.formantRatio;
    f[4] = p.timbreStrength;
    f[5] = p.intonation;
    f[6] = p.styleF0;
    f[7] = p.userF0;
    f[8] = sampleRate;
    f[9] = p.gateDb;
    f[10] = p.outputGain;
    f[11] = p.gateDepth;
    u[12] = this.hasStyleShape ? 1 : 0;
    u[13] = this.hasUserShape ? 1 : 0;
    f[14] = p.breath;
    u[15] = 0;
    this.device.queue.writeBuffer(this.transformParams, 0, this.transformParamsData);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** Analysis only: spectral envelope + pitch for `count` frames. */
  analyze(frames: F32, count: number, sampleRate: number): Promise<AnalyzeResult> {
    return this.run(async () => {
      this.assertUsable(count, frames);
      this.device.queue.writeBuffer(this.frames, 0, frames, 0, count * FFT_SIZE);
      this.writeAnalyzeParams(count, sampleRate);

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.ctx.analyzePipeline);
      pass.setBindGroup(0, this.analyzeBindGroup);
      pass.dispatchWorkgroups(count);
      pass.end();
      encoder.copyBufferToBuffer(this.frameInfo, 0, this.staging, this.infoOffset, count * FRAME_INFO_FLOATS * 4);
      encoder.copyBufferToBuffer(this.env, 0, this.staging, this.envOffset, count * HALF_BINS * 4);
      this.device.queue.submit([encoder.finish()]);

      const end = this.envOffset + count * HALF_BINS * 4;
      await this.staging.mapAsync(GPUMapMode.READ, 0, end);
      const info = new Float32Array(
        this.staging.getMappedRange(this.infoOffset, count * FRAME_INFO_FLOATS * 4).slice(0),
      );
      const env = new Float32Array(this.staging.getMappedRange(this.envOffset, count * HALF_BINS * 4).slice(0));
      this.staging.unmap();
      return { count, info, env };
    });
  }

  /** Full chain: analyze -> transform -> synthesize for `count` frames. */
  process(frames: F32, count: number, sampleRate: number, params: TransformParams): Promise<ProcessResult> {
    return this.run(async () => {
      this.assertUsable(count, frames);
      this.device.queue.writeBuffer(this.frames, 0, frames, 0, count * FFT_SIZE);
      this.writeAnalyzeParams(count, sampleRate);
      this.writeTransformParams(count, sampleRate, params);

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.ctx.analyzePipeline);
      pass.setBindGroup(0, this.analyzeBindGroup);
      pass.dispatchWorkgroups(count);
      pass.setPipeline(this.ctx.transformPipeline);
      pass.setBindGroup(0, this.transformBindGroup);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(this.ctx.synthesizePipeline);
      pass.setBindGroup(0, this.synthesizeBindGroup);
      pass.dispatchWorkgroups(count);
      pass.end();
      encoder.copyBufferToBuffer(this.outFrames, 0, this.staging, 0, count * FFT_SIZE * 4);
      encoder.copyBufferToBuffer(this.frameInfo, 0, this.staging, this.infoOffset, count * FRAME_INFO_FLOATS * 4);
      encoder.copyBufferToBuffer(this.env, 0, this.staging, this.envOffset, count * HALF_BINS * 4);
      this.device.queue.submit([encoder.finish()]);

      const end = this.envOffset + count * HALF_BINS * 4;
      await this.staging.mapAsync(GPUMapMode.READ, 0, end);
      const out = new Float32Array(this.staging.getMappedRange(0, count * FFT_SIZE * 4).slice(0));
      const info = new Float32Array(
        this.staging.getMappedRange(this.infoOffset, count * FRAME_INFO_FLOATS * 4).slice(0),
      );
      const env = new Float32Array(this.staging.getMappedRange(this.envOffset, count * HALF_BINS * 4).slice(0));
      this.staging.unmap();
      return { count, out, info, env };
    });
  }

  private assertUsable(count: number, frames: F32) {
    if (this.destroyed) throw new Error("VoicePipeline 已被釋放");
    if (count < 1 || count > this.maxFrames) {
      throw new Error(`frame count ${count} 超出範圍 (1..${this.maxFrames})`);
    }
    if (frames.length < count * FFT_SIZE) {
      throw new Error("frames 緩衝區長度不足");
    }
  }

  destroy() {
    this.destroyed = true;
    for (const b of [
      this.frames,
      this.analyzeParams,
      this.mag,
      this.phase,
      this.env,
      this.frameInfo,
      this.transformParams,
      this.styleShape,
      this.userShape,
      this.pvState,
      this.outSpec,
      this.outFrames,
      this.staging,
    ]) {
      b.destroy();
    }
  }
}
