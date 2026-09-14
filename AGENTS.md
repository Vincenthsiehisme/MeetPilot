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

## CodeGraph 的兩個盲區（實測，別踩）

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
| `export const askDocument = async () => {}`（arrow） | body 的呼叫查得到 |
| `export const askDocumentStream = async function* ()`（匿名 generator） | **空的** |
| `export async function* generateAudioSlices()`（具名 generator） | **只有預設參數與型別，body 的呼叫一個都沒有** |

具名 generator 最危險：它會回東西（`generateAudioSlices` 回 `SLICE_OVERLAP_SECONDS` 與
`TranscriptSegment`，都來自 signature），body 裡的 `getAudioDuration`、`extractAudio`、
`resolveDuration` 全部缺席。**非空不代表 body 被解析過**，這份文件最初就是踩這個坑寫錯的。

所以 `callees` 對 generator 沒有意義，空和非空都不能當證據。要確認某個函式有沒有走共用
路徑，只有讀碼算數。`callers` 從共用函式那頭反查可以縮小範圍，但**它只到檔案層級**：
`codegraph callers postStream` 回的是 `file geminiService.ts`，不會指名 `askDocumentStream`。

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
| `services/audioDuration.ts` | `audioDuration.test.ts` | — |
| `services/printDocument.ts` | `printDocument.test.ts` | — |
| `services/escapeHtml.ts` | `escapeHtml.test.ts`、`printDocument.test.ts` | — |
| `services/storageService.ts` | **（空）** | **假的空。有 7 條測試**，但 `storageService.test.ts` 用 `vi.resetModules()` ＋ `await import('./storageService')` 動態載入（為了清模組層的連線快取），圖上沒有 import 邊 |
| `services/geminiService.ts` | （空） | 真的空，沒有測試 import 它 |
| `services/audioService.ts` | （空） | 真的空 |
| `server.ts` | （空） | 真的空 |
| `App.tsx` | （空） | 真的空 |

所以改到後面五個檔案時，`affected` 回空**不代表不用跑測試**，三條 gate 一律照跑。
改 `storageService.ts` 一定要手動指定 `services/storageService.test.ts`。

## 這個 repo 的已知地雷

- `server.ts` 的 middleware 順序有意義：限流 → Basic Auth → body parser → body parser 錯誤處理 → 路由。
  往上搬 body parser 會讓未認證請求先吃 50MB。
- overlap 秒數的唯一來源是 `services/transcriptMerge.ts` 的 `SLICE_OVERLAP_SECONDS`，
  `App.tsx` 與 `generateAudioSlices` 都 import 它。不要在任何地方寫回字面 15。
- `services/httpGuards.ts` 的環境變數只收十進位整數（`/^\d+$/`）。`Number()` 會放行
  `6e1`、`0x3c`，設定看起來生效但值不是寫的那個。
- 不設 `trust proxy` 是刻意的（理由在 README），反向代理後全員共用一個限流桶。
