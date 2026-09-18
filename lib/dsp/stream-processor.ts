import { FFT_SIZE, HOP_SIZE } from "./constants";
import type { TransformParams, VoicePipeline } from "./gpu-pipeline";

export interface StreamResult {
  /** One HOP_SIZE block of output per input block, in order. */
  outputs: Float32Array[];
  info: Float32Array;
  env: Float32Array;
}

/**
 * Turns a sequence of HOP_SIZE input blocks into a sequence of HOP_SIZE output
 * blocks by maintaining the sliding analysis window and the overlap-add
 * accumulator around a `VoicePipeline`. Algorithmic latency is FFT_SIZE
 * samples.
 */
export class StreamProcessor {
  private readonly history = new Float32Array(FFT_SIZE);
  private readonly ola = new Float32Array(FFT_SIZE);

  constructor(
    private readonly pipeline: VoicePipeline,
    public sampleRate: number,
  ) {}

  reset() {
    this.history.fill(0);
    this.ola.fill(0);
    this.pipeline.resetState();
  }

  get maxBlocks() {
    return this.pipeline.maxFrames;
  }

  async process(blocks: Float32Array[], params: TransformParams): Promise<StreamResult> {
    const count = blocks.length;
    if (count === 0) return { outputs: [], info: new Float32Array(0), env: new Float32Array(0) };
    if (count > this.pipeline.maxFrames) throw new Error("too many blocks for one dispatch");

    const frames = new Float32Array(count * FFT_SIZE);
    for (let i = 0; i < count; i++) {
      this.history.copyWithin(0, HOP_SIZE);
      const block = blocks[i];
      if (block.length === HOP_SIZE) {
        this.history.set(block, FFT_SIZE - HOP_SIZE);
      } else {
        this.history.fill(0, FFT_SIZE - HOP_SIZE);
        this.history.set(block.subarray(0, HOP_SIZE), FFT_SIZE - HOP_SIZE);
      }
      frames.set(this.history, i * FFT_SIZE);
    }

    const result = await this.pipeline.process(frames, count, this.sampleRate, params);

    const outputs: Float32Array[] = [];
    const ola = this.ola;
    for (let i = 0; i < count; i++) {
      const base = i * FFT_SIZE;
      for (let n = 0; n < FFT_SIZE; n++) ola[n] += result.out[base + n];
      outputs.push(ola.slice(0, HOP_SIZE));
      ola.copyWithin(0, HOP_SIZE);
      ola.fill(0, FFT_SIZE - HOP_SIZE);
    }
    return { outputs, info: result.info, env: result.env };
  }
}
