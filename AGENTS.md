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

索引在 `.codegraph/`（2026-09-14 建，`codegraph init`，34 檔 / 334 nodes / 981 edges）。
本機產物，不進版控。auto-sync 預設開啟，正常不用手動 `sync`。

定位或理解程式碼**先查拓樸再 grep**：

| 要回答的問題 | 指令 |
|---|---|
| X 怎麼走到 Y | `codegraph explore <query>`（MCP 是 `codegraph_explore`） |
| 改這個 symbol 會影響什麼 | `codegraph impact <symbol> --depth <n>` |
| 誰呼叫它 / 它呼叫誰 | `codegraph callers` / `codegraph callees <symbol>` |

**為什麼這個 repo 需要它**：2026-09-14 的修復只靠整檔讀加 grep，漏掉
`askDocumentStream` 繞過 `withRetry` 與 `postJson`（它自己 `fetch`），導致「撞 429 讀
`Retry-After`」那條修復沒涵蓋串流問答路徑。事後 `codegraph callees askDocument` 對
`codegraph callees askDocumentStream` 一比就看得出來：前者列出 `withRetry`、`postJson`，
後者是 `No callees found`。

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
