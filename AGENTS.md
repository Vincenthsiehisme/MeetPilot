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

目標分支 `main`。`npm run build` 會產生 `dist/`，驗證完記得 `rm -rf dist`，否則工作樹不乾淨。

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
server 端 ffmpeg）。下面這段的結論仍然成立，但那個具名 generator 的對照組**已經沒辦法重跑**；
repo 現存的 generator 只剩 `askDocumentStream` 一個（匿名）。下次要驗具名 generator 的行為，
得自己寫一個來試。

具名 generator 最危險：它會回東西，讓人以為 body 被解析過。`generateAudioSlices` 的兩筆是
`SLICE_OVERLAP_SECONDS`（來自 `audioService.ts:150` 的預設參數）與 `TranscriptSegment`
（**那個檔案裡一次都沒出現過**，`grep -c` 為 0、`git log -S` 查無歷史，是圖上憑空多出來的
邊），而 body 裡的 `getAudioDuration`、`extractAudio`、`resolveDuration` 全部缺席。
**非空不代表 body 被解析過，回傳的東西也不保證真的在那個檔案裡**；這份文件最初寫錯兩次，
都是拿沒看內容的 `callees` 筆數當證據。

所以 `callees` 對 generator 沒有意義，空和非空都不能當證據。要確認某個函式有沒有走共用
路徑，只有讀碼算數。`callers` 從共用函式那頭反查可以縮小範圍，但**它只到檔案層級**：
`codegraph callers postStream` 回的是 `file geminiService.ts`，不會指名 `askDocumentStream`。

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
| `services/geminiService.ts` | （空） | 真的空，沒有測試 import 它 |
| `server.ts` | （空） | 真的空 |
| `App.tsx` | （空） | 真的空 |

`services/audioService.ts` 與 `services/audioDuration.ts` 已於 W2 刪除，原本那兩列拿掉。
W2 新增的 `audioSlicer`、`audioFileStore`、`transcriptionPipeline`、`transcriptionQueue`、
`geminiServerClient`、`meetingClient`、`meetingAdapter` 各有同名測試，**尚未逐檔實測 affected 的覆蓋**，
別假設它們都查得到。

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

## 這個 repo 的已知地雷

- `server.ts` 的 middleware 順序有意義：限流 → Basic Auth → **音檔路由** → body parser →
  body parser 錯誤處理 → 其餘路由。往上搬 body parser 會讓未認證請求先吃 50MB；
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
