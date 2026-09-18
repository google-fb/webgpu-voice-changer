/**
 * WGSL compute kernels for the voice changer.
 *
 * All kernels share a 2048-point radix-2 FFT that runs entirely inside one
 * workgroup using `re`/`im` workgroup arrays (2 x 2048 x f32 = 16 KiB, which is
 * exactly the WebGPU default `maxComputeWorkgroupStorageSize`). Because there
 * is no room left for extra shared scalars, small cross-thread values are
 * exchanged through storage buffers instead.
 *
 * Kernel overview (one hop = one STFT frame):
 *   analyze    : Hann window -> FFT -> |X|, arg X
 *                -> NCCF pitch tracking on a decimated copy -> F0 + voicing
 *                -> cepstral smoothing of log|X| -> spectral envelope
 *   transform  : phase-vocoder pitch shift of the harmonic fine structure with
 *                identity phase locking, formant warp, timbre transfer
 *                (style envelope - user envelope), breath, noise gate and
 *                per-frame level matching (sequential over frames)
 *   synthesize : Hermitian mirror -> IFFT -> Hann synthesis window
 */

const PRELUDE_COMMON = /* wgsl */ `
const N: u32 = 2048u;
const LOGN: u32 = 11u;
const HALF: u32 = 1025u;
const WG: u32 = 256u;
const PI: f32 = 3.14159265358979;
const TWO_PI: f32 = 6.28318530717959;
const LOG10_E: f32 = 0.43429448190325;

var<workgroup> re: array<f32, 2048>;
var<workgroup> im: array<f32, 2048>;

fn bitrev(x: u32) -> u32 {
  return reverseBits(x) >> (32u - LOGN);
}

fn hann(n: u32) -> f32 {
  return 0.5 - 0.5 * cos(TWO_PI * f32(n) / f32(N));
}
`;

const PRELUDE_FFT = /* wgsl */ `
@group(0) @binding(0) var<storage, read> twiddles: array<vec2<f32>>;

// In-place iterative radix-2 DIT FFT over the workgroup arrays. Input must be
// stored in bit-reversed order; output is in natural order. The inverse
// transform conjugates the twiddles and scales by 1/N.
fn fft_inplace(lid: u32, inverse: bool) {
  var len = 2u;
  loop {
    if (len > N) { break; }
    let halfLen = len >> 1u;
    let tstep = N / len;
    for (var b = lid; b < N / 2u; b += WG) {
      let group = b / halfLen;
      let pos = b - group * halfLen;
      let i0 = group * len + pos;
      let i1 = i0 + halfLen;
      let tw = twiddles[pos * tstep];
      let wr = tw.x;
      var wi = tw.y;
      if (inverse) { wi = -wi; }
      let xr = re[i1];
      let xi = im[i1];
      let tr = xr * wr - xi * wi;
      let ti = xr * wi + xi * wr;
      let ur = re[i0];
      let ui = im[i0];
      re[i0] = ur + tr;
      im[i0] = ui + ti;
      re[i1] = ur - tr;
      im[i1] = ui - ti;
    }
    workgroupBarrier();
    len = len << 1u;
  }
  if (inverse) {
    let s = 1.0 / f32(N);
    for (var i = lid; i < N; i += WG) {
      re[i] = re[i] * s;
      im[i] = im[i] * s;
    }
    workgroupBarrier();
  }
}
`;

export const ANALYZE_SHADER = /* wgsl */ `
${PRELUDE_COMMON}
${PRELUDE_FFT}

struct AnalyzeParams {
  frameCount: u32,
  sampleRate: f32,
  f0Min: f32,
  f0Max: f32,
}

@group(0) @binding(1) var<uniform> params: AnalyzeParams;
@group(0) @binding(2) var<storage, read> frames: array<f32>;
@group(0) @binding(3) var<storage, read_write> mag: array<f32>;
@group(0) @binding(4) var<storage, read_write> phase: array<f32>;
@group(0) @binding(5) var<storage, read_write> env: array<f32>;
@group(0) @binding(6) var<storage, read_write> frameInfo: array<vec4<f32>>;

// Pitch tracking works on a 2x decimated copy of the raw frame (M samples at
// fs/2) using the normalised cross-correlation function (NCCF, as in RAPT):
// exact linear correlation with per-lag energy normalisation, so there is no
// window bias and no circular wrap-around to create spurious sub-harmonics.
const M: u32 = 1024u;
const MAX_LAGS_PER_THREAD: u32 = 4u;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lidv: vec3<u32>) {
  let f = wid.x;
  let lid = lidv.x;
  let base = f * HALF;

  // --- 1. windowed frame -> spectrum -------------------------------------
  for (var n = lid; n < N; n += WG) {
    let r = bitrev(n);
    re[r] = frames[f * N + n] * hann(n);
    im[r] = 0.0;
  }
  workgroupBarrier();
  fft_inplace(lid, false);

  for (var k = lid; k < HALF; k += WG) {
    let a = re[k];
    let b = im[k];
    mag[base + k] = sqrt(a * a + b * b);
    phase[base + k] = atan2(b, a);
  }
  // DC estimate from the windowed sum (sum of the Hann window is N/2).
  let dc = re[0] / f32(N / 2u);
  workgroupBarrier();

  // --- 2. decimated, DC-free copy of the raw frame + energy ----------------
  var energy = 0.0;
  for (var m = lid; m < M; m += WG) {
    let a = frames[f * N + 2u * m] - dc;
    let b = frames[f * N + 2u * m + 1u] - dc;
    re[m] = 0.5 * (a + b);
    energy += a * a + b * b;
  }
  workgroupBarrier();

  // --- 3. NCCF over the candidate lag range --------------------------------
  let fsD = params.sampleRate * 0.5;
  let lagMin = max(u32(fsD / params.f0Max), 4u);
  let lagMax = min(u32(fsD / params.f0Min), M / 2u - 2u);
  var rr: array<f32, MAX_LAGS_PER_THREAD>;
  for (var i = 0u; i < MAX_LAGS_PER_THREAD; i++) {
    let t = lagMin + lid + i * WG;
    var r = -1.0;
    if (t <= lagMax) {
      var cross = 0.0;
      var e1 = 0.0;
      var e2 = 0.0;
      let count = M - t;
      for (var n = 0u; n < count; n++) {
        let a = re[n];
        let b = re[n + t];
        cross += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      r = cross / sqrt(e1 * e2 + 1e-12);
    }
    rr[i] = r;
  }
  workgroupBarrier();
  for (var i = 0u; i < MAX_LAGS_PER_THREAD; i++) {
    let t = lagMin + lid + i * WG;
    if (t <= lagMax) { im[t] = rr[i]; }
  }
  im[M + lid] = energy;
  workgroupBarrier();

  // --- 4. peak picking (single thread, ~400 lags) --------------------------
  if (lid == 0u) {
    var bestStrength = -10.0;
    var bestLag = 0u;
    var bestVal = 0.0;
    var prev = -1.0;
    var cur = im[lagMin];
    for (var t = lagMin; t <= lagMax; t++) {
      var next = -1.0;
      if (t < lagMax) { next = im[t + 1u]; }
      if (cur > prev && cur >= next && cur > 0.3) {
        // Preference for shorter lags (higher pitch) breaks the tie between a
        // period and its multiples, suppressing octave-down errors.
        let strength = cur - 0.05 * log2(f32(t) * params.f0Min / fsD);
        if (strength > bestStrength) {
          bestStrength = strength;
          bestLag = t;
          bestVal = cur;
        }
      }
      prev = cur;
      cur = next;
    }
    var f0 = 0.0;
    var clarity = 0.0;
    if (bestLag > 0u) {
      var ym = bestVal;
      var yp = bestVal;
      if (bestLag > lagMin) { ym = im[bestLag - 1u]; }
      if (bestLag < lagMax) { yp = im[bestLag + 1u]; }
      let denom = ym - 2.0 * bestVal + yp;
      var delta = 0.0;
      if (abs(denom) > 1e-9) { delta = clamp(0.5 * (ym - yp) / denom, -1.0, 1.0); }
      let lag = f32(bestLag) + delta;
      clarity = clamp(bestVal, 0.0, 1.0);
      if (clarity > 0.5) { f0 = fsD / lag; }
    }
    var total = 0.0;
    for (var i = 0u; i < WG; i++) { total += im[M + i]; }
    let rms = sqrt(total / f32(N));
    // Cepstral lifter length: below the pitch period so harmonics are smoothed
    // out but formants are kept.
    let fs = params.sampleRate;
    var lifter = fs / 400.0;
    if (f0 > 0.0) { lifter = clamp(0.7 * fs / f0, 32.0, 512.0); }
    frameInfo[f] = vec4<f32>(f0, rms, clarity, lifter);
  }
  storageBarrier();
  workgroupBarrier();
  let lifterLen = frameInfo[f].w;

  // --- 5. spectral envelope by cepstral smoothing of log|X| --------------
  for (var k = lid; k < N; k += WG) {
    var kk = k;
    if (k > N / 2u) { kk = N - k; }
    let r = bitrev(k);
    re[r] = log(max(mag[base + kk], 1e-7));
    im[r] = 0.0;
  }
  workgroupBarrier();
  fft_inplace(lid, false);

  for (var q = lid; q < N; q += WG) {
    let d = f32(min(q, N - q));
    var w = 0.0;
    let t = d / lifterLen;
    if (t <= 0.7) { w = 1.0; }
    else if (t < 1.0) { w = 0.5 + 0.5 * cos(PI * (t - 0.7) / 0.3); }
    im[q] = re[q] * w;
  }
  workgroupBarrier();
  for (var q = lid; q < N; q += WG) { re[bitrev(q)] = im[q]; }
  workgroupBarrier();
  for (var q = lid; q < N; q += WG) { im[q] = 0.0; }
  workgroupBarrier();
  fft_inplace(lid, true);

  for (var k = lid; k < HALF; k += WG) {
    env[base + k] = re[k];
  }
}
`;

export const TRANSFORM_SHADER = /* wgsl */ `
${PRELUDE_COMMON}

struct TransformParams {
  frameCount: u32,
  hop: u32,
  pitchRatio: f32,
  formantRatio: f32,
  timbreStrength: f32,
  intonation: f32,
  styleF0: f32,
  userF0: f32,
  sampleRate: f32,
  gateDb: f32,
  outputGain: f32,
  gateDepth: f32,
  hasStyleShape: u32,
  hasUserShape: u32,
  breath: f32,
  _pad: u32,
}

@group(0) @binding(1) var<uniform> params: TransformParams;
@group(0) @binding(2) var<storage, read> mag: array<f32>;
@group(0) @binding(3) var<storage, read> phase: array<f32>;
@group(0) @binding(4) var<storage, read> env: array<f32>;
@group(0) @binding(5) var<storage, read> frameInfo: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> styleShape: array<f32>;
@group(0) @binding(7) var<storage, read> userShape: array<f32>;
@group(0) @binding(8) var<storage, read_write> pvState: array<f32>;
@group(0) @binding(9) var<storage, read_write> outSpec: array<vec2<f32>>;

const BINS_PER_THREAD: u32 = 5u;
const PEAK_SPLIT: u32 = 1023u;

// Shared-memory layout (16 KiB total, see PRELUDE_COMMON):
//   re[0 .. HALF)          instantaneous frequency of each source bin (in bins)
//   re[HALF .. 2048)       peak index of source bins 0 .. 1022
//   im[0 .. HALF)          accumulated phase correction per output bin (psi)
//   im[HALF .. HALF + 2)   peak index of source bins 1023 .. 1024
fn ld_peak(j: u32) -> u32 {
  if (j < PEAK_SPLIT) { return u32(re[HALF + j]); }
  return u32(im[HALF + (j - PEAK_SPLIT)]);
}
fn st_peak(j: u32, p: u32) {
  if (j < PEAK_SPLIT) { re[HALF + j] = f32(p); } else { im[HALF + (j - PEAK_SPLIT)] = f32(p); }
}

fn sample_env(base: u32, pos: f32) -> f32 {
  let p = clamp(pos, 0.0, f32(HALF - 1u));
  let i0 = u32(floor(p));
  let i1 = min(i0 + 1u, HALF - 1u);
  return mix(env[base + i0], env[base + i1], p - f32(i0));
}

fn sample_user_shape(pos: f32) -> f32 {
  let p = clamp(pos, 0.0, f32(HALF - 1u));
  let i0 = u32(floor(p));
  let i1 = min(i0 + 1u, HALF - 1u);
  return mix(userShape[i0], userShape[i1], p - f32(i0));
}

fn wrap_pi(x: f32) -> f32 {
  return x - TWO_PI * round(x / TWO_PI);
}

// Climb the magnitude spectrum to the local maximum that "owns" bin j
// (its region of influence, Laroche & Dolson identity phase locking).
fn find_peak(base: u32, j: u32) -> u32 {
  var p = j;
  for (var s = 0u; s < 6u; s++) {
    let m = mag[base + p];
    var up = -1.0;
    var dn = -1.0;
    if (p + 1u < HALF) { up = mag[base + p + 1u]; }
    if (p > 0u) { dn = mag[base + p - 1u]; }
    if (up > m && up >= dn) { p = p + 1u; }
    else if (dn > m) { p = p - 1u; }
    else { break; }
  }
  return p;
}

// Bin-scaling a spectrum also scales the analysis window in time by 1/ratio.
// This returns the mean of (time-scaled Hann) * (synthesis Hann) over a frame,
// which is 3/8 for ratio 1; together with a sqrt(ratio) term it keeps the
// overlap-add level constant regardless of the pitch ratio.
fn ola_energy(ratio: f32) -> f32 {
  var acc = 0.0;
  for (var i = 0u; i < 64u; i++) {
    let t = (f32(i) + 0.5) / 64.0;
    let u = ratio * (t - 0.5) + 0.5;
    var wr = 0.0;
    if (u > 0.0 && u < 1.0) {
      let su = sin(PI * u);
      wr = su * su;
    }
    let st = sin(PI * t);
    acc += wr * st * st;
  }
  return max(acc / 64.0, 0.05);
}

fn hash(x: u32) -> f32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967295.0;
}

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lidv: vec3<u32>) {
  let lid = lidv.x;
  let expct = TWO_PI * f32(params.hop) / f32(N);
  let binHz = params.sampleRate / f32(N);

  var lastPh: array<f32, BINS_PER_THREAD>;
  var psiLocal: array<f32, BINS_PER_THREAD>;
  for (var i = 0u; i < BINS_PER_THREAD; i++) {
    let k = lid + i * WG;
    if (k < HALF) {
      lastPh[i] = pvState[k];
      im[k] = pvState[HALF + k];
    }
  }
  var lastRatio = pvState[2u * HALF];
  var frameSeed = u32(pvState[2u * HALF + 1u]);
  var initialised = pvState[2u * HALF + 2u] > 0.5;
  if (lastRatio <= 0.0) { lastRatio = params.pitchRatio; }
  workgroupBarrier();

  for (var f = 0u; f < params.frameCount; f++) {
    let base = f * HALF;
    let info = frameInfo[f];
    let f0 = info.x;

    // Pitch ratio for this frame. pitchRatio already equals
    // styleF0 / userF0 * manual offset; intonation != 1 rescales how far the
    // speaker's own pitch excursions are carried into the target voice.
    var targetRatio = params.pitchRatio;
    if (f0 > 0.0 && params.styleF0 > 0.0 && params.userF0 > 0.0) {
      targetRatio = params.pitchRatio * pow(f0 / params.userF0, params.intonation - 1.0);
    }
    targetRatio = clamp(targetRatio, 0.25, 4.0);
    var alpha = 0.35;
    if (f0 <= 0.0) { alpha = 0.1; }
    let ratio = mix(lastRatio, targetRatio, alpha);
    lastRatio = ratio;

    let rmsDb = 20.0 * log(max(info.y, 1e-6)) * LOG10_E;
    let gate = smoothstep(params.gateDb - 6.0, params.gateDb + 6.0, rmsDb);
    let gain = params.outputGain * mix(params.gateDepth, 1.0, gate);
    frameSeed = frameSeed + 1u;

    // (a) per source bin: instantaneous frequency (in bins) and owning peak.
    for (var i = 0u; i < BINS_PER_THREAD; i++) {
      let j = lid + i * WG;
      if (j < HALF) {
        let ph = phase[base + j];
        var d = ph - lastPh[i];
        lastPh[i] = ph;
        d = wrap_pi(d - f32(j) * expct);
        re[j] = f32(j) + d / expct;
        st_peak(j, find_peak(base, j));
      }
    }
    workgroupBarrier();

    // (b) per output bin: phase correction. Every bin inherits the accumulated
    //     correction of its peak's output bin and adds the peak's extra phase
    //     advance due to frequency scaling, so a whole harmonic lobe moves as a
    //     unit (identity phase locking). On the first frame after a reset the
    //     previous phases are unknown, so no correction is accumulated.
    for (var i = 0u; i < BINS_PER_THREAD; i++) {
      let k = lid + i * WG;
      if (k < HALF) {
        let p = f32(k) / ratio;
        var psi = 0.0;
        if (p < f32(HALF - 1u)) {
          let j0 = u32(floor(p));
          var jn = j0;
          if (p - f32(j0) > 0.5) { jn = j0 + 1u; }
          let jp = ld_peak(jn);
          let kp = min(u32(round(f32(jp) * ratio)), HALF - 1u);
          var inc = re[jp] * (ratio - 1.0) * expct;
          if (!initialised) { inc = 0.0; }
          psi = wrap_pi(im[kp] + inc);
        }
        psiLocal[i] = psi;
      }
    }
    workgroupBarrier();
    for (var i = 0u; i < BINS_PER_THREAD; i++) {
      let k = lid + i * WG;
      if (k < HALF) { im[k] = psiLocal[i]; }
    }

    // (c) per output bin: gather the shifted harmonic fine structure, impose the
    //     target envelope and synthesise. The +/- PI parity term re-references
    //     the window to zero phase so a stretched lobe stays coherent.
    var eIn = 0.0;
    var eOut = 0.0;
    for (var i = 0u; i < BINS_PER_THREAD; i++) {
      let k = lid + i * WG;
      if (k < HALF) {
        var out = vec2<f32>(0.0, 0.0);
        let p = f32(k) / ratio;
        let mk = mag[base + k];
        eIn += mk * mk;
        if (k > 0u && k < HALF - 1u && p < f32(HALF - 1u)) {
          let j0 = u32(floor(p));
          let fr = p - f32(j0);
          var jn = j0;
          if (fr > 0.5) { jn = j0 + 1u; }
          let fine0 = mag[base + j0] * exp(-env[base + j0]);
          let fine1 = mag[base + j0 + 1u] * exp(-env[base + j0 + 1u]);
          var fine = mix(fine0, fine1, fr);

          let kw = f32(k) / params.formantRatio;
          var envT = sample_env(base, kw);
          if (params.hasStyleShape == 1u) {
            var user = 0.0;
            if (params.hasUserShape == 1u) { user = sample_user_shape(kw); }
            envT = envT + params.timbreStrength * (styleShape[k] - user);
          }

          if (params.breath > 0.0) {
            // Breathiness: blend in a noisy replica of the fine structure so
            // the upper band sounds airy rather than purely harmonic.
            let hz = f32(k) * binHz;
            let air = smoothstep(1500.0, 5000.0, hz) * params.breath;
            let noise = hash(k * 2654435761u + frameSeed * 40503u) * 2.0 - 1.0;
            fine = fine * (1.0 + air * noise * 1.5);
          }

          let lowcut = smoothstep(50.0, 90.0, f32(k) * binHz);
          let outMag = fine * exp(envT) * lowcut;
          eOut += outMag * outMag;
          var flip = 0.0;
          if (((k + jn) & 1u) == 1u) { flip = PI; }
          let phOut = phase[base + jn] + flip + psiLocal[i];
          out = vec2<f32>(outMag * cos(phOut), outMag * sin(phOut));
        }
        outSpec[base + k] = out;
      }
    }
    workgroupBarrier();

    // (d) match the frame energy to the input so that pitch ratio and timbre
    //     transfer do not change loudness, then apply gate / output gain.
    //     re[] is free at this point; im[] still holds psi.
    re[lid] = eIn;
    re[WG + lid] = eOut;
    workgroupBarrier();
    if (lid == 0u) {
      var sIn = 0.0;
      var sOut = 0.0;
      for (var i = 0u; i < WG; i++) {
        sIn += re[i];
        sOut += re[WG + i];
      }
      var scale = 1.0;
      if (sOut > 1e-12) { scale = clamp(sqrt(sIn / sOut), 0.25, 4.0); }
      re[0] = scale;
    }
    workgroupBarrier();
    // sqrt(ratio): the energy match above sets the frame energy, but the
    // time-scaled window spreads that energy over 1/ratio of the frame.
    let frameGain = re[0] * gain * (0.375 / (ola_energy(ratio) * sqrt(ratio)));
    for (var i = 0u; i < BINS_PER_THREAD; i++) {
      let k = lid + i * WG;
      if (k < HALF) { outSpec[base + k] = outSpec[base + k] * frameGain; }
    }
    initialised = true;
    workgroupBarrier();
  }

  for (var i = 0u; i < BINS_PER_THREAD; i++) {
    let k = lid + i * WG;
    if (k < HALF) {
      pvState[k] = lastPh[i];
      pvState[HALF + k] = im[k];
    }
  }
  if (lid == 0u) {
    pvState[2u * HALF] = lastRatio;
    pvState[2u * HALF + 1u] = f32(frameSeed % 1048576u);
    pvState[2u * HALF + 2u] = 1.0;
  }
}
`;

export const SYNTHESIZE_SHADER = /* wgsl */ `
${PRELUDE_COMMON}
${PRELUDE_FFT}

@group(0) @binding(1) var<storage, read> outSpec: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> outFrames: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lidv: vec3<u32>) {
  let f = wid.x;
  let lid = lidv.x;
  let base = f * HALF;

  for (var k = lid; k < N; k += WG) {
    var v: vec2<f32>;
    if (k <= N / 2u) {
      v = outSpec[base + k];
    } else {
      let c = outSpec[base + (N - k)];
      v = vec2<f32>(c.x, -c.y);
    }
    let r = bitrev(k);
    re[r] = v.x;
    im[r] = v.y;
  }
  workgroupBarrier();
  fft_inplace(lid, true);

  // Hann synthesis window; with 75% overlap the analysis*synthesis windows sum
  // to 1.5, hence the 2/3 normalisation.
  for (var n = lid; n < N; n += WG) {
    outFrames[f * N + n] = re[n] * hann(n) * (2.0 / 3.0);
  }
}
`;
