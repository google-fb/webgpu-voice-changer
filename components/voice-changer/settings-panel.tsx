"use client";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { EngineState, VoiceEngine } from "@/lib/audio/engine";
import { FFT_SIZE, HOP_SIZE } from "@/lib/dsp/constants";

interface SettingsPanelProps {
  engine: VoiceEngine;
  state: EngineState;
  gateDb: number;
  onGateChange: (db: number) => void;
}

const DEFAULT_INPUT = "__default_input__";
const DEFAULT_OUTPUT = "__default_output__";

export function SettingsPanel({ engine, state, gateDb, onGateChange }: SettingsPanelProps) {
  const inputs = state.inputs.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
  const outputs = state.outputs.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium">裝置與訊號</h3>
        <p className="text-xs text-muted-foreground">
          實況時可將輸出導向虛擬音效裝置（VB-Cable、VoiceMeeter 等），再在 OBS / Discord 選擇該裝置作為麥克風。
        </p>
      </div>

      <div className="space-y-2">
        <Label>輸入裝置（麥克風）</Label>
        <Select
          value={state.inputDeviceId || DEFAULT_INPUT}
          onValueChange={(v) => void engine.setInputDevice(v === DEFAULT_INPUT ? "" : v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="系統預設" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_INPUT}>系統預設</SelectItem>
            {inputs.map((d, i) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label || `麥克風 ${i + 1}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {inputs.length === 0 && <p className="text-xs text-muted-foreground">啟動一次並允許麥克風權限後，才能看到裝置名稱。</p>}
      </div>

      <div className="space-y-2">
        <Label>輸出裝置</Label>
        <Select
          value={state.outputDeviceId || DEFAULT_OUTPUT}
          onValueChange={(v) => void engine.setOutputDevice(v === DEFAULT_OUTPUT ? "" : v)}
          disabled={!state.canSelectOutput}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="系統預設" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_OUTPUT}>系統預設</SelectItem>
            {outputs.map((d, i) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label || `輸出 ${i + 1}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!state.canSelectOutput && (
          <p className="text-xs text-muted-foreground">此瀏覽器不支援選擇輸出裝置（需要 Chrome / Edge 110 以上）。</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-white/8 p-3">
        <div>
          <Label htmlFor="ns" className="text-sm">
            瀏覽器降噪
          </Label>
          <p className="text-xs text-muted-foreground">開啟可減少環境噪音，但可能讓音高偵測略不穩定。</p>
        </div>
        <Switch id="ns" checked={state.noiseSuppression} onCheckedChange={(v) => engine.setNoiseSuppression(v)} />
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <Label className="text-sm">噪音閘門</Label>
          <span className="font-mono text-xs text-muted-foreground">{gateDb <= -90 ? "關閉" : `${gateDb} dBFS`}</span>
        </div>
        <Slider value={[gateDb]} min={-90} max={-20} step={1} onValueChange={([v]) => onGateChange(v)} aria-label="噪音閘門" />
        <p className="text-xs text-muted-foreground">低於門檻的片段會被壓低 26 dB，避免背景噪音也被變聲放大。</p>
      </div>

      <div className="rounded-lg border border-white/8 bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <div>取樣率 {state.sampleRate} Hz · FFT {FFT_SIZE} · hop {HOP_SIZE}（{((HOP_SIZE / (state.sampleRate || 48000)) * 1000).toFixed(1)} ms / 區塊）</div>
        <div>
          GPU：{state.gpuInfo?.description || [state.gpuInfo?.vendor, state.gpuInfo?.architecture, state.gpuInfo?.device].filter(Boolean).join(" ") || "—"}
          {state.gpuInfo?.isFallbackAdapter ? "（軟體後備）" : ""}
        </div>
        <div>
          管線：Hann 視窗 → FFT → 自相關音高追蹤 → 倒頻譜包絡 → 相位聲碼器移調 → 共振峰／音色轉換 → IFFT → 重疊相加
        </div>
      </div>
    </div>
  );
}
