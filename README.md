# 政見支票

檢視 2014、2018、2022 三屆六都市長當選人的選舉政見，讓使用者依生活經驗投票評估政見是否兌現。

## 技術架構

- Cloudflare Worker：API、Google OAuth 2.0 Authorization Code + PKCE
- Cloudflare Workers Static Assets：原生 HTML、CSS、JavaScript 前端，無前端框架與執行期套件
- Cloudflare D1：使用者、出生／工作縣市、Session、投票與唯一性約束
- Cloudflare KV：快取不含投票結果的靜態政見目錄；票數永遠直接讀 D1
- Go：把原始 Excel 活頁簿轉成可重跑、可版控的 D1 migration

投票資料的唯一約束是 `(user_id, promise_id)`。使用者更新選擇時會修改同一筆資料，不會增加票數。投票 API 也會確認該政見的縣市在使用者設定的出生地或工作地之中。

## 本機執行

需求：Node.js 22 以上、Go 1.22 以上。

```sh
npm install
npm run seed
npm run db:migrate:local
cp .dev.vars.example .dev.vars
npm run dev
```

`npm run seed` 會讀取專案根目錄的 `縣市首長當選人政見整理.xlsx`，並覆寫 `migrations/0002_seed.sql`。生成器會檢查來源仍為 18 位當選人與 134 項政見，避免欄位偏移後靜默匯入錯誤。

若只想瀏覽資料與介面，可以先不設定 Google OAuth；登入按鈕會等設定完成後才可使用。

## Google 登入設定

在 Google Cloud Console 建立 Web application OAuth client，加入以下 redirect URI：

- 本機：`http://localhost:8787/auth/google/callback`
- 正式站：`https://你的網域/auth/google/callback`

本機將以下值放進 `.dev.vars`：

```dotenv
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
SESSION_SECRET="至少 32 字元的隨機字串"
```

正式環境使用 Wrangler secret，不要把憑證寫入 `wrangler.jsonc`：

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

如正式 redirect URI 與 Worker 網址不同，將 `wrangler.jsonc` 的 `GOOGLE_REDIRECT_URI` 改為完整 callback URL。

## 建立 Cloudflare 資源

```sh
npx wrangler d1 create mayors-in-promises
npx wrangler kv namespace create CACHE
```

把兩個指令回傳的 ID 分別填入 `wrangler.jsonc` 的 `database_id` 與 KV `id`，再執行：

```sh
npm run db:migrate:remote
npm run deploy
```

部署前可用以下指令完整檢查型別、前端 JavaScript 與 Go 匯入工具：

```sh
npm run check
npx wrangler deploy --dry-run
```

## 資料與結果說明

原始活頁簿收錄六個直轄市、三屆共 18 位當選人、102 個政見分類與 134 項政見。頁面上的比例代表本站參與者的生活體感，不能取代官方施政報告、預算執行資料或獨立事實查核。

