# WebGPU 變聲器（即時語音風格轉換）

以 **WebGPU compute shader** 實作的瀏覽器即時變聲器，目標是實況主常用的「變聲器」工作流程：

1. 上傳或錄一段 3–15 秒的動畫角色語音，系統在 GPU 上逐幀分析，把它的**音高（F0 統計）**與**音色（平均頻譜包絡）**濃縮成一個「風格」。
2. 講話時從風格庫點選要套用的聲線，麥克風訊號即時被移調、共振峰扭曲並套上角色的音色曲線。
3. 可校正自己的聲音（6 秒）讓轉換量更精準，也能離線試聽、錄製輸出成 WAV，或把輸出導向虛擬音效裝置給 OBS / Discord 使用。

所有音訊都在使用者裝置上處理，不會上傳。

## 功能

- **風格擷取**：GPU 分析音高軌跡、有聲/無聲判定、倒頻譜平滑的頻譜包絡，得到中位音高、音域（P10–P90）、亮度與音色指紋，並以圖表呈現。
- **即時變聲**：相位聲碼器移調 + 共振峰縮放 + 音色轉換（角色平均頻譜 − 講者平均頻譜）+ 噪音閘門 + 氣音；語調起伏可從 0（機器人單音）到 160%。
- **內建預設**：動漫少女、元氣少年、成熟御姐、低沉魔王、沙啞大叔、花栗鼠、巨人、機器人、幽靈。
- **我的聲音校正**：記住講者的中位音高與音色，存在 localStorage。
- **離線試聽**：把一段錄音以目前參數在 GPU 上一次渲染完成，可播放與下載 WAV。
- **實況導流**：可選擇輸入/輸出裝置（`AudioContext.setSinkId`），輸出至 VB-Cable / VoiceMeeter 等虛擬裝置。
- 即時頻譜視覺化、音高讀數、GPU 每批處理時間、緩衝/斷音統計、A/B 直通比較。

## 技術架構

```
麥克風 ─► AudioWorklet（切成 512 樣本區塊）
              │ MessagePort（直接傳給 Worker，不經主執行緒）
              ▼
        DSP Worker（擁有 WebGPU device）
              │
              ├─ analyze.wgsl    Hann 視窗 → 2048 點 FFT → |X|、∠X
              │                  → 2x 降採樣 NCCF 音高追蹤（含八度錯誤抑制）
              │                  → log|X| 倒頻譜 lifter → 頻譜包絡
              ├─ transform.wgsl  瞬時頻率估計 → 峰值區域（identity phase locking）
              │                  → 以音高比例搬移諧波細結構、共振峰扭曲
              │                  → 套用「風格包絡 − 講者包絡」× 強度、氣音、閘門
              │                  → 每幀能量比對，保持音量一致
              └─ synthesize.wgsl 共輝鏡射 → IFFT → Hann 合成視窗
              │
              ▼ 重疊相加（75%）
        AudioWorklet 環形緩衝 ─► 喇叭 / 虛擬音效裝置 / WAV 錄製
```

- FFT 在單一 workgroup 內用 16 KiB workgroup memory 完成（剛好是 WebGPU 預設上限），一個 workgroup 處理一個 STFT 幀，離線分析時數百幀平行。
- `transform` kernel 依序處理一批幀並保存相位狀態（`pvState`），所以即時與離線路徑共用同一套 shader。
- 演算法延遲為 FFT 長度（48 kHz 下約 43 ms），加上區塊與抖動緩衝約 90–120 ms；UI 會顯示即時估計值。

## 執行方式

需求：Node.js 20+、支援 WebGPU 的瀏覽器（Chrome / Edge 113+，桌面版最佳）。

```bash
npm install
npm run dev -- -p 43117
```

開啟 <http://127.0.0.1:43117>。首次啟動會要求麥克風權限，建議戴耳機避免回授。

其他指令：

```bash
npm run lint          # ESLint
npm run build         # 產生靜態站（out/），本機路徑為 /
npm run build:pages   # 產生給 GitHub Pages 的靜態站（basePath /webgpu-voice-changer）
npx serve out         # 本機預覽正式版
```

## 給實況主的使用流程

1. 到「我的聲音」唸一句話校正（約 6 秒）。
2. 到「建立」上傳角色語音（乾淨、無 BGM 的對白最好），確認擷取出的音高與包絡後儲存。
3. 在「設定」把輸出裝置切到虛擬音效線（VB-Cable 等），OBS / Discord 選該裝置為麥克風。
4. 講話時在風格庫點選聲線；「調整」分頁可微調音高、共振峰、音色強度、語調與氣音。

## 部署

專案是純前端靜態站（`output: "export"`），不需要環境變數或後端服務。麥克風與 WebGPU 都要求 **HTTPS**（或 localhost）。

### GitHub Pages

正式站：<https://google-fb.github.io/webgpu-voice-changer/>

來源儲存庫：[google-fb/webgpu-voice-changer](https://github.com/google-fb/webgpu-voice-changer)（公開）。使用者網站 [google-fb/google-fb.github.io](https://github.com/google-fb/google-fb.github.io) 的 Pages workflow 會 checkout 此儲存庫，以 `NEXT_PUBLIC_BASE_PATH=/webgpu-voice-changer` 靜態匯出，並發佈到上述路徑。儲存庫內的 `.github/workflows/deploy-pages.yml` 也可在 Settings → Pages → Source 選 GitHub Actions 後，直接當成專案站部署。

若要自己接 Pages：

1. 把儲存庫設為 **Public**（GitHub Free 無法對私人儲存庫發佈 Pages）。
2. Settings → Pages → Source 選 **GitHub Actions**。
3. 把 workflow 裡的 `NEXT_PUBLIC_BASE_PATH` 改成 `/<repo-name>`，與專案站路徑一致。
4. 推送到 `main`，等 Actions 的 Deploy to GitHub Pages 完成。

### Vercel

1. 到 [vercel.com/new](https://vercel.com/new) 匯入儲存庫。
2. Framework 會偵測為 Next.js；不要設定 `NEXT_PUBLIC_BASE_PATH`（站點掛在網域根路徑）。
3. 之後每次推送到 `main` 都會自動重新部署。

## 專案結構

```
app/                         Next.js App Router 頁面與全域樣式
components/voice-changer/    UI（即時面板、風格庫、建立風格、校正、試聽、設定）
components/ui/               shadcn/ui 元件
lib/dsp/shaders.ts           三個 WGSL compute shader
lib/dsp/gpu-pipeline.ts      WebGPU 裝置、緩衝區、bind group、dispatch 與讀回
lib/dsp/dsp.worker.ts        DSP Worker：即時迴圈、離線分析、離線渲染、錄音
lib/dsp/features.ts          風格特徵統計（中位音高、包絡正規化、亮度）
lib/audio/engine.ts          主執行緒 facade：AudioContext、裝置、Worklet、Worker RPC
lib/voice/                   風格模型、預設、講者校正檔（localStorage）
public/worklets/             AudioWorklet 處理器（音訊執行緒 I/O 與環形緩衝）
```

## 限制與注意事項

- 這是訊號處理式的風格轉換（音高 + 共振峰 + 平均音色），不是神經網路聲音複製；擷取的是角色的「平均」聲學特徵，講者本身的咬字與語氣仍會保留。
- 移調幅度超過一個八度時相位聲碼器會帶有明顯的合成感；建議搭配共振峰與音色強度一起調整。
- 需要硬體加速的 WebGPU。若瀏覽器落在軟體後備（SwiftShader），GPU 每批處理時間會遠高於即時需求，系統會丟棄區塊以維持延遲上限。
- 手機瀏覽器對 WebGPU 與 `setSinkId` 支援不一，桌面 Chrome / Edge 體驗最完整。
