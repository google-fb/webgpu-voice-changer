"use client";

import { Check, Sparkles, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hzToNoteName } from "@/lib/dsp/features";
import { describePitch, type VoiceStyle } from "@/lib/voice/styles";
import { EnvelopeChart } from "./envelope-chart";

interface StyleGridProps {
  styles: VoiceStyle[];
  selectedId: string;
  onSelect: (style: VoiceStyle) => void;
  onDelete: (style: VoiceStyle) => void;
  onCreate: () => void;
}

export function StyleGrid({ styles, selectedId, onSelect, onDelete, onCreate }: StyleGridProps) {
  const custom = styles.filter((s) => s.kind === "extracted");
  const presets = styles.filter((s) => s.kind === "preset");

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">聲線風格</h2>
          <p className="text-sm text-muted-foreground">
            點選即可即時切換。上方是從角色語音擷取的風格，下方是內建預設。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onCreate} className="gap-1.5">
          <Sparkles className="size-4" />
          從語音建立風格
        </Button>
      </div>

      {custom.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {custom.map((style) => (
            <StyleCard
              key={style.id}
              style={style}
              selected={style.id === selectedId}
              onSelect={() => onSelect(style)}
              onDelete={() => onDelete(style)}
            />
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={onCreate}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground"
        >
          <UserRound className="size-6" />
          <span>還沒有自訂風格。上傳或錄一段 3–15 秒的角色語音，就能�訂風格。上傳或錄一段 3–15 秒的角色語音，就能擷取它的音高與音色。</span>
        </button>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {presets.map((style) => (
          <StyleCard key={style.id} style={style} selected={style.id === selectedId} onSelect={() => onSelect(style)} />
        ))}
      </div>
    </section>
  );
}

interface StyleCardProps {
  style: VoiceStyle;
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}

function StyleCard({ style, selected, onSelect, onDelete }: StyleCardProps) {
  const f = style.features;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={selected}
      className={`group relative flex cursor-pointer flex-col gap-2 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        selected ? "border-transparent bg-white/[0.06] shadow-lg" : "border-white/8 bg-white/[0.02] hover:bg-white/[0.045]"
      }`}
      style={selected ? { boxShadow: `0 0 0 1.5px ${style.color}, 0 10px 30px -12px ${style.color}88` } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: style.color }} />
          <span className="font-medium leading-tight">{style.name}</span>
        </div>
        <div className="flex items-center gap-1">
          {selected && <Check className="size-4" style={{ color: style.color }} />}
          {onDelete && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-6 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  aria-label={`刪除 ${style.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>刪除此風格</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <p className="line-clamp-2 min-h-[2.5em] text-xs text-muted-foreground">{style.description}</p>
      {style.kind === "extracted" && style.shape ? (
        <EnvelopeChart shape={style.shape.data} sampleRate={style.shape.sampleRate} color={style.color} compact className="h-10 w-full" />
      ) : null}
      <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono">
          音高 {describePitch(style)}
          {style.pitch.mode === "targetF0" ? ` (${hzToNoteName(style.pitch.hz)})` : ""}
        </span>
        <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono">共振峰 ×{style.formantRatio.toFixed(2)}</span>
        {f ? (
          <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono">
            亮度 {f.brightnessDb >= 0 ? "+" : ""}
            {f.brightnessDb.toFixed(1)} dB
          </span>
        ) : null}
      </div>
    </div>
  );
}
