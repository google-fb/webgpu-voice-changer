"use client";

import { FileAudio, Loader2, Mic, Play, Save, Square, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import type { EngineState, VoiceEngine } from "@/lib/audio/engine";
import { decodeAudioFile, normalizePeak } from "@/lib/audio/decode";
import { hzToNoteName, type VoiceFeatures } from "@/lib/dsp/features";
import type { F32 } from "@/lib/dsp/gpu-pipeline";
import type { UserVoiceProfile } from "@/lib/voice/profile";
import { newStyleId, STYLE_COLORS, type VoiceStyle } from "@/lib/voice/styles";
import { EnvelopeChart } from "./envelope-chart";
import { PitchTrackChart } from "./pitch-track-chart";

interface Clip {
  samples: F32;
  sampleRate: number;
  name: string;
}

interface CreateStylePanelProps {
  engine: VoiceEngine;
  state: EngineState;
  profile: UserVoiceProfile | null;
  onSave: (style: VoiceStyle) => void;
}

const RECORD_SECONDS = 8;

export function CreateStylePanel({ engine, state, profile, onSave }: CreateStylePanelProps) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [features, setFeatures] = useState<VoiceFeatures | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [recording, setRecording] = useState<{ startedAt: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [name, setName] = useState("");
  const [color, setColor] = useState(STYLE_COLORS[0]);
  const [playing, setPlaying] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setProgress(Math.min(1, (performance.now() - recording.startedAt) / (RECORD_SECONDS * 1000)));
    }, 100);
    return () => window.clearInterval(timer);
  }, [recording]);

  const analyze = useCallback(
    async (next: Clip) => {
      setClip(next);
      setFeatures(null);
      setAnalyzing(true);
      try {
        const result = await engine.analyzeClip(next.samples, next.sampleRate);
        setFeatures(result);
        if (!name) setName(next.name.replace(/\.[^.]+$/, "").slice(0, 24));
        if (result.voicedFrames < 10) {
          toast.warning("這段聲音幾乎沒有有聲片段", {
            description: "請使用清楚說話、沒有背景音樂的片段，效果才會準確。",
          });
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setAnalyzing(false);
      }
    },
    [engine, name],
  );

  const onFile = useCallback(
    async (file: File) => {
      try {
        const decoded = await decodeAudioFile(file, state.sampleRate || 48000, file.name);
        normalizePeak(decoded.samples);
        await analyze({ samples: decoded.samples, sampleRate: decoded.sampleRate, name: decoded.name });
      } catch (e) {
        toast.error("無法解碼這個音訊檔", { description: e instanceof Error ? e.message : String(e) });
      }
    },
    [analyze, state.sampleRate],
  );

  const record = useCallback(async () => {
    if (recording) {
      engine.cancelCapture();
      setRecording(null);
      return;
    }
    if (!state.running) {
      await engine.start();
      if (!engine.getState().running) {
        toast.error("需要先開啟麥克風才能錄製參考語音");
        return;
      }
    }
    setRecording({ startedAt: performance.now() });
    setProgress(0);
    try {
      const captured = await engine.captureInput(RECORD_SECONDS);
      normalizePeak(captured.samples);
      await analyze({ samples: captured.samples, sampleRate: captured.sampleRate, name: `錄音 ${new Date().toLocaleTimeString()}` });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRecording(null);
    }
  }, [analyze, engine, recording, state.running]);

  const togglePlay = useCallback(async () => {
    if (!clip) return;
    if (playing) {
      engine.stopPlayback();
      setPlaying(false);
      return;
    }
    setPlaying(true);
    await engine.play(clip.samples, clip.sampleRate, () => setPlaying(false));
  }, [clip, engine, playing]);

  const save = useCallback(() => {
    if (!features || !clip) return;
    const hasLead = features.medianF0 > 0;
    const userF0 = profile?.medianF0 || 0;
    // Higher voices usually come with a shorter vocal tract; start from a mild
    // formant shift derived from the pitch ratio and let the user fine-tune.
    const formantRatio =
      hasPitch && userF0 > 0 ? Math.max(0.8, Math.min(1.3, Math.pow(features.medianF0 / userF0, 0.3))) : 1;
    const style: VoiceStyle = {
      id: newStyleId(),
      name: name.trim() || "未命名風格",
      description: hasPitch
        ? `擷取自「${clip.name}」，中位音高 ${Math.round(features.medianF0)} Hz，亮度 ${features.brightnessDb >= 0 ? "+" : ""}${features.brightnessDb.toFixed(1)} dB。`
        : `擷取自「${clip.name}」（未偵測到穩定音高，僅套用音色）。`,
      color,
      kind: "extracted",
      pitch: hasPitch ? { mode: "targetF0", hz: features.medianF0 } : { mode: "semitones", semitones: 0 },
      formantRatio,
      timbreStrength: 0.75,
      intonation: 1,
      breath: 0,
      shape: { data: Array.from(features.shape), sampleRate: features.sampleRate },
      shapeRelative: false,
      features: {
        medianF0: features.medianF0,
        f0Low: features.f0Low,
        f0High: features.f0High,
        brightnessDb: features.brightnessDb,
        durationSec: features.durationSec,
        voicedFrames: features.voicedFrames,
        sourceName: clip.name,
      },
      createdAt: Date.now(),
    };
    onSave(style);
    toast.success(`已建立風格「${style.name}」`, { description: "已自動選取，開始講話試試看。" });
    setClip(null);
    setFeatures(null);
    setName("");
  }, [clip, color, features, name, onSave, profile?.medianF0]);

  const gpuReady = state.gpuStatus === "ready";

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">從角色語音建立風格</h3>
        <p className="text-xs text-muted-foreground">
          上傳或錄製 3–15 秒乾淨的角色語音（沒有背景音樂）。系統會在 GPU 上逐幀分析音高與頻譜包絡，濃縮成一個可即時套用的風格。
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/mp4,video/webm"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.currentTarget.value = "";
          }}
        />
        <Button
          variant="outline"
          className="h-20 flex-col gap-1.5"
          disabled={!gpuReady || analyzing || !!recording}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void onFile(f);
          }}
        >
          <Upload className="size-5" />
          <span>上傳音檔（可拖曳）</span>
          <span className="text-[11px] font-normal text-muted-foreground">mp3 / wav / m4a / ogg</span>
        </Button>
        <Button
          variant={recording ? "destructive" : "outline"}
          className="h-20 flex-col gap-1.5"
          disabled={!gpuReady || analyzing}
          onClick={record}
        >
          {recording ? <Square className="size-5" /> : <Mic className="size-5" />}
          <span>{recording ? "取消錄音" : `用麥克風錄 ${RECORD_SECONDS} 秒`}</span>
          <span className="text-[11px] font-normal text-muted-foreground">
            {recording ? "請對著麥克風播放或模仿角色語音" : "可搭配「立體聲混音」輸入裝置錄下播放中的影片"}
          </span>
        </Button>
      </div>

      {recording && <Progress value={progress * 100} className="h-1.5" />}

      {analyzing && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          GPU 分析中…（FFT、音高追蹤、倒頻譜包絡）
        </div>
      )}

      {clip && features && !analyzing && (
        <div className="space-y-4 rounded-xl border border-white/8 bg-white/[0.03] p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <FileAudio className="size-4 text-muted-foreground" />
              <span className="truncate font-medium">{clip.name}</span>
              <span className="text-xs text-muted-foreground">{features.durationSec.toFixed(1)} 秒</span>
            </div>
            <Button size="sm" variant="ghost" onClick={togglePlay} className="gap-1.5">
              {playing ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
              {playing ? "停止" : "試聽原始"}
            </Button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="中位音高" value={features.medianF0 > 0 ? `${Math.round(features.medianF0)} Hz` : "--"} sub={features.medianF0 > 0 ? hzToNoteName(features.medianF0) : "未偵測到"} color={color} />
            <Stat
              label="音域 (P10–P90)"
              value={features.medianF0 > 0 ? `${Math.round(features.f0Low)}–${Math.round(features.f0High)}` : "--"}
              sub="Hz"
            />
            <Stat
              label="亮度"
              value={`${features.brightnessDb >= 0 ? "+" : ""}${features.brightnessDb.toFixed(1)} dB`}
              sub={`有聲幀 ${features.voicedFrames}/${features.frameCount}`}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">頻譜包絡（音色指紋）{profile ? "，灰線為你的聲音" : ""}</div>
              <EnvelopeChart
                shape={features.shape}
                reference={profile?.shape ?? null}
                sampleRate={features.sampleRate}
                color={color}
                className="h-28 w-full rounded-lg bg-black/30"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">音高軌跡</div>
              <PitchTrackChart
                f0Track={features.f0Track}
                rmsTrackDb={features.rmsTrackDb}
                medianF0={features.medianF0}
                color={color}
                className="h-28 w-full rounded-lg bg-black/30"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="style-name">風格名稱</Label>
              <Input id="style-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：主角小蘭" maxLength={24} />
            </div>
            <div className="space-y-1.5">
              <Label>顏色</Label>
              <div className="flex flex-wrap gap-1.5">
                {STYLE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`選擇顏色 ${c}`}
                    onClick={() => setColor(c)}
                    className={`size-6 rounded-full border-2 transition ${color === c ? "scale-110 border-white" : "border-transparent"}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          <Button onClick={save} className="w-full gap-2">
            <Save className="size-4" />
            儲存為風格並套用
          </Button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg bg-black/25 px-2 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-base font-semibold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub ? <div className="text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
