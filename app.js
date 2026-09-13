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
const GEMINI_MODEL = "gemini-2.5-flash";

async function callGemini(apiKey, prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini APIエラー (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return text;
}

/* 出典タグ付きの教材抜粋を作成する（プロンプトに埋め込む素材） */
function buildSourceExcerpts(materialsForField, maxChars) {
  let out = "";
  const sourceLabels = [];
  for (const m of materialsForField) {
    const kindLabel = m.type === "past" ? "過去問" : "教材";
    for (const p of m.pages) {
      if (!p.text) continue;
      const label =
        m.type === "past"
          ? `[出典:${m.title} 問題頁${p.page}]`
          : `[出典:${m.title} P.${p.page}]`;
      const chunk = `${label} ${p.text}\n`;
      if (out.length + chunk.length > maxChars) continue;
      out += chunk;
      sourceLabels.push(label.slice(4, -1)); // "出典:" と "]" を除いたラベル本体
    }
  }
  return { excerpts: out, sourceLabels };
}

function buildPrompt({ field, count, excerpts, includePast }) {
  return `あなたは臨床工学技士(CE)国家試験・認定試験対策の問題作成アシスタントです。
以下は「${field}」分野の教材・過去問から抜粋したテキストです。各行の先頭に [出典:...] というタグが付いています。

このタグ付きテキストだけを根拠として、4択問題を ${count} 問作成してください。

厳守事項：
- 必ず与えられたテキストに書かれている内容のみを根拠にすること。テキストにない知識を勝手に補わない。
- 各問題には、根拠にした [出典:...] の中身をそのまま source フィールドに書くこと。複数箇所を根拠にした場合は主要な1つを書く。
- 出典が特定できない問題は作らない。
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

  const { excerpts, sourceLabels } = buildSourceExcerpts(materialsForField, 60000);
  const prompt = buildPrompt({ field, count, excerpts, includePast });
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

  const saved = [];
  for (const q of validated) {
    const record = { ...q, field, createdAt: new Date().toISOString() };
    const id = await dbAdd("questions", record);
    saved.push({ ...record, id });
  }
  return saved;
}

/* ---------------------------------------------------------
 * 画面制御
 * --------------------------------------------------------- */
const views = ["home", "add", "generate", "quiz", "settings"];
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
  showView("settings");
});

document.getElementById("btn-save-key").addEventListener("click", async () => {
  const key = document.getElementById("settings-api-key").value.trim();
  await saveApiKey(key);
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
      <div class="field-group">
        <div class="field-title">${escapeHtml(field)}</div>
        <div class="field-counts">教材 ${c.teach}冊 ・ 過去問 ${c.past}冊</div>
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
  const field = document.getElementById("gen-field").value;
  const count = Math.max(1, Math.min(20, Number(document.getElementById("gen-count").value) || 5));
  const includePast = document.getElementById("gen-include-past").checked;
  const statusEl = document.getElementById("gen-status");
  const btn = document.getElementById("btn-generate-confirm");

  statusEl.textContent = "AIが問題を作成中…（数十秒かかることがあります）";
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
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
