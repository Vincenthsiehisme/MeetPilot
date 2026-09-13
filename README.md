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

## 環境變數

見 `.env.example`。`npm run dev` 與 `npm start` 用 Node 的 `--env-file-if-exists=.env` 讀 `.env`，沒有那個檔就只吃 shell 環境變數。`HOST` 不是本機位址時必須設 `MEETPILOT_BASIC_AUTH_USER` 與 `MEETPILOT_BASIC_AUTH_PASSWORD`，server 才會啟動。`/api/*` 每個 IP 每分鐘最多 `MEETPILOT_API_RATE_LIMIT` 次（預設 60）。放在反向代理後面時所有使用者會共用同一個 IP 的額度，Express 沒設 `trust proxy`，這是刻意的：設了又沒限定代理位址，`X-Forwarded-For` 就能繞過限流。
