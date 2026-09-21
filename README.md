# MeetPilot（語音蒟蒻）

會議錄音 → 切片轉錄 → 依規範產出的會議記錄（帶逐字稿出處）→ 投影到 Obsidian vault。前端 React 19 + Vite，後端 Express 5 代理 Gemini API。

## 跑起來

前置需求：Node、以及 **ffmpeg（含 ffprobe）**。切片在 server 端用 ffmpeg 串流處理，
記憶體與會議長度無關，不再受瀏覽器分頁的記憶體限制。

```bash
brew install ffmpeg     # macOS；沒有它上傳的會議會轉 FAILED 並在 error 裡說要裝
cp .env.example .env    # 填 GEMINI_API_KEY
npm install
npm run dev             # http://127.0.0.1:3000
```

### 匯入與會者名單

全新安裝或升級到含與會者功能的版本後，先匯入 roster：

```bash
npx tsx scripts/importRoster.ts <csv-path>
```

匯入完成後，`GET /api/people` 才會回傳人員，建立會議時的 `ParticipantPicker` 才能列出與會者。
名單沒匯入時，至少一位與會者的建立規則會擋下所有新會議。

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
POST   /api/meetings/:id/link     重算跨會議關聯（READY / LINKED / LINK_FAILED 才行，同步等它跑完）
DELETE /api/meetings/:id          刪掉；正在跑的回 409，等它結束或失敗再刪
PATCH  /api/meetings/:id/transcript   改逐字稿或存潤稿
PATCH  /api/meetings/:id/analysis     改會議記錄
PATCH  /api/meetings/:id/title        改標題；畫面上的名字與下載檔名用它，分析完成時模型先填一個建議（只填還沒有標題的會）
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

`ANALYZING`（產出結論、待辦、未決事項）的規範正本在 `prompts/meeting-record-spec.md`，
`analyzeTranscript` 啟動時讀進 systemInstruction，不在程式碼裡另外抄一份規則。

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

### 切片接縫：去重與破洞

一場會切成多片送給模型，第 N 片與第 N+1 片刻意重疊 15 秒。合併時要把那段重複拿掉。

**去重看文字，不看時間戳。** 模型回的時間戳在片內會被壓縮——實測一場 65 分鐘的會，第 0 片
把 615 秒音檔的時間戳壓進 262 秒，其中一段 200 多字標成 7.5 秒。以時間為準的去重在那種片上
完全失效，同一段話會進逐字稿兩次而且沒有任何錯誤。

**重疊區同時是覆蓋度的量測工具。** 前一片的尾巴對得上後一片的開頭，代表前一片轉完了；
對不上代表**有一片沒把自己該轉的轉完，中間是破洞**（實測六個接縫有兩個是這種，
獨立轉錄那段音檔得到的內容有七成在合併結果裡找不到）。

每個接縫的判定寫進 `transcripts.seam_report`，`GET /api/meetings/:id` 以 `seamReport` 回傳：

```
{ sliceIndex, verdict: 'duplicate' | 'gap' | 'inconclusive', similarity, droppedSegments }
```

`verdict` 是 `gap` 不是警告，是**那個接縫有一段音檔沒有人轉過**。

**破洞會自動補。** 系統補轉一段跨接縫的橋接音檔，用同一套對齊接回去：橋接的開頭要接得上既有
逐字稿、結尾要接得上後一片的開頭，**兩端都錨得住才算數**，錨不住就把窗放大重試（120、300、
600 秒）。補回來的結果記在 `repair`：

```
repair: { outcome: 'repaired' | 'failed' | 'skipped', attempts, bridgeSeconds? }
```

- `repaired` — 補回來了
- `failed` — **試過但補不回來，那一段內容確實不在逐字稿裡**。不補假內容，也不假裝成功
- `skipped` — 沒試（修復關閉，或這場會的修復額度用完）。這是「還不知道有沒有缺」，跟 `failed` 不一樣

修復要花額外的 Gemini 呼叫，所以有煞車：一場會預設最多 6 次（`MEETPILOT_SEAM_REPAIR_BUDGET`），
`MEETPILOT_SEAM_REPAIR=off` 整個關掉。**預設是開的**：破洞是內容安靜消失，而音檔在分析成功
之後就刪了，之後補不回來。

刪除有一道幾何上限：只刪按新片自己的時間戳完全落在重疊區內的段落。超過那條線的音檔前一片
根本沒有，不可能是重複。代價是接縫偶爾留下一段沒刪乾淨的重複（實測六個接縫有一個），
那是刻意的取捨——**重複看得出來，掉字看不出來**。

**上傳音檔一律從頭轉錄**：`PUT` 在收檔之前就會清掉前一輪的逐字稿、分析與續傳游標。先清再寫是刻意的——
反過來的話，斷在「音檔已換、游標還沒清」的瞬間，重啟後會把新音檔的後半接到舊音檔的逐字稿後面。
續傳只發生在上面那張表的第一列，也就是 server 自己重啟後的掃描，不會因為重新上傳而沿用舊進度。

### 題目標籤：拿來跨會議比對的那一組

分析成功之後、狀態進 `READY` 之前，server 會再送一次 Gemini，從逐字稿抽出**題目標籤**
（`topic_tags`），那是之後判斷「兩場會在討論同一件事」的原料。

**這跟會議標籤是兩件事，不要混：**

| | 誰產的 | 存在哪 | 用途 |
|---|---|---|---|
| 會議標籤 | 使用者建立會議時自己打 | `meeting_tags` | 當分析 prompt 的背景 |
| 題目標籤 | 模型從逐字稿抽 | `topic_tags` | 跨會議比對 |

`GET /api/meetings/:id` 兩組分開回（`tags` 與 `topicTags`）。人工優先規則只套用在題目標籤上，
會議標籤本來就全是人打的。

**抽取用專屬 prompt，不能沿用 `analyze` 的那一份。** 那份是為「給人看的會議記錄」寫的，
會把一場會壓成 3 到 5 個抽象標題；實測在那個粒度下任何關聯策略都認不出同一題目。
專屬 prompt 的產出量級是一場會 15 到 25 條。prompt 在
`services/geminiServerClient.ts` 的 `EXTRACT_TAGS_SYSTEM_INSTRUCTION`，**改它要重跑評測**。

**抽不出標籤不會讓這場會失敗。** 分析已經成功，逐字稿與結論照樣可用，這場會仍然進 `READY`。
代價是那場會**永遠不會參與任何關聯**，所以結果留成資料而不是只寫 log：

| `meetings.topic_extraction_status` | 意思 |
|---|---|
| `NULL` | 還沒抽過（這個功能之前就存在的會、搬遷進來的會） |
| `ok` | 抽到了，標籤在 `topic_tags` |
| `empty` | 模型回了，但一條可比對的標籤都沒有 |
| `failed` | 呼叫或解析失敗，原因在 `topic_extraction_error` |

撈出「不會參與關聯」的會：

```sql
SELECT meeting_id, status, topic_extraction_status, topic_extraction_error
FROM meetings
WHERE status = 'READY' AND (topic_extraction_status IS NULL OR topic_extraction_status <> 'ok');
```

每條標籤除了給人看的 `title`，還存一個正規化後的比對鍵 `match_key` 與它的規則版本
`match_key_version`（規則在 `services/topicTag.ts`）。**改正規化規則就要把
`MATCH_KEY_VERSION` 加一**：不加的話，舊鍵與新鍵會用兩套規則混在同一張表裡比對，
而那不會有任何錯誤訊息，只會讓兩場本來對得上的會安靜地對不上。

**這一期還沒有任何產生 `source = 'manual'` 標籤的入口**（人工修正走 Obsidian vault 的受控區塊，之後才做），保護與測試先做在這裡：等入口做好才補，等於讓「重算會洗掉人工修正」這條路在中間裸奔，而它洗掉的當下沒有任何錯誤訊息。

重新解析（`retry`）會把 `source = 'auto'` 的標籤整組換掉，**`source = 'manual'` 的一條都不動**；
新抽出來的標籤若跟人改過的同一題目撞上（`match_key` 相同）就整條跳過，保留人工版本。
`empty` 與 `failed` 不刪既有標籤——這一輪沒抽到不代表上一輪抽到的是錯的。

### 跨會議關聯：哪幾場會在討論同一件事

題目標籤抽完、狀態進 `READY` 之後，server 接著算**跨會議關聯**，狀態走
`READY → LINKING → LINKED`（失敗是 `LINK_FAILED`）。

**兩段式，不是單一演算法：**

1. **S2 召回**：把每條題目標籤送去取 embedding，跟歷史會議的標籤兩兩算 cosine。
   至少 3 對標籤相似度 >= 0.7 才算候選。
2. **S3 判定**：候選（最多 20 場，按最高相似度排）逐一交給 Gemini，回「是不是同一個題目」、
   信心值、**一句判定理由**與共同題目清單。信心值 >= 0.5 才落地成關聯。

門檻與 prompt 在 `services/topicLink.ts` 與 `services/geminiServerClient.ts`。
**改它們要對評測集重跑並做前後比較**，不是改一個數字：關聯算錯的代價是人看到一則錯的關聯，
而信任回不來。同一個理由，改完要把 `LINK_ALGO_VERSION` 換掉。

向量存在 `topic_tag_embeddings`（float32 的 BLOB，帶 model 與維度）。**model 或維度對不上的兩條
標籤不會被拿去比**，那是「不知道」不是「不像」。向量在抽完標籤時就算，既有的會第一次算關聯時補上；
**換 embedding model 之後，舊 model 算的向量會在下一次關聯時自動重算**（不自動重算的話，舊向量會
被全部判成不可比，那些會就安靜地關聯不到任何東西，狀態卻是正常的 `LINKED` ＋ 空集合）。真的還有
比不了的向量時，`link_runs.incomparable_pairs` 會講出來。

**三種狀態在資料上分得開**，這是 `READY` 與 `LINKED` 要拆成兩個狀態的全部理由：

| 狀況 | `meetings.status` | `GET /api/meetings/:id` |
|---|---|---|
| 還沒算 | `READY` / `LINKING` | `links: []`、`linkRun: null` |
| 算過了，沒有同題目的會 | `LINKED` | `links: []`、`linkRun.candidates = 0` |
| 算了一部分（撞到額度） | `LINKED` | `linkRun.skipped_error > 0`、`linkRun.error` 有原因 |
| 算壞了（一對都沒判成功） | `LINK_FAILED` | `meeting.error` 有原因 |

**判的比候選少是常態**（有上限），所以每次計算的覆蓋率落在 `link_runs`，三種沒判到的原因分開數：

| 欄位 | 意思 |
|---|---|
| `candidates` | S2 過門檻的對數 |
| `judged` | 真的送去 S3 判過的對數 |
| `skipped_cap` | 超出 20 場上限、分數最低那幾對 |
| `skipped_excluded` | 人標過不相關的 |
| `skipped_error` | 撞到額度或呼叫失敗，還沒輪到的 |
| `incomparable_pairs` | embedding 的 model 或維度對不上、因此沒被比到的**標籤對**數。正常永遠是 0 |

撞到額度時**已經判出來的關聯留著**、狀態仍是 `LINKED`，`skipped_error` 與 `error` 說明沒判完；
一對都沒判成功才是 `LINK_FAILED`，而且**不動上一輪算出來的關聯**——這一輪沒算到不代表上一輪算到的是錯的。

撈出「算到一半就停了」的會：

```sql
SELECT meeting_id, judged, candidates, skipped_error, error FROM link_runs WHERE skipped_error > 0;
```

**被標為不相關的關聯不會復活。** 排除紀錄存在 `link_exclusions`（跟關聯分開兩張表：關聯可以
全量重建，人的判斷不行），原因分四種：`different_topic`、`outdated`、`not_needed`、`unspecified`。
重算時被排除的那幾對連 S3 都不會打。**這一期還沒有標記不相關的入口**（跟人工修正標籤一樣走
Obsidian vault 的受控區塊，之後才做），保護與測試先做在這裡，理由同題目標籤那一節。

**`MEETPILOT_LINKING=off` 整個關掉關聯。** 關掉時會議停在 `READY`——那是「還沒算」，
跟 `LINK_FAILED`（算了、失敗了）不是同一件事。關掉之後 `POST /api/meetings/:id/link` 回 503。

**目前沒有關聯品質的實測數字。** 這一版的機制有測試把關，但兩段式組合起來對評測集的
precision / recall 還沒跑過，門檻是沿用兩段各自單獨跑的結果推的。

### 投影到 Obsidian vault：一場會一份 markdown

會議有分析結果之後（`READY` 起，之後每次關聯重算），`VaultProjector`（`services/vaultProjector.ts`）
把它投影成獨立 Obsidian vault 裡的一份 markdown，路徑由 `MEETPILOT_VAULT` 指定，預設
`~/MeetPilot Vault`。**SQLite 是真相源，markdown 是可以整份重建的投影**：檔案砍掉重來不損失資料。

檔案分兩區：

- **系統區**（`<!-- meetpilot:auto:start -->` 到 `<!-- meetpilot:auto:end -->` 之間）：每次投影
  整份重寫，含結論、待辦、討論題目、題目標籤、相關會議。frontmatter 的 `auto_checksum` 是這一區
  內容的 sha256，**每次寫入前先驗證現場的值符不符**——不符代表人手動改過系統區，這時**不覆寫**，
  現有檔案（含它的人工區）整份另存為 `<原檔名>.conflict-<timestamp>.md`，新版才寫進原檔名。
- **人工區**（`## 我的修正` 底下 `<!-- meetpilot:manual:start -->` 到 `:manual:end`）：系統只讀不寫。
  **W5 只保留原文，不解析、不回寫**——解析人工區的指令（標不相關、修正題目標籤）並把它讀回 SQLite
  是 W6 才做的事。

身分靠 frontmatter 的 `meetpilot_id`（＝ `meeting_id`），**不靠檔名**：每次投影都重新掃一次 vault
建 `meetpilot_id → path` 的索引，所以人在 Obsidian 把檔案改名或搬動之後，下一次投影仍然找得到、
寫回原檔。檔名（`YYYY-MM-DD HHmm <標題>.md`，標題取 overview 前 30 字）只在第一次投影時決定，
之後系統永不更改，即使之後重新分析換了摘要，檔名也不會跟著變——wikilink 才不會全部一起斷掉。
**同一個 `meetpilot_id` 出現在兩個檔案（通常是人複製了檔案）會讓投影直接報錯**，不猜、不挑一個寫。

`meetpilot_status` 只在畫面上分三種，**空集合與未完成絕不能寫成同一句話**：`linked`（含空陣列，
即「算過了、沒有同題目的會」）、`linking`（還沒算完，涵蓋 `READY`／`MEETPILOT_LINKING=off` 的
穩定終態）、`link_failed`（帶原因與重試指令）。連結到的歷史會議若還沒被投影過，wikilink 用同一套
命名規則預先算出目標檔名，在 Obsidian 裡會先顯示未解析，等那場會自己被投影後才接上——**W5 不會
連帶投影它連結到的其他會議**，理由是那正是 W4 剩餘風險點名的「舊會議那一側被誤寫成剛重新計算過」。

寫入一律先寫暫存檔再原子 `rename`，理由同音檔上傳：同一個 vault 可能同時開著 Obsidian，非原子寫入
會讓它讀到截斷的檔。**不要把 `MEETPILOT_VAULT` 設成 AI Memory 那個 vault**：那個 vault 的
`vault-check.py` 對會議 markdown 有三條硬衝突（`status` 只收五個合法值、`INDEX_MIN` 要求每份筆記
被 index 列到、遞迴全掃沒有排除清單），而且它是 git repo、每個 session 自動快照，會議逐字稿的結論
與待辦會全部進版控。

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

`MEETPILOT_LINKING=off` 關掉跨會議關聯（預設開啟），關掉時會議停在 `READY`。

`MEETPILOT_VAULT` 是會議 markdown 投影到的 Obsidian vault 路徑，預設 `~/MeetPilot Vault`，沒有
off 開關；目錄不可寫時 server 直接起不來。細節見上面〈投影到 Obsidian vault〉。

每次 Gemini 呼叫會在 `MEETPILOT_LLM_LOG`（預設 `logs/llm.jsonl`）追加一行 JSON，設成 `off` 關閉。一次嘗試一行，fallback 鏈退了幾個模型、重試幾次都各自有一行，所以它回答得了「首選模型多常不可用」「撞限流時實際等多久」「一場會議燒多少 token」。**只記 metadata，不記逐字稿、提問或模型回覆**；拿不到的 token 數記成 `null`，不是 `0`。啟動時就開檔，路徑不可寫會直接讓 server 起不來。

看最近十次呼叫：

```bash
tail -10 logs/llm.jsonl | python3 -m json.tool --json-lines
```
