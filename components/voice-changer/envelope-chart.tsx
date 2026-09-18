"use client";

import { useEffect, useRef } from "react";
import { FFT_SIZE } from "@/lib/dsp/constants";
import { LN_TO_DB } from "@/lib/dsp/features";

interface EnvelopeChartProps {
  /** Natural-log magnitude envelope, one value per FFT bin (HALF_BINS). */
  shape: ArrayLike<number> | null;
  sampleRate: number;
  color: string;
  /** Optional second curve (e.g. the speaker's own shape) drawn in grey. */
  reference?: ArrayLike<number> | null;
  className?: string;
  compact?: boolean;
}

const MIN_HZ = 80;
const MAX_HZ = 10000;
const RANGE_DB = 30;

/** Draws a spectral envelope shape on a log-frequency axis. */
export function EnvelopeChart({ shape, sampleRate, color, reference, className, compact }: EnvelopeChartProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const binHz = sampleRate / FFT_SIZE;
    const xForHz = (hz: number) =>
      ((Math.log(hz) - Math.log(MIN_HZ)) / (Math.log(MAX_HZ) - Math.log(MIN_HZ))) * w;
    const yForDb = (db: number) => h / 2 - (db / RANGE_DB) * (h / 2 - 4 * dpr);

    if (!compact) {
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = `${9 * dpr}px ui-monospace, monospace`;
      ctx.textBaseline = "bottom";
      for (const hz of [100, 200, 500, 1000, 2000, 5000]) {
        const x = xForHz(hz);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x + 3 * dpr, h - 2 * dpr);
      }
      for (const db of [-20, -10, 0, 10, 20]) {
        const y = yForDb(db);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.strokeStyle = db === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)";
        ctx.stroke();
      }
    } else {
      const y = yForDb(0);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const drawCurve = (data: ArrayLike<number>, stroke: string, fill: boolean) => {
      ctx.beginPath();
      let started = false;
      for (let x = 0; x <= w; x += 2) {
        const t = x / w;
        const hz = Math.exp(Math.log(MIN_HZ) + t * (Math.log(MAX_HZ) - Math.log(MIN_HZ)));
        const bin = Math.min(data.length - 1, hz / binHz);
        const b0 = Math.floor(bin);
        const b1 = Math.min(data.length - 1, b0 + 1);
        const v = data[b0] + (data[b1] - data[b0]) * (bin - b0);
        const db = Math.max(-RANGE_DB, Math.min(RANGE_DB, v * LN_TO_DB));
        const y = yForDb(db);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = (compact ? 1.5 : 2) * dpr;
      ctx.lineJoin = "round";
      ctx.stroke();
      if (fill) {
        ctx.lineTo(w, yForDb(0));
        ctx.lineTo(0, yForDb(0));
        ctx.closePath();
        ctx.fillStyle = stroke;
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };

    if (reference) drawCurve(reference, "rgba(255,255,255,0.4)", false);
    if (shape) drawCurve(shape, color, true);
  }, [shape, sampleRate, color, reference, compact]);

  return <canvas ref={ref} className={className} aria-label="頻譜包絡曲線" />;
}
