"use client";

import { useEffect, useRef } from "react";

interface SpectrumVisualizerProps {
  input: AnalyserNode | null;
  output: AnalyserNode | null;
  sampleRate: number;
  accent: string;
  active: boolean;
  className?: string;
}

const MIN_HZ = 60;
const MAX_HZ = 12000;

/**
 * Overlays the input (grey) and processed output (accent colour) magnitude
 * spectra on a log-frequency axis.
 */
export function SpectrumVisualizer({ input, output, sampleRate, accent, active, className }: SpectrumVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let inData: Uint8Array<ArrayBuffer> | null = null;
    let outData: Uint8Array<ArrayBuffer> | null = null;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    const xForHz = (hz: number, w: number) => {
      const t = (Math.log(hz) - Math.log(MIN_HZ)) / (Math.log(MAX_HZ) - Math.log(MIN_HZ));
      return t * w;
    };

    const drawSpectrum = (data: Uint8Array, w: number, h: number, color: string, fill: boolean) => {
      const binHz = sampleRate / 2 / data.length;
      ctx.beginPath();
      let started = false;
      for (let x = 0; x <= w; x += 2) {
        const t = x / w;
        const hz = Math.exp(Math.log(MIN_HZ) + t * (Math.log(MAX_HZ) - Math.log(MIN_HZ)));
        const bin = hz / binHz;
        const b0 = Math.min(data.length - 1, Math.floor(bin));
        const b1 = Math.min(data.length - 1, b0 + 1);
        const v = (data[b0] + (data[b1] - data[b0]) * (bin - b0)) / 255;
        const y = h - Math.pow(v, 1.2) * (h - 6) - 2;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6 * (window.devicePixelRatio || 1);
      ctx.lineJoin = "round";
      ctx.stroke();
      if (fill) {
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, hexToRgba(color, 0.35));
        grad.addColorStop(1, hexToRgba(color, 0.02));
        ctx.fillStyle = grad;
        ctx.fill();
      }
    };

    const drawGrid = (w: number, h: number) => {
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = `${10 * (window.devicePixelRatio || 1)}px ui-monospace, monospace`;
      ctx.textBaseline = "top";
      for (const hz of [100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = xForHz(hz, w);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
        ctx.fillText(label, x + 4 * (window.devicePixelRatio || 1), 4 * (window.devicePixelRatio || 1));
      }
    };

    const frame = () => {
      resize();
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      drawGrid(w, h);
      if (active && input) {
        if (!inData || inData.length !== input.frequencyBinCount) inData = new Uint8Array(input.frequencyBinCount);
        input.getByteFrequencyData(inData);
        drawSpectrum(inData, w, h, "rgba(255,255,255,0.35)", false);
      }
      if (active && output) {
        if (!outData || outData.length !== output.frequencyBinCount) outData = new Uint8Array(output.frequencyBinCount);
        output.getByteFrequencyData(outData);
        drawSpectrum(outData, w, h, accent, true);
      }
      if (!active) {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.font = `${12 * (window.devicePixelRatio || 1)}px ui-sans-serif, system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("啟動後會即時顯示輸入（灰）與輸出（彩色）頻譜", w / 2, h / 2);
        ctx.textAlign = "start";
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [input, output, sampleRate, accent, active]);

  return <canvas ref={canvasRef} className={className} aria-label="頻譜視覺化" />;
}

function hexToRgba(color: string, alpha: number): string {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4 ? color.slice(1).split("").map((c) => c + c).join("") : color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}
