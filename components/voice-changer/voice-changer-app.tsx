"use client";

import { AlertTriangle, Headphones, Mic2, Settings2, SlidersHorizontal, Sparkles, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { F32 } from "@/lib/dsp/gpu-pipeline";
import { DEFAULT_CONTROLS, type VoiceControls } from "@/lib/dsp/protocol";
import { loadProfile, saveProfile, type UserVoiceProfile } from "@/lib/voice/profile";
import {
  loadCustomStyles,
  PRESET_STYLES,
  saveCustomStyles,
  styleShapePayload,
  type VoiceStyle,
} from "@/lib/voice/styles";
import { AppHeader } from "./app-header";
import { AuditionPanel } from "./audition-panel";
import { CalibrationPanel } from "./calibration-panel";
import { CreateStylePanel } from "./create-style-panel";
import { LivePanel } from "./live-panel";
import { SettingsPanel } from "./settings-panel";
import { StyleGrid } from "./style-grid";
import { TweakPanel, tweaksFromStyle, type Tweaks } from "./tweak-panel";
import { useVoiceEngine } from "./use-voice-engine";

const SELECTED_KEY = "webgpu-voice-changer.selected.v1";

export function VoiceChangerApp() {
  const { engine, state } = useVoiceEngine();

  // This component is loaded with ssr: false, so persisted data can be read
  // synchronously in the state initialisers.
  const [customStyles, setCustomStyles] = useState<VoiceStyle[]>(() => loadCustomStyles());
  const [profile, setProfile] = useState<UserVoiceProfile | null>(() => loadProfile());
  const [selectedId, setSelectedId] = useState<string>(() => {
    const saved = window.localStorage.getItem(SELECTED_KEY);
    const all = [...loadCustomStyles(), ...PRESET_STYLES];
    return (all.find((s) => s.id === saved) ?? PRESET_STYLES[0]).id;
  });
  const [tweaks, setTweaks] = useState<Tweaks>(() => {
    const all = [...loadCustomStyles(), ...PRESET_STYLES];
    return tweaksFromStyle(all.find((s) => s.id === selectedId) ?? PRESET_STYLES[0]);
  });
  const [bypass, setBypass] = useState(false);
  const [gateDb, setGateDb] = useState(DEFAULT_CONTROLS.gateDb);
  const [tab, setTab] = useState("tweak");
  const [calibrationClip, setCalibrationClip] = useState<{ samples: F32; sampleRate: number } | null>(null);

  const styles = useMemo(() => [...customStyles, ...PRESET_STYLES], [customStyles]);
  const style = useMemo(() => styles.find((s) => s.id === selectedId) ?? PRESET_STYLES[0], [selectedId, styles]);

  const controls = useMemo<VoiceControls>(
    () => ({
      pitch: style.pitch,
      pitchOffsetSemitones: tweaks.pitchOffsetSemitones,
      formantRatio: tweaks.formantRatio,
      timbreStrength: style.shape || style.tilt ? tweaks.timbreStrength : 0,
      intonation: tweaks.intonation,
      breath: tweaks.breath,
      gateDb,
      gateDepth: DEFAULT_CONTROLS.gateDepth,
      outputGain: 1,
      userF0: profile?.medianF0 ?? 0,
      bypass,
    }),
    [bypass, gateDb, profile?.medianF0, style, tweaks],
  );

  // Push controls / shapes to the DSP worker whenever they change.
  useEffect(() => {
    if (state.gpuStatus !== "ready") return;
    engine.setControls(controls);
  }, [controls, engine, state.gpuStatus]);

  useEffect(() => {
    if (state.gpuStatus !== "ready") return;
    engine.setStyleShape(styleShapePayload(style));
  }, [engine, state.gpuStatus, style]);

  useEffect(() => {
    if (state.gpuStatus !== "ready") return;
    engine.setUserShape(
      profile ? { shape: Float32Array.from(profile.shape), sampleRate: profile.sampleRate, relative: false } : null,
    );
  }, [engine, profile, state.gpuStatus]);

  useEffect(() => {
    window.localStorage.setItem(SELECTED_KEY, selectedId);
  }, [selectedId]);

  const selectStyle = useCallback((next: VoiceStyle) => {
    setSelectedId(next.id);
    setTweaks(tweaksFromStyle(next));
    setBypass(false);
  }, []);

  const saveStyle = useCallback(
    (next: VoiceStyle) => {
      setCustomStyles((prev) => {
        const list = [next, ...prev.filter((s) => s.id !== next.id)];
        saveCustomStyles(list);
        return list;
      });
      selectStyle(next);
      setTab("tweak");
    },
    [selectStyle],
  );

  const deleteStyle = useCallback(
    (target: VoiceStyle) => {
      setCustomStyles((prev) => {
        const list = prev.filter((s) => s.id !== target.id);
        saveCustomStyles(list);
        return list;
      });
      if (target.id === selectedId) selectStyle(PRESET_STYLES[0]);
      toast(`已刪除「${target.name}」`);
    },
    [selectStyle, selectedId],
  );

  const updateProfile = useCallback((next: UserVoiceProfile | null) => {
    setProfile(next);
    saveProfile(next);
  }, []);

  const latencyMs = engine.estimatedLatencyMs();
  const gpuBlocked = state.gpuStatus === "unsupported" || state.gpuStatus === "error";

  return (
    <div className="bg-grid min-h-screen">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
        <AppHeader state={state} latencyMs={latencyMs} />

        {gpuBlocked && (
          <Card className="border-destructive/40 bg-destructive/10">
            <CardContent className="flex items-start gap-3 p-4 text-sm">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="space-y-1">
                <div className="font-medium">無法使用 WebGPU</div>
                <p className="text-muted-foreground">{state.gpuError}</p>
                <p className="text-muted-foreground">
                  建議使用最新版 Chrome 或 Edge（桌面版），並確認 chrome://gpu 中 WebGPU 為 Hardware accelerated。
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {!profile && state.gpuStatus === "ready" && (
          <button
            type="button"
            onClick={() => setTab("calibrate")}
            className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-left text-sm transition hover:bg-primary/15"
          >
            <UserRound className="size-5 shrink-0 text-primary" />
            <span>
              <span className="font-medium">建議先花 6 秒校正你的聲音。</span>{" "}
              <span className="text-muted-foreground">校正後套用角色風格時，音高與音色的轉換量才會精準。</span>
            </span>
          </button>
        )}

        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-7">
            <LivePanel engine={engine} state={state} style={style} bypass={bypass} onBypassChange={setBypass} />
            <StyleGrid
              styles={styles}
              selectedId={style.id}
              onSelect={selectStyle}
              onDelete={deleteStyle}
              onCreate={() => setTab("create")}
            />
          </div>

          <div className="lg:col-span-5">
            <Card className="glass-panel sticky top-6 border-0">
              <CardContent className="p-5">
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList className="grid h-auto w-full grid-cols-5">
                    <TabsTrigger value="tweak" className="flex-col gap-0.5 py-1.5 text-[11px] sm:flex-row sm:text-sm">
                      <SlidersHorizontal className="size-4" />
                      調整
                    </TabsTrigger>
                    <TabsTrigger value="create" className="flex-col gap-0.5 py-1.5 text-[11px] sm:flex-row sm:text-sm">
                      <Sparkles className="size-4" />
                      建立
                    </TabsTrigger>
                    <TabsTrigger value="calibrate" className="flex-col gap-0.5 py-1.5 text-[11px] sm:flex-row sm:text-sm">
                      <Mic2 className="size-4" />
                      我的聲音
                    </TabsTrigger>
                    <TabsTrigger value="audition" className="flex-col gap-0.5 py-1.5 text-[11px] sm:flex-row sm:text-sm">
                      <Headphones className="size-4" />
                      試聽
                    </TabsTrigger>
                    <TabsTrigger value="settings" className="flex-col gap-0.5 py-1.5 text-[11px] sm:flex-row sm:text-sm">
                      <Settings2 className="size-4" />
                      設定
                    </TabsTrigger>
                  </TabsList>
                  <div className="pt-4">
                    <TabsContent value="tweak">
                      <TweakPanel
                        style={style}
                        tweaks={tweaks}
                        onChange={(patch) => setTweaks((t) => ({ ...t, ...patch }))}
                        onReset={() => setTweaks(tweaksFromStyle(style))}
                        profile={profile}
                        liveMedianF0={state.liveStats?.liveMedianF0 ?? 0}
                      />
                    </TabsContent>
                    <TabsContent value="create">
                      <CreateStylePanel engine={engine} state={state} profile={profile} onSave={saveStyle} />
                    </TabsContent>
                    <TabsContent value="calibrate">
                      <CalibrationPanel
                        engine={engine}
                        state={state}
                        profile={profile}
                        onProfileChange={updateProfile}
                        onCaptured={setCalibrationClip}
                      />
                    </TabsContent>
                    <TabsContent value="audition">
                      <AuditionPanel engine={engine} state={state} style={style} controls={controls} calibrationClip={calibrationClip} />
                    </TabsContent>
                    <TabsContent value="settings">
                      <SettingsPanel engine={engine} state={state} gateDb={gateDb} onGateChange={setGateDb} />
                    </TabsContent>
                  </div>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>

        <footer className="border-t border-white/5 pt-6 text-xs leading-relaxed text-muted-foreground">
          <p>
            運作原理：麥克風音訊在 AudioWorklet 中切成 {""}
            512 樣本的區塊，經 MessagePort 直接送進擁有 WebGPU 裝置的 Worker。三個 compute shader 依序完成 2048 點 FFT
            與音高追蹤、倒頻譜包絡估計，接著以相位聲碼器移動諧波、扭曲共振峰並套上角色的平均頻譜包絡，最後 IFFT 與重疊相加還原成聲音。
            所有音訊都在你的裝置上處理，不會上傳。
          </p>
        </footer>
      </main>
    </div>
  );
}
