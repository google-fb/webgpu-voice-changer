"use client";

import { Download, FileAudio, Loader2, Play, Square, Upload, Wand2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { EngineState, VoiceEngine } from "@/lib/audio/engine";
import { decodeAudioFile, normalizePeak } from "@/lib/audio/decode";
import { downloadBlob, encodeWav } from "@/lib/audio/wav";
import type { F32 } from "@/lib/dsp/gpu-pipeline";
import type { VoiceControls } from "@/lib/dsp/protocol";
import type { VoiceStyle } from "@/lib/voice/styles";

interface Clip {
  samples: F32;
  sampleRate: number;
  name: string;
}

interface AuditionPanelProps {
  engine: VoiceEngine;
  state: EngineState;
  style: VoiceStyle;
  controls: VoiceControls;
  calibrationClip: { samples: F32; sampleRate: number } | null;
}

export function AuditionPanel({ engine, state, style, controls, calibrationClip }: AuditionPanelProps) {
  const [source, setSource] = useState<Clip | null>(null);
  const [rendered, setRendered] = useState<Clip | null>(null);
  const [renderedFor, setRenderedFor] = useState<string>("");
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState<"source" | "rendered" | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const controlsKey = JSON.stringify({ controls, styleId: style.id });
  const stale = !!rendered && renderedFor !== controlsKey;

  const onFile = useCallback(
    async (file: File) => {
      try {
        const decoded = await decodeAudioFile(file, state.sampleRate || 48000, file.name);
        normalizePeak(decoded.samples);
        setSource({ samples: decoded.samples, sampleRate: decoded.sampleRate, name: decoded.name });
        setRendered(null);
      } catch (e) {
        toast.error("無法解碼這個音訊檔", { description: e instanceof Error ? e.message : String(e) });
      }
    },
    [state.sampleRate],
  );

  const useCalibration = useCallback(() => {
    if (!calibrationClip) return;
    setSource({ samples: calibrationClip.samples, sampleRate: calibrationClip.sampleRate, name: "校正錄音" });
    setRendered(null);
  }, [calibrationClip]);

  const render = useCallback(async () => {
    if (!source) return;
    setRendering(true);
    setProgress(0);
    engine.stopPlayback();
    setPlaying(null);
    try {
      const t0 = performance.now();
      const result = await engine.renderClip(source.samples, source.sampleRate, controls, setProgress);
      const ms = performance.now() - t0;
      setRendered({ samples: result.samples, sampleRate: result.sampleRate, name: `${style.name}-${source.name}` });
      setRenderedFor(controlsKey);
      toast.success(`GPU 渲染完成（${(source.samples.length / source.sampleRate).toFixed(1)} 秒音訊，耗時 ${Math.round(ms)} ms）`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRendering(false);
    }
  }, [controls, controlsKey, engine, source, style.name]);

  const play = useCallback(
    async (which: "source" | "rendered") => {
      const clip = which === "source" ? source : rendered;
      if (!clip) return;
      if (playing === which) {
        engine.stopPlayback();
        setPlaying(null);
        return;
      }
      setPlaying(which);
      await engine.play(clip.samples, clip.sampleRate, () => setPlaying((p) => (p === which ? null : p)));
    },
    [engine, playing, rendered, source],
  );

  const download = useCallback(() => {
    if (!rendered) return;
    downloadBlob(encodeWav(rendered.samples, rendered.sampleRate), `${rendered.name.replace(/\.[^.]+$/, "")}.wav`);
  }, [rendered]);

  const gpuReady = state.gpuStatus === "ready";

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">離線試聽</h3>
        <p className="text-xs text-muted-foreground">
          沒有麥克風、或想仔細比較效果時，上傳一段你自己說話的錄音，用目前選取的風格與參數在 GPU 上一次渲染完成。
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.currentTarget.value = "";
          }}
        />
        <Button
          variant="outline"
          className="h-16 flex-col gap-1"
          disabled={!gpuReady || rendering}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void onFile(f);
          }}
        >
          <Upload className="size-4" />
          <span>上傳說話錄音</span>
        </Button>
        <Button variant="outline" className="h-16 flex-col gap-1" disabled={!calibrationClip || rendering} onClick={useCalibration}>
          <FileAudio className="size-4" />
          <span>{calibrationClip ? "使用剛才的校正錄音" : "先完成校正即可直接試聽"}</span>
        </Button>
      </div>

      {source && (
        <div className="space-y-3 rounded-xl border border-white/8 bg-white/[0.03] p-4">
          <div className="flex items-center justify-between gap-2 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <FileAudio className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{source.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {(source.samples.length / source.sampleRate).toFixed(1)} 秒
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => play("source")} className="gap-1.5">
              {playing === "source" ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
              原始
            </Button>
          </div>

          <Button onClick={render} disabled={rendering || !gpuReady} className="w-full gap-2">
            {rendering ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
            {rendering ? "GPU 渲染中…" : stale ? "參數已變更，重新渲染" : `以「${style.name}」渲染`}
          </Button>
          {rendering && <Progress value={progress * 100} className="h-1.5" />}

          {rendered && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/8 p-3" style={{ borderColor: `${style.color}55` }}>
              <span className="mr-auto text-sm">
                變聲結果
                {stale ? <span className="ml-2 text-xs text-muted-foreground">（參數已變更）</span> : null}
              </span>
              <Button size="sm" onClick={() => play("rendered")} className="gap-1.5" style={{ background: style.color, color: "#0b0b0f" }}>
                {playing === "rendered" ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                {playing === "rendered" ? "停止" : "播放"}
              </Button>
              <Button size="sm" variant="outline" onClick={download} className="gap-1.5">
                <Download className="size-3.5" />
                下載 WAV
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
