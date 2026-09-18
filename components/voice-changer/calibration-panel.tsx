"use client";

import { Loader2, Mic, Square, Trash2, UserRoundCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { EngineState, VoiceEngine } from "@/lib/audio/engine";
import { normalizePeak } from "@/lib/audio/decode";
import { hzToNoteName } from "@/lib/dsp/features";
import type { F32 } from "@/lib/dsp/gpu-pipeline";
import { profileFromFeatures, type UserVoiceProfile } from "@/lib/voice/profile";
import { EnvelopeChart } from "./envelope-chart";

interface CalibrationPanelProps {
  engine: VoiceEngine;
  state: EngineState;
  profile: UserVoiceProfile | null;
  onProfileChange: (profile: UserVoiceProfile | null) => void;
  onCaptured?: (clip: { samples: F32; sampleRate: number }) => void;
}

const CALIBRATION_SECONDS = 6;
const PROMPT = "今天天氣真好，我們一起去公園散步吧。這是一段用來校正聲音的句子，請用平常講話的語氣自然地唸出來。";

export function CalibrationPanel({ engine, state, profile, onProfileChange, onCaptured }: CalibrationPanelProps) {
  const [recording, setRecording] = useState<{ startedAt: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setProgress(Math.min(1, (performance.now() - recording.startedAt) / (CALIBRATION_SECONDS * 1000)));
    }, 100);
    return () => window.clearInterval(timer);
  }, [recording]);

  const calibrate = useCallback(async () => {
    if (recording) {
      engine.cancelCapture();
      setRecording(null);
      return;
    }
    if (!state.running) {
      await engine.start();
      if (!engine.getState().running) {
        toast.error("需要先開啟麥克風才能校正");
        return;
      }
    }
    setRecording({ startedAt: performance.now() });
    setProgress(0);
    try {
      const captured = await engine.captureInput(CALIBRATION_SECONDS);
      setRecording(null);
      setAnalyzing(true);
      normalizePeak(captured.samples);
      const features = await engine.analyzeClip(captured.samples, captured.sampleRate);
      if (features.medianF0 <= 0 || features.voicedFrames < 15) {
        toast.error("沒有偵測到足夠的說話聲", { description: "請靠近麥克風，以正常音量唸完整句。" });
        return;
      }
      const next = profileFromFeatures(features);
      onProfileChange(next);
      onCaptured?.({ samples: captured.samples, sampleRate: captured.sampleRate });
      toast.success(`校正完成：你的中位音高約 ${Math.round(next.medianF0)} Hz (${hzToNoteName(next.medianF0)})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRecording(null);
      setAnalyzing(false);
    }
  }, [engine, onCaptured, onProfileChange, recording, state.running]);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium">校正我的聲音</h3>
        <p className="text-xs text-muted-foreground">
          錄 {CALIBRATION_SECONDS} 秒你平常說話的聲音，系統會記住你的中位音高與平均音色。之後套用角色風格時，就能精準計算「要往上或往下移多少」以及「音色差多少」。
        </p>
      </div>

      <blockquote className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-sm leading-relaxed">
        {PROMPT}
      </blockquote>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={calibrate}
          disabled={state.gpuStatus !== "ready" || analyzing}
          variant={recording ? "destructive" : "default"}
          className="gap-2"
        >
          {analyzing ? <Loader2 className="size-4 animate-spin" /> : recording ? <Square className="size-4" /> : <Mic className="size-4" />}
          {analyzing ? "分析中…" : recording ? "取消" : profile ? "重新校正" : `開始校正（${CALIBRATION_SECONDS} 秒）`}
        </Button>
        {profile && (
          <Button variant="ghost" onClick={() => onProfileChange(null)} className="gap-1.5 text-muted-foreground">
            <Trash2 className="size-4" />
            清除
          </Button>
        )}
      </div>

      {recording && <Progress value={progress * 100} className="h-1.5" />}

      {profile ? (
        <div className="space-y-3 rounded-xl border border-white/8 bg-white/[0.03] p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserRoundCheck className="size-4 text-primary" />
            已校正 · {new Date(profile.createdAt).toLocaleString()}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-black/25 px-2 py-2">
              <div className="text-[11px] text-muted-foreground">中位音高</div>
              <div className="font-mono text-base font-semibold">{Math.round(profile.medianF0)} Hz</div>
              <div className="text-[11px] text-muted-foreground">{hzToNoteName(profile.medianF0)}</div>
            </div>
            <div className="rounded-lg bg-black/25 px-2 py-2">
              <div className="text-[11px] text-muted-foreground">音域</div>
              <div className="font-mono text-base font-semibold">
                {Math.round(profile.f0Low)}–{Math.round(profile.f0High)}
              </div>
              <div className="text-[11px] text-muted-foreground">Hz</div>
            </div>
            <div className="rounded-lg bg-black/25 px-2 py-2">
              <div className="text-[11px] text-muted-foreground">亮度</div>
              <div className="font-mono text-base font-semibold">
                {profile.brightnessDb >= 0 ? "+" : ""}
                {profile.brightnessDb.toFixed(1)} dB
              </div>
              <div className="text-[11px] text-muted-foreground">2–6k vs 0.2–1k</div>
            </div>
          </div>
          <EnvelopeChart shape={profile.shape} sampleRate={profile.sampleRate} color="#a5b4fc" className="h-24 w-full rounded-lg bg-black/30" />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          尚未校正。未校正時系統會在你講話的前幾秒自動估計音高與音色，但精準度較低，且每次啟動都要重新學習。
        </p>
      )}
    </div>
  );
}
