"use client";

import { useEffect, useRef } from "react";

interface PitchTrackChartProps {
  f0Track: ArrayLike<number> | null;
  rmsTrackDb?: ArrayLike<number> | null;
  medianF0?: number;
  color: string;
  className?: string;
}

const MIN_HZ = 55;
const MAX_HZ = 900;

/** Plots the extracted per-frame pitch contour (log axis) with an energy strip. */
export function PitchTrackChart({ f0Track, rmsTrackDb, medianF0, color, className }: PitchTrackChartProps) {
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

    const yForHz = (hz: number) => {
      const t = (Math.log(hz) - Math.log(MIN_HZ)) / (Math.log(MAX_HZ) - Math.log(MIN_HZ));
      return h - 4 * dpr - t * (h - 8 * dpr);
    };

    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = `${9 * dpr}px ui-monospace, monospace`;
    ctx.textBaseline = "top";
    for (const hz of [80, 120, 200, 300, 500, 800]) {
      const y = yForHz(hz);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${hz}`, 3 * dpr, y + 2 * dpr);
    }

    if (!f0Track || f0Track.length === 0) return;
    const n = f0Track.length;

    if (rmsTrackDb) {
      for (let i = 0; i < n; i++) {
        const db = rmsTrackDb[i];
        const v = Math.max(0, Math.min(1, (db + 60) / 60));
        ctx.fillStyle = `rgba(255,255,255,${0.04 + v * 0.1})`;
        ctx.fillRect((i / n) * w, 0, Math.max(1, w / n), h);
      }
    }

    if (medianF0 && medianF0 > 0) {
      const y = yForHz(medianF0);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = color;
    const r = Math.max(1.2 * dpr, Math.min(2.4 * dpr, (w / n) * 0.6));
    for (let i = 0; i < n; i++) {
      const f0 = f0Track[i];
      if (!(f0 > 0)) continue;
      const x = ((i + 0.5) / n) * w;
      const y = yForHz(Math.max(MIN_HZ, Math.min(MAX_HZ, f0)));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [f0Track, rmsTrackDb, medianF0, color]);

  return <canvas ref={ref} className={className} aria-label="音高軌跡" />;
}
