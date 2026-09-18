"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { hzToNoteName } from "@/lib/dsp/features";
import type { UserVoiceProfile } from "@/lib/voice/profile";
import { type VoiceStyle } from "@/lib/voice/styles";

export interface Tweaks {
  pitchOffsetSemitones: number;
  formantRatio: number;
  timbreStrength: number;
  intonation: number;
  breath: number;
}

export function tweaksFromStyle(style: VoiceStyle): Tweaks {
  return {
    pitchOffsetSemitones: 0,
    formantRatio: style.formantRatio,
    timbreStrength: style.timbreStrength,
    intonation: style.intonation,
    breath: style.breath,
  };
}

interface TweakPanelProps {
  style: VoiceStyle;
  tweaks: Tweaks;
  onChange: (patch: Partial<Tweaks>) => void;
  onReset: () => void;
  profile: UserVoiceProfile | null;
  liveMedianF0: number;
}

interface ParamSliderProps {
  label: string;
  hint: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}

function ParamSlider({ label, hint, value, display, min, max, step, onChange, disabled }: ParamSliderProps) {
  return (
    <div className={`space-y-2 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-baseline justify-between gap-3">
        <Label className="text-sm">{label}</Label>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{display}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} disabled={disabled} aria-label={label} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function TweakPanel({ style, tweaks, onChange, onReset, profile, liveMedianF0 }: TweakPanelProps) {
  const hasShape = !!(style.shape || style.tilt);
  const userF0 = profile?.medianF0 || liveMedianF0 || 0;
  const baseTargetHz =
    style.pitch.mode === "targetF0"
      ? style.pitch.hz
      : userF0 > 0
        ? userF0 * Math.pow(2, style.pitch.semitones / 12)
        : 0;
  const targetHz = baseTargetHz * Math.pow(2, tweaks.pitchOffsetSemitones / 12);
  const totalSemitones =
    userF0 > 0 && targetHz > 0 ? 12 * Math.log2(targetHz / userF0) : style.pitch.mode === "semitones" ? style.pitch.semitones + tweaks.pitchOffsetSemitones : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">微調「{style.name}」</h3>
          <p className="text-xs text-muted-foreground">
            {targetHz > 0
              ? `目標音高約 ${Math.round(targetHz)} Hz (${hzToNoteName(targetHz)})，相對你的聲音 ${totalSemitones >= 0 ? "+" : ""}${totalSemitones.toFixed(1)} 半音`
              : "啟動後偵測到你的音高，才會顯示實際的音高變化量"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onReset} className="gap-1.5">
          <RotateCcw className="size-3.5" />
          重設
        </Button>
      </div>

      <ParamSlider
        label="音高微調"
        hint="在風格的目標音高上再加減半音。"
        value={tweaks.pitchOffsetSemitones}
        display={`${tweaks.pitchOffsetSemitones >= 0 ? "+" : ""}${tweaks.pitchOffsetSemitones.toFixed(1)} 半音`}
        min={-12}
        max={12}
        step={0.5}
        onChange={(v) => onChange({ pitchOffsetSemitones: v })}
      />
      <ParamSlider
        label="共振峰（聲道大小）"
        hint="大於 1 聲道變小、聲音更稚嫩；小於 1 則更巨大厚實。"
        value={tweaks.formantRatio}
        display={`×${tweaks.formantRatio.toFixed(2)}`}
        min={0.7}
        max={1.4}
        step={0.01}
        onChange={(v) => onChange({ formantRatio: v })}
      />
      <ParamSlider
        label="音色強度"
        hint={
          hasShape
            ? style.kind === "extracted"
              ? "把角色的平均頻譜包絡套到你的聲音上，1.0 = 完全比對。"
              : "此預設使用內建的 EQ 曲線，強度決定套用程度。"
            : "此風格沒有音色曲線，僅調整音高與共振峰。"
        }
        value={tweaks.timbreStrength}
        display={`${Math.round(tweaks.timbreStrength * 100)}%`}
        min={0}
        max={1.2}
        step={0.01}
        onChange={(v) => onChange({ timbreStrength: v })}
        disabled={!hasShape}
      />
      <ParamSlider
        label="語調起伏"
        hint="1.0 保留你原本的抑揚頓挫；0 完全單音（機器人）；大於 1 誇張化。"
        value={tweaks.intonation}
        display={`${Math.round(tweaks.intonation * 100)}%`}
        min={0}
        max={1.6}
        step={0.05}
        onChange={(v) => onChange({ intonation: v })}
      />
      <ParamSlider
        label="氣音"
        hint="在高頻加入氣息感，適合耳語或成熟聲線。"
        value={tweaks.breath}
        display={`${Math.round(tweaks.breath * 100)}%`}
        min={0}
        max={1}
        step={0.01}
        onChange={(v) => onChange({ breath: v })}
      />
    </div>
  );
}
