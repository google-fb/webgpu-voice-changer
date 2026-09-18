"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// The app talks to WebGPU, AudioWorklet and localStorage from the first render,
// so it is only ever rendered on the client.
const VoiceChangerApp = dynamic(() => import("./voice-changer-app").then((m) => m.VoiceChangerApp), {
  ssr: false,
  loading: () => (
    <div className="bg-grid flex min-h-screen items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        載入 WebGPU 變聲器…
      </div>
    </div>
  ),
});

export function VoiceChangerLoader() {
  return <VoiceChangerApp />;
}
