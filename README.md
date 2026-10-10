# MeetPilot（語音蒟蒻）

會議錄音 → 切片轉錄 → 依規範產出的會議記錄（帶逐字稿出處）→ 投影到 Obsidian vault。前端 React 19 + Vite，後端 Express 5 代理 Gemini API。

## 跑起來

前置需求：Node 22.13 以上（`node:sqlite` 從這版起不用旗標；CI 跑 Node 24）、以及 **ffmpeg（含 ffprobe）**。
切片在 server 端用 ffmpeg 串流處理，記憶體與會議長度無關，不再受瀏覽器分頁的記憶體限制。

macOS：

```bash
brew install ffmpeg     # 沒有它上傳的會議會轉 FAILED 並在 error 裡說要裝
cp .env.example .env    # 填 GEMINI_API_KEY
npm install
npm run dev             # http://127.0.0.1:3000
```

Windows（PowerShell）：

```powershell
winget install Gyan.FFmpeg   # 裝完要開新的終端機，PATH 才吃得到；或用 MEETPILOT_FFMPEG / MEETPILOT_FFPROBE 指定完整路徑
Copy-Item .env.example .env  # 填 GEMINI_API_KEY
npm install
npm run dev
```

網頁版在 Windows 上沒有語音備忘錄錄音：錄音按鍵不會出現，空狀態會顯示一行「錄音目前不能用」加原因，
只能拖檔或選檔上傳（見〈用語音備忘錄錄音〉）。Windows 上要錄音用桌面 app（見〈桌面 app〉的 app 內錄音）。
repo 的 `.gitattributes` 強制所有文字檔以 LF 取出，不要在本機另外設 `core.autocrlf` 去蓋它：規範檔換成
CRLF 會讓 `prompt_version` 跟 macOS 算出來的不一樣。

### 匯入與會者名單

全新安裝或升級到含與會者功能的版本後，先匯入 roster：

```bash
npx tsx scripts/importRoster.ts <csv-path>
```

匯入完成後，`GET /api/people` 才會回傳人員，建立會議時的 `ParticipantPicker` 才能列出與會者。
名單沒匯入時，至少一位與會者的建立規則會擋下所有新會議。

設了 `MEETPILOT_ROSTER_CSV`（見 `.env.example`）的話，server 啟動時若 people 表還是空的會自動
跑一次上面同一套匯入邏輯，不用每次重建資料庫都手動下指令；不設就維持原本行為，仍要手動執行
CLI。這仍然是 CLI 邏輯的重用，不是新增的 API 端點或前端介面。

### 把名單發到 gateway（多位記錄人）

多位記錄人各自跑 MeetPilot 時，名單改由 gateway（`meetpilot-gateway`，部署在 Vercel）發給每台 app，
admin 在自己的電腦發布一次：

```bash
npx tsx scripts/publishRoster.ts <csv-path>
```

macOS 與 Windows 同一行。腳本先驗 CSV，驗過才提示貼上 Blob token（Vercel 的 Blob store 頁面拿），輸入不顯示、
不進 shell history。

先用跟 CLI 匯入同一套 `parseRosterCsv` 整份驗過，有任何一列錯就整批不發；通過才上傳到 gateway
私有 Blob store 的 `roster/people.json`（`{ version: 1, rows }`，形狀在 `services/rosterDocument.ts`）。
名單是 PII，只放 Blob，不進任何 git repo。token 不要寫進 `.env`，也不要用 `BLOB_READ_WRITE_TOKEN=... 指令`
的寫法帶（會留在 shell history）；那個環境變數只給非互動環境（CI）用。

桌面 app 每次啟動向 gateway 拿名單，驗過（`parseRosterDocument`，欄位規則對齊 `parseRosterCsv` 的輸出）才寫成
userData 的 `roster.json`，server 以 `MEETPILOT_ROSTER_DOCUMENT` 指到它、**每次啟動都匯入**（upsert，跟 CSV 的
「people 表空的才補」不同）。所以 admin 發布新名單後，各台 app 下次啟動就拿到新增的人與改過的欄位；
**從名單拿掉的人不會從 app 裡消失**（upsert 不刪，跟「離職不刪除、只標 `active`」同一條規則，標記方式還沒做）。`MEETPILOT_ROSTER_DOCUMENT` 與
`MEETPILOT_ROSTER_CSV` 只能設一個，兩個都設 server 起不來。

### 用語音備忘錄錄音

畫面上的「開始錄音」會叫**跑 server 的這台 Mac** 上的語音備忘錄開始錄，按「停止錄音」後自動取回
那支錄音送進轉錄。錄音在語音備忘錄裡，關掉分頁、重新整理或 server 重啟都不會中斷。只支援 macOS，
而且只接受從這台 Mac 本機來的請求（`HOST` 開到區網時，別台電腦不能遠端打開這台的麥克風）。

**不要用同一台 Mac 上的反向代理（nginx、Caddy 等）對外開放 MeetPilot。** 「本機請求」看的是連線來源位址，
經同機代理轉進來的外部請求來源一律是 `127.0.0.1`，會被當成本機，錄音路由就擋不住遠端。而且那種部署下
`HOST` 還是本機位址，server 不會要求 Basic Auth，整個 API 都沒有認證。要讓別台電腦連進來，就把 `HOST`
設成對外位址並設 Basic Auth（見〈環境變數〉），這時錄音路由照樣只收本機。

語音備忘錄沒有 AppleScript 也沒有 URL scheme，只開放「捷徑」App 的動作，而且沒有任何動作會交出
錄音檔。所以要先在「捷徑」App 建三個捷徑，**名稱要一字不差**，server 用 `shortcuts run <名稱>` 呼叫：

| 捷徑名稱 | 內容 |
|---|---|
| `MeetPilot 開始錄音` | 語音備忘錄的「開始錄製新錄音」動作 |
| `MeetPilot 停止錄音` | 語音備忘錄的「停止錄音」動作 |
| `MeetPilot 取檔` | 「取得檔案夾的內容」，資料夾選 `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings`（選取視窗按 Cmd+Shift+G 貼路徑）；接「過濾檔案」：條件「副檔名不是 `waveform`」、排序「建立日期、最新優先」、限制 1 個 |

`MeetPilot 取檔` 的過濾條件一定要排除 `waveform`：每支錄音旁邊都有一個 `.waveform` 附屬檔（波形資料），
沒排除的話「最新一支」會拿到它，server 會回「取回的檔案讀不出長度」。錄音資料夾受 macOS 權限保護，
server 行程自己讀不到（`Operation not permitted`），授權是捷徑 App 拿的，server 不需要「完全取用磁碟」權限。
第一次執行時系統可能跳麥克風或資料夾存取的授權視窗。

三個捷徑缺任何一個，錄音按鍵不會出現，空狀態頁會寫出缺了哪一個（`GET /api/recording/availability`）。
建好之後重新整理頁面就會出現，不用重啟 server。

取回的檔案要對得上這場會才收：讀得到長度、建立時間落在開始與停止之間、長度跟實際錄的時間差不超過
10 秒（`services/voiceMemoRecorder.ts` 的 `RECORDING_CHECK`）。對不上（例如 iPhone 的錄音經 iCloud
同步進同一個資料夾，變成最新一支）就不送轉錄，會議退回「等待音檔」，從語音備忘錄把那支錄音拖進來就會接著跑。

`shortcuts run` 實測會間歇性卡住不回來（2026-09-23 連三次，之後又自己恢復），所以每個捷徑呼叫都有逾時上限
（`services/voiceMemoRecorder.ts` 的 `RECORDER_TIMEOUTS_MS`：開始、停止 20 秒，取檔 15 秒）。逾時會中止那次呼叫並講出
是哪個捷徑：停止逾時時這場會維持「錄音中」，再按一次停止即可；開始逾時時結果不明，語音備忘錄有可能晚一點才開始錄，
畫面會提示你看一眼語音備忘錄。卡住的呼叫不會把整台 server 的錄音操作鎖住。

還沒驗證的：筆電闔上或睡眠時語音備忘錄會不會繼續錄。

## 桌面 app（開發中）

多位記錄人各自在 Mac 或 Windows 上用的版本，Electron 包一層，裡面跑的就是上面這個 server（vault plan
`MeetPilot · 跨平台打包部署`）。目前做到外殼（E1）、隨附 ffmpeg（E2）、邀請碼設定畫面（E3）、app 內錄音（E4）
與從共享資料夾更新（E5）。

```bash
npm run ffmpeg:build -- mac-arm64   # 先編隨附的 ffmpeg（mac-arm64、mac-x64、win-x64），輸出到 vendor/ffmpeg/
npm run desktop        # 建置後直接開桌面 app（開發用）
npm run package:mac    # 產 .dmg（arm64 與 x64），輸出在 release/
npm run package:win    # 產 .exe 安裝程式（在 Windows 上跑）
node scripts/smokeDesktop.mjs <打包後的執行檔>   # 啟動打包後的 app，確認裡面的 server 有回應
```

- server 跑在 Electron 的 `utilityProcess` 裡（`electron/main.ts`），動態 port、只綁 `127.0.0.1`，主視窗載它。
- 資料全部在 userData：macOS `~/Library/Application Support/MeetPilot`，Windows `%APPDATA%\MeetPilot`。
  會議 markdown 投影到設定頁選的資料夾。server 的輸出寫在 userData 的 `logs/server.log`。
- **log 跟著會議記錄出去。** 每場會走到流程終點（投影完、轉錄 `FAILED`、分析失敗退回 `TRANSCRIBED`），
  `logs/server.log` 與 `logs/llm.jsonl` 整份複製到投影資料夾底下的 `_診斷/`，另寫一份 `info.json`
  （app 版本、平台、觸發的會議與狀態、每個檔複製了幾 bytes 或為什麼沒有）。投影資料夾在共享 OneDrive 裡，
  所以別台電腦出問題時不用請對方找檔案，直接看 `MeetPilot 記錄/<名字>/_診斷/`。**共享資料夾的成員都讀得到**：
  `llm.jsonl` 只有 metadata；`server.log` 沒有整份逐字稿，但有與會者人名、會議 id、投影資料夾路徑、
  錯誤訊息與 stack、題目標籤原文、從逐字稿抽出卻對不上名單的字串（不一定是人名）、邀請碼的 id（不是邀請碼本身）。
  失敗的會不會投影，它的這些內容只會經 `_診斷/server.log` 出去。
  寫不進去（資料夾不見了、Windows 上 OneDrive 正鎖著檔）只在 `server.log` 記一行，不影響會議，下一場會再寫。
- 關掉視窗只是縮到托盤，托盤選單的「結束 MeetPilot」才會停 server。同時只能開一個。
- server 掛掉會跳錯誤視窗，顯示結束碼與最後幾行輸出，由使用者選重新啟動或結束，不會安靜重啟。
- **隨附的 ffmpeg 是自己從官方原始碼編的最小版本**（`scripts/ffmpeg/build.sh`，參數在 `configure-flags.txt`）：
  只開 server 用得到的音訊解碼器、容器、WAV 輸出與重採樣，沒有 GPL 元件、沒有外部函式庫，授權 LGPL 2.1 以上，
  授權檔跟著放在安裝檔的 `ffmpeg/LICENSE-ffmpeg.txt`，`ffmpeg/NOTICE-ffmpeg.txt` 寫明版本、官方原始碼網址與 sha256、
  configure 參數，以及連進執行檔的三個 MIT 授權檔案聲明。原始碼固定 8.1.3 並驗 sha256，CI 另外驗官方簽章
  （金鑰指紋釘死在腳本裡，撤銷或過期的金鑰也拒絕）。兩個執行檔合計約 5.5 MB。
- 打包前 `scripts/ffmpeg/beforePack.cjs` 確認那個平台與架構的 ffmpeg 已經編好，缺了就讓打包失敗。
  `package:mac` 同時打 arm64 與 x64，兩個都要先編。
- 編完一定要跑 `npm run ffmpeg:verify -- <ffmpeg> <ffprobe>`：拿 `scripts/ffmpeg-fixtures/` 的測試音檔
  （21 支：語音備忘錄 m4a、ALAC、MP3、MediaRecorder 那種沒長度的 webm、Opus、Vorbis、FLAC、WAV、WMA、AAC、
  Android 的 AMR 與 AMR-WB、GarageBand 的 24-bit AIFF、QuickTime 的 24-bit／float LPCM、錄音筆常見的 IMA／MS ADPCM
  與 8-bit WAV、64-bit float WAV、MP2、CAF ima4。AMR 兩支是用合法格式手工組的雜訊，本機 ffmpeg 沒有 AMR 編碼器）
  跑 server 自己的 `createAudioSlicer`。少開一個解碼器，某種檔就會在轉錄一開始 FAILED，而三條 gate 照樣全綠。
  要支援新格式：在 `configure-flags.txt` 加元件、在 fixtures 加一支該格式的音檔，兩個都要。
- 打包後找不到隨附的 ffmpeg 會跳錯誤視窗，不退回 PATH（記錄人電腦上本來就沒有 ffmpeg）。
- **app icon 與托盤圖示是產生的**：圖案定義在 `scripts/icon/iconArtwork.ts`，`npm run icons:build`（只能在 macOS 跑，
  `.icns` 要用 `iconutil`）寫出 `build/icon.icns`、`build/icon.ico` 與 `electron/assets/` 的三張托盤圖，產出的圖一起 commit。
  要改樣子改 `iconArtwork.ts` 再重跑，不要手改圖檔。32px 以下（`.icns` 的 16、32 與 `.ico` 的 16、24、32）是照像素格手排的，
  `iconArtwork.test.ts` 守條與點排版時的外框落在整數像素（前傾的條渲染後邊緣本來就是斜的）、前傾之後離方塊左右仍留 1px，
  以及每個尺寸接到對的那一版（`renderPlan`）。macOS 26 會把形狀不合 Apple 格線的 icon 放進灰底框；目前的形狀是超橢圓近似，
  會不會被判不合要在 macOS 26 上裝起來看。要根治得改用 Icon Composer 的 `.icon`（electron-builder 支援，但要 Xcode 26 的 `actool`）。
- 安裝檔沒有簽章，第一次打開 macOS 要到「系統設定 → 隱私權與安全性」按「仍要打開」，Windows 的 SmartScreen
  要按「其他資訊 → 仍要執行」。
- **第一次打開是設定頁**（外殼自己的 `electron/setup.html`，server 還沒起來）：輸入 admin 給的邀請碼、選會議記錄資料夾。
  邀請碼向 gateway（`https://meetpilot-gateway.vercel.app`，repo `meetpilot-gateway`）換成 token，再拿 Gemini key 與名單；
  兩樣都到手才存設定、起 server。邀請碼本身不存。之後要換資料夾或邀請碼，從托盤選單的「設定…」。
- token 與 Gemini key 用 Electron `safeStorage` 加密後存在 userData 的 `credentials.json`（macOS 鑰匙圈的
  「MeetPilot Safe Storage」、Windows DPAPI）；安全儲存不能用的電腦不存，不退回明文。名單存 `roster.json`，
  投影資料夾存 `desktop-settings.json`，這兩個不加密：名單匯入後本來就以明文存在 SQLite。
  Windows 的加密金鑰（DPAPI 保護）存在 userData 的 `Local State`，Chromium 約十秒內或正常結束時才寫檔：
  設定完不到十秒 app 就被強制結束的話，下次打開登入資料解不開，設定頁會講原因、要重新輸入邀請碼。
- **每次啟動都向 gateway 更新 key 與名單。** 連不上（網路、逾時、5xx、回應內容不對）就用上次存的繼續，
  server 的畫面底部掛一條離線橫幅說哪一樣是舊的；gateway 回 401（邀請碼被撤銷）就刪掉 token、key、名單，
  回設定頁講原因，不退回上次的。撤銷只在啟動時檢查，app 一直開著不會中途停。
- 啟動 app 的環境變數 `GEMINI_API_KEY` 不再使用。
- **app 內錄音（E4）。** 桌面版的「開始錄音」用這台電腦的麥克風錄，不叫語音備忘錄（外殼給 server 設
  `MEETPILOT_RECORDER=in-app`）。選與會者的畫面下面選麥克風，上次選的記在這台電腦上。開始前會確認瀏覽器把
  回音消除、噪音抑制、自動增益三項前處理都關了，關不掉就不開始（這三項會壓掉會議室裡遠一點的人聲）。
  - 每 10 秒一段送到 server，接在 userData `audio/<meeting_id>.recording` 後面；按「停止錄音」時等所有段落送到，
    整支變成這場會的音檔進轉錄。格式是 webm／opus（64 kbps 單聲道，100 分鐘約 48 MB），隨附的 ffmpeg 解得開。
  - **關掉視窗會縮到系統匣繼續錄**，錄音中電腦不會閒置睡眠（`powerSaveBlocker`）；**筆電闔上、結束 MeetPilot、
    重新整理會中斷**。錄音中從托盤按「結束」會先問一次；托盤的「設定…」錄音中不開。
  - 錄音中的橫幅有音量條與「已送出幾段」；段落送不到（網路或 server 暫時出問題）會一直自動重送並顯示原因；
    連續一分鐘幾乎沒聲音會警告；麥克風被拔掉會停下來講出來，已錄的照樣可以送。
  - **macOS 開始錄音前先確認系統的麥克風權限**：還沒問過就請系統問，被拒就跳視窗講去哪裡打開（可直接開系統設定），
    這次不開始錄音。沒有權限時錄到的可能是一段空白，2026-09-24 第一次實機就是這樣（31 秒 7 KB）。
  - **整支音檔幾乎沒有聲音就不送去轉錄**（`services/audioLevel.ts`，app 內錄音與上傳的檔案都一樣）：從第一片開始量最大音量，
    每一片都低於 -45 dBFS 就讓這場會 FAILED，錯誤訊息講原因。空白的音檔送去 Gemini 會轉出一段編的內容，
    連與會者名字都用上，而且直接投影進共享資料夾。開頭安靜、後面有人說話的會議照常轉錄；中間某一片安靜不在這裡管。
  - 中斷之後（app 被結束、當掉、重新整理）那場會停在「錄音中斷了」，server 已經收到的段落都在，按「送出已錄的部分」
    就轉錄那一段；中斷之後的內容沒有錄到，不能接著錄，要另開一場。
  - 還沒驗證：Windows 實機（E6）、跟語音備忘錄同場對照的品質（AC-8）、長時間（100 分鐘）錄音、闔蓋再打開的行為。
- **從共享資料夾更新（E5，`electron/updater.ts`）。** 新版放在投影資料夾的上一層 `_更新/`，也就是 OneDrive 的
  `MeetPilot 記錄/_更新/`（投影資料夾是 `MeetPilot 記錄/<自己的名字>/`）。app 啟動時、每 4 小時、托盤「檢查更新…」各看一次；
  清單版本比這版新、安裝檔大小與 sha512 都對得上，才在托盤與畫面右上角提示「安裝新版」，按了才裝。
  - **發版（admin）：** 升 `package.json` 的 `version`，推上去等 CI 跑完，下載 `update-bundle` 這個 artifact，
    裡面的檔案（兩個 dmg、一個 exe、`meetpilot-update.json`）全部放進 `_更新/`，舊版的檔案刪掉。
    這包由 `scripts/writeUpdateBundle.ts` 產，少任何一個平台、或安裝檔版本跟 `package.json` 不一樣就不產。
    升版的 PR merge 之後，在那個 merge commit 打 `v<版本>` 的 tag，tag message 寫這版之後使用者看到什麼不一樣。
  - `_更新/` 對記錄人的群組只給檢視權限，只有 admin 能寫：安裝檔沒有簽章，app 會直接執行它。
  - Windows：安裝檔先複製到暫存、複本再驗一次雜湊，才以 `--updated /S --force-run` 靜默安裝，MeetPilot 結束、裝完自動重開。
    macOS：沒有簽章不能自動換版，打開 dmg 後結束，使用者把 MeetPilot 拖到「應用程式」取代，再自己打開。
  - 錄音中不裝（更新要結束 app），複製與驗雜湊之後、起安裝程式之前再擋一次。安裝檔還沒同步完（大小不對）只說
    「還在同步」；讀不了（OneDrive 正在寫、權限）講實際原因；大小對但雜湊不對、或清單讀不懂，提示卡改成警告、不給安裝，要通知 admin。
  - 起安裝程式之前在 userData 留 `update-pending.json`。安裝程式是 detached 起的、app 接著就結束，它失敗時沒有畫面，
    所以下次啟動比對版本：沒換成新版就跳一次「上次更新沒有完成」。暫存的安裝檔（`%TEMP%`／`$TMPDIR` 的 `MeetPilot-update/`）每次裝之前清掉。
  - 不用 electron-updater：它抓檔用的 `net.request` 不收 `file://`（Electron 44.4.5 實測），macOS 的自動安裝又要簽章。
  - 從 electron-builder 26 的 NSIS 模板讀到、實機還沒驗的：只裝給自己（per-user）的話，靜默更新從 registry 的
    `InstallLocation` 讀回原本的安裝目錄；第一次安裝時選了「所有使用者」的話，靜默更新會跳系統的權限詢問，按取消就沒裝（下次啟動會講）。
  - 還沒驗證：兩平台實際換版（AC-7，E6 實機）、OneDrive「檔案隨選」的佔位檔被讀時會不會自動下載、
    macOS 換版後鑰匙圈會不會跳詢問。

## 成本總覽

只給使用者自己看的估算，不進 app。腳本讀共享資料夾底下每位記錄人的 `_診斷/llm.jsonl`，算出分人、分月、逐場的花費與各步驟分項，寫成一份 `總覽.md`。

```bash
npm run cost:report                                   # 共享資料夾取桌面 app 設定檔 vaultDir 的上一層，輸出到 ~/MeetPilot 成本/
npm run cost:report -- --shared <共享資料夾> --out <輸出資料夾>
```

- 共享資料夾預設讀 `~/Library/Application Support/MeetPilot/desktop-settings.json`（Windows 是 `%APPDATA%\MeetPilot`）的 `vaultDir`，取它的上一層。讀不到設定又沒給 `--shared` 就報錯退出。共享資料夾底下每個子資料夾當一位記錄人。
- 輸出預設 `~/MeetPilot 成本/總覽.md`。`--out` 落在共享資料夾裡面會被拒絕，總覽不寫進共享資料夾。不設花費上限，只呈現。
- 價目表是 `scripts/geminiPrices.json`，每列 `{ model, effectiveFrom, inputPerM, audioInputPerM?, outputPerM }`，單位是每 1M token 美元。同一模型多列時取呼叫當下有效的那列。
  - 現行價取自 2026-10-10 讀的 Gemini API 價目頁，`effectiveFrom` 寫 `2026-01-01` 表示「往前沿用」（頁面沒寫起算日，紀錄最早 2026-09-16）。`gemini-3.8-flash` 在 2027-01-01 起換成較高的價，換價前後的呼叫分開算。價格改了就加新的一列，不改舊列。
  - 日期與月份一律用呼叫時間（`ts`）的 UTC 日期，跟台灣時間差 8 小時，換價日與月底附近的呼叫可能差一天。
  - `gemini-3.8-flash` 價目頁只列一個 input 價，轉錄也用它；有 `audioInputPerM` 的模型，`kind` 是 `transcribe` 的呼叫才用音訊價。
  - 估算 = `promptTokens` 乘 input 價，加（`outputTokens` + `thoughtsTokens`）乘 output 價。`thoughtsTokens` 沒有當 0。
  - 紀錄裡出現價目表沒有的模型，或呼叫日早於該模型最早的生效日，整份報錯，不當 0；補上價格再跑。
- `embed` 的紀錄沒有 token 數，列「未計」，不算進金額。三個 token 欄都是 null 的呼叫（失敗在拿到回應前）也列未計，不查價。
- 失敗的呼叫（`outcome` 不是 `ok`）只要有回傳 token 就照算進每場、每人、每月總額，另外單列「其中失敗重試」一欄。
- 會議標題是從同一位記錄人資料夾裡會議記錄的 frontmatter `meetpilot_id` 對回檔名；對不到的寫 meetingId 前 8 碼，`meetingId` 是 null 的列「未歸屬」。一場跨月會分成兩列，讓逐場加總等於分月。
- `_診斷/llm.jsonl` 只在會議走到終點時匯出，還在跑的會議不一定算進來。
- **卡住的會議。** 每位記錄人資料夾根目錄的 `_狀態.json`（app 每 60 秒與狀態有變時寫）也會讀，總覽的「會議狀態」一段把每一場只放進一類。沒有狀態檔的記錄人會寫「沒有狀態檔」，不會當成沒事；`schema` 不是 1 就報錯。
  - 卡住：`inProgress` 為 true，而且狀態檔 `writtenAt` 超過 10 分鐘沒更新（app 沒在跑），或這場的 `updatedAt` 超過 30 分鐘沒變。寫「卡多久」（從 `updatedAt` 算）與原因。
  - 處理中：`inProgress` 為 true、沒超時。
  - 錄音中：`RECORDING`，`updatedAt` 在 3 小時內；超過 3 小時改列需要處理，寫已過多久。
  - 需要處理：其餘 `inProgress` 為 false 的（`CREATED`、`FAILED`、`LINK_FAILED`，以及停在 `TRANSCRIBING`、`TRANSCRIBED`、`ANALYZING` 卻沒有進行中 job 的），寫狀態與 `error`。

## 驗證

```bash
npx tsc --noEmit        # 型別檢查
npm test                # vitest，純函式單元測試
npm run build           # 前端與 server bundle
```

三條都要綠才算通過。`npm run lint` 等同第一條。

GitHub Actions（`.github/workflows/ci.yml`）在 macOS 與 Windows 各跑一次三條 gate，再加一步正式版冒煙測試：
`npm prune --omit=dev` 拿掉 devDependencies 之後跑 `node scripts/smokeProduction.mjs`，用 `npm start`
啟動 `dist/server.cjs`，確認 `/api/health` 與前端頁回得出來。這一步守的是三條 gate 看不到的東西：
bundle 能不能在沒有開發工具的環境啟動，以及 `npm start` 在 Windows 上能不能跑。本機要跑它，先
`npm run build`；它的資料全部寫進暫存目錄，不碰 `data/`。

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
POST   /api/meetings/:id/recording/start  開始錄音（CREATED → RECORDING），只收本機請求。語音備忘錄模式叫它開始錄；
                                          app 內錄音模式只記開始時間（麥克風在頁面手上）
PUT    /api/meetings/:id/recording/chunks/:seq  app 內錄音的一段（原始位元組，不經 body parser）。只收下一段：
                                          重送已收到的回 200 目前進度，跳號 409，上一段還在寫 503
POST   /api/meetings/:id/recording/stop   語音備忘錄：停止、取回錄音、比對，對得上回 202 進轉錄（TRANSCRIBING），
                                          對不上 422 退回 CREATED。app 內錄音：body 帶 {"chunks":N}（段數對不上 409）
                                          或 {"partial":true}（救回中斷的錄音），一段都沒收到 422 退回 CREATED
GET    /api/recording/availability        這台 server 能不能錄，不能的話帶原因
GET    /api/meetings/:id          每 3 秒查一次進度（processed_slices / total_slices / status / error）
POST   /api/meetings/:id/retry    FAILED 重跑轉錄（音檔還在才行），或 TRANSCRIBED 重跑分析（不用重新轉錄）
POST   /api/meetings/:id/link     重算跨會議關聯（READY / LINKED / LINK_FAILED 才行，同步等它跑完）
DELETE /api/meetings/:id          刪掉；正在跑的回 409，等它結束或失敗再刪；語音備忘錄錄音中的先叫它停止，停不下來就不刪；
                                  app 內錄音的段落跟著刪
PATCH  /api/meetings/:id/transcript   改逐字稿或存潤稿
PATCH  /api/meetings/:id/analysis     改會議記錄
PATCH  /api/meetings/:id/title        改標題；畫面上的名字與下載檔名用它，分析完成時模型先填一個建議（只填還沒有標題的會）
```

回 meeting 的路（`POST`、`PUT`、`GET`、錄音的 start／stop）送出來的不是資料庫裡的 `Meeting`，而是 `MeetingView`：多一個
`has_audio`，server 當下去看檔案系統的結果，不是資料庫欄位；另一個 `recording_started_at` 只有 `RECORDING` 時有值，
畫面上的錄音計時從它接回來（存在 `recordings` 表）；`recording_method`（`voice_memo`／`in_app`）與
`recording_received_chunks`（app 內錄音已收到的段數）同樣只有 `RECORDING` 時有值。需要它是因為 **`CREATED` 是兩種相反處境合用
一個狀態**——「建立了還沒上傳，等使用者給音檔」與「retry 之後在佇列裡排隊，音檔好好地在 server 上」。光看
狀態分不出來，而兩者該做的事相反：前者要顯示上傳入口，對後者顯示上傳入口是假話（下面那張表與 409 規則都
建立在這個區分上）。型別正本在 `services/meetingApi.ts`。

上傳的 body 是音檔本體（`Content-Type: application/octet-stream`），**不經 body parser、不做
base64**：base64 會先把整個檔案變成一條字串留在記憶體裡還膨脹 33%，那正是舊版把分頁弄崩的方式。

容器裡沒寫長度的檔（瀏覽器 `MediaRecorder` 錄的 webm，ffprobe 讀長度回 `N/A`）在轉錄一開始會先
`ffmpeg -c copy` remux 成 matroska 蓋回原檔、再讀一次長度（`audioSlicer.probeDurationRemuxingIfMissing`），
不重新編碼。以前這種檔會直接 FAILED。

轉錄與分析各自是一條持久化的 SQLite job queue（`services/jobStore.ts`／`services/jobWorker.ts`），
不是同一條鏈：轉錄完成（`TRANSCRIBED`）之後自動排一個分析 job，但兩者各自有自己的並行量
（`MEETPILOT_TRANSCRIPTION_CONCURRENCY`／`MEETPILOT_ANALYSIS_CONCURRENCY`，預設都是 1）、各自失敗
各自重試，分析失敗不會連坐已經轉錄成功的逐字稿——退回 `TRANSCRIBED`，逐字稿還在，`POST retry`
可以只重跑分析。續傳游標是 `meetings.processed_slices`。音檔在**分析成功之後**才刪，轉錄或分析
失敗時保留供重試。

`ANALYZING`（產出討論、結論、待辦、未決事項）的規範正本在 `prompts/meeting-record-spec.md`，
`analyzeTranscript` 啟動時讀進 systemInstruction，不在程式碼裡另外抄一份規則。討論段每個議題是
「走到哪」一兩句加條列要點，每點都帶逐字稿出處、不標提出者（`C-ANALYSIS` 的 `topics[].points`，加欄位、
`contract_version` 不動；舊會議沒有 `points`，照原本只顯示整段內容，不會自動重跑）。網頁、列印、匯出、
vault 投影都把出處印成接在要點後面的縮小時間標籤。

重啟時分兩步：

1. **回收上一個 process 留下的 job**（`jobStore.reclaimAllActive`）：單一 process 前提下，
   一個新啟動的 process 看到 job table 裡還停在 `claimed`／`running` 的列，那一定是上一個
   process 死掉留下的，不用等 lease 到期，啟動當下就無條件回收，退回 `queued` 重試
   （或用盡重試次數轉 `failed`）。
2. **補齊沒有 active job 的在途會議**（`backfillInterruptedMeetings`）：涵蓋這次升級前留下的
   舊資料，或 `PUT audio`／`POST retry` 先改狀態再 enqueue job 之間極短的競態窗口。

| 掃到的狀態 | 處置 |
|---|---|
| `TRANSCRIBING`，音檔還在，沒有 active 轉錄 job | 補一個轉錄 job，從 `processed_slices` 續傳，已轉好的片段不重打 |
| `TRANSCRIBING`，音檔不在 | 轉 `FAILED` 並寫明原因。它確實斷在半路了，不留在 `TRANSCRIBING` 假裝還在跑 |
| `CREATED`，音檔不在 | **維持 `CREATED` 等上傳。** 它根本還沒開始跑，狀態本來就對，缺的只是音檔；轉成 FAILED 會變成死路（`PUT` 與 `retry` 都只收 CREATED 或有音檔的會） |
| `CREATED`，音檔在，沒有 active 轉錄 job | 補一個轉錄 job；游標是空就從頭跑，游標不為空就是 retry 之後還在排隊，從游標**續跑**（保留游標是刻意的——retry 的用意就是不要為了重跑分析而連帶重跑兩小時的轉錄） |
| `ANALYZING` 或 `TRANSCRIBED`，沒有 active 分析 job | 補一個分析 job，讀「目前顯示的版本」（`getCurrentTranscript`）決定 payload |
| `RECORDING` | **不動。** 語音備忘錄的錄音在語音備忘錄裡，server 重啟不影響它；開始時間在 SQLite，重開頁面照樣看得到計時與停止按鍵。app 內錄音的 `<id>.recording` 不是 `.part`，啟動清理不會刪它 |

沒上傳完的暫存檔（`<meeting_id>.audio.<uuid>.part`）也在啟動時清掉。檔名帶 uuid 是因為同一場會
可能有兩個上傳同時在飛——雖然 server 端有 in-flight 鎖擋住第二個，唯一命名是跨 process 時的第二道防線。

已經在轉錄佇列裡的會**不接受重新上傳音檔**，回 409。不擋的話上傳會在 pipeline 正在讀那個檔的時候
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
資料庫的 schema 版本比程式碼新時也拒絕開啟，不用舊程式碼往裡面寫。`npm run dev` 與 `npm start` 用 Node 的 `--env-file-if-exists=.env` 讀 `.env`，沒有那個檔就只吃 shell 環境變數。`HOST` 不是本機位址時必須設 `MEETPILOT_BASIC_AUTH_USER` 與 `MEETPILOT_BASIC_AUTH_PASSWORD`，server 才會啟動。`/api/*` 每個 IP 每分鐘最多 `MEETPILOT_API_RATE_LIMIT` 次（預設 60）。開發模式的熱更新 port 可用 `MEETPILOT_HMR_PORT` 改（預設 24678），同機跑第二個 `npm run dev` 時要設，`scripts/worktreeSetup.ts` 開的 worktree 會自動寫好。放在反向代理後面時所有使用者會共用同一個 IP 的額度，Express 沒設 `trust proxy`，這是刻意的：設了又沒限定代理位址，`X-Forwarded-For` 就能繞過限流。同機反向代理另有兩個問題：`HOST` 是本機位址所以不要求 Basic Auth，而且語音備忘錄錄音的「只收本機請求」會失效，見〈用語音備忘錄錄音〉。

`MEETPILOT_RECORDER` 決定新的錄音怎麼開始：`voice-memo`（預設，叫本機語音備忘錄）或 `in-app`（頁面自己用麥克風錄、分段送上來，桌面 app 用這個）。寫錯值 server 起不來。已經在錄的那場照它開始時的方式收尾，不看現在的設定。

`MEETPILOT_LINKING=off` 關掉跨會議關聯（預設開啟），關掉時會議停在 `READY`。

`MEETPILOT_VAULT` 是會議 markdown 投影到的 Obsidian vault 路徑，預設 `~/MeetPilot Vault`，沒有
off 開關；目錄不可寫時 server 直接起不來。細節見上面〈投影到 Obsidian vault〉。

每次 Gemini 呼叫會在 `MEETPILOT_LLM_LOG`（預設 `logs/llm.jsonl`）追加一行 JSON，設成 `off` 關閉。一次嘗試一行，fallback 鏈退了幾個模型、重試幾次都各自有一行，所以它回答得了「首選模型多常不可用」「撞限流時實際等多久」「一場會議燒多少 token」。**只記 metadata，不記逐字稿、提問或模型回覆**；拿不到的 token 數記成 `null`，不是 `0`。啟動時就開檔，路徑不可寫會直接讓 server 起不來。

撞到限流（429、`RESOURCE_EXHAUSTED`）時照回應的 `retryDelay` 等，夾在 1 到 60 秒，回應沒給就 5 秒起跳、每次加倍，
都加 0～1 秒 jitter；同一個模型的第二次也撞到就直接換下一個模型，不再等（各模型額度分開算）。回應看得出是每日額度
用完（`quotaId` 含 `PerDay`）就不在那個模型上等，直接換。embedding 不換模型，限流最多試 3 次。每次因限流而等待，
那一行的 `backoffMs` 記等了幾毫秒、`backoffSource` 記時間從哪來（`retry-info`、`backoff`，每日額度用完換模型是
`daily-quota` 加 0）；空輸出與 503 仍固定等 1、2 秒，這兩欄是 `null`。2026-09-29 以前的紀錄沒有這兩欄。
**429 的回應格式照 Gemini API 公開文件寫，還沒有實際樣本**，解析不到就當沒給，照樣走退避。

`MEETPILOT_SERVER_LOG` 是 server 輸出所在的檔，只有桌面 app 設（`electron/serverEnv.ts`）；有設才會在會議跑完時
把它和 `MEETPILOT_LLM_LOG` 複製進投影資料夾的 `_診斷/`（見〈桌面 app〉）。網頁版不設，啟動時印一行講明不複製。
`MEETPILOT_APP_VERSION` 同樣由桌面 app 設，寫進 `_診斷/info.json`。

`MEETPILOT_GEMINI_MAX_CONCURRENCY`（預設 2）是所有 Gemini 呼叫共用的全域併發上限，不管是轉錄還是分析發出的請求。目前處理仍是完全序列，這個值暫時不會改變任何行為。

看最近十次呼叫：

```bash
tail -10 logs/llm.jsonl | python3 -m json.tool --json-lines
```
