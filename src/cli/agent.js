// Agent tool loop：prompt → Claude 串流 → 跑工具 → 把結果餵回去 → 迴圈到 end_turn。
// 每次工具動作都會 onEvent({type:'active', path})，讓 CLI 的視角跳到那一格。
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DEFS, makeExecutor } from './tools.js';
import { verifyChangedFiles, formatProblems } from './verify.js';

// 小模型常把「我下一步要讀哪個檔」用文字講出來，而不是真的發 read_file（narrate-instead-of-call）。
// 從這種收尾文字裡撈出它點名、實際存在、還沒讀過的原始碼路徑，由 loop 代它發 read_file，
// 讓它讀完該讀的才會進到診斷→動手，而不是卡在「請用 read_file 讀取…」的空轉。
// 只撈讀檔（唯讀、安全）；寫檔絕不從文字自動代發，一律走 verify 守門。
export function extractNarratedReads(text, { exists, alreadyRead = new Set(), max = 3, requireIntent = true } = {}) {
  const s = String(text || '');
  // 沒有讀檔意圖訊號就不撈，避免把正常收尾文字裡提到的檔名誤當成要讀。
  // requireIntent=false 用在「任務本身列出的可疑檔」：那是使用者明示要查的，不需要意圖關鍵字。
  if (requireIntent && !/(read_file|查看|讀取|读取|檢視|检视|看一下|看看)/.test(s)) return [];
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(/[\w./-]+\.(?:mjs|cjs|jsx|tsx|js|ts|json|py)\b/g)) {
    const p = m[0].replace(/^\.\//, '');
    if (seen.has(p) || alreadyRead.has(p)) continue;
    seen.add(p);
    if (exists && !exists(p)) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

const SYSTEM = `你是一個在使用者專案裡幹活的 coding agent，介面叫 Cosmos Tree。
規則：
- 動手前先用 list_dir / read_file 看清楚現況，不要憑空猜。
- 要改檔案用 edit_file（精準替換）或 write_file（新檔/整檔重寫）。
- 一次只做一件清楚的事，每個動作後簡短說你在哪個檔案做了什麼。
- 完成後用一兩句話收尾，不要長篇大論。`;

const READ_TOOLS = new Set(['read_file', 'list_dir', 'search_code']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export function createAgent({ llm, root, emit, onEvent, model, systemSuffix, memory, verify = true, maxVerifyRounds = 3, maxNoWorkNudges = 2, tools = TOOL_DEFS }) {
  const execute = makeExecutor(root, emit);
  const system = systemSuffix ? `${SYSTEM}\n${systemSuffix}` : SYSTEM;
  const messages = [];
  const activeTools = tools; // 可由上層裁剪（例如本地小模型只給 write_file，避免跟 edit_file 搞混 schema）
  const forceTarget = activeTools.some((t) => t.name === 'write_file') ? 'write_file' : (activeTools.find((t) => WRITE_TOOLS.has(t.name))?.name);

  async function send(userText) {
    messages.push({ role: 'user', content: userText });
    let guard = 0;

    // 持續進化（快迴圈）：開工前撈出過去相似任務的軌跡，墊進這次的 system
    let runSystem = system;
    if (memory) {
      const recalled = memory.recall(userText);
      if (recalled) {
        runSystem = `${system}\n\n${recalled}`;
        onEvent({ type: 'recall', text: recalled });
      }
    }

    // 軌跡收集：這次任務讀了/改了哪些檔、用了幾次工具、最後一輪說了什麼
    const filesRead = new Set();
    const filesModified = new Set();
    let toolCount = 0;
    let lastTurnText = '';
    let verifyRounds = 0;
    let verifyPassed = null; // null=沒驗(沒改檔), true/false=驗過/沒過
    let lastVerifyProblems = null; // 最後一次驗證沒過的細節（語法/import/測試尾段）：升級時帶給下一層當線索
    let noWorkNudges = 0;    // 小模型常「看一眼就收工」：零修改想結束時頂回去逼它真的動手
    let forceToolNext = false; // 下一回合強制吐工具呼叫（把 narrate-then-stop 頂回行動）
    let salvagedReads = 0;   // 把模型「用文字講要讀哪個檔」代發成真的 read_file 的次數（防無限打撈）
    const maxSalvageReads = 4;
    const confTrace = [];    // 每回合的 token 信心摘要（local 引擎開 logprobs 才有）：路由/halting 的判據
    const fileExists = (rel) => { try { return fs.statSync(path.join(root, rel)).isFile(); } catch { return false; } };

    const finish = (endedCleanly) => {
      onEvent({ type: 'turn_end' });
      // 真正算「善終」要連驗證都過（沒改檔則沿用模型自己的收尾判斷）
      const ok = endedCleanly && verifyPassed !== false;
      if (memory) {
        memory.record({
          task: userText,
          filesRead: [...filesRead],
          filesModified: [...filesModified],
          toolCount,
          endedCleanly: ok,
          verifyPassed,
          summary: lastTurnText,
        });
      }
      // 回傳結果給上層（路由器）：能否善終、驗證過沒、改了哪些檔、信心軌跡。
      // 路由器拿這個決定要不要把同一個任務升級到更大的模型。
      return {
        ok,
        endedCleanly,
        verifyPassed,
        verifyProblems: lastVerifyProblems,
        filesModified: [...filesModified],
        filesRead: [...filesRead],
        toolCount,
        summary: lastTurnText,
        confTrace,
      };
    };

    while (guard++ < 30) {
      lastTurnText = '';
      // narrate-then-stop 的小模型：被 nudge 後這一回合「只」給寫檔工具，逼它從「光說」轉成「動手」。
      // 觀察到 ollama 0.30 即使指名 write_file，模型也會閃去呼叫 read_file 逃避動手。
      // 解法：強制回合把 read 類工具整個拿掉，桌上只剩 write_file/edit_file，它想呼叫就只能寫檔。
      // 此時它已讀過檔、recall 也給了修法，內容資訊足夠。
      const turnTools = forceToolNext ? activeTools.filter((t) => WRITE_TOOLS.has(t.name)) : activeTools;
      const res = await llm.run({
        system: runSystem,
        tools: turnTools,
        messages,
        // 指名 write_file。ollama 0.30 不認 tool_choice:'required'，但認「指名某個 function」，
        // 會把該呼叫吐成 content JSON，由 local-llm 的後備解析撿回成 tool_use。
        toolChoice: forceToolNext ? { type: 'function', function: { name: forceTarget } } : undefined,
        onText: (delta) => {
          lastTurnText += delta;
          onEvent({ type: 'text', delta });
        },
      });
      forceToolNext = false;
      if (res.confidence) { confTrace.push(res.confidence); onEvent({ type: 'confidence', ...res.confidence }); }
      messages.push({ role: 'assistant', content: res.content });

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
        // 品質地板：模型想收工，但只要改過檔就先跑真實驗證，沒過就把錯誤丟回去逼它修
        if (verify && filesModified.size && verifyRounds < maxVerifyRounds) {
          verifyRounds++;
          const { ok, problems } = verifyChangedFiles(root, [...filesModified], { tests: true });
          verifyPassed = ok;
          lastVerifyProblems = ok ? null : problems;
          onEvent({ type: 'verify', ok, problems });
          if (!ok) {
            messages.push({ role: 'user', content: formatProblems(problems) });
            continue; // 不准收工，回迴圈修
          }
        }
        // narration 打撈：模型還沒動手、也沒貼程式碼，只是用文字說「請用 read_file 讀取 X、Y」。
        // 這是把讀檔動作也 narrate 掉了。與其 nudge 空轉，直接代它把點名、存在、還沒讀過的檔讀進來，
        // 餵回去，讓它讀完該讀的再進到診斷→動手。只代發讀檔（唯讀安全），有次數上限防空轉。
        if (filesModified.size === 0 && !/```/.test(lastTurnText) && salvagedReads < maxSalvageReads) {
          const budget = Math.min(3, maxSalvageReads - salvagedReads);
          // 候選 = narration 裡點名要讀的檔 ∪ 任務本身列出的可疑檔（後者不需意圖關鍵字）。
          // 後者專治「模型 list_dir 完沒讀主嫌就空泛 narration」這種卡死。
          const fromText = extractNarratedReads(lastTurnText, { exists: fileExists, alreadyRead: filesRead, max: budget });
          const fromTask = extractNarratedReads(userText, { exists: fileExists, alreadyRead: filesRead, max: budget, requireIntent: false });
          const wanted = [...new Set([...fromText, ...fromTask])].slice(0, budget);
          if (wanted.length) {
            const parts = [];
            for (const rel of wanted) {
              salvagedReads++;
              toolCount++;
              filesRead.add(rel);
              onEvent({ type: 'tool', name: 'read_file', path: rel, input: { path: rel } });
              onEvent({ type: 'active', path: rel });
              let out;
              try { out = await execute('read_file', { path: rel }); }
              catch (e) { out = `工具錯誤：${e.message}`; }
              parts.push(`檔案 ${rel}：\n${String(out)}`);
            }
            onEvent({ type: 'salvage', reads: wanted });
            messages.push({ role: 'user', content: `（已照你說的把這些檔讀進來了，內容如下。看完直接動手：找出根因後用 write_file 整檔重寫修好，不要再用文字描述步驟。）\n\n${parts.join('\n\n')}` });
            continue; // 讀完回迴圈，讓它進到診斷→動手
          }
        }
        // 零修改就想收工：小模型最常見的兩種擺爛——
        //   (1) 看一眼就放棄；(2) 把修好的程式碼貼成 markdown 區塊「講」給人聽，而不是真的呼叫工具。
        // 後者最致命：模型自以為改好了，實際上一個字都沒寫進檔案。偵測到收尾文字裡有 ``` 程式碼區塊就點破它。
        if (verify && filesModified.size === 0 && noWorkNudges < maxNoWorkNudges) {
          noWorkNudges++;
          const dumpedCode = /```/.test(lastTurnText);
          onEvent({ type: 'nudge', reason: dumpedCode ? 'code_in_text' : 'no_edit' });
          const msg = dumpedCode
            ? '（你把程式碼貼在訊息裡，但那樣「完全不會生效」，檔案一個字都沒變。請『立刻』發一個 write_file 工具呼叫：path 填你要改的檔案路徑，content 填那個檔案修好後的完整內容。不要再用文字解釋，直接呼叫工具。）'
            : '（你到目前為止還沒有修改任何檔案。如果這個任務需要改程式，請「直接用工具動手」：先 read_file 讀過可疑檔案找出根因，再用 write_file 整檔重寫或 edit_file 修好，不要只用文字描述步驟。如果確認真的不需要改任何檔案，再用一句話說明原因收尾。）';
          messages.push({ role: 'user', content: msg });
          forceToolNext = true; // 下一回合只給寫檔工具並指名強制，逼它把修好的內容真的寫進檔
          continue;
        }
        return finish(true);
      }

      const results = [];
      for (const tu of toolUses) {
        const p = tu.input?.path;
        toolCount++;
        if (p && READ_TOOLS.has(tu.name)) filesRead.add(p);
        if (p && WRITE_TOOLS.has(tu.name)) filesModified.add(p);
        onEvent({ type: 'tool', name: tu.name, path: p, input: tu.input });
        if (p) onEvent({ type: 'active', path: p }); // 視角跳到這一格
        let out;
        try {
          out = await execute(tu.name, tu.input || {});
        } catch (e) {
          out = `工具錯誤：${e.message}`;
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
      }
      messages.push({ role: 'user', content: results });
    }
    return finish(false);
  }

  return { send, messages };
}
