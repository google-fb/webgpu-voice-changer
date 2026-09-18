"use client";

import { Cpu, Gauge, Waves } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EngineState } from "@/lib/audio/engine";

interface AppHeaderProps {
  state: EngineState;
  latencyMs: number;
}

export function AppHeader({ state, latencyMs }: AppHeaderProps) {
  const gpuLabel = (() => {
    switch (state.gpuStatus) {
      case "ready": {
        const name = [state.gpuInfo?.vendor, state.gpuInfo?.architecture || state.gpuInfo?.device]
          .filter(Boolean)
          .join(" · ");
        return name ? `WebGPU 就緒 · ${name}` : "WebGPU 就緒";
      }
      case "initializing":
        return "WebGPU 初始化中…";
      case "unsupported":
        return "不支援 WebGPU";
      case "error":
        return "WebGPU 錯誤";
      default:
        return "WebGPU";
    }
  })();

  const gpuVariant = state.gpuStatus === "ready" ? "default" : state.gpuStatus === "initializing" ? "secondary" : "destructive";

  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          <Waves className="size-3.5" />
          Realtime voice style transfer
        </div>
        <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
          WebGPU 變聲器
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground md:text-base">
          從一段短短的角色語音擷取「音高 + 音色」特徵成為風格，講話時透過 GPU
          計算著色器即時套用。適合實況、Discord 與配音。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={gpuVariant} className="gap-1.5 px-2.5 py-1 font-mono text-[11px]">
              <Cpu className="size-3.5" />
              {gpuLabel}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            {state.gpuInfo?.description || state.gpuError || "所有頻譜分析與合成都在 WebGPU compute shader 上執行"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1.5 px-2.5 py-1 font-mono text-[11px]">
              <Gauge className="size-3.5" />
              {state.running ? `延遲約 ${latencyMs} ms` : `預估延遲 ${latencyMs} ms`}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            演算法延遲 (FFT 2048) + 緩衝 + GPU 往返 + 音效裝置延遲
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
