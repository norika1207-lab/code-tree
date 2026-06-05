# Code Tree — 完整交接文件（給另一個 AI 讀）

這份文件描述 Code Tree 這個專案的「設計目標、架構、所有功能、每一個檔案路徑與作用」。
寫給接手的 AI / 工程師看，讓它不用重讀整個 codebase 就能掌握全貌。

- Repo 根目錄：`/Users/norikaoda/Dropbox/Code Tree`
- GitHub：`https://github.com/norika1207-lab/code-tree`
- npm 套件名（未發佈，卡在帳號 2FA）：`code-tree`（unscoped）
- 安裝後的 app：`/Applications/Code Tree.app`（bundleId `com.norika.codetree`）
- VPS 部署：`sportverse:/opt/codetree/Code-Tree-0.1.0-arm64.dmg`
- 執行時 user data：`~/Library/Application Support/code-tree/`
  - `prefs.json`（記住上次開的專案）
  - `codetree.log`（Electron 啟動 log，debug 第一手）
  - `no-project/`（跟隨模式用的空暫存資料夾）

---

## 0. 使命（Mission）— 先讀這段，這是「為什麼存在」

**Code Tree 要成為全世界獨立開發工作者的「入口」。**

一句話使命：**讓一台窮人的文書電腦，在完全離線、不付任何訂閱費、不付任何 API 費的情況下，也能寫程式、開發網站，而且體驗跟連線狀態一模一樣。**

這條使命決定了每一個工程取捨：
- **為什麼一定要離線也能用**：核心目的就是「斷線也能像連線一樣開發」。所以有本機模型路徑（Ollama / vLLM / llama.cpp），零雲端登入也能跑 agent。
- **為什麼一定要把檔案做小**：要整合作者自己新訓練出來的模型（能力目標不輸 Claude，尺寸約 800MB），加上 Code Tree 本體，**整包控制在 1GB 以內**。一個人下載一次，從此免訂閱、免 API、離線可用。檔案大 = 違反使命。
- **為什麼一定要視覺化（使命級，不是裝飾）**：沒有經驗的人「沒有系統架構的概念」。把 codebase 畫成一棵會自己長、自己亮的樹之後，他們會「看著看著就慢慢理解程式架構是怎麼組成的」，之後自己開發就有 sense。**視覺化 = 替沒有導師的人，當架構導師。**
- **為什麼要內建各種版型（design 層）**：讓沒經驗的人也能一步做出像樣的網站介面，而不是 AI slop。

定位總結：**程式（本機模型）+ 介面（視覺化世界樹 + 版型）+ 開發工具（agent）= 一個免費、離線、給所有人的開發入口。** 想登入 Claude / GPT 的人也可以選，但預設不需要任何雲端帳號。這就是 Code Tree 存在的理由，後面所有功能都是為這條服務。

---

## 1. 設計目標 / 北極星（North Star）

一句話：**一個會自己跟著開發者跑的「程式碼世界樹」。左邊是真實終端機，右邊是把整個 codebase 畫成一棵樹；開發者（或 AI agent）動到哪個檔案，鏡頭就飛到那一格，那一格亮起來、程式被即時塞進去。**

核心信條（違反就是做錯）：
1. **絕不要使用者按按鈕告訴它「這是哪個專案」。** 樹要自動跟隨終端機的 cwd（本機 `cd` 或 `ssh` 進遠端都要跟）。
2. **不准造假。** 不顯示估算/編造的數字（曾經有個「Waste $X」假指標已被移除）。畫面上的 token 數、檔案、格子都必須是真的。
3. **AI 處理的每一步都要看得見。** 不要「(agent working…)」黑盒；讀檔、改檔、每一句推理都要逐行印在畫面上並留著。
4. **被改的檔案，右邊對應的格子要亮起來，而且看得到程式一行行被塞進去。**
5. 終端機介面（CLI）裡，對話從「最上面」往下印，命令列「釘在最底部」，不要浮在中間。

商業定位：開發者工具，先用 macOS app / CLI 變現（npm + DMG）。作者主要在遠端機器（sportverse 等）用 ssh 開發，所以「遠端專案跟隨」是一等公民功能。

---

## 2. 兩種前端 + 一個共用後端（整體架構）

Code Tree 有「兩個入口」，但共用同一個 core：

```
                    ┌─────────────────────────────────────────┐
   入口 A：CLI       │  bin/cosmos-tree.js  (Ink 終端機 TUI)      │
   `code-tree .`    │  左：agent 對話逐行印  右：footprint flow   │
                    └───────────────┬─────────────────────────┘
                                    │ 直接 import startCore + 自己跑 agent
                                    ▼
   入口 B：Electron  ┌─────────────────────────────────────────┐
   App（雙擊開）      │  electron/main.js → startCore()           │
   或 `codetree .`  │  視窗載入 http://localhost:7790/          │
                    └───────────────┬─────────────────────────┘
                                    ▼
                    ┌─────────────────────────────────────────┐
   共用後端 core     │  src/core/server.js  startCore()         │
                    │  - file watcher (chokidar) → 掃描 codebase│
                    │  - 建 Graph（cells + import edges）        │
                    │  - WebSocket 7778 廣播 state/active/...   │
                    │  - HTTP 7790 服務 terminal.html / cosmos  │
                    │  - 多分頁 node-pty 真實 shell             │
                    │  - cwd 跟隨（本機 lsof / 遠端 prompt 解析）│
                    │  - MASL gate / token bar / 遠端 ssh 來源   │
                    └─────────────────────────────────────────┘
```

Web 端（Electron 視窗或瀏覽器 `localhost:7790`）：
- `src/web/terminal.html`：主畫面。左邊真實終端機（xterm + node-pty，多分頁），右邊用 `<iframe>` 嵌入世界樹。上方 token 列。
- `src/web/cosmos.html`：世界樹本體（D3 畫的 cards + import 連線 + flow + issue radar + change ledger）。

通訊協定（WebSocket 7778）：
- core → 前端廣播：`state`（cells+edges）、`active`（現在在哪個檔）、`activity`（某檔被改）、`project`（切根目錄）、`tokens`、`recall`、`token_by_file`、`gate`（MASL 攔截）、`anomaly`。
- 前端 → core：`pty_start` / `pty_input` / `pty_resize` / `pty_close` / `tab_active`（多分頁終端機）、`revert`（還原檔案）、`run`、`gate_reply`、`cli_usage`、`tokens_clear`。

---

## 3. 完整檔案地圖（每個路徑 + 作用）

### 入口 / 啟動
- `bin/cosmos-tree.js`（583 行）— **CLI 主程式**。Ink + React 寫的終端機 TUI。借用 Claude Code 登入直接跑 agent；左邊逐行印 agent 的每一步、右邊畫 footprint flow；Tab 切換完整樹狀檢視。對話從上往下印、命令列釘底。支援引擎切換（見下）。
- `bin/codetree.js` — `codetree [path]` 啟動器，像 `code .`。把目標目錄用環境變數 `CODE_TREE_ROOT` 傳進 Electron，main.js 讀到就直接開那個專案、不彈 picker。

### Electron 殼層
- `electron/main.js`（207 行）— Electron 主程序。啟動流程、開視窗、`startCore()`、本機/遠端專案選單、記住上次專案。**啟動不再彈 picker（北極星）**，第一次直接進跟隨模式；picker 移到 Project 選單（Cmd+O）。寫 log 到 `codetree.log`。
- `electron/entry.cjs` — CommonJS 進入點（包進 app 用）。
- `electron/preload.cjs` — 暴露 `window.codetree`（pickProject / openNoProject）給網頁。
- `electron/remote-preload.cjs` / `electron/remote-prompt.html` — 「開遠端 ssh 專案」的小輸入視窗。
- `electron/welcome.html` — 載入中的歡迎 splash（"Growing the world-tree…"）。

### 共用後端 core
- `src/core/server.js`（684 行）— **整個系統的脊椎**。`startCore({root,...})`。包含：
  - file watcher（chokidar）+ 建 Graph + 防抖廣播 `state`。
  - HTTP server（7790）服務 `terminal.html`、`/viz`(cosmos.html)、`/file?path=`（卡片程式預覽）、`/preview/<path>`（UI 檔渲染）。
  - WebSocket server（7778）。
  - **多分頁 node-pty**：一條連線一個 `Map` 管多個真實 shell，依 `sessionId` 路由。
  - **本機 cwd 跟隨**：`startCwdFollow()` 用 `lsof` 抓 shell 的 cwd，`looksLikeProject()` 判斷後 `reroot()` 切換整棵樹。`looksLikeProject` 已放寬成「有任何 code 檔或 src/」（排除 `$HOME` 本身）。
  - **遠端 ssh 跟隨**：`detectSshFromInput()`（解析你打的 `ssh host`）+ `detectRemoteFromOutput()`（解析遠端 bash prompt `user@host:/path$` 的 cwd）→ `enterRemote()/exitRemote()` 動態切到遠端專案。
  - **token bar**：讀真實 usage 廣播。
  - **revert**：本機從 baseline 還原 / 遠端 `cat > file`。
  - **MASL gate**：改檔前先算 blast radius 攔下等核可。
- `src/core/state.js` — codebase 的活結構（Cell / Edge / Activity 資料模型 + 異常偵測 repeat/stall）。
- `src/core/parser.js` — 輕量 import 解析（regex 抓 import/require/from-import，畫檔案間相依連線）。
- `src/core/runner.js` — **core 內的 agent runner**：讓瀏覽器當主 UI，網頁送 prompt → core 跑 agent → 把每一步（思路/工具/改檔/token/MASL）廣播回網頁。
- `src/core/remote-source.js`（187 行）— **遠端專案來源**。純 ssh + find + cat（兩端零安裝），輪詢遠端 codebase，產出和本機 Graph 一樣的 `{cells, edges, root}`。解析 JS/Python import、卡片預覽 `getContent`、`revert` 用 `cat > file`。
- `src/core/session-log.js` — Session 逐字稿記錄器，CLI 一開就寫純文字 txt（給「長期記憶訓練」用）。
- `src/core/token-meter.js` — 讀 Claude Code 自己寫的 session JSONL，抓「你在終端機跑 claude」那條的真實 token usage（不是 Code Tree 內建 agent 那條）。
- `src/core/token-savings.js` — 純 Node 版 token 浪費計算（從 mercury python 移植）；只讀本機 `~/.claude/projects/*/*.jsonl`，不外傳。**註：對應的「Waste $」UI 已移除，這支現在沒接到畫面。**

### Agent 後端（多引擎，全部對 CLI 同一個契約）
- `src/cli/agent.js` — 手刻的 agent tool loop：prompt → Claude 串流 → 跑工具 → 餵回 → 直到 end_turn。每個工具動作 emit `active` 讓樹的鏡頭飛過去。
- `src/cli/sdk-agent.js` — **預設引擎**。用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，借用 Claude Code 登入；只把「現在動哪個檔」翻成 onEvent 餵樹。
- `src/cli/codex-agent.js` — Codex 後端（`@openai/codex-sdk`，借用 ChatGPT 登入），與 Claude 後端對稱。
- `src/cli/llm.js` — LLM 抽象（`createClaudeLLM` 直打 API、`createScriptedLLM` 給 demo）。`run({system,messages,tools,onText})`。
- `src/cli/local-llm.js` — 本機 code LLM 轉接（OpenAI 相容協定，vLLM / llama.cpp），契約同 `createClaudeLLM`。**零雲端登入也能寫 code。**
- `src/cli/local-detect.js` — 偵測本機跑著的 OpenAI 相容模型伺服器（env > Ollama:11434 > 通用:8000/:1234）。
- `src/cli/routed-agent.js` + `src/cli/router.js` — **省 token 骨幹**：同一個任務先丟最便宜的本機小模型，過了 verify 就結束（0 Anthropic token），過不了才升級到 Claude SDK。
- `src/cli/verify.js` — 品質底線：`node --check` 抓壞語法 + 抓「import 了目標檔沒 export 的符號」（getSession vs setSession 那種）。
- `src/cli/memory.js` — **跨 session 軌跡記憶**：每次任務結束寫一行 JSONL（任務/讀了哪些檔/改了哪些檔/做法摘要/有沒有乾淨完成）；下次類似任務 recall 最相似的幾筆塞進 system prompt，「越用越熟這個 codebase」而不需重訓權重。存在每個專案的 `.cosmos-tree/trajectories.jsonl`。
- `src/cli/tools.js` — 給 agent 的檔案工具（read/list/edit/write）。每個動作 emit → core → 對應格子亮起來。**「樹從 agent 的軌跡長出來」的接縫。**
- `src/cli/auth.js` — 借用 Claude Code 已登入的 OAuth session（macOS Keychain `Claude Code-credentials`）；只在本機 runtime 讀，token 不外流。
- `src/cli/tokens.js` — CLI token 計量（本 session 即時 usage）。
- `src/cli/demo.js` — 可重播的劇本（agent 連改三次 session-store 後發現根因在 middleware），給 scripted LLM 跟 demo 影片用。
- `src/cli/design.js` + `src/design/DESIGN.md` — **設計品味層**：agent 被要求做 UI 時，注入精煉的設計紀律（語意 token + 硬性 do/don't），產出 Linear/Vercel/Stripe 等級介面而非 AI slop。仿 Google Labs stitch-skills。

### MASL（改檔前攔截）
- `src/masl/gate.js` — MASL gate 純邏輯：改檔前算「這次改動會連帶弄壞誰」（blast radius），組報告。攔截/核可 UI 在 CLI；這支只算。

### Web 前端
- `src/web/terminal.html`（392 行）— 主畫面：左真實終端機（xterm + 多分頁 `#tabrail`，左側凸出 `+` 開新分頁）、右世界樹 iframe、上方 token 列（Input / Cache hits / Output / Burned，**已移除假的 Waste 與重複的 Saved**）、底部專案名（**已移除 Open/No project 按鈕**，改顯示「follows your shell automatically」）。
- `src/web/cosmos.html`（837 行）— **世界樹**：D3 畫的程式碼卡片（檔名 + 狀態點 + 程式預覽）、import 連線、blast radius hover、issue radar（churn×coupling 熱點排序）、change ledger（這個 session 改了什麼 + 還原鈕 + token 歸因）、recall toast。**改檔時格子脈動發光 + 程式逐行打字塞入（`streamInto`），0 格時顯示誠實空狀態。**
- `src/web/index.html` / `src/web/main.jsx` / `src/web/Tree.jsx` — 早期 Vite + React Flow 版的世界樹（舊版，現在主用 cosmos.html 的 D3 版）。

### 設定 / 打包 / 工具
- `src/config.js` — 共用設定。`WS_PORT=7778`、`WEB_PORT=7790`、忽略規則、CODE_EXT、ANOMALY 門檻。
- `package.json` — name `code-tree`、`main` 指向 `electron/entry.cjs`、`build`（electron-builder，asar 關閉）、scripts：`dist`(打 app)、`release`(打包+部署 VPS+git push)。
- `scripts/build-mac.sh` — electron-builder 打 `--mac dir` → ad-hoc 簽章（`codesign --sign -`）→ `hdiutil` 做 dmg。
- `scripts/release.sh` — build-mac.sh + scp 到 `sportverse:/opt/codetree` + git push，三邊同步。
- `vite.config.js` — 舊 React 版的 Vite 設定。
- `src/vendor/` — 移植來源（`mercury_cache_panel.py`、`token_savings_json.py`、`ail-core.js`），參考用。
- `build/` — demo 影片 / 截圖產生器（`record-demo.mjs`、`record-real.mjs`、`gen-demo.mjs`、`capture-web*.mjs`）+ 大量 frames（可刪的產物）。
- `sample/` — 示範專案（`src/auth.js`、`session-store.js`、`middleware.js`、`user-service.js`），測試樹 + demo 用。
- `CLAUDE.md` — 專案規則（給 norika 的解釋一律中文）。
- `README.md` / `cosmos_tree_spec.md` — 對外說明 / 原始規格。

---

## 4. 功能清單（目前實際有的）

1. **自動跟隨的世界樹**：本機 `cd` 或 `ssh` 進專案，右邊樹自動切換重畫；不用按按鈕。
2. **鏡頭跟著 agent**：agent 動到哪個檔，鏡頭飛過去、那格亮起來，程式逐行被塞進去（打字機效果 + 脈動發光）。
3. **真實多分頁終端機**：左邊是 node-pty 真 shell（跟 VS Code/Hyper 同一套），左側凸出 `+` 可開多個獨立分頁。
4. **不用登入也能寫 code**：偵測本機 Ollama / vLLM / llama.cpp，零雲端登入跑 agent。
5. **多引擎**：claude（SDK 預設）/ claude-api（直打 API）/ local（本機模型）/ codex（ChatGPT 登入）/ routed（先便宜後升級，省 token）。
6. **遠端 ssh 專案**：純 ssh+find+cat，把另一台機器上的 codebase 畫成同樣的樹，可遠端還原檔案。
7. **MASL 改檔前攔截**：改檔前算 blast radius，四條件才出聲攔下等核可。
8. **change ledger + 還原**：這個 session 改了哪些檔、各幾次、燒了多少 token，一鍵還原到 session 開始的樣子（本機 + 遠端）。
9. **跨 session 記憶**：把過去的修法軌跡記成 JSONL，下次類似任務 recall 進 prompt，越用越熟。
10. **issue radar**：用 churn×coupling 熱點法把「真正會連鎖爆炸」的檔案列出來，一鍵飛過去。
11. **token bar**：真實 token usage（Input / Cache hits / Output / Burned），不造假。
12. **設計品味層**：做 UI 時注入設計紀律，輸出高級介面。
13. **CLI TUI**：對話從上往下逐行印（每個字都記錄）、命令列釘底、Tab 看完整樹。
14. **打包成 macOS app（DMG）+ 一條龍部署**（`npm run release` 同步桌面 / VPS / git）。

---

## 5. 強項（為什麼這個設計好）

- **「視覺化反過來解決開發問題」**：樹不只是好看，它用顏色/連線「指出」哪裡有問題（重複改、stall、import 斷裂），radar 把它「列出來」，一鍵就到現場。
- **真實、不造假**：所有數字與檔案都是 runtime 抓的真資料；曾經的估算指標已清除。
- **零侵入跟隨**：不改使用者的 shell，用 lsof / prompt 解析就跟到 cwd，本機與遠端一致。
- **省 token 的路由骨幹**：能用本機小模型過 verify 就不花 Anthropic token，過不了才升級。
- **可離線**：本機模型路徑讓它在沒有雲端登入時也能寫 code。

---

## 6. 怎麼跑 / 連線資訊

- 開發跑 CLI：`node bin/cosmos-tree.js <專案路徑>`（引擎旗標：`--local` / `--codex` / `--engine=claude-api` / `--model=...`）。
- 開發跑 app：`npm run dist` 後開 `release/mac-arm64/Code Tree.app`；或 `npm run release` 連同部署。
- Port：WebSocket `7778`、Web `7790`（若被佔住，core 起不來、右邊會卡 splash → 先清掉佔用程序）。
- 啟動 debug 看 `~/Library/Application Support/code-tree/codetree.log`。

---

## 7. 最近修掉的關鍵 bug（接手要知道的歷史）

- **右邊永遠空白**：根因是「啟動彈 picker 擋路 → 取消就落到空的 no-project 資料夾（零檔案）」+「`looksLikeProject` 太嚴只認 .git/package.json，cd 進一般專案樹不切」。已修：移除啟動 picker 牆、放寬專案判斷、加誠實空狀態。已驗證 core 對 sample 吐 4 cells + 3 edges。
- **假的 Waste $X 指標**：已從 CLI 與 web 全部移除，core 也停掉廣播。
- **CLI 版面**：對話改成從上往下逐行印 + 命令列釘底；agent 每一步即時印出留著。
- **卡片**：改檔時脈動發光 + 程式逐行塞入；不再把「cannot read: ENOENT」當程式碼貼進卡片。

---

## 8. 已知待辦 / 待補

- npm publish 還卡在帳號 2FA/captcha（未發佈）。
- app 為 ad-hoc 簽章，Gatekeeper 仍會跳「無法驗證」（要 $99 notarization 才根治）；目前靠移除 quarantine。
- `looksLikeProject` 放寬後，理論上家目錄底下若散落 code 檔、在某些 cd 路徑可能誤判，已排除 `$HOME` 本身，但子目錄邊界情況待觀察。
- 本機 cwd 跟隨用 `lsof` 輪詢（1.5s），大量分頁切換時的 pid 追蹤待壓測。
- `src/web/index.html`/`Tree.jsx` 舊 React 版與 cosmos.html 並存，未清理（保留 rollback）。
