/* CE Study AI - MVP
 * 構成：
 *  - IndexedDBラッパー（db*関数）
 *  - PDF処理（pdf.jsでテキスト抽出）
 *  - AIアダプタ（Gemini API / 将来ローカルAIに差し替え可能）
 *  - 画面制御（showView, 各画面の初期化）
 */

// PDFライブラリが正しく読み込めなかった場合でも、
// アプリの他のボタン（設定・問題生成・クイズ等）は動作し続けるようにする
const PDF_WORKER_URL = "https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";
let pdfWorkerReadyPromise = null;

// SafariはCDN上のWorkerスクリプトを直接読み込めないことがあるため、
// 一度fetchで中身を取得し、同一オリジン扱いのBlob URLとして渡す
function ensurePdfWorkerReady() {
  if (pdfWorkerReadyPromise) return pdfWorkerReadyPromise;
  pdfWorkerReadyPromise = (async () => {
    if (typeof pdfjsLib === "undefined") {
      throw new Error("pdf.jsの読み込みに失敗しました。ページを再読み込みしてください。");
    }
    try {
      const res = await fetch(PDF_WORKER_URL);
      const code = await res.text();
      const blob = new Blob([code], { type: "application/javascript" });
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    } catch (e) {
      console.error("Workerのfetchに失敗、直接URLを使用します", e);
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    }
  })();
  return pdfWorkerReadyPromise;
}

/* ---------------------------------------------------------
 * IndexedDB
 * --------------------------------------------------------- */
const DB_NAME = "cestudy";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("materials")) {
        db.createObjectStore("materials", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("questions")) {
        db.createObjectStore("questions", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("attempts")) {
        db.createObjectStore("attempts", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

async function dbAdd(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).add(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------------------------------------------------
 * 設定（APIキー）
 * --------------------------------------------------------- */
async function getApiKey() {
  const row = await dbGet("settings", "geminiApiKey");
  return row ? row.value : "";
}
async function saveApiKey(key) {
  await dbPut("settings", { key: "geminiApiKey", value: key });
}

async function getGeminiModel() {
  const row = await dbGet("settings", "geminiModel");
  return row ? row.value : GEMINI_MODEL_DEFAULT;
}
async function saveGeminiModel(model) {
  await dbPut("settings", { key: "geminiModel", value: model });
}

/* ---------------------------------------------------------
 * PDF処理：テキスト抽出（ページ単位）
 * --------------------------------------------------------- */
async function extractPdfPages(file) {
  await ensurePdfWorkerReady();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join("");
    pages.push({ page: i, text: text.trim() });
  }
  return pages;
}

/* ---------------------------------------------------------
 * AIアダプタ層
 * 今はGemini API（クラウド）のみ実装。
 * 将来ローカルLLM(WebLLM)を追加する場合は、
 * generateQuestionsWithLocalAI(prompt) を実装し、
 * mode に応じて呼び分けるようにする。
 * --------------------------------------------------------- */
const GEMINI_MODEL_DEFAULT = "gemini-3.6-flash";

async function callGemini(apiKey, prompt, retriesLeft = 2) {
  const model = await getGeminiModel();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.4
    }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (res.status === 429 && retriesLeft > 0) {
    // 1分あたりの回数制限（RPM）による一時的な混雑の可能性があるため、
    // 少し待ってから自動的に再試行する
    await new Promise((r) => setTimeout(r, 20000));
    return callGemini(apiKey, prompt, retriesLeft - 1);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error(
        "Gemini APIの利用上限（無料枠）に達しました。1日あたりの上限の場合は日付が変わるまで待つ必要があります。しばらく時間をおいてから、もう一度お試しください。"
      );
    }
    throw new Error(`Gemini APIエラー (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return text;
}

/* 出典タグ付きの教材抜粋を作成する（プロンプトに埋め込む素材）
 * 資料が多い場合、文字数上限(maxChars)ですべては渡しきれないため、
 * 毎回同じ（先頭の）ページばかりが使われないよう、ページの順序をシャッフルしてから詰め込む。
 * entries には、後で「出典の中身と問題の内容が矛盾していないか」を
 * 照合するための { docTitle, label, text } を保持しておく */
function buildSourceExcerpts(materialsForField, maxChars) {
  const allPages = [];
  for (const m of materialsForField) {
    for (const p of m.pages) {
      if (!p.text) continue;
      allPages.push({ m, p });
    }
  }
  // Fisher-Yatesシャッフル
  for (let i = allPages.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allPages[i], allPages[j]] = [allPages[j], allPages[i]];
  }

  let out = "";
  const sourceLabels = [];
  const entries = [];
  for (const { m, p } of allPages) {
    const label =
      m.type === "past"
        ? `[出典:${m.title} 問題頁${p.page}]`
        : `[出典:${m.title} P.${p.page}]`;
    const chunk = `${label} ${p.text}\n`;
    if (out.length + chunk.length > maxChars) continue;
    out += chunk;
    const labelBody = label.slice(4, -1); // "出典:" と "]" を除いたラベル本体
    sourceLabels.push(labelBody);
    entries.push({ docTitle: m.title, page: p.page, label: labelBody, text: p.text });
  }
  return { excerpts: out, sourceLabels, entries };
}

const QUESTION_ANGLES = [
  "定義・基本知識を問う",
  "複数の概念や方式の比較を問う",
  "数値・計算・基準値を問う",
  "禁忌・注意点・トラブル対応を問う",
  "手順・操作の順序を問う",
  "症例（状況設定）に基づく判断を問う",
  "過去問に類似した形式で問う"
];

function buildPrompt({ field, count, excerpts, includePast, masteredQuestions, weakTopics }) {
  const masteredNote =
    masteredQuestions && masteredQuestions.length > 0
      ? `\n参考：以下は、ユーザーがすでに正解した問題文です。同じ内容を扱う場合でも、これらと全く同じ文面はできるだけ避け、問い方（聞かれる角度・具体例・形式など）を変えてください。ただし内容自体（分野・出典）が重複すること自体は問題ありません。\n${masteredQuestions.map((q) => `・${q}`).join("\n")}\n`
      : "";

  const weakNote =
    weakTopics && weakTopics.length > 0
      ? `\n参考：このユーザーは以下のトピックで正答率が低く、苦手としています。資料の範囲内で構わないので、${count}問のうち半分以上は、これらのトピックに関連する内容を優先して出題してください。\n${weakTopics.map((t) => `・${t}`).join("\n")}\n`
      : "";

  // 問題数に応じて、問い方のパターンを割り当てる（多角的な出題にするため）
  const angleAssignment = Array.from({ length: count }, (_, i) => QUESTION_ANGLES[i % QUESTION_ANGLES.length]);

  return `あなたは臨床工学技士(CE)国家試験・認定試験対策の問題作成アシスタントです。
以下は「${field}」分野の教材・過去問から抜粋したテキストです。各行の先頭に [出典:...] というタグが付いています。

このタグ付きテキストだけを根拠として、4択問題を ${count} 問作成してください。
${masteredNote}${weakNote}
出題の多様化（重要）：
- ${count}問それぞれに、以下の「問い方のパターン」を順番に割り当てて作成してください（資料の内容的にどうしても対応できない場合のみ別のパターンに変えて構いません）。同じような聞き方の問題ばかりにならないようにすること。
${angleAssignment.map((a, i) => `  ${i + 1}問目：${a}`).join("\n")}

厳守事項：
- 必ず与えられたテキストに書かれている内容のみを根拠にすること。テキストにない知識を勝手に補わない。
- 各問題には、根拠にした [出典:...] の中身をそのまま source フィールドに書くこと。複数箇所を根拠にした場合は主要な1つを書く。
- 出典が特定できない問題は作らない。
- 各問題に、内容を表す短いトピック名（例：「抗凝固療法」「穿刺・シャント管理」など、10文字程度）を topic フィールドに付けること。
- ${includePast ? "過去問の抜粋がある場合、そのまま使う・一部改変する・類題を作る、すべて可とする。使った場合は isPastExam を true にする。" : "過去問の抜粋は出題傾向の参考のみに使い、そのままの引用はしない。isPastExam は常に false にする。"}
- 選択肢は4つ、正解は1つ。誤答も医学的にもっともらしいものにする。
- 出力は次のJSON配列の形式のみ。説明文やマークダウンは一切付けない。

[
  {
    "question": "問題文",
    "choices": ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
    "answerIndex": 0,
    "explanation": "なぜその答えになるかの解説",
    "source": "出典表記",
    "topic": "トピック名",
    "isPastExam": false
  }
]

--- 資料抜粋 ---
${excerpts}
--- 資料抜粋ここまで ---
`;
}

/* 生成結果の機械チェック：出典が実在する資料のものかを確認 */
function validateQuestions(rawQuestions, validSourceLabels) {
  const valid = [];
  for (const q of rawQuestions || []) {
    if (
      !q.question ||
      !Array.isArray(q.choices) ||
      q.choices.length !== 4 ||
      typeof q.answerIndex !== "number" ||
      q.answerIndex < 0 ||
      q.answerIndex > 3 ||
      !q.source
    ) {
      continue; // 形式不正はスキップ
    }
    const sourceOk = validSourceLabels.some((label) => q.source.includes(label.split(" ")[0]));
    if (!sourceOk) continue; // 出典が資料に存在しない場合はスキップ（品質チェック）
    valid.push(q);
  }
  return valid;
}

/* 問題ごとに、根拠となった出典の本文（原文）を探して付与する。
 * まず出典表記からページ番号を読み取り、そのページの原文を優先的に使う。
 * ページ番号が読み取れない場合のみ、同じ資料名の中身をまとめて渡す（フォールバック）。 */
function attachSourceExcerpt(q, entries) {
  const pageMatch = q.source.match(/(?:P\.|頁)(\d+)/);
  const docMatches = entries.filter((e) => q.source.includes(e.docTitle.split(" ")[0]));

  if (pageMatch) {
    const pageNum = Number(pageMatch[1]);
    const exact = docMatches.find((e) => e.page === pageNum);
    if (exact) return exact.text.slice(0, 4000);
  }

  const text = docMatches.map((e) => e.text).join("\n").slice(0, 4000);
  return text || "(該当する原文が見つかりませんでした)";
}

/* AIによる整合性チェック：出典本文と問題内容が食い違っていないかを再度AIに確認させる。
 * 通信エラー等でチェック自体が失敗した場合は、出典実在チェック済みのリストをそのまま返す
 * （品質チェックが動かないことでMVPが完全に止まらないようにするため） */
async function verifyQuestions(apiKey, questions, entries) {
  if (questions.length === 0) return { passed: questions, rejectedReasons: [] };

  const items = questions.map((q, i) => ({
    index: i,
    question: q.question,
    correctChoice: q.choices[q.answerIndex],
    explanation: q.explanation,
    sourceExcerpt: attachSourceExcerpt(q, entries)
  }));

  const prompt = `以下は自動生成された臨床工学技士試験対策の4択問題です。各問題について、添えられた「根拠原文」の内容と、問題文・正解・解説が事実として矛盾していないかを確認してください。

判定基準（重要）：
- 根拠原文に書かれている内容の範囲で、一般的な臨床工学の常識を使って説明を補っているだけなら ok とする（厳しくしすぎない）。
- ng とするのは、根拠原文に書かれていない具体的な数値・固有名詞・手順を勝手に作り出している場合や、根拠原文の内容と明確に矛盾する場合のみ。
- 判断に迷う場合は ok とする。

出力は次のJSON配列の形式のみ。ok の値は必ず true または false のブール値にすること。説明文やマークダウンは一切付けない。

[
  { "index": 0, "ok": true, "reason": "簡潔な理由" }
]

--- チェック対象 ---
${JSON.stringify(items, null, 0)}
--- チェック対象ここまで ---
`;

  try {
    const rawText = await callGemini(apiKey, prompt);
    const results = JSON.parse(rawText) || [];
    const isOk = (v) => v === true || v === "true" || v === 1;
    const okIndexes = new Set(results.filter((r) => r && isOk(r.ok)).map((r) => Number(r.index)));
    const passed = questions.filter((_, i) => okIndexes.has(i));
    const rejectedReasons = results
      .filter((r) => r && !isOk(r.ok))
      .map((r) => r.reason)
      .filter(Boolean)
      .slice(0, 3);
    return { passed, rejectedReasons };
  } catch (e) {
    console.error("整合性チェックに失敗したため、このステップをスキップします", e);
    return { passed: questions, rejectedReasons: [] };
  }
}

async function generateQuestions({ field, count, includePast }) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("設定画面でGemini APIキーを登録してください。");

  const all = await dbGetAll("materials");
  const materialsForField = all.filter(
    (m) => m.field === field && (includePast || m.type !== "past")
  );
  if (materialsForField.length === 0) {
    throw new Error("この分野に登録された資料がありません。");
  }

  const { excerpts, sourceLabels, entries } = buildSourceExcerpts(materialsForField, 60000);

  // すでに正解済みの問題は、AIに「同じ文面を繰り返さない」よう伝える
  const existingQuestions = (await dbGetAll("questions")).filter((q) => q.field === field);
  const attempts = await dbGetAll("attempts");
  const latestByQuestion = new Map();
  for (const a of attempts) {
    const prev = latestByQuestion.get(a.questionId);
    if (!prev || new Date(a.answeredAt) > new Date(prev.answeredAt)) {
      latestByQuestion.set(a.questionId, a);
    }
  }
  const masteredQuestions = existingQuestions
    .filter((q) => {
      const latest = latestByQuestion.get(q.id);
      return latest && latest.correct;
    })
    .map((q) => q.question)
    .slice(-100); // プロンプトが長くなりすぎないよう直近100問まで

  // トピック別の正答率を集計し、正答率が低い（かつある程度回答数がある）トピックを苦手分野とする
  const topicStats = {};
  for (const q of existingQuestions) {
    if (!q.topic) continue;
    const latest = latestByQuestion.get(q.id);
    if (!latest) continue;
    topicStats[q.topic] = topicStats[q.topic] || { correct: 0, total: 0 };
    topicStats[q.topic].total++;
    if (latest.correct) topicStats[q.topic].correct++;
  }
  const weakTopics = Object.entries(topicStats)
    .filter(([, s]) => s.total >= 2 && s.correct / s.total < 0.7)
    .sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total)
    .slice(0, 8)
    .map(([topic]) => topic);

  const prompt = buildPrompt({ field, count, excerpts, includePast, masteredQuestions, weakTopics });
  const rawText = await callGemini(apiKey, prompt);

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error("AIの応答を解析できませんでした。もう一度お試しください。");
  }

  const validated = validateQuestions(parsed, sourceLabels);
  if (validated.length === 0) {
    throw new Error("出典が確認できる問題を生成できませんでした。資料を増やして再度お試しください。");
  }

  const { passed, rejectedReasons } = await verifyQuestions(apiKey, validated, entries);
  if (passed.length === 0) {
    const reasonNote = rejectedReasons.length ? `（理由例：${rejectedReasons.join(" / ")}）` : "";
    throw new Error(`品質チェックで内容の矛盾が見つかり、有効な問題がありませんでした${reasonNote}`);
  }

  const saved = [];
  for (const q of passed) {
    const record = { ...q, field, createdAt: new Date().toISOString() };
    const id = await dbAdd("questions", record);
    saved.push({ ...record, id });
  }
  return saved;
}

/* ---------------------------------------------------------
 * 画面制御
 * --------------------------------------------------------- */
const views = ["home", "add", "generate", "quiz", "settings", "materials", "history", "review"];
function showView(name) {
  for (const v of views) {
    document.getElementById(`view-${v}`).classList.toggle("hidden", v !== name);
  }
}

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showView("home"));
});

document.getElementById("btn-settings").addEventListener("click", async () => {
  document.getElementById("settings-api-key").value = await getApiKey();
  document.getElementById("settings-model").value = await getGeminiModel();
  showView("settings");
});

document.getElementById("btn-save-key").addEventListener("click", async () => {
  const key = document.getElementById("settings-api-key").value.trim();
  const model = document.getElementById("settings-model").value;
  await saveApiKey(key);
  await saveGeminiModel(model);
  showView("home");
});

/* --- ホーム画面：資料一覧の描画 --- */
async function renderFieldList() {
  const materials = await dbGetAll("materials");
  const listEl = document.getElementById("field-list");
  const genFieldEl = document.getElementById("gen-field");
  const fieldOptionsEl = document.getElementById("field-options");

  if (materials.length === 0) {
    listEl.innerHTML = `<p class="empty-note">まだ登録された資料がありません。上のボタンからPDFを追加してください。</p>`;
    genFieldEl.innerHTML = "";
    fieldOptionsEl.innerHTML = "";
    return;
  }

  const byField = {};
  for (const m of materials) {
    byField[m.field] = byField[m.field] || { teach: 0, past: 0 };
    byField[m.field][m.type === "past" ? "past" : "teach"]++;
  }

  listEl.innerHTML = Object.entries(byField)
    .map(
      ([field, c]) => `
      <div class="field-group" data-field="${escapeHtml(field)}">
        <div>
          <div class="field-title">${escapeHtml(field)}</div>
          <div class="field-counts">教材 ${c.teach}冊 ・ 過去問 ${c.past}冊</div>
        </div>
        <div class="chevron">›</div>
      </div>`
    )
    .join("");

  genFieldEl.innerHTML = Object.keys(byField)
    .map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)
    .join("");

  fieldOptionsEl.innerHTML = Object.keys(byField)
    .map((f) => `<option value="${escapeHtml(f)}"></option>`)
    .join("");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

document.getElementById("field-list").addEventListener("click", (e) => {
  const group = e.target.closest(".field-group");
  if (!group) return;
  openMaterialsView(group.dataset.field);
});

document.getElementById("btn-history").addEventListener("click", async () => {
  await renderHistory();
  showView("history");
});

async function renderHistory() {
  const attempts = await dbGetAll("attempts");
  const questions = await dbGetAll("questions");
  const qMap = new Map(questions.map((q) => [q.id, q]));

  const byField = {};
  let totalCorrect = 0;
  let total = 0;

  for (const a of attempts) {
    const q = qMap.get(a.questionId);
    const field = q ? q.field : "不明";
    byField[field] = byField[field] || { correct: 0, total: 0 };
    byField[field].total++;
    if (a.correct) byField[field].correct++;
    total++;
    if (a.correct) totalCorrect++;
  }

  const summaryEl = document.getElementById("history-summary");
  const overallRate = total > 0 ? Math.round((totalCorrect / total) * 100) : 0;
  summaryEl.innerHTML = `
    <div class="stat">
      <div class="stat-value">${total}</div>
      <div class="stat-label">総回答数</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalCorrect}</div>
      <div class="stat-label">総正解数</div>
    </div>
    <div class="stat">
      <div class="stat-value">${overallRate}%</div>
      <div class="stat-label">全体正答率</div>
    </div>`;

  const listEl = document.getElementById("history-field-list");
  const fields = Object.entries(byField);
  if (fields.length === 0) {
    listEl.innerHTML = `<p class="empty-note">まだ回答履歴がありません。問題に回答すると、ここに分野別の正答率が表示されます。</p>`;
    return;
  }

  listEl.innerHTML = fields
    .map(([field, c]) => {
      const rate = c.total > 0 ? Math.round((c.correct / c.total) * 100) : 0;
      return `
      <div class="history-field-row">
        <div class="history-field-top">
          <span>${escapeHtml(field)}</span>
          <span class="history-field-rate">${c.correct}/${c.total}（${rate}%）</span>
        </div>
        <div class="history-bar-track">
          <div class="history-bar-fill" style="width:${rate}%"></div>
        </div>
      </div>`;
    })
    .join("");
}

/* --- 復習（保存済み問題の再出題） --- */
document.getElementById("btn-review").addEventListener("click", async () => {
  await populateReviewFieldOptions();
  document.getElementById("review-status").textContent = "";
  showView("review");
});

async function populateReviewFieldOptions() {
  const questions = await dbGetAll("questions");
  const fields = [...new Set(questions.map((q) => q.field))];
  const sel = document.getElementById("review-field");
  sel.innerHTML =
    `<option value="__all__">すべての分野</option>` +
    fields.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
}

document.getElementById("btn-review-start").addEventListener("click", async () => {
  const field = document.getElementById("review-field").value;
  const mode = document.getElementById("review-mode").value;
  const statusEl = document.getElementById("review-status");

  const questions = await dbGetAll("questions");
  const attempts = await dbGetAll("attempts");

  // 各問題の直近の回答結果を調べる
  const latestByQuestion = new Map();
  for (const a of attempts) {
    const prev = latestByQuestion.get(a.questionId);
    if (!prev || new Date(a.answeredAt) > new Date(prev.answeredAt)) {
      latestByQuestion.set(a.questionId, a);
    }
  }

  let filtered = questions;
  if (field !== "__all__") filtered = filtered.filter((q) => q.field === field);
  if (mode === "wrong") {
    filtered = filtered.filter((q) => {
      const latest = latestByQuestion.get(q.id);
      return latest && !latest.correct;
    });
  } else if (mode === "past") {
    filtered = filtered.filter((q) => q.isPastExam);
  }

  if (filtered.length === 0) {
    statusEl.textContent = "条件に合う問題がありません。条件を変えて試してください。";
    return;
  }

  // 出題順をシャッフルし、多すぎる場合は20問までに絞る
  const shuffled = [...filtered].sort(() => Math.random() - 0.5).slice(0, 20);
  startQuiz(shuffled);
});

/* --- 資料一覧（分野別）・削除 --- */
async function openMaterialsView(field) {
  document.getElementById("materials-title").textContent = field;
  await renderMaterialsForField(field);
  showView("materials");
}

async function renderMaterialsForField(field) {
  const all = await dbGetAll("materials");
  const items = all.filter((m) => m.field === field);
  const teach = items.filter((m) => m.type !== "past");
  const past = items.filter((m) => m.type === "past");

  renderMaterialGroup("materials-teach-list", teach);
  renderMaterialGroup("materials-past-list", past);
}

function renderMaterialGroup(elId, items) {
  const el = document.getElementById(elId);
  if (items.length === 0) {
    el.innerHTML = `<p class="material-empty">登録なし</p>`;
    return;
  }
  el.innerHTML = items
    .map(
      (m) => `
      <div class="material-item">
        <div class="material-info">
          <div class="material-name">${escapeHtml(m.title)}</div>
          <div class="material-meta">${m.pages.length}ページ ・ ${new Date(m.createdAt).toLocaleDateString("ja-JP")}登録</div>
        </div>
        <button class="material-delete-btn" data-delete-id="${m.id}">削除</button>
      </div>`
    )
    .join("");

  el.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.deleteId);
      if (!confirm("この資料を削除しますか？（取り込んだテキストも削除されます）")) return;
      await dbDelete("materials", id);
      const field = document.getElementById("materials-title").textContent;
      await renderMaterialsForField(field);
      await renderFieldList();
    });
  });
}

/* --- 教材・過去問の追加 --- */
let pendingAddType = "teach";

document.getElementById("btn-add-material").addEventListener("click", () => {
  pendingAddType = "teach";
  document.getElementById("add-title").textContent = "教材を追加";
  resetAddForm();
  showView("add");
});

document.getElementById("btn-add-exam").addEventListener("click", () => {
  pendingAddType = "past";
  document.getElementById("add-title").textContent = "過去問を追加";
  resetAddForm();
  showView("add");
});

function resetAddForm() {
  document.getElementById("add-field").value = "";
  document.getElementById("add-doc-title").value = "";
  document.getElementById("add-file").value = "";
  document.getElementById("add-status").textContent = "";
}

document.getElementById("btn-add-confirm").addEventListener("click", async () => {
  const field = document.getElementById("add-field").value.trim();
  const title = document.getElementById("add-doc-title").value.trim();
  const fileInput = document.getElementById("add-file");
  const statusEl = document.getElementById("add-status");
  const file = fileInput.files[0];

  if (!navigator.onLine) {
    statusEl.textContent = "オフラインのため、PDF取り込みはできません（PDF処理ライブラリの読み込みにネット接続が必要です）。";
    return;
  }

  if (!field || !title || !file) {
    statusEl.textContent = "分野・タイトル・PDFファイルをすべて入力してください。";
    return;
  }

  statusEl.textContent = "PDFを読み込み中…";
  try {
    const pages = await extractPdfPages(file);
    await dbAdd("materials", {
      type: pendingAddType,
      field,
      title,
      pages,
      createdAt: new Date().toISOString()
    });
    statusEl.textContent = `取り込み完了（${pages.length}ページ）`;
    await renderFieldList();
    setTimeout(() => showView("home"), 600);
  } catch (e) {
    console.error(e);
    statusEl.textContent = "PDFの読み込みに失敗しました：" + (e.message || "不明なエラー");
  }
});

/* --- 問題生成 --- */
document.getElementById("btn-generate").addEventListener("click", async () => {
  await renderFieldList();
  const genFieldEl = document.getElementById("gen-field");
  if (!genFieldEl.options.length) {
    alert("先に教材または過去問を登録してください。");
    return;
  }
  document.getElementById("gen-status").textContent = "";
  showView("generate");
});

document.getElementById("btn-generate-confirm").addEventListener("click", async () => {
  const statusEl = document.getElementById("gen-status");
  if (!navigator.onLine) {
    statusEl.textContent = "オフラインのため、AIでの問題生成はできません。ネット接続時にお試しください。";
    return;
  }
  const field = document.getElementById("gen-field").value;
  const count = Math.max(1, Math.min(20, Number(document.getElementById("gen-count").value) || 5));
  const includePast = document.getElementById("gen-include-past").checked;
  const btn = document.getElementById("btn-generate-confirm");

  statusEl.textContent = "AIが問題を作成し、品質チェック中…（混雑時は自動で少し待って再試行するため、最大2分ほどかかることがあります）";
  btn.disabled = true;
  try {
    const questions = await generateQuestions({ field, count, includePast });
    startQuiz(questions);
  } catch (e) {
    console.error(e);
    statusEl.textContent = e.message || "生成に失敗しました。";
  } finally {
    btn.disabled = false;
  }
});

/* --- クイズ画面 --- */
let quizQueue = [];
let quizIndex = 0;

function startQuiz(questions) {
  quizQueue = questions;
  quizIndex = 0;
  showView("quiz");
  renderCurrentQuestion();
}

function renderCurrentQuestion() {
  const resultEl = document.getElementById("quiz-result");
  resultEl.classList.add("hidden");

  const q = quizQueue[quizIndex];
  document.getElementById("quiz-progress").textContent = `${quizIndex + 1} / ${quizQueue.length} 問`;
  document.getElementById("quiz-topic").textContent = q.topic || "";
  document.getElementById("quiz-question").textContent = q.question;

  const choicesEl = document.getElementById("quiz-choices");
  choicesEl.innerHTML = "";
  q.choices.forEach((choice, idx) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.textContent = choice;
    btn.addEventListener("click", () => answerQuestion(idx));
    choicesEl.appendChild(btn);
  });
}

async function answerQuestion(selectedIdx) {
  const q = quizQueue[quizIndex];
  const buttons = document.querySelectorAll("#quiz-choices .choice-btn");
  buttons.forEach((b, idx) => {
    b.disabled = true;
    if (idx === q.answerIndex) b.classList.add("correct");
    else if (idx === selectedIdx) b.classList.add("wrong");
  });

  const correct = selectedIdx === q.answerIndex;
  const labelEl = document.getElementById("quiz-result-label");
  labelEl.textContent = correct ? "正解！" : "不正解";
  labelEl.className = "quiz-result-label " + (correct ? "is-correct" : "is-wrong");

  document.getElementById("quiz-explanation").textContent = q.explanation || "";
  document.getElementById("quiz-source").textContent = q.source ? `出典：${q.source}` : "";
  document.getElementById("quiz-result").classList.remove("hidden");

  await dbAdd("attempts", {
    questionId: q.id,
    correct,
    answeredAt: new Date().toISOString()
  });
}

document.getElementById("btn-next-question").addEventListener("click", () => {
  quizIndex++;
  if (quizIndex >= quizQueue.length) {
    showView("home");
  } else {
    renderCurrentQuestion();
  }
});

/* ---------------------------------------------------------
 * 初期化
 * --------------------------------------------------------- */
(async function init() {
  await renderFieldList();
  showView("home");
  updateOfflineBanner();
  window.addEventListener("online", updateOfflineBanner);
  window.addEventListener("offline", updateOfflineBanner);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();

function updateOfflineBanner() {
  const banner = document.getElementById("offline-banner");
  banner.classList.toggle("hidden", navigator.onLine);
}
