// 條件路由（Path B）：把一個任務先丟最便宜的模型，跑不過品質地板就升級到更大的。
//
// 為什麼這樣分工有觀測根據：Mercury 對 qwen2.5 3B/7B 的逐 cell 觀測顯示，
// 小模型的「universal backbone」反而更大（3B 比 7B 多 2.4×），但「專精 cell」少很多
// （physics 少 2.08×）。白話：小模型扛得住常見/通用任務，真正難的專精任務才需要大模型。
// 這支路由器就是把那個發現變成 runtime 行為：80% 任務走小模型省成本，難的才冒泡上去。
//
// 監督信號用的是現成的「品質地板」(verify gate)：agent.send() 回傳的 outcome.ok
// 已經是「善終且 verify 過」。跑不過就 rollback（丟掉這層改壞的檔，下一層從乾淨狀態重來），
// 再升級。不繼承弱模型改壞的檔，是合理的 production 行為，也讓「完成率」量得乾淨。

export function createRouter({ tiers, buildAgent, reset, onTier } = {}) {
  if (!Array.isArray(tiers) || !tiers.length) throw new Error('router 需要至少一個 tier');
  if (typeof buildAgent !== 'function') throw new Error('router 需要 buildAgent(tier) -> { send }');

  async function run(task) {
    const attempts = [];
    let priorNote = ''; // 上一層留下的「縫合擾亂因子」：改了哪些檔、驗證為什麼掛。帶給下一層別重蹈覆轍。
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      const last = i === tiers.length - 1;
      if (reset) await reset(tier, i); // 每層從乾淨基線開跑（丟掉前一層改壞的）
      onTier?.({ tier: tier.name, index: i, last });
      const agent = buildAgent(tier);
      let outcome;
      try {
        // 第一層拿乾淨任務；之後每層在任務後面附上「前一層線索」。
        // 檔案本身已 reset 回乾淨基線，線索只進對話、不污染程式碼，等於把擾亂因子拉回來壓住。
        outcome = await agent.send(priorNote ? task + priorNote : task);
      } catch (e) {
        outcome = { ok: false, error: String(e?.message || e), confTrace: [] };
      }
      // 真正算「解掉」只認 verifyPassed===true：改了檔且完整 verify（含 npm test）過。
      // 不認 agent 的軟性 ok——「沒改任何檔就善終」對 bug-fix 任務是 narrate-instead-of-call 失敗，
      // 不是完成。這正是把 router 從「相信模型自以為做完了」改成「相信品質地板真的過了」。
      const solved = outcome.verifyPassed === true;
      attempts.push({
        tier: tier.name,
        solved,
        softOk: !!outcome.ok,
        verifyPassed: outcome.verifyPassed ?? null,
        nEdits: (outcome.filesModified || []).length,
        filesModified: outcome.filesModified || [],
        conf: summarizeConfidence(outcome.confTrace),
        error: outcome.error,
      });
      if (solved) return { solved: true, tier: tier.name, tierIndex: i, attempts };
      priorNote = buildPriorNote(tier, outcome); // 失敗了：把這層的擾亂因子整理成線索，帶給下一層
    }
    return { solved: false, tier: null, tierIndex: -1, attempts };
  }

  return { run };
}

// 把一層失敗的「擾亂因子」壓成一段線索，附到下一層的任務後面。
// 帶兩種訊號：(1) 上一層動過哪些檔（縮小搜尋面，別又從零亂翻）；
// (2) 驗證為什麼掛（語法/import/測試尾段），直接點出上一層縫錯在哪。
// 注意只帶「為什麼錯」的事實，不帶上一層的具體改法——改法本身可能就是錯的，帶過去會把下一層也帶歪。
function buildPriorNote(tier, outcome) {
  const files = (outcome.filesModified || []);
  const probs = (outcome.verifyProblems || []);
  if (!files.length && !probs.length) return '';
  const lines = [];
  lines.push(`\n\n（上一個較小的模型（${tier.name}）試過但沒修好，以下是牠踩到的坑，給你避雷，不要重蹈覆轍：）`);
  if (files.length) lines.push(`- 牠改動過：${files.join('、')}（根因很可能在這附近，但牠的改法是錯的，別照抄）`);
  for (const p of probs.slice(0, 6)) lines.push(`- 驗證沒過 [${p.kind}] ${p.file}：${p.message}`);
  lines.push('- 請重新獨立診斷根因，改完一樣要通過驗證（含 npm test）才算完成。');
  return lines.join('\n');
}

// 把一個任務的多回合信心軌跡壓成幾個數，方便事後檢查「信心能不能預測失敗」。
//   meanLogprob：整段生成平均信心（越接近 0 越篤定）
//   minLogprob：最不確定的那個 token（亂掰時會很負）
//   maxWantedToolMass：任一回合「其實想呼叫工具卻沒呼叫」的最高質量（narrate-instead-of-call 指標）
//   turns / toolTurns：總回合 / 真的吐了工具的回合
export function summarizeConfidence(confTrace = []) {
  if (!Array.isArray(confTrace) || !confTrace.length) return null;
  const means = confTrace.map((c) => c.meanLogprob).filter((x) => typeof x === 'number');
  const mins = confTrace.map((c) => c.minLogprob).filter((x) => typeof x === 'number');
  const narrateMass = confTrace.filter((c) => !c.hadTool).map((c) => c.wantedToolMass || 0);
  return {
    turns: confTrace.length,
    toolTurns: confTrace.filter((c) => c.hadTool).length,
    meanLogprob: means.length ? means.reduce((a, b) => a + b, 0) / means.length : null,
    minLogprob: mins.length ? Math.min(...mins) : null,
    maxWantedToolMass: narrateMass.length ? Math.max(...narrateMass) : 0,
  };
}
