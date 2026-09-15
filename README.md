# MeetPilot（語音蒟蒻）

會議錄音 → 切片轉錄 → 結構化中文摘要 → 即時策略與問答。前端 React 19 + Vite，後端 Express 5 代理 Gemini API。

## 跑起來

前置需求：Node、以及 **ffmpeg（含 ffprobe）**。切片在 server 端用 ffmpeg 串流處理，
記憶體與會議長度無關，不再受瀏覽器分頁的記憶體限制。

```bash
brew install ffmpeg     # macOS；沒有它上傳的會議會轉 FAILED 並在 error 裡說要裝
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

**新的會議全部在 server。** Meeting、逐字稿、分析在 server 端 SQLite（`MEETPILOT_DB`，預設
`data/meetpilot.db`），音檔在 `MEETPILOT_AUDIO_DIR`（預設 `data/audio`）。前端只負責建立會議、
上傳音檔、polling 看進度，不再在瀏覽器裡切片或轉錄，也不再寫任何新資料進 IndexedDB。

搬到 server 是因為兩件事：處理狀態留在瀏覽器時換一台機器那場會就不存在；以及跨會議關聯要做
向量相似度查詢，IndexedDB 做不到。另有一個實證的理由：舊版整檔在分頁裡解碼，106 分鐘的會會讓
分頁崩潰。設計在 vault 的 `MeetPilot · 團隊知識回流 SDD`。

**舊資料還在瀏覽器。** 轉型前產生的 Job（metadata、逐字稿、分析、音檔）仍留在這台瀏覽器的
IndexedDB。側邊欄雙讀，兩區分開顯示：「伺服器上的會議」與「尚未搬到伺服器的本機紀錄」。
本機那一區是唯讀的，瀏覽器端的轉錄已經移除，停在處理中的舊紀錄不會再前進。

### 一場會走過的路

```
POST   /api/meetings              建立 Meeting（CREATED）
PUT    /api/meetings/:id/audio    上傳音檔，立刻回 202，轉錄在 server 背景跑（TRANSCRIBING）
GET    /api/meetings/:id          每 3 秒查一次進度（processed_slices / total_slices / status / error）
POST   /api/meetings/:id/retry    FAILED 的會重跑（音檔還在才行）
DELETE /api/meetings/:id          刪掉；正在跑的回 409，等它結束或失敗再刪
PATCH  /api/meetings/:id/transcript   改逐字稿或存潤稿
PATCH  /api/meetings/:id/analysis     改會議記錄
```

回 meeting 的三條路（`POST`、`PUT`、`GET`）送出來的不是資料庫裡的 `Meeting`，而是 `MeetingView`：多一個
`has_audio`，server 當下去看檔案系統的結果，不是資料庫欄位。需要它是因為 **`CREATED` 是兩種相反處境合用
一個狀態**——「建立了還沒上傳，等使用者給音檔」與「retry 之後在佇列裡排隊，音檔好好地在 server 上」。光看
狀態分不出來，而兩者該做的事相反：前者要顯示上傳入口，對後者顯示上傳入口是假話（下面那張表與 409 規則都
建立在這個區分上）。型別正本在 `services/meetingApi.ts`。

上傳的 body 是音檔本體（`Content-Type: application/octet-stream`），**不經 body parser、不做
base64**：base64 會先把整個檔案變成一條字串留在記憶體裡還膨脹 33%，那正是舊版把分頁弄崩的方式。

server 端一次只跑一場會（序列佇列），理由是 Gemini 的限流與每日額度，不是資源不夠。續傳游標是
`meetings.processed_slices`。音檔在**分析成功之後**才刪，轉錄或分析失敗時保留供重試。

重啟時會掃一次，三種處境分開處理：

| 重啟當下的狀態 | 處置 |
|---|---|
| `TRANSCRIBING`，音檔還在 | 從 `processed_slices` 續傳，已轉好的片段不重打 |
| `TRANSCRIBING`，音檔不在 | 轉 `FAILED` 並寫明原因。它確實斷在半路了，不留在 `TRANSCRIBING` 假裝還在跑 |
| `CREATED`，音檔不在 | **維持 `CREATED` 等上傳。** 它根本還沒開始跑，狀態本來就對，缺的只是音檔；轉成 FAILED 會變成死路（`PUT` 與 `retry` 都只收 CREATED 或有音檔的會） |
| `CREATED`，音檔在，游標是空的 | 重新入列從頭跑。這是「音檔上傳完了但還沒輪到它」 |
| `CREATED`，音檔在，游標不為空 | 重新入列**從游標續跑**。這是「retry 之後還在排隊」，那個游標是刻意保留的——retry 的用意就是不要為了重跑分析而連帶重跑兩小時的轉錄 |

沒上傳完的暫存檔（`<meeting_id>.audio.<uuid>.part`）也在這一步清掉。檔名帶 uuid 是因為同一場會
可能有兩個上傳同時在飛——雖然 server 端有 in-flight 鎖擋住第二個，唯一命名是跨 process 時的第二道防線。

已經在佇列裡等待轉錄的會**不接受重新上傳音檔**，回 409。不擋的話上傳會在 pipeline 正在讀那個檔的時候
把它換掉，產出前半來自舊音檔、後半來自新音檔的逐字稿，而且沒有任何錯誤。上傳失敗時 server 會把這場會的
音檔清乾淨，回到「等待上傳」——因為游標與逐字稿在收檔前就清了，留著舊音檔的組合更難解釋。

**上傳音檔一律從頭轉錄**：`PUT` 在收檔之前就會清掉前一輪的逐字稿、分析與續傳游標。先清再寫是刻意的——
反過來的話，斷在「音檔已換、游標還沒清」的瞬間，重啟後會把新音檔的後半接到舊音檔的逐字稿後面。
續傳只發生在上面那張表的第一列，也就是 server 自己重啟後的掃描，不會因為重新上傳而沿用舊進度。

### 把舊紀錄搬到 server

搬遷由使用者在本機那一區按「搬到伺服器」發動，不會自動觸發（server 讀不到 IndexedDB）：

```
POST /api/meetings/import   { jobs: Job[], blobIds: string[] }
```

回傳一份報告，五種結果分開列，不合併成一個數字：

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

本機紀錄搬完不會被自動刪除，要不要清掉由使用者自己決定。

## 環境變數

見 `.env.example`。`MEETPILOT_AUDIO_DIR` 是上傳音檔的落地位置；`MEETPILOT_FFMPEG` 與
`MEETPILOT_FFPROBE` 指定那兩支執行檔的路徑，不設就走 PATH。`MEETPILOT_DB` 是 SQLite 的位置，路徑不可寫時 server 直接起不來；
資料庫的 schema 版本比程式碼新時也拒絕開啟，不用舊程式碼往裡面寫。`npm run dev` 與 `npm start` 用 Node 的 `--env-file-if-exists=.env` 讀 `.env`，沒有那個檔就只吃 shell 環境變數。`HOST` 不是本機位址時必須設 `MEETPILOT_BASIC_AUTH_USER` 與 `MEETPILOT_BASIC_AUTH_PASSWORD`，server 才會啟動。`/api/*` 每個 IP 每分鐘最多 `MEETPILOT_API_RATE_LIMIT` 次（預設 60）。放在反向代理後面時所有使用者會共用同一個 IP 的額度，Express 沒設 `trust proxy`，這是刻意的：設了又沒限定代理位址，`X-Forwarded-For` 就能繞過限流。

每次 Gemini 呼叫會在 `MEETPILOT_LLM_LOG`（預設 `logs/llm.jsonl`）追加一行 JSON，設成 `off` 關閉。一次嘗試一行，fallback 鏈退了幾個模型、重試幾次都各自有一行，所以它回答得了「首選模型多常不可用」「撞限流時實際等多久」「一場會議燒多少 token」。**只記 metadata，不記逐字稿、提問或模型回覆**；拿不到的 token 數記成 `null`，不是 `0`。啟動時就開檔，路徑不可寫會直接讓 server 起不來。

看最近十次呼叫：

```bash
tail -10 logs/llm.jsonl | python3 -m json.tool --json-lines
```
