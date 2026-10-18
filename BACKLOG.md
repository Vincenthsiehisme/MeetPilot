# MeetPilot：沒做完的事

這份只寫「已知、還沒排進任何 plan」的事。做到的那個 PR 同時刪掉那一條：結案靠 git，刪掉就算解掉，留著過期的條目比沒有清單更糟。

每一條有一個不會變的名字，沒有編號。節裡固定三樣：一段說明、一行錨點、一行來源。錨點是這件事碰到的地方，只收三種：反引號包的 repo 相對路徑、反引號包的函式名、規格正本的〈節名〉；開 plan、改碼、開 PR 時拿它比對，碰到了就浮出來問這次要不要做。來源是 vault 裡記下這件事的 plan。

登記用 vault 的 `checkpoint.py --open`，格式用 `checkpoint.py --backlog-check` 驗，不要手寫新條目。

- 規格正本：`AGENTS.md`

## `切片破洞修補沒成功`

W2-2 AC-1 在真實模型上修補破洞 0／2 成功，反證修法；要先開診斷 plan 找破洞成因，碰 `services/transcriptionPipeline.ts` 與 `services/geminiServerClient.ts` 的轉錄 prompt（2026-10-03 使用者結案記 fail）

- 錨點：`services/transcriptionPipeline.ts`、`services/geminiServerClient.ts`
- 來源：MeetPilot · 團隊知識回流 W2-2 切片覆蓋與去重

## `切片接縫重複沒降到門檻`

W2-2 AC-2 接縫殘餘 0.505／0.229，未達 0.20，重跑原料 final.json 已遺失；去重正本在 `services/transcriptMerge.ts`，重評要先決定是否落地逐片原始輸出（2026-10-03 使用者結案記 fail）

- 錨點：`services/transcriptMerge.ts`
- 來源：MeetPilot · 團隊知識回流 W2-2 切片覆蓋與去重
