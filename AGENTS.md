# AGENTS.md — MeetPilot

給在這個 repo 工作的 AI agent。跑法與環境變數在 `README.md`，這份只講 agent 要知道的事。

跨專案的開發規範在 vault：`/Users/vincent/AI Memory/05 - Resources/DEV-STANDARDS.md`（寫碼）、
`CODE-REVIEW.md`（review）、`03 - Jobs/CODE-DEVELOPMENT.md`（流程）。技術慣例（目標分支、測試命令、
commit 格式）以本檔為準。

**授權邊界不受本檔覆蓋。** commit、push、開 PR、merge、deploy 一律要使用者當次授權。
這個 repo 沒有任何「agent 可直推」的例外。

## Gate

三條都要綠才算通過：

```bash
npx tsc --noEmit        # 等同 npm run lint
npm test                # vitest
npm run build           # 前端與 server bundle
```

目標分支 `main`。`npm run build` 會產生 `dist/`（已在 `.gitignore`，不影響工作樹乾不乾淨）。

**CI（`.github/workflows/ci.yml`）在 macOS 與 Windows 各跑一次三條 gate，外加正式版冒煙測試**
（`npm prune --omit=dev` 後跑 `scripts/smokeProduction.mjs`）。本機只有 macOS，**Windows 的結果只有
CI 看得到**：碰到路徑、換行、spawn、檔案權限、`process.platform` 的改動，本機綠不代表 Windows 綠，
要等 CI 的 Windows 那格。

- `dist/server.cjs` 不能在檔頭 require 任何 devDependency。esbuild `--packages=external` 會把 static
  import 原樣變成檔頭 `require()`，只有開發模式才用的東西（`vite`）要在分支裡 `await import()`。
  冒煙測試在拿掉 devDependencies 之後啟動，守的就是這條。
- `.gitattributes` 強制 LF。`prompt_version` 是規範檔原始內容的雜湊，換行一變就變，`lineEndings.test.ts`
  在 Windows runner 上守它。
- `npm start` 用 `cross-env` 設 `NODE_ENV`，因為 cmd 與 PowerShell 不吃 `VAR=value cmd` 的寫法。
  它放在 `dependencies` 不是 `devDependencies`：`--omit=dev` 的安裝也要能 `npm start`。

## 開 worktree 與收掉

正式 server 從主 clone 跑，**主 clone 不切分支、不 pull、不直接改檔**。要動手就開 worktree：

```bash
npx tsx scripts/worktreeSetup.ts <分支名>     # 從 origin/main 開、npm ci、寫好這個 worktree 專用的 .env
npx tsx scripts/worktreeClean.ts              # 列出已合併、乾淨、沒鎖、沒有行程在用的 worktree；加 --apply 才搬進垃圾桶（macOS／Linux）
```

`worktreeSetup.ts` 寫的 `.env` 會把 `PORT`、`MEETPILOT_HMR_PORT` 換成空的 port，`MEETPILOT_VAULT` 指到暫存目錄，
會寫檔的絕對路徑拿掉、只讀輸入檔的相對路徑改指回主 clone。規則與理由在兩支腳本的檔頭。
shell 裡已經 export 了 `PORT`、`MEETPILOT_HMR_PORT` 或會寫檔的路徑設定時，Node 的 `--env-file` 不會蓋掉它們，腳本會拒跑；之後在那個 worktree 跑 `npm run dev` 的 shell 也不能有這些 export。
新增會寫檔或只讀的路徑型 `MEETPILOT_*` 設定時，要加進 `worktreeSetup.ts` 的 `WRITE_TARGET_KEYS` 或 `READ_INPUT_KEYS`，
不然 worktree 會寫到正式那份，或一啟動就找不到檔。

## commit 前的檢查

`.githooks/pre-commit` 用 gitleaks 掃 staged 的改動，`.githooks/commit-msg` 掃 commit message，`.githooks/pre-merge-commit`
在沒有衝突、git 直接建 merge commit 時掃合併結果（git 這時不呼叫 pre-commit），有疑似密鑰就擋。
**在主 clone 啟用一次，所有 worktree 共用**：

```bash
brew install gitleaks
git config core.hooksPath "$(git rev-parse --show-toplevel)/.githooks"    # 在主 clone 裡跑（不是 worktree）；一定要絕對路徑
```

一定要絕對路徑：相對的 `.githooks` 會從每個 worktree 自己的根目錄找，還沒有這些 hook 的舊分支 worktree 會被
git 安靜略過。絕對路徑指到主 clone，主 clone 一律待在 main（正式 server 從那裡跑）。
hook 讀的是主 clone 工作樹裡的 `.githooks/`：主 clone 更新到含這個目錄的 main 之前，git 找不到 hook，所有 worktree 的 commit 都不掃
（2026-09-25 設好 `core.hooksPath` 時主 clone 停在 `d84ee6e`，就是這個狀態）。確認有沒有作用：`git hook run pre-commit`，印 `cannot find a hook` 就是沒有。
CI 的 `secrets` job 另外每次掃 HEAD 的整段歷史與 commit message，抓 GitHub 網頁 merge、fork 這些不經過本機 hook 的路；
本機 hook 是第一層。`secrets` 是 main 的 required check（2026-09-25 起），紅了不能 merge；admin 看得到 bypass 選項，不要用它硬合。
本機 hook 擋不到的路：`git rebase --continue`（解衝突時新貼進去的內容）、無衝突的 cherry-pick 與 rebase 重放、fast-forward，這些靠 CI。
已經進歷史的誤報寫進 `.gitleaksignore`，一條一個理由。
沒裝 gitleaks 時三支 hook 都直接擋 commit，不會安靜略過。誤報（例如公開的簽章指紋）在那一行加 `# gitleaks:allow`
並寫理由，不要整個關掉 hook。`gitleaks:allow` 整行放行，只能用在整行都是公開資料的地方；commit message 裡不准寫它
（寫了，message 掃描也會放行）。PR 說明照 `.github/pull_request_template.md` 寫。

## CodeGraph

索引在 `.codegraph/`（2026-09-14 建，`codegraph init`）。本機產物，不進版控。
**auto-sync 不可靠，查之前先 `codegraph sync`**（理由見下面的盲區一）。

定位或理解程式碼**先查拓樸再 grep**：

| 要回答的問題 | 指令 |
|---|---|
| X 怎麼走到 Y | `codegraph explore <query>`（MCP 是 `codegraph_explore`） |
| 改這個 symbol 會影響什麼 | `codegraph impact <symbol> --depth <n>` |
| 誰呼叫它 / 它呼叫誰 | `codegraph callers` / `codegraph callees <symbol>` |

**為什麼這個 repo 需要它**：2026-09-14 的修復只靠整檔讀加 grep，漏掉
`askDocumentStream` 繞過 `withRetry` 與 `postJson`（它自己 `fetch`），導致「撞 429 讀
`Retry-After`」那條修復沒涵蓋串流問答路徑。`impact` 與 `callers` 在這種「誰沒走到共用
路徑」的問題上比 grep 可靠得多。

**但不要用 `callees` 的空來證明「它沒呼叫任何東西」**，理由見下面的盲區。

## CodeGraph 的三個盲區（實測，別踩）

**一、索引不會自己跟上 worker 在 worktree 做的改動。** 2026-09-14 三個 worktree 的改動
merge 回主 clone 之後，索引仍停在 34 檔／334 nodes，`postStream`、`withConnection` 這些
新符號一律 `Symbol not found`，而且**不會報錯**，只會安靜地用舊圖回答。查之前先跑一次：

```bash
codegraph sync      # 沒東西要同步時很快，有東西時會印 Synced N changed files
```

**二、generator 函式的 body 呼叫看不見，具名或匿名都一樣。** 實測（2026-09-14）：

| 寫法 | `callees` 回什麼 |
|---|---|
| `function withRetry()`、`async function postStream()`（一般宣告） | body 的呼叫查得到 |
| `export const polishTranscript = async () => {}`（arrow） | body 的呼叫查得到（`withRetry`、`postJson`） |
| `export const askDocumentStream = async function* ()`（匿名 generator） | **空的** |
| `export async function* generateAudioSlices()`（具名 generator） | **只有預設參數與型別，body 的呼叫一個都沒有** |

**2026-09-14（W2）更新：`generateAudioSlices` 與 `services/audioService.ts` 已經刪掉**（切片搬到
server 端 ffmpeg）。**2026-09-20 更新：`askDocumentStream` 連同整個問答功能也刪掉了。** 下面這段的
結論仍然成立，但兩個對照組**都已經沒辦法重跑**；repo 現在沒有任何 generator。下次要驗 generator 的
行為，得自己寫一個來試。

具名 generator 最危險：它會回東西，讓人以為 body 被解析過。`generateAudioSlices` 的兩筆是
`SLICE_OVERLAP_SECONDS`（來自 `audioService.ts:150` 的預設參數）與 `TranscriptSegment`
（**那個檔案裡一次都沒出現過**，`grep -c` 為 0、`git log -S` 查無歷史，是圖上憑空多出來的
邊），而 body 裡的 `getAudioDuration`、`extractAudio`、`resolveDuration` 全部缺席。
**非空不代表 body 被解析過，回傳的東西也不保證真的在那個檔案裡**；這份文件最初寫錯兩次，
都是拿沒看內容的 `callees` 筆數當證據。

所以 `callees` 對 generator 沒有意義，空和非空都不能當證據。要確認某個函式有沒有走共用
路徑，只有讀碼算數。`callers` 從共用函式那頭反查可以縮小範圍，但**它只到檔案層級**：
當時 `codegraph callers postStream` 回的是 `file geminiService.ts`，不會指名 `askDocumentStream`
（兩個符號都已隨問答功能刪除，這裡留的是行為紀錄）。

**三、符號查詢是模糊比對，查一個不存在的名字可能拿到別人的答案。** 2026-09-14 刪掉
`askDocument` 之後，`codegraph callers askDocument` 仍回 3 筆，內容其實是
`askDocumentStream` 的呼叫者（名字是它的前綴）。對照組 `getAgentById` 整個檔被刪，回的是
乾淨的 `Symbol not found`。**所以 `callers` 非空不保證那個符號還存在**，用它判斷死碼時，
名字互為前綴的一組符號會互相污染。判死碼一律再跑一次
`grep -rn --include=*.ts --include=*.tsx '<符號名>' .` 交叉驗證。

**四、掛在回傳物件字面值上的方法不在圖裡。** 2026-09-15（W3 收尾）實測：`MeetingStore` 是
`createMeetingStore` 回一個物件字面值，它上面每一支方法查符號都是 `Symbol not found`——
`codegraph callers saveTopicExtraction`、`codegraph callers saveSeamReport` 都一樣。所以
**`MeetingStore`、`TopicExtractor`、`TopicLinker`、`TranscriptionPipeline` 這一整組 factory 回傳的
方法，用拓樸查呼叫端一律是假的空**，不是「沒有人呼叫」。同一次還撞到：`server.ts` 不會被算成
`callers` 的呼叫端（它跟 `App.tsx` 一樣，`affected` 對它也回空）。

這個 repo 的 module 幾乎全是這個寫法，所以**接線要靠讀碼與 grep 確認**，不要拿 `callers` 的空
當證據。

## `codegraph affected` 的 filter 與盲區

**驗證過的 glob（2026-09-14 實測）**：

```bash
codegraph affected --stdin --quiet --filter "services/*.test.ts"
```

測試檔命名剛好符合 auto-detect 的慣例（`*.test.ts`），不帶 `--filter` 結果相同；
仍然明寫，命名一改就會安靜回空。

**逐檔實測的覆蓋地圖。「空」有兩種意思，不要當成同一件事：**

| 餵進去的檔 | affected 回傳 | 空的意思 |
|---|---|---|
| `services/transcriptMerge.ts` | `transcriptMerge.test.ts` | — |
| `services/httpGuards.ts` | `httpGuards.test.ts` | — |
| `services/transcribeSegments.ts` | `transcribeSegments.test.ts` | — |
| `services/retryPolicy.ts` | `retryPolicy.test.ts` | — |
| `services/httpError.ts` | `retryPolicy.test.ts` | — |
| `services/printDocument.ts` | `printDocument.test.ts` | — |
| `services/escapeHtml.ts` | `escapeHtml.test.ts`、`printDocument.test.ts` | — |
| `services/storageService.ts` | **（空）** | **假的空。有測試**，但 `storageService.test.ts` 用 `vi.resetModules()` ＋ `await import('./storageService')` 動態載入（為了清模組層的連線快取），圖上沒有 import 邊 |
| `services/geminiService.ts` | （2026-09-14 實測時空） | 當時真的空；之後加了 `geminiService.test.ts`，這一列**未重測**，別當成現況 |
| `server.ts` | （空） | 真的空 |
| `App.tsx` | （空） | 真的空 |

`services/audioService.ts` 與 `services/audioDuration.ts` 已於 W2 刪除，原本那兩列拿掉。
W2 新增的 `audioSlicer`、`audioFileStore`、`transcriptionPipeline`、`transcriptionQueue`、
`geminiServerClient`、`meetingClient`、`meetingAdapter` 各有同名測試，**尚未逐檔實測 affected 的覆蓋**，
別假設它們都查得到。

2026-09-20 新增的 `droppedFiles.ts` **已實測**：`affected` 回 `droppedFiles.test.ts`。

所以改到後面五個檔案時，`affected` 回空**不代表不用跑測試**，三條 gate 一律照跑。
改 `storageService.ts` 一定要手動指定 `services/storageService.test.ts`。

## gate 守不到哪裡（2026-09-15 實測）

**`npx tsc --noEmit` 對 `App.tsx` 與整個 `components/` 幾乎沒有型別覆蓋。**

`package.json` 沒有 `@types/react`，`node_modules/react` 也沒有自帶 `.d.ts`，而 tsconfig 沒開
`strict`（`noImplicitAny` 關著）。所以 `import ... from 'react'` 整個解析成 `any`，
於是每一個 `useState` 回來的值、以及由它推導出去的每一個東西，在 `App.tsx` 裡都是 `any`。

實測（2026-09-15，W2 期間）：把 `useState({a:1})` 的結果賦值給 `number` **不報錯**；
把字串傳給一個明確吃物件的函式參數也**不報錯**；但把同一個呼叫的參數明確標成型別之後就報錯，
代表函式簽名本身是好的，失效的是呼叫端的推導。

**後果**：W2 期間前端的每一條缺陷都是 reviewer 抓到的，沒有一條被 gate 攔下。
所以「可測的邏輯抽進 `services/` 的純函式再測」在這個 repo **不是風格偏好，是唯一的防線**。
改 `App.tsx` 或 `components/` 時不要靠 tsc 給你安全感。

修法是把 `@types/react` 與 `@types/react-dom` 加進 devDependencies，但加上去會一次噴出一批
既有的型別錯誤，要排時間，**當成獨立一包做，不要夾在別的任務裡順手加**。

**沒開 `strict` 還有第二個後果，跟上面那條無關：判別聯合（discriminated union）對布林欄位的
窄化會失效，就算在有明確型別的 `services/` 檔案也一樣（2026-09-20 實測）。**

```ts
type Pick = { ok: true; file: File } | { ok: false; reason: string };
function f(p: Pick) {
  if (!p.ok) { p.reason }              // 錯：p 仍是整個 union，讀不到 reason
  if (p.ok) {} else { p.reason }       // 同樣錯，else 分支一樣收斂不到
  if (p.ok === false) { p.reason }     // 對：明確比較 === false 才會窄化
}
```

用 `npx tsc --noEmit --strict` 單獨測這段會過；拿掉 `--strict` 就跟這個 repo 的 tsconfig 一樣紅。
這跟上一條「`App.tsx` 型別是 `any`」是不同成因：這裡型別是對的、有明確標註，純粹是 TS 的
控制流程分析在非 strict 模式下對布林判別式較弱。**寫任何 `{ ok: true; ... } | { ok: false; ... }`
形狀的回傳值時，判斷式一律寫成 `x.ok === false`（或 `x.ok === true`），不要寫 `!x.ok`
或 `if (x.ok) {} else {}`**——後兩種在這個 repo 會安靜地把整個 union 留在原地，`tsc` 才會抓到，
但 `services/` 以外（`App.tsx`、`components/`）沒有 tsc 覆蓋，抓不到就是執行期才炸。

## 桌面 app（`electron/`）

- **打包設定 `asar: false` 是刻意的。** server 用 `process.cwd()` 找 `dist/`（前端）與 `prompts/`（會議記錄規範），
  外殼把 utilityProcess 的 `cwd` 設成 app 目錄；asar 是虛擬檔案系統，不能當 cwd。要改回 asar，得先讓 server
  的這兩個路徑改吃環境變數。
- **Electron 版本釘死（`44.4.5`，不用 `^`）。** `node:sqlite` 能在它的 utilityProcess 裡用是對這一版實測的
  （Node 24.21.0），升版要重驗。npm 上 44 是最新穩定版，45 還是 alpha。
- **單一實例不能拿掉。** `jobStore.reclaimAllActive` 建立在同一個 DB 只有一個 process 上。
- **app 內錄音（E4）跑在主視窗的頁面裡。** 會讓頁面換掉的動作（托盤「設定…」、結束、server 崩潰後換錯誤頁）都會切斷錄音；
  錄音狀態由頁面經 preload 的 `meetpilotDesktop.setRecording` 告訴主程序，主程序只收 server 頁面來的。主視窗的
  `backgroundThrottling: false` 不能拿掉：藏到系統匣的頁面會被節流。冒煙測試的錄音段用 Chromium 假麥克風，
  從主程序（`--inspect`）關視窗；頁面裡的 `window.close()` 會被 Chromium 擋掉，測不到關視窗那條路。
- **`electron/serverEnv.ts` 不 import electron**，才測得到；呼叫端環境裡 `MEETPILOT_*`、`HOST`、`PORT`、`GEMINI_API_KEY`
  一律不往下傳給 server，值只由外殼決定。
- 打包後的 app 只有 `scripts/smokeDesktop.mjs` 驗得到（CI 的 `desktop` job 兩平台各跑一次）。Windows 的結果只有 CI 看得到。
  它起一個假 gateway（`MEETPILOT_DESKTOP_GATEWAY_URL`），用 CDP 操作設定頁，連跑首次設定、離線、錄音、資料夾不見了、更新、撤銷六段。
  設定頁的 `#invite-code`、`#vault-dir`、`#save`、`#message` 是它操作的把手，改名要一起改。
- **gateway 回 401 一律當撤銷，不能退回上次存的 key。** 連不上才用上次的。這兩條的分界在
  `electron/gatewayClient.ts`，改之前先看檔頭；冒煙測試的「撤銷」那段守它。
- **更新（E5）不用 electron-updater**，理由在 `electron/updater.ts` 檔頭。安裝檔檔名是契約：`build.dmg`／`build.nsis` 的
  `artifactName` 是 `MeetPilot-<版本>-<mac|win>-<架構>.<dmg|exe>`，`electron/updateBundle.ts` 從檔名讀平台與架構產清單，
  改一邊要改另一邊的 `ARTIFACT_NAME_PATTERN`，不然 CI 的 `update-bundle` job 紅在「少了某個平台」。
  清單格式只有 `parseUpdateManifest` 一份定義，`updateBundle.test.ts` 拿 app 端的 `checkForUpdate` 讀產出的清單來守；
  改格式要升 `UPDATE_MANIFEST_SCHEMA`，舊版 app 看到不認得的 schema 會講出來、不安裝。
  「錄音中不裝」與「按下去真的安裝」在 `main.ts`，沒有自動測試，實際換版在實機驗（AC-7）。
- **token 與 key 只能經 `safeStorage` 落地。** `electron/desktopStore.ts` 的加解密由呼叫端傳入，不要加「不能用就存明文」的退路。
- `setupPreload.ts` 掛在主視窗上，server 的頁面也拿得到 `window.meetpilotSetup`；`ipcMain` 那頭一律用
  `isSetupPageUrl` 驗來源，新增的設定頁 handler 也要驗。
- **隨附的 ffmpeg 只開了 server 用得到的元件**（`scripts/ffmpeg/configure-flags.txt`）。server 改用新的 ffmpeg 功能
  （新的濾鏡、編碼器、容器）時，開發機上的完整版 ffmpeg 照樣能跑、三條 gate 照樣綠，打包後才壞。改 `audioSlicer.ts`
  的 ffmpeg 參數時，同一個 PR 要在 flags 加元件並跑 `npm run ffmpeg:verify`；新格式要加一支 fixture。
- **icon 與托盤圖示由 `npm run icons:build` 產生**（圖案在 `scripts/icon/iconArtwork.ts`），不要手改 `build/icon.*`
  或 `electron/assets/*.png`，下次重跑就被蓋掉。托盤的 `trayTemplate*.png` 是 macOS template：只能有黑色與透明，
  檔名結尾 `Template` 不能改，系統靠它判斷要依深淺模式上色。
- `package.json` 的 `name` 是 `meetpilot`：electron-builder 要求合法的 npm 套件名，中文名不行；產品名在 `build.productName`。

## 這個 repo 的已知地雷

- `server.ts` 的 middleware 順序有意義：限流 → Basic Auth → **音檔路由（`PUT audio` 與 app 內錄音的
  `PUT recording/chunks/:seq`）** → body parser → body parser 錯誤處理 → 其餘路由。往上搬 body parser 會讓未認證請求先吃 50MB；
  往下搬音檔路由會讓 100 分鐘的音檔先被讀進記憶體。
- overlap 秒數的唯一來源是 `services/transcriptMerge.ts` 的 `SLICE_OVERLAP_SECONDS`。
  W2 之後 import 它的只有 `services/transcriptionPipeline.ts`（前端已經不切片）；
  `services/audioSlicer.ts` **不 import 它**，overlap 是 `planSlices(total, sliceDuration, overlapSeconds)`
  的參數，由 pipeline 傳進去。切片邊界與去重上限因此保證同源。不要在任何地方寫回字面 15。
- **`PUT /api/meetings/:id/audio` 必須掛在 body parser 之前**，body 直接 pipe 進檔案。
  往後搬會讓 100 分鐘的音檔先被讀進記憶體，那正是 W2 要解掉的東西。限流與 Basic Auth 仍要在
  它前面：middleware 的順序是限流 → Basic Auth → **音檔路由** → body parser → body parser 錯誤處理 → 其餘路由。
- server 端切片需要 `ffmpeg` 與 `ffprobe`（`MEETPILOT_FFMPEG` / `MEETPILOT_FFPROBE`，不設走 PATH）。
  沒裝的時候三條 gate 照樣全綠（測試一律走注入的假 runner），**但那不等於轉錄驗過**，
  兩者不要混為一談。
- `services/httpGuards.ts` 的環境變數只收十進位整數（`/^\d+$/`）。`Number()` 會放行
  `6e1`、`0x3c`，設定看起來生效但值不是寫的那個。
- 不設 `trust proxy` 是刻意的（理由在 README），反向代理後全員共用一個限流桶。
- **錄音路由的「只收本機請求」（`isLoopbackAddress`）在同機反向代理後面會失效**：經代理轉進來的請求 socket 來源一律是
  loopback。2026-09-23 Codex review 提出，使用者裁定不改程式、只寫進文件（對外開放一律用 `HOST` 加 Basic Auth，
  不用同機代理；那種部署下整個 API 本來就沒有認證）。不要用 `X-Forwarded-For`、`Origin`、`Host` 補判斷：
  沒設 `trust proxy` 的前提下這些都是客戶端能偽造的 header。真的要支援同機代理，做法是錄音 API 另開只綁
  loopback 的 listener。
