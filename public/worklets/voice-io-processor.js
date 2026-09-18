/**
 * AudioWorklet processor that bridges the audio thread and the DSP worker.
 *
 *  - Input render quanta (128 samples) are packed into `hop`-sized blocks and
 *    posted (transferred) to the DSP worker through a MessagePort handed over
 *    by the main thread.
 *  - Processed blocks coming back are written into a ring buffer and played
 *    out with a small jitter buffer. Underruns emit silence and re-arm the
 *    prefill so the buffer can recover.
 */
class VoiceIOProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.hop = opts.hop || 512;
    this.prefillBlocks = opts.prefillBlocks || 2;
    this.maxBufferedBlocks = opts.maxBufferedBlocks || 8;

    this.inBlock = new Float32Array(this.hop);
    this.inFill = 0;

    this.ringSize = this.hop * 64;
    this.ring = new Float32Array(this.ringSize);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.started = false;

    this.dsp = null;
    this.underruns = 0;
    this.sentBlocks = 0;
    this.receivedBlocks = 0;
    this.lastReport = currentTime;
    this.inputPeak = 0;
    this.outputPeak = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "connect") {
        this.dsp = msg.port;
        this.dsp.onmessage = (ev) => this.enqueueOutput(ev.data);
        this.reset();
      } else if (msg.type === "disconnect") {
        if (this.dsp) this.dsp.close();
        this.dsp = null;
        this.reset();
      } else if (msg.type === "tap") {
        // Capture raw (unprocessed) input for calibration / reference clips.
        this.tap = { buffer: new Float32Array(msg.samples), fill: 0, id: msg.id };
      } else if (msg.type === "cancelTap") {
        this.tap = null;
      }
    };
    this.tap = null;
  }

  captureTap(input) {
    const tap = this.tap;
    if (!tap) return;
    const remaining = tap.buffer.length - tap.fill;
    const n = Math.min(remaining, input.length);
    tap.buffer.set(input.subarray(0, n), tap.fill);
    tap.fill += n;
    if (tap.fill >= tap.buffer.length) {
      this.tap = null;
      this.port.postMessage({ type: "tap", id: tap.id, buffer: tap.buffer.buffer }, [tap.buffer.buffer]);
    }
  }

  reset() {
    this.inFill = 0;
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.started = false;
  }

  enqueueOutput(data) {
    const block = data instanceof Float32Array ? data : new Float32Array(data);
    this.receivedBlocks++;
    // Drop the oldest audio if the consumer stalled, to keep latency bounded.
    while (this.available + block.length > this.maxBufferedBlocks * this.hop) {
      const drop = Math.min(this.hop, this.available);
      this.readPos = (this.readPos + drop) % this.ringSize;
      this.available -= drop;
    }
    const first = Math.min(block.length, this.ringSize - this.writePos);
    this.ring.set(block.subarray(0, first), this.writePos);
    if (first < block.length) this.ring.set(block.subarray(first), 0);
    this.writePos = (this.writePos + block.length) % this.ringSize;
    this.available += block.length;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];

    if (input && this.tap) this.captureTap(input);

    if (input && this.dsp) {
      let peak = this.inputPeak;
      for (let i = 0; i < input.length; i++) {
        const v = input[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        this.inBlock[this.inFill++] = v;
        if (this.inFill === this.hop) {
          const block = this.inBlock;
          this.dsp.postMessage(block.buffer, [block.buffer]);
          this.sentBlocks++;
          this.inBlock = new Float32Array(this.hop);
          this.inFill = 0;
        }
      }
      this.inputPeak = peak;
    }

    if (output) {
      const n = output.length;
      if (!this.started && this.available >= this.prefillBlocks * this.hop) this.started = true;
      if (this.started && this.available >= n) {
        let peak = this.outputPeak;
        for (let i = 0; i < n; i++) {
          const v = this.ring[this.readPos];
          output[i] = v;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          this.readPos = (this.readPos + 1) % this.ringSize;
        }
        this.outputPeak = peak;
        this.available -= n;
      } else {
        output.fill(0);
        if (this.started) {
          this.underruns++;
          this.started = false;
        }
      }
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output);
    }

    if (currentTime - this.lastReport > 0.25) {
      this.lastReport = currentTime;
      this.port.postMessage({
        type: "stats",
        underruns: this.underruns,
        bufferedBlocks: this.available / this.hop,
        sentBlocks: this.sentBlocks,
        receivedBlocks: this.receivedBlocks,
        inputPeak: this.inputPeak,
        outputPeak: this.outputPeak,
        connected: !!this.dsp,
      });
      this.inputPeak = 0;
      this.outputPeak = 0;
    }
    return true;
  }
}

registerProcessor("voice-io-processor", VoiceIOProcessor);
