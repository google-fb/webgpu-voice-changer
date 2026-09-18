"use client";

import { Activity, CircleDot, Loader2, Mic, MicOff, Power, Square, Volume2, VolumeX } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { EngineState, VoiceEngine } from "@/lib/audio/engine";
import { downloadBlob, encodeWav } from "@/lib/audio/wav";
import { hzToNoteName } from "@/lib/dsp/features";
import type { VoiceStyle } from "@/lib/voice/styles";
import { SpectrumVisualizer } from "./spectrum-visualizer";

interface LivePanelProps {
  engine: VoiceEngine;
  state: EngineState;
  style: VoiceStyle;
  bypass: boolean;
  onBypassChange: (value: boolean) => void;
}

function peakToDb(peak: number) {
  return peak > 0 ? 20 * Math.log10(peak) : -100;
}

function LevelMeter({ label, db, color }: { label: string; db: number; color: string }) {
  const pct = Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{db > -99 ? `${db.toFixed(1)} dB` : "-∞"}</span>
      </div>
      <div className="meter-track h-2 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-[width] duration-100"
          style={{ width: `${pct * 100}%`, background: color }}
        />
      </div>
    </div>
  );
}

export function LivePanel({ engine, state, style, bypass, onBypassChange }: LivePanelProps) {
  const [recordingBusy, setRecordingBusy] = useState(false);

  const toggleRun = useCallback(async () => {
    if (state.running) await engine.stop();
    else await engine.start();
  }, [engine, state.running]);

  const toggleRecording = useCallback(async () => {
    if (!state.running) return;
    if (!state.recording) {
      engine.startRecording();
      toast("開始錄製輸出", { description: "再按一次即可停止並下載 WAV。" });
      return;
    }
    setRecordingBusy(true);
    try {
      const clip = await engine.stopRecording();
      if (clip.samples.length === 0) {
        toast.warning("沒有錄到任何聲音");
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(encodeWav(clip.samples, clip.sampleRate), `voice-${style.name}-${stamp}.wav`);
        toast.success(`已下載 ${(clip.samples.length / clip.sampleRate).toFixed(1)} 秒的錄音`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRecordingBusy(false);
    }
  }, [engine, state.recording, state.running, style.name]);

  const live = state.liveStats;
  const worklet = state.workletStats;
  const inputDb = worklet ? peakToDb(worklet.inputPeak) : -100;
  const outputDb = worklet ? peakToDb(worklet.outputPeak) : -100;
  const inputF0 = live?.inputF0 ?? 0;
  const targetF0 = live?.targetF0 ?? 0;
  const gpuReady = state.gpuStatus === "ready";

  return (
    <Card className="glass-panel overflow-hidden border-0">
      <CardContent className="space-y-5 p-5">
        <div className="relative h-44 overflow-hidden rounded-xl border border-white/5 bg-black/30 md:h-56">
          <SpectrumVisualizer
            input={engine.inAnalyser}
            output={engine.outAnalyser}
            sampleRate={state.sampleRate}
            accent={style.color}
            active={state.running}
            className="h-full w-full"
          />
          <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs font-medium backdrop-blur">
            <span
              className={`size-2 rounded-full ${state.running ? "animate-pulse-ring" : ""}`}
              style={{ background: state.running ? style.color : "rgba(255,255,255,0.3)", ["--pulse-color" as string]: `${style.color}88` }}
            />
            {state.running ? (bypass ? "直通中（未變聲）" : `套用中：${style.name}`) : "待命"}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[auto_1fr] md:items-center">
          <Button
            size="lg"
            onClick={toggleRun}
            disabled={!gpuReady || state.starting}
            className="h-14 min-w-44 gap-2 rounded-xl text-base font-semibold shadow-lg shadow-primary/20"
            variant={state.running ? "secondary" : "default"}
          >
            {state.starting ? (
              <Loader2 className="size-5 animate-spin" />
            ) : state.running ? (
              <Square className="size-5" />
            ) : (
              <Power className="size-5" />
            )}
            {state.starting ? "啟動中…" : state.running ? "停止" : "啟動變聲器"}
          </Button>

          <div className="grid gap-3 sm:grid-cols-2">
            <LevelMeter label="輸入（麥克風）" db={inputDb} color="rgba(255,255,255,0.55)" />
            <LevelMeter label="輸出（變聲後）" db={outputDb} color={style.color} />
          </div>
        </div>

        {(state.micError || state.lastError) && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <MicOff className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="flex-1">{state.micError || state.lastError}</div>
            <Button size="sm" variant="ghost" onClick={() => engine.clearError()}>
              關閉
            </Button>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3">
            <div className="text-xs text-muted-foreground">你的音高</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
              {inputF0 > 0 ? Math.round(inputF0) : "--"}
              <span className="ml-1 text-xs font-normal text-muted-foreground">Hz</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {inputF0 > 0 ? hzToNoteName(inputF0) : "偵測中"}
              {live?.liveMedianF0 ? ` · 中位 ${Math.round(live.liveMedianF0)} Hz` : ""}
            </div>
          </div>
          <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3">
            <div className="text-xs text-muted-foreground">目標音高</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums" style={{ color: style.color }}>
              {targetF0 > 0 && !bypass ? Math.round(targetF0) : "--"}
              <span className="ml-1 text-xs font-normal text-muted-foreground">Hz</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {targetF0 > 0 && !bypass ? hzToNoteName(targetF0) : "直通"}
            </div>
          </div>
          <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Activity className="size-3" />
              GPU 管線
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
              {live ? live.gpuMs.toFixed(1) : "--"}
              <span className="ml-1 text-xs font-normal text-muted-foreground">ms / 批</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {worklet
                ? `緩衝 ${worklet.bufferedBlocks.toFixed(0)} 區塊 · 斷音 ${worklet.underruns}${live?.droppedBlocks ? ` · 丟棄 ${live.droppedBlocks}` : ""}`
                : "尚未啟動"}
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-t border-white/5 pt-4 md:grid-cols-[1fr_auto] md:items-center">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <Switch id="bypass" checked={bypass} onCheckedChange={onBypassChange} />
              <Label htmlFor="bypass" className="text-sm">
                直通比較（A/B）
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="mute" checked={!state.muted} onCheckedChange={(v) => engine.setMuted(!v)} />
              <Label htmlFor="mute" className="flex items-center gap-1 text-sm">
                {state.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
                輸出至喇叭 / 裝置
              </Label>
            </div>
            <div className="flex min-w-48 flex-1 items-center gap-3">
              <Label className="whitespace-nowrap text-sm text-muted-foreground">音量</Label>
              <Slider
                value={[state.outputVolume]}
                min={0}
                max={2}
                step={0.01}
                onValueChange={([v]) => engine.setOutputVolume(v)}
                aria-label="輸出音量"
              />
              <span className="w-12 text-right font-mono text-xs text-muted-foreground">
                {Math.round(state.outputVolume * 100)}%
              </span>
            </div>
          </div>
          <Button
            variant={state.recording ? "destructive" : "outline"}
            onClick={toggleRecording}
            disabled={!state.running || recordingBusy}
            className="gap-2"
          >
            {state.recording ? <Square className="size-4" /> : <CircleDot className="size-4" />}
            {state.recording ? "停止並下載" : "錄製輸出"}
          </Button>
        </div>

        {!state.running && gpuReady && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Mic className="size-3.5" />
            啟動後會要求麥克風權限。建議戴耳機監聽，避免回授；實況請在「設定」把輸出導向虛擬音效裝置（例如 VB-Cable）。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
