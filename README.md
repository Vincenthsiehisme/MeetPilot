# MeetPilot（語音蒟蒻）

會議錄音 → 切片轉錄 → 結構化中文摘要 → 即時策略與問答。前端 React 19 + Vite，後端 Express 5 代理 Gemini API。

## 跑起來

```bash
cp .env.example .env    # 填 GEMINI_API_KEY
npm install
npm run dev             # http://127.0.0.1:3000
```

## 驗證

```bash
npx tsc --noEmit        # 型別檢查
npm test                # vitest，純函式單元測試
npm run build           # 前端與 server bundle
```

三條都要綠才算通過。`npm run lint` 等同第一條。

## 資料存在哪

**轉型中，目前兩邊都有。** 既有的 Job（會議 metadata、逐字稿、分析、音檔）在瀏覽器的 IndexedDB；
新的 Meeting 在 server 端 SQLite（`MEETPILOT_DB`，預設 `data/meetpilot.db`）。

搬到 server 是因為兩件事：處理狀態留在瀏覽器時換一台機器那場會就不存在；以及跨會議關聯要做
向量相似度查詢，IndexedDB 做不到。設計在 vault 的 `MeetPilot · 團隊知識回流 SDD`。

搬遷由前端發動，server 讀不到 IndexedDB：

```
POST /api/meetings/import   { jobs: Job[], blobIds: string[] }
```

**狀態：endpoint 可用，前端的入口還沒接上。** 目前只能自己撈出 IndexedDB 的內容後用 curl 呼叫；
畫面上的「搬遷」動作與「同時讀 server 與 IndexedDB」都還沒做，所以一般使用者的流程完全走舊路徑，
既有的 IndexedDB 資料不受影響。

回傳一份報告，四種結果分開列，不合併成一個數字：

| 欄位 | 意思 |
|---|---|
| `imported` | 這次寫進 SQLite 的 |
| `skippedExisting` | server 上已經有了，跳過不覆寫（重跑匯入是安全的） |
| `rejected` | 轉換不過去的，每筆帶原因。常見是 `status` 標成 COMPLETED 但缺逐字稿或分析 |
| `notes` | 轉過去了但要知道的事，例如原本處理到一半的會匯入後回到待處理 |
| `audioStillInBrowser` | **音檔這一期不搬**。`blobIds` 逐筆列出，每筆標 `imported` / `skippedExisting` / `rejected` / `orphan`，清掉 IndexedDB 之前它們重跑不了。**`rejected` 那群最要緊**，那正是要重跑的幾場 |

`action_items` 在這一步從 `string[]` 升級成物件陣列（`C-ANALYSIS` v2）。歷史待辦沒有狀態資訊，
一律補 `status: "unknown"`，不補 `open` 也不補 `done`：兩種都是編造。

缺 `createdAt`、缺 `updatedAt`、`transcript` 有值但不是陣列，這幾種一律整筆拒收，不補值也不
當成「沒有那個欄位」。判準是：分不出來的兩種空，等於兩種都沒擋。

讀取：`GET /api/meetings` 列表，`GET /api/meetings/:id` 單場（含逐字稿、分析、標籤）。

## 環境變數

見 `.env.example`。`MEETPILOT_DB` 是 SQLite 的位置，路徑不可寫時 server 直接起不來；
資料庫的 schema 版本比程式碼新時也拒絕開啟，不用舊程式碼往裡面寫。`npm run dev` 與 `npm start` 用 Node 的 `--env-file-if-exists=.env` 讀 `.env`，沒有那個檔就只吃 shell 環境變數。`HOST` 不是本機位址時必須設 `MEETPILOT_BASIC_AUTH_USER` 與 `MEETPILOT_BASIC_AUTH_PASSWORD`，server 才會啟動。`/api/*` 每個 IP 每分鐘最多 `MEETPILOT_API_RATE_LIMIT` 次（預設 60）。放在反向代理後面時所有使用者會共用同一個 IP 的額度，Express 沒設 `trust proxy`，這是刻意的：設了又沒限定代理位址，`X-Forwarded-For` 就能繞過限流。

每次 Gemini 呼叫會在 `MEETPILOT_LLM_LOG`（預設 `logs/llm.jsonl`）追加一行 JSON，設成 `off` 關閉。一次嘗試一行，fallback 鏈退了幾個模型、重試幾次都各自有一行，所以它回答得了「首選模型多常不可用」「撞限流時實際等多久」「一場會議燒多少 token」。**只記 metadata，不記逐字稿、提問或模型回覆**；拿不到的 token 數記成 `null`，不是 `0`。啟動時就開檔，路徑不可寫會直接讓 server 起不來。

看最近十次呼叫：

```bash
tail -10 logs/llm.jsonl | python3 -m json.tool --json-lines
```
