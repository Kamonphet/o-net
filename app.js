/* ==========================================================================
   O-NET Grade 6 (Year 2568 / Exam 31 Jan 2569) Web Application
   Supports Set 100 (Group A) & Set 200 (Group B), Tutor & Exam Simulation Modes
   ========================================================================== */

(function () {
  "use strict";

  const STORAGE_KEY = "onet_p6_2568_state_v1";

  // Application State
  let DATA = null;
  let store = loadStore();

  // Active Session State (not persisted in full for Exam timer except on finish)
  let session = null;
  /*
    session = {
      paperKey: "A_math",
      paper: {...},
      mode: "tutor" | "exam",
      filter: "all" | "starred" | "wrong",
      filteredNos: [1, 2, ...],
      currentNo: 1,
      answers: { [no]: value },
      checked: { [no]: boolean },     // tutor mode
      revealed: { [no]: boolean },    // tutor mode
      activeWordSlot: { "21.1": null, "21.2": null },
      remainingSec: 3600,
      elapsedSec: 0,
      timerId: null,
      submittedResult: null,
      reviewFilter: "all"
    }
  */

  // -------------------------------------------------------------------------
  // Persistence Helpers
  // -------------------------------------------------------------------------
  function defaultStore() {
    return {
      selectedGroup: "A",
      selectedMode: "tutor",
      fontScale: "md",
      bookmarks: {},      // { "A_math": [9, 12] }
      wrongBank: {},      // { "A_math": [4, 9] }
      tutorSessions: {},  // { "A_math": { answers: {}, checked: {}, lastNo: 1 } }
      examRecords: {}     // { "A_math": { bestScore: 93.5, attempts: 1, lastScore: 93.5 } }
    };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultStore();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultStore(), parsed || {});
    } catch (_) {
      return defaultStore();
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (_) {
      // Ignore quota or private-browsing storage restrictions gracefully
    }
  }

  // -------------------------------------------------------------------------
  // Safe HTML & Exam Text Formatting (Strict XSS Prevention)
  // -------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Allows ONLY literal <u>...</u> underline tags from verified exam text
  function formatInlineExam(text) {
    const escaped = escapeHtml(text);
    return escaped.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, "<u>$1</u>");
  }

  function safeImageSrc(relPath) {
    const clean = String(relPath || "").trim();
    if (!/^images\/[A-Za-z0-9_.-]+\.(png|jpg|jpeg|webp)$/i.test(clean)) {
      return "";
    }
    return "data/" + clean;
  }

  function parseMarkdownTableLines(lines) {
    const rows = lines.map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
    );
    if (rows.length < 2) return null;
    const isSep = rows[1].every((c) => /^:?-{2,}:?$/.test(c));
    if (!isSep) return null;

    const headers = rows[0];
    const body = rows.slice(2);
    let html = '<div class="exam-md-table-wrap"><table class="exam-md-table"><thead><tr>';
    headers.forEach((h) => {
      html += `<th scope="col">${formatInlineExam(h)}</th>`;
    });
    html += "</tr></thead><tbody>";
    body.forEach((r) => {
      html += "<tr>";
      headers.forEach((_, idx) => {
        html += `<td>${formatInlineExam(r[idx] ?? "")}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  function formatRichBlocks(rawText, options = {}) {
    if (!rawText) return "";
    let text = String(rawText).trim();

    // Strip embedded markdown table when interactive true/false table widget renders it
    if (options.stripMarkdownTable) {
      const filteredLines = text
        .split("\n")
        .filter((ln) => !ln.trim().startsWith("|"));
      text = filteredLines.join("\n").trim();
    }

    // Special formatting for Scratch pseudocode passage (Science Q17)
    if (options.isPassage && text.includes("A เริ่มทำงานของโปรแกรม")) {
      const splitIdx = text.indexOf("A เริ่มทำงานของโปรแกรม");
      const intro = text.slice(0, splitIdx).trim();
      const code = text.slice(splitIdx).trim();
      return (
        `<p>${formatInlineExam(intro)}</p>` +
        `<div class="code-block-passage">${formatInlineExam(code)}</div>`
      );
    }

    const lines = text.split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      if (lines[i].trim().startsWith("|")) {
        const tblLines = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          tblLines.push(lines[i]);
          i++;
        }
        const tblHtml = parseMarkdownTableLines(tblLines);
        if (tblHtml) {
          out.push(tblHtml);
          continue;
        }
        tblLines.forEach((tl) => out.push(`<p>${formatInlineExam(tl)}</p>`));
        continue;
      }

      if (lines[i].trim() === "") {
        i++;
        continue;
      }

      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !lines[i].trim().startsWith("|")
      ) {
        paraLines.push(formatInlineExam(lines[i]));
        i++;
      }
      out.push(`<p>${paraLines.join("<br>")}</p>`);
    }

    return out.join("");
  }

  // -------------------------------------------------------------------------
  // Scoring & Evaluation Engine
  // -------------------------------------------------------------------------
  function getSectionForQuestion(paper, q) {
    return paper.sections.find((s) => s.id === q.section) || paper.sections[0];
  }

  function getMaxPoints(paper, q) {
    const sec = getSectionForQuestion(paper, q);
    return Number(sec?.points ?? 0);
  }

  function formatPoints(num) {
    if (Number.isInteger(num)) return String(num);
    return Number(num.toFixed(3)).toString();
  }

  function createDefaultWordOrderAnswer(meta) {
    const obj = {};
    meta.parts.forEach((part) => {
      const arr = new Array(part.length).fill(null);
      Object.entries(part.fixed || {}).forEach(([posOneBased, wordNum]) => {
        arr[Number(posOneBased) - 1] = Number(wordNum);
      });
      obj[part.id] = arr;
    });
    return obj;
  }

  function isQuestionAnswered(q, ans) {
    if (ans === undefined || ans === null) return false;
    if (q.type === "mcq") {
      return ans >= 1 && ans <= 4;
    }
    if (q.type === "numeric") {
      return typeof ans === "string" && /^\d+$/.test(ans.trim());
    }
    if (q.type === "other" && q.meta) {
      if (q.meta.kind === "true_false_table") {
        return Array.isArray(ans) && ans.length === q.meta.items.length && ans.every(Boolean);
      }
      if (q.meta.kind === "word_order") {
        return q.meta.parts.every((part) => {
          const arr = ans[part.id];
          return Array.isArray(arr) && arr.length === part.length && arr.every((n) => Number.isInteger(n));
        });
      }
      if (q.meta.kind === "essay_summary") {
        return Boolean(ans && typeof ans.text === "string" && ans.text.trim().length > 0);
      }
    }
    return false;
  }

  function evaluateQuestion(paper, q, ans) {
    const maxPoints = getMaxPoints(paper, q);
    const answered = isQuestionAnswered(q, ans);

    if (q.type === "mcq") {
      const isCorrect = answered && Number(ans) === Number(q.answer);
      return {
        isAnswered: answered,
        isCorrect,
        earnedPoints: isCorrect ? maxPoints : 0,
        maxPoints,
        userText: answered ? `ตัวเลือกที่ ${ans}` : "ไม่ได้เลือกคำตอบ",
        keyText: `ตัวเลือกที่ ${q.answer}`
      };
    }

    if (q.type === "numeric") {
      const clean = typeof ans === "string" ? ans.trim() : "";
      const isValid = /^\d+$/.test(clean);
      const isCorrect = isValid && parseInt(clean, 10) === parseInt(q.answer, 10);
      const numVal = parseInt(q.answer, 10);
      return {
        isAnswered: isValid,
        isCorrect,
        earnedPoints: isCorrect ? maxPoints : 0,
        maxPoints,
        userText: isValid ? clean : "ไม่ได้กรอกตัวเลข",
        keyText: `${numVal} (ระบายในกระดาษคำตอบ ${q.answer})`
      };
    }

    if (q.type === "other" && q.meta?.kind === "true_false_table") {
      const userArr = Array.isArray(ans) ? ans : [];
      const rowMatches = q.answer.map((expected, idx) => userArr[idx] === expected);
      const allCorrect = answered && rowMatches.every(Boolean);
      return {
        isAnswered: answered,
        isCorrect: allCorrect,
        earnedPoints: allCorrect ? maxPoints : 0,
        maxPoints,
        rowMatches,
        userText: userArr.some(Boolean)
          ? q.meta.items.map((it, idx) => `${it.id}: ${userArr[idx] || "-"}`).join(" · ")
          : "ไม่ได้เลือกคำตอบ",
        keyText: q.meta.items.map((it, idx) => `${it.id}: ${q.answer[idx]}`).join(" · ")
      };
    }

    if (q.type === "other" && q.meta?.kind === "word_order") {
      let earned = 0;
      const partResults = {};
      const userParts = [];
      const keyParts = [];

      q.meta.parts.forEach((part) => {
        const arr = ans && Array.isArray(ans[part.id]) ? ans[part.id] : [];
        const match =
          arr.length === part.answer.length &&
          arr.every((val, idx) => Number(val) === Number(part.answer[idx]));
        if (match) earned += part.points;
        partResults[part.id] = match;
        userParts.push(
          `${part.id}: [${arr.map((v) => (v == null ? "_" : v)).join(", ")}]`
        );
        keyParts.push(`${part.id}: [${part.answer.join(", ")}] (${part.sentence})`);
      });

      return {
        isAnswered: answered,
        isCorrect: earned === maxPoints,
        earnedPoints: earned,
        maxPoints,
        partResults,
        userText: userParts.join(" | "),
        keyText: keyParts.join(" | ")
      };
    }

    if (q.type === "other" && q.meta?.kind === "essay_summary") {
      const rubricState = (ans && ans.rubric) || {};
      let earned = 0;
      q.meta.rubric.forEach((r) => {
        if (rubricState[r.id]) earned += r.points;
      });
      const hasText = Boolean(ans && typeof ans.text === "string" && ans.text.trim().length > 0);
      return {
        isAnswered: hasText,
        isCorrect: earned >= 12,
        isEssay: true,
        earnedPoints: earned,
        maxPoints,
        userText: hasText ? ans.text.trim() : "ไม่ได้เขียนสรุปใจความสำคัญ",
        keyText: q.meta.sampleAnswer
      };
    }

    return {
      isAnswered: false,
      isCorrect: false,
      earnedPoints: 0,
      maxPoints,
      userText: "-",
      keyText: "-"
    };
  }

  // -------------------------------------------------------------------------
  // Bookmark & Wrong Bank Helpers
  // -------------------------------------------------------------------------
  function isBookmarked(paperKey, qNo) {
    return (store.bookmarks[paperKey] || []).includes(qNo);
  }

  function toggleBookmark(paperKey, qNo) {
    const list = new Set(store.bookmarks[paperKey] || []);
    if (list.has(qNo)) list.delete(qNo);
    else list.add(qNo);
    store.bookmarks[paperKey] = Array.from(list).sort((a, b) => a - b);
    saveStore();
  }

  function recordOutcomeInWrongBank(paperKey, qNo, isCorrect, isEssay) {
    if (isEssay) return;
    const set = new Set(store.wrongBank[paperKey] || []);
    if (isCorrect) set.delete(qNo);
    else set.add(qNo);
    store.wrongBank[paperKey] = Array.from(set).sort((a, b) => a - b);
  }

  // -------------------------------------------------------------------------
  // View Switching & Topbar Controls
  // -------------------------------------------------------------------------
  function showView(viewId) {
    ["view-loading", "view-home", "view-session", "view-result"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = id !== viewId;
    });
    const setSwitch = document.getElementById("topbar-set-Slot");
    if (setSwitch) {
      setSwitch.hidden = viewId !== "view-home";
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function applyFontScale(scale) {
    store.fontScale = scale;
    document.documentElement.setAttribute("data-font", scale);
    document.querySelectorAll(".font-btn").forEach((btn) => {
      const active = btn.dataset.fontScale === scale;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    saveStore();
  }

  function stopExamTimer() {
    if (session && session.timerId) {
      clearInterval(session.timerId);
      session.timerId = null;
    }
  }

  // -------------------------------------------------------------------------
  // 1. Render Home Workbench
  // -------------------------------------------------------------------------
  function renderHome() {
    stopExamTimer();
    session = null;
    showView("view-home");

    const group = store.selectedGroup;
    const mode = store.selectedMode;
    const setMeta = DATA.sets.find((s) => s.group === group) || DATA.sets[0];

    // Update topbar set buttons
    document.querySelectorAll("[data-set-group]").forEach((btn) => {
      const active = btn.dataset.setGroup === group;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });

    // Update mode radio buttons
    document.querySelectorAll(".mode-option").forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle("is-selected", active);
      btn.setAttribute("aria-checked", String(active));
    });

    document.getElementById("active-set-badge").textContent =
      `${setMeta.label} · ${setMeta.subLabel}`;

    // Render 4 subjects
    const listEl = document.getElementById("subject-list");
    let subjectRowsHtml = "";

    let totalQuestionsInSet = 0;
    let totalCheckedInSet = 0;
    let totalStarredInSet = 0;
    let totalWrongInSet = 0;
    const reviewItems = [];

    DATA.subjects.forEach((subj) => {
      const paperKey = `${group}_${subj.id}`;
      const paper = DATA.papers[paperKey];
      const tutorSaved = store.tutorSessions[paperKey] || { answers: {}, checked: {} };
      const examRec = store.examRecords[paperKey] || null;
      const starredCount = (store.bookmarks[paperKey] || []).length;
      const wrongCount = (store.wrongBank[paperKey] || []).length;
      const checkedCount = Object.keys(tutorSaved.checked || {}).length;

      totalQuestionsInSet += paper.questions.length;
      totalCheckedInSet += checkedCount;
      totalStarredInSet += starredCount;
      totalWrongInSet += wrongCount;

      if (starredCount > 0) {
        reviewItems.push({
          paperKey,
          filter: "starred",
          label: `${subj.name} · ข้อที่ติดดาว`,
          count: `${starredCount} ข้อ`
        });
      }
      if (wrongCount > 0) {
        reviewItems.push({
          paperKey,
          filter: "wrong",
          label: `${subj.name} · ข้อที่เคยตอบผิด`,
          count: `${wrongCount} ข้อ`
        });
      }

      const secSummary = paper.sections
        .map((s) => s.title.replace(/^ตอนที่\s*\S+\s*/, ""))
        .join(" + ");

      let progressTags = "";
      if (checkedCount > 0) {
        progressTags += `<span class="progress-tag ${checkedCount === paper.questions.length ? "is-good" : ""}">ติวแล้ว ${checkedCount}/${paper.questions.length} ข้อ</span>`;
      } else {
        progressTags += `<span class="progress-tag">ยังไม่ได้เริ่มติว</span>`;
      }

      if (examRec) {
        progressTags += `<span class="progress-tag is-good">คะแนนสอบสูงสุด ${examRec.bestScore.toFixed(2)} / 100</span>`;
      }
      if (starredCount > 0) {
        progressTags += `<span class="progress-tag">ติดดาว ${starredCount} ข้อ</span>`;
      }

      const primaryLabel =
        mode === "exam"
          ? "เริ่มจำลองสอบ"
          : checkedCount > 0 && checkedCount < paper.questions.length
          ? "ติวต่อจากเดิม"
          : "เริ่มติวข้อสอบ";

      subjectRowsHtml += `
        <div class="subject-row">
          <div class="subject-info">
            <div class="subject-title-line">
              <h3 class="subject-name">${escapeHtml(subj.name)}</h3>
              <span class="subject-code">รหัสวิชา ${subj.code} · ชุดที่ ${paper.setCode}</span>
            </div>
            <p class="subject-spec">จำนวน ${subj.questionCount} ข้อ (${escapeHtml(secSummary)}) · เวลาสอบ ${subj.durationMinutes} นาที · ${subj.totalPoints} คะแนน</p>
            <div class="subject-progress-row">${progressTags}</div>
          </div>
          <div class="subject-actions">
            <button type="button" class="btn btn-primary" data-start-paper="${paperKey}" data-start-mode="${mode}">
              ${primaryLabel}
            </button>
          </div>
        </div>
      `;
    });

    listEl.innerHTML = subjectRowsHtml;

    // Overall stats sidebar
    const statsEl = document.getElementById("overall-stats");
    const examsTaken = DATA.subjects.filter(
      (s) => Boolean(store.examRecords[`${group}_${s.id}`])
    ).length;

    statsEl.innerHTML = `
      <div class="stat-item">
        <dt>ความคืบหน้าโหมดติว (${escapeHtml(setMeta.label)})</dt>
        <dd>${totalCheckedInSet} / ${totalQuestionsInSet}</dd>
      </div>
      <div class="stat-item">
        <dt>วิชาที่จำลองสอบแล้ว</dt>
        <dd>${examsTaken} / 4 วิชา</dd>
      </div>
      <div class="stat-item">
        <dt>ข้อที่ติดดาวทบทวน</dt>
        <dd>${totalStarredInSet} ข้อ</dd>
      </div>
      <div class="stat-item">
        <dt>ข้อที่ควรฝึกซ้ำ</dt>
        <dd>${totalWrongInSet} ข้อ</dd>
      </div>
    `;

    // Quick review list
    const qrEl = document.getElementById("quick-review-list");
    if (reviewItems.length === 0) {
      qrEl.innerHTML = `<button type="button" class="quick-review-btn" disabled><span>ยังไม่มีข้อที่ติดดาวหรือข้อที่ตอบผิดใน${escapeHtml(setMeta.label)}</span><span>0 ข้อ</span></button>`;
    } else {
      qrEl.innerHTML = reviewItems
        .map(
          (item) => `
          <button type="button" class="quick-review-btn" data-quick-paper="${item.paperKey}" data-quick-filter="${item.filter}">
            <span>${escapeHtml(item.label)}</span>
            <span>${escapeHtml(item.count)}</span>
          </button>
        `
        )
        .join("");
    }
  }

  // -------------------------------------------------------------------------
  // 2. Start Session (Tutor or Exam Simulation)
  // -------------------------------------------------------------------------
  function startSession(paperKey, mode, initialFilter = "all") {
    const paper = DATA.papers[paperKey];
    if (!paper) return;

    stopExamTimer();

    let answers = {};
    let checked = {};
    let startNo = 1;

    if (mode === "tutor") {
      const saved = store.tutorSessions[paperKey];
      if (saved) {
        answers = JSON.parse(JSON.stringify(saved.answers || {}));
        checked = JSON.parse(JSON.stringify(saved.checked || {}));
        startNo = saved.lastNo || 1;
      }
    }

    // Ensure word_order questions have fixed hint positions pre-populated
    paper.questions.forEach((q) => {
      if (q.meta?.kind === "word_order" && !answers[q.no]) {
        answers[q.no] = createDefaultWordOrderAnswer(q.meta);
      }
    });

    session = {
      paperKey,
      paper,
      mode,
      filter: initialFilter,
      filteredNos: [],
      currentNo: startNo,
      answers,
      checked,
      revealed: {},
      activeWordSlot: {},
      remainingSec: (paper.durationMinutes || 60) * 60,
      elapsedSec: 0,
      timerId: null,
      submittedResult: null,
      reviewFilter: "all"
    };

    recomputeFilteredQuestions(startNo);
    showView("view-session");

    document.getElementById("exam-submit-strip").hidden = true;
    document.getElementById("question-palette-aside").classList.remove("is-open");

    if (mode === "exam") {
      startExamCountdown();
    }

    renderSessionHeader();
    renderCurrentQuestion();
    renderPalette();
  }

  function persistTutorSession() {
    if (!session || session.mode !== "tutor") return;
    store.tutorSessions[session.paperKey] = {
      answers: session.answers,
      checked: session.checked,
      lastNo: session.currentNo
    };
    saveStore();
  }

  function recomputeFilteredQuestions(preferredNo) {
    const { paper, paperKey, filter } = session;
    const allNos = paper.questions.map((q) => q.no);

    if (session.mode === "exam" || filter === "all") {
      session.filteredNos = allNos;
    } else if (filter === "starred") {
      const starred = new Set(store.bookmarks[paperKey] || []);
      session.filteredNos = allNos.filter((n) => starred.has(n));
    } else if (filter === "wrong") {
      const wrongs = new Set(store.wrongBank[paperKey] || []);
      session.filteredNos = allNos.filter((n) => wrongs.has(n));
    }

    if (session.filteredNos.length > 0) {
      if (preferredNo && session.filteredNos.includes(preferredNo)) {
        session.currentNo = preferredNo;
      } else {
        session.currentNo = session.filteredNos[0];
      }
    }
  }

  function startExamCountdown() {
    updateTimerDisplay();
    session.timerId = setInterval(() => {
      if (!session || session.mode !== "exam") return;
      session.remainingSec = Math.max(0, session.remainingSec - 1);
      session.elapsedSec += 1;
      updateTimerDisplay();
      if (session.remainingSec === 0) {
        finalizeExamSubmission();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const timerBox = document.getElementById("exam-timer");
    const timerText = document.getElementById("exam-timer-text");
    if (!timerBox || !timerText || !session) return;

    const mins = Math.floor(session.remainingSec / 60);
    const secs = session.remainingSec % 60;
    timerText.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    timerBox.classList.toggle("is-low", session.remainingSec <= 300);
  }

  function renderSessionHeader() {
    const { paper, mode, filter } = session;
    document.getElementById("session-subject-title").textContent = paper.subjectName;
    document.getElementById("session-meta-label").textContent =
      `รหัสวิชา ${paper.subjectCode} · ชุดที่ ${paper.setCode} · ${mode === "exam" ? "โหมดจำลองสอบจริง" : "โหมดติวข้อสอบ"}`;

    const tutorFilterBar = document.getElementById("tutor-filter-bar");
    const tutorScorePill = document.getElementById("tutor-score-pill");
    const examControls = document.getElementById("exam-controls");

    tutorFilterBar.hidden = mode !== "tutor";
    tutorScorePill.hidden = mode !== "tutor";
    examControls.hidden = mode !== "exam";

    if (mode === "tutor") {
      tutorFilterBar.querySelectorAll(".pill-btn").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.filter === filter);
      });
      const checkedNos = Object.keys(session.checked).map(Number);
      let correctCount = 0;
      checkedNos.forEach((no) => {
        const q = paper.questions[no - 1];
        if (q && evaluateQuestion(paper, q, session.answers[no]).isCorrect) {
          correctCount++;
        }
      });
      tutorScorePill.textContent = `ตรวจแล้ว ${checkedNos.length}/${paper.questions.length} ข้อ (ถูก ${correctCount})`;
    }
  }

  // -------------------------------------------------------------------------
  // Render Active Question & Interactive Widgets
  // -------------------------------------------------------------------------
  function renderCurrentQuestion() {
    const emptyEl = document.getElementById("empty-filter-state");
    const bodyWrap = document.getElementById("question-body-wrap");
    const bannerEl = document.getElementById("section-banner");

    if (session.filteredNos.length === 0) {
      bannerEl.hidden = true;
      bodyWrap.hidden = true;
      emptyEl.hidden = false;
      return;
    }

    bannerEl.hidden = false;
    bodyWrap.hidden = false;
    emptyEl.hidden = true;

    const { paper, paperKey, currentNo, mode } = session;
    const q = paper.questions[currentNo - 1];
    const sec = getSectionForQuestion(paper, q);
    const maxPts = getMaxPoints(paper, q);
    const isChecked = mode === "tutor" && Boolean(session.checked[q.no]);
    const isRevealed = mode === "tutor" && Boolean(session.revealed[q.no]);

    // Section Banner
    bannerEl.innerHTML = `<strong>${escapeHtml(sec.title)}</strong> — ${escapeHtml(sec.instructions)}`;

    // Header & Bookmark
    document.getElementById("q-heading").textContent = `ข้อที่ ${q.no}`;
    document.getElementById("q-points-badge").textContent = `${formatPoints(maxPts)} คะแนน`;

    const starred = isBookmarked(paperKey, q.no);
    const bmBtn = document.getElementById("btn-bookmark");
    bmBtn.setAttribute("aria-pressed", String(starred));
    document.getElementById("bookmark-label").textContent = starred ? "ติดดาวแล้ว" : "ติดดาวทบทวน";

    // Reading Passage
    const passageEl = document.getElementById("q-passage");
    if (q.passage) {
      passageEl.hidden = false;
      passageEl.innerHTML = formatRichBlocks(q.passage, { isPassage: true });
    } else {
      passageEl.hidden = true;
      passageEl.innerHTML = "";
    }

    // Stem Figures (skip here if Thai Q21 renders per-part images, or if picture choices render in interaction)
    const figEl = document.getElementById("q-figures");
    const hasStemFigures =
      Array.isArray(q.images) &&
      q.images.length > 0 &&
      !q.choiceImages &&
      q.meta?.kind !== "word_order";

    if (hasStemFigures) {
      figEl.hidden = false;
      figEl.innerHTML = q.images
        .map((imgRel, idx) => renderFigureHtml(imgRel, `ภาพประกอบข้อที่ ${q.no}${q.images.length > 1 ? ` (${idx + 1})` : ""}`))
        .join("");
    } else {
      figEl.hidden = true;
      figEl.innerHTML = "";
    }

    // Question Stem
    const stemEl = document.getElementById("q-stem");
    if (q.meta?.kind === "word_order") {
      stemEl.innerHTML = `<p>จงนำคำที่กำหนดให้ทุกคำมาเรียงเป็นประโยคที่ต่อเนื่องและสอดคล้องกับภาพ โดยคลิกเลือกคำด้านล่างเพื่อวางลงในช่องลำดับคำ</p>`;
    } else {
      stemEl.innerHTML = formatRichBlocks(q.question, {
        stripMarkdownTable: q.meta?.kind === "true_false_table"
      });
    }

    // Interactive Answer Widget
    const interEl = document.getElementById("q-interaction");
    interEl.innerHTML = buildInteractionHtml(q, session.answers[q.no], isChecked);

    // Tutor Mode Action Buttons & Feedback
    const tutorRow = document.getElementById("tutor-action-row");
    const checkBtn = document.getElementById("btn-check-answer");
    const revealBtn = document.getElementById("btn-reveal-explanation");
    const feedbackEl = document.getElementById("q-feedback");

    if (mode === "tutor") {
      const answered = isQuestionAnswered(q, session.answers[q.no]);
      const isEssay = q.meta?.kind === "essay_summary";
      tutorRow.hidden = isChecked;
      checkBtn.textContent = isEssay ? "บันทึกและเทียบแนวคำตอบ" : "ตรวจคำตอบ";
      checkBtn.disabled = !answered && !isEssay;
      revealBtn.hidden = isChecked || isRevealed;

      if (isChecked || isRevealed) {
        const evalRes = evaluateQuestion(paper, q, session.answers[q.no]);
        feedbackEl.hidden = false;
        if (isChecked && !isEssay) {
          feedbackEl.className = `feedback-panel ${evalRes.isCorrect ? "is-correct" : "is-wrong"}`;
          const headTitle = evalRes.isCorrect
            ? `ถูกต้อง (+${formatPoints(evalRes.earnedPoints)} คะแนน)`
            : `ยังไม่ถูกต้อง — เฉลยคือ ${escapeHtml(evalRes.keyText)}`;
          feedbackEl.innerHTML = `
            <div class="feedback-head">${headTitle}</div>
            <div class="feedback-exp">${formatInlineExam(q.explanation)}</div>
          `;
        } else {
          feedbackEl.className = "feedback-panel";
          feedbackEl.innerHTML = `
            <div class="feedback-head">เฉลยและแนวคิด (${escapeHtml(evalRes.keyText)})</div>
            <div class="feedback-exp">${formatInlineExam(q.explanation)}</div>
          `;
        }
      } else {
        feedbackEl.hidden = true;
        feedbackEl.innerHTML = "";
      }
    } else {
      tutorRow.hidden = true;
      feedbackEl.hidden = true;
    }

    // Prev / Next Footer
    const posIdx = session.filteredNos.indexOf(currentNo);
    document.getElementById("btn-prev-q").disabled = posIdx <= 0;
    document.getElementById("btn-next-q").disabled = posIdx >= session.filteredNos.length - 1;
    document.getElementById("q-progress-text").textContent =
      `ข้อ ${currentNo} (${posIdx + 1} จาก ${session.filteredNos.length})`;
  }

  function renderFigureHtml(relPath, caption) {
    const src = safeImageSrc(relPath);
    if (!src) return "";
    return `
      <figure class="figure-frame">
        <img src="${escapeHtml(src)}" alt="${escapeHtml(caption)}" data-zoom-src="${escapeHtml(src)}" data-zoom-caption="${escapeHtml(caption)}">
        <button type="button" class="zoom-btn" data-zoom-src="${escapeHtml(src)}" data-zoom-caption="${escapeHtml(caption)}">
          <svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
            <path d="M20 20L16.2 16.2M11 8V14M8 11H14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>ขยายภาพขนาดเต็ม</span>
        </button>
      </figure>
    `;
  }

  function buildInteractionHtml(q, userAns, isLockedFeedback) {
    // 1. Multiple Choice (Text or Picture Choices)
    if (q.type === "mcq") {
      let html = "";
      if (q.choiceImages && Array.isArray(q.images) && q.images.length > 0) {
        html += q.images
          .map((rel) => renderFigureHtml(rel, `ภาพตัวเลือกข้อที่ ${q.no}`))
          .join("");
        html += `<div class="choice-list is-picture-grid" role="radiogroup" aria-label="เลือกคำตอบ 1 ถึง 4">`;
        for (let idx = 1; idx <= 4; idx++) {
          const cls = getMcqOptionClass(idx, userAns, q.answer, isLockedFeedback);
          html += `
            <button type="button" class="choice-btn ${cls}" data-mcq-choice="${idx}" ${isLockedFeedback ? "disabled" : ""} role="radio" aria-checked="${userAns === idx}">
              <span class="choice-num">${idx}</span>
              <span>ภาพที่ ${idx}</span>
            </button>
          `;
        }
        html += `</div>`;
        return html;
      }

      html += `<div class="choice-list" role="radiogroup" aria-label="ตัวเลือกคำตอบ">`;
      q.choices.forEach((choiceText, i) => {
        const idx = i + 1;
        const cls = getMcqOptionClass(idx, userAns, q.answer, isLockedFeedback);
        html += `
          <button type="button" class="choice-btn ${cls}" data-mcq-choice="${idx}" ${isLockedFeedback ? "disabled" : ""} role="radio" aria-checked="${userAns === idx}">
            <span class="choice-num">${idx}</span>
            <span class="choice-label">${formatInlineExam(choiceText)}</span>
          </button>
        `;
      });
      html += `</div>`;
      return html;
    }

    // 2. Numeric Entry (Math Section 2)
    if (q.type === "numeric") {
      const val = typeof userAns === "string" ? userAns : "";
      return `
        <div class="numeric-widget">
          <label class="numeric-label" for="numeric-ans-input">กรอกตัวเลขคำตอบ (จำนวนเต็มบวก)</label>
          <div class="numeric-input-row">
            <input
              type="text"
              id="numeric-ans-input"
              class="numeric-input"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="4"
              placeholder="เช่น 034"
              value="${escapeHtml(val)}"
              ${isLockedFeedback ? "disabled" : ""}
              autocomplete="off"
            >
          </div>
          <p class="numeric-hint">สามารถพิมพ์เป็นตัวเลขปกติ (เช่น 34) หรือเลข 3 หลักตามกระดาษคำตอบ (034) ระบบตรวจให้คะแนนตรงกันทั้งสองแบบ</p>
        </div>
      `;
    }

    // 3. True/False Complex Table (Science Q19-20)
    if (q.type === "other" && q.meta?.kind === "true_false_table") {
      const arr = Array.isArray(userAns) ? userAns : new Array(q.meta.items.length).fill(null);
      let rowsHtml = "";

      q.meta.items.forEach((item, idx) => {
        const picked = arr[idx];
        let rowCls = "";
        if (isLockedFeedback) {
          rowCls = picked === q.answer[idx] ? "tf-row-correct" : "tf-row-wrong";
        }
        rowsHtml += `
          <tr class="${rowCls}">
            <td><strong>${escapeHtml(item.id)}</strong></td>
            <td>${formatInlineExam(item.text)}</td>
            <td class="tf-options-cell">
              <div class="tf-btn-group" role="group" aria-label="คำตอบข้อย่อย ${escapeHtml(item.id)}">
                ${q.meta.options
                  .map(
                    (opt) => `
                  <button
                    type="button"
                    class="tf-choice-btn ${picked === opt ? "is-selected" : ""}"
                    data-tf-index="${idx}"
                    data-tf-val="${escapeHtml(opt)}"
                    ${isLockedFeedback ? "disabled" : ""}
                    aria-pressed="${picked === opt}"
                  >${escapeHtml(opt)}</button>
                `
                  )
                  .join("")}
              </div>
            </td>
          </tr>
        `;
      });

      return `
        <div class="exam-md-table-wrap">
          <table class="tf-table">
            <thead>
              <tr>
                <th scope="col">ข้อย่อย</th>
                <th scope="col">ข้อความ</th>
                <th scope="col" class="tf-options-cell">ใช่ หรือ ไม่ใช่</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      `;
    }

    // 4. Word Ordering (Thai Q21.1 & Q21.2)
    if (q.type === "other" && q.meta?.kind === "word_order") {
      const currentObj = userAns || createDefaultWordOrderAnswer(q.meta);
      let html = `<div class="word-order-stack">`;

      q.meta.parts.forEach((part) => {
        const slots = currentObj[part.id] || [];
        const usedSet = new Set(slots.filter((n) => Number.isInteger(n)));
        const wordMap = {};
        part.words.forEach((w) => {
          wordMap[w.num] = w.text;
        });

        let targetIdx = session.activeWordSlot[part.id];
        if (
          targetIdx == null ||
          part.fixed[String(targetIdx + 1)] ||
          slots[targetIdx] != null
        ) {
          targetIdx = slots.findIndex(
            (v, idx) => v == null && !part.fixed[String(idx + 1)]
          );
        }

        const slotsHtml = slots
          .map((wNum, idx) => {
            const pos = idx + 1;
            const isFixed = Boolean(part.fixed[String(pos)]);
            const isFilled = wNum != null;
            const isTarget = !isLockedFeedback && idx === targetIdx;
            const cls = [
              "wo-slot",
              isFixed ? "is-fixed" : isFilled ? "is-filled" : "",
              isTarget ? "is-active-target" : ""
            ]
              .filter(Boolean)
              .join(" ");

            const label = isFilled ? `${wNum}. ${escapeHtml(wordMap[wNum] || "")}` : "ว่าง";
            return `
              <button
                type="button"
                class="${cls}"
                data-wo-part="${escapeHtml(part.id)}"
                data-wo-slot="${idx}"
                ${isFixed || isLockedFeedback ? "disabled" : ""}
                title="${isFixed ? "ตำแหน่งที่โจทย์กำหนดให้คงที่" : "คลิกเพื่อเลือกช่องหรือนำคำออก"}"
              >
                <span class="wo-slot-pos">[${pos}]</span>
                <span>${label}</span>
              </button>
            `;
          })
          .join("");

        const chipsHtml = part.words
          .map((w) => {
            const used = usedSet.has(w.num);
            return `
              <button
                type="button"
                class="wo-chip"
                data-wo-part="${escapeHtml(part.id)}"
                data-wo-word="${w.num}"
                ${used || isLockedFeedback ? "disabled" : ""}
              >
                ${w.num}. ${escapeHtml(w.text)}
              </button>
            `;
          })
          .join("");

        const sentencePreview = slots
          .map((n) => (n != null ? wordMap[n] : "___"))
          .join("");

        html += `
          <div class="word-order-part">
            <div class="wo-part-head">
              <h3 class="wo-part-title">${escapeHtml(part.title)}</h3>
              ${
                !isLockedFeedback
                  ? `<button type="button" class="btn btn-secondary btn-sm" data-wo-reset="${escapeHtml(part.id)}">ล้างเรียงใหม่</button>`
                  : ""
              }
            </div>
            <p class="wo-hint">${escapeHtml(part.hint)}</p>
            ${renderFigureHtml(part.image, `ภาพประกอบ ${part.title}`)}
            <div class="wo-slots-label">ลำดับคำในประโยค (${part.length} ตำแหน่ง):</div>
            <div class="wo-slots">${slotsHtml}</div>
            <div class="wo-bank-label">คลังคำที่กำหนดให้ (คลิกเพื่อเติมลงช่องว่าง):</div>
            <div class="wo-bank">${chipsHtml}</div>
            <div class="wo-preview"><strong>ประโยคที่เรียงได้:</strong> ${escapeHtml(sentencePreview)}</div>
          </div>
        `;
      });

      html += `</div>`;
      return html;
    }

    // 5. Essay 3-Line Summary (Thai Q22)
    if (q.type === "other" && q.meta?.kind === "essay_summary") {
      const obj = userAns || { text: "", rubric: {} };
      const textVal = obj.text || "";
      const lineCount = textVal.trim() ? textVal.split("\n").length : 0;
      const charCount = textVal.trim().length;
      const isOver = lineCount > 3 || charCount > 260;

      const rubricHtml = q.meta.rubric
        .map((r) => {
          const checked = Boolean(obj.rubric && obj.rubric[r.id]);
          return `
            <label class="rubric-item">
              <input type="checkbox" data-essay-rubric="${escapeHtml(r.id)}" ${checked ? "checked" : ""}>
              <span>${escapeHtml(r.label)} <strong>(${r.points} คะแนน)</strong></span>
            </label>
          `;
        })
        .join("");

      return `
        <div class="essay-widget">
          <label class="numeric-label" for="essay-summary-input">เขียนสรุปใจความสำคัญด้วยภาษาของตนเอง (ความยาวไม่เกิน 3 บรรทัด)</label>
          <textarea
            id="essay-summary-input"
            class="essay-textarea"
            rows="4"
            placeholder="พิมพ์ข้อความสรุปใจความสำคัญของบทอ่านที่นี่..."
          >${escapeHtml(textVal)}</textarea>
          <div id="essay-counter" class="essay-meta-bar ${isOver ? "is-over" : ""}">
            <span>จำนวนบรรทัดที่ขึ้นใหม่: ${lineCount} / 3 บรรทัด</span>
            <span>ความยาวข้อความ: ${charCount} ตัวอักษร (แนะนำประมาณ 160–240 ตัวอักษร)</span>
          </div>
          <div class="rubric-box">
            <h3>รายการประเมินตนเองตามเกณฑ์การสรุปใจความสำคัญ (เต็ม 15 คะแนน)</h3>
            <div class="rubric-list">${rubricHtml}</div>
          </div>
        </div>
      `;
    }

    return "";
  }

  function getMcqOptionClass(idx, userAns, correctAns, isLockedFeedback) {
    if (!isLockedFeedback) {
      return userAns === idx ? "is-selected" : "";
    }
    if (idx === correctAns) return "is-correct";
    if (userAns === idx && userAns !== correctAns) return "is-wrong";
    return "";
  }

  // -------------------------------------------------------------------------
  // Render Question Navigator Palette
  // -------------------------------------------------------------------------
  function renderPalette() {
    if (!session) return;
    const { paper, paperKey, currentNo, mode } = session;
    const summaryEl = document.getElementById("palette-summary");
    const secContainer = document.getElementById("palette-sections");

    let answeredCount = 0;
    paper.questions.forEach((q) => {
      if (isQuestionAnswered(q, session.answers[q.no])) answeredCount++;
    });

    summaryEl.textContent = `ทำแล้ว ${answeredCount} จาก ${paper.questions.length} ข้อ`;

    secContainer.innerHTML = paper.sections
      .map((sec) => {
        const secQs = paper.questions.filter((q) => q.section === sec.id);
        const btns = secQs
          .map((q) => {
            const ans = session.answers[q.no];
            const answered = isQuestionAnswered(q, ans);
            const checked = mode === "tutor" && Boolean(session.checked[q.no]);
            const starred = isBookmarked(paperKey, q.no);

            let stateCls = "";
            if (checked) {
              const ev = evaluateQuestion(paper, q, ans);
              stateCls = ev.isCorrect ? "is-correct" : "is-wrong";
            } else if (answered) {
              stateCls = "is-answered";
            }
            if (q.no === currentNo) stateCls += " is-current";

            return `
              <button type="button" class="pal-btn ${stateCls}" data-jump-no="${q.no}" aria-label="ไปยังข้อที่ ${q.no}">
                ${q.no}
                ${starred ? '<span class="pal-star-dot" aria-hidden="true"></span>' : ""}
              </button>
            `;
          })
          .join("");

        return `
          <div class="palette-sec">
            <div class="palette-sec-title">${escapeHtml(sec.title)}</div>
            <div class="palette-grid">${btns}</div>
          </div>
        `;
      })
      .join("");
  }

  // -------------------------------------------------------------------------
  // 3. Exam Submission & Results View
  // -------------------------------------------------------------------------
  function requestExamSubmit() {
    if (!session || session.mode !== "exam") return;
    const { paper } = session;
    const unanswered = paper.questions.filter(
      (q) => !isQuestionAnswered(q, session.answers[q.no])
    );

    const strip = document.getElementById("exam-submit-strip");
    const msg = document.getElementById("exam-submit-message");
    strip.hidden = false;

    if (unanswered.length > 0) {
      msg.textContent = `คุณยังไม่ได้ตอบข้อสอบอีก ${unanswered.length} ข้อ (ข้อ ${unanswered
        .slice(0, 8)
        .map((q) => q.no)
        .join(", ")}${unanswered.length > 8 ? " ..." : ""}) ต้องการส่งกระดาษคำตอบเลยหรือไม่?`;
    } else {
      msg.textContent = "ตอบครบทุกข้อเรียบร้อยแล้ว ยืนยันการส่งกระดาษคำตอบเพื่อตรวจคะแนนหรือไม่?";
    }
    strip.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function finalizeExamSubmission() {
    if (!session) return;
    stopExamTimer();

    const { paper, paperKey } = session;
    const evaluations = paper.questions.map((q) => ({
      q,
      ev: evaluateQuestion(paper, q, session.answers[q.no])
    }));

    let totalEarned = 0;
    const wrongNos = [];

    evaluations.forEach(({ q, ev }) => {
      totalEarned += ev.earnedPoints;
      recordOutcomeInWrongBank(paperKey, q.no, ev.isCorrect, ev.isEssay);
      if (!ev.isCorrect && !ev.isEssay) {
        wrongNos.push(q.no);
      }
    });

    const prevRec = store.examRecords[paperKey] || { bestScore: 0, attempts: 0 };
    store.examRecords[paperKey] = {
      bestScore: Math.max(prevRec.bestScore, totalEarned),
      lastScore: totalEarned,
      attempts: prevRec.attempts + 1
    };
    saveStore();

    session.submittedResult = {
      evaluations,
      totalEarned,
      wrongNos
    };
    session.reviewFilter = "all";

    showView("view-result");
    renderExamResults();
  }

  function renderExamResults() {
    if (!session || !session.submittedResult) return;
    const { paper, paperKey, elapsedSec, submittedResult, reviewFilter } = session;

    // Recalculate live in case Thai Q22 self-rubric checkboxes are toggled on result view
    const evaluations = paper.questions.map((q) => ({
      q,
      ev: evaluateQuestion(paper, q, session.answers[q.no])
    }));
    const totalEarned = evaluations.reduce((sum, item) => sum + item.ev.earnedPoints, 0);
    submittedResult.evaluations = evaluations;
    submittedResult.totalEarned = totalEarned;

    // Update best score if essay rubric adjusted upward
    if (store.examRecords[paperKey]) {
      store.examRecords[paperKey].bestScore = Math.max(
        store.examRecords[paperKey].bestScore,
        totalEarned
      );
      saveStore();
    }

    const usedMin = Math.floor(elapsedSec / 60);
    const usedSec = elapsedSec % 60;

    document.getElementById("result-title").textContent =
      `ผลคะแนนจำลองสอบวิชา${paper.subjectName} (ชุดที่ ${paper.setCode})`;
    document.getElementById("result-subtitle").textContent =
      `รหัสวิชา ${paper.subjectCode} · ใช้เวลาทำข้อสอบ ${usedMin} นาที ${usedSec} วินาที`;
    document.getElementById("result-total-score").textContent = totalEarned.toFixed(2);

    // Section breakdown table
    const tbody = document.getElementById("result-section-tbody");
    tbody.innerHTML = paper.sections
      .map((sec) => {
        const items = evaluations.filter((x) => x.q.section === sec.id);
        const correctCnt = items.filter((x) => x.ev.isCorrect).length;
        const secEarned = items.reduce((s, x) => s + x.ev.earnedPoints, 0);
        const secMax = items.reduce((s, x) => s + x.ev.maxPoints, 0);
        return `
          <tr>
            <td>${escapeHtml(sec.title)}</td>
            <td class="num-col">${correctCnt} / ${items.length} ข้อ</td>
            <td class="num-col"><strong>${secEarned.toFixed(2)}</strong></td>
            <td class="num-col">${secMax.toFixed(2)}</td>
          </tr>
        `;
      })
      .join("");

    // Thai Q22 Essay Self-Grader in Result Summary if present
    const essayGraderEl = document.getElementById("result-essay-grader");
    const essayItem = evaluations.find((x) => x.q.meta?.kind === "essay_summary");
    if (essayItem) {
      const q = essayItem.q;
      const obj = session.answers[q.no] || { text: "", rubric: {} };
      essayGraderEl.hidden = false;
      essayGraderEl.innerHTML = `
        <div class="rubric-box">
          <h3>ประเมินคะแนนข้ออัตนัย (ข้อที่ ${q.no} สรุปใจความสำคัญ — ${essayItem.ev.earnedPoints} / 15 คะแนน)</h3>
          <p class="sidebar-caption" style="margin-bottom:0.6rem;">คำตอบของคุณ: ${escapeHtml(obj.text?.trim() || "(ไม่ได้เขียนคำตอบ)")}</p>
          <div class="rubric-list">
            ${q.meta.rubric
              .map((r) => {
                const ck = Boolean(obj.rubric && obj.rubric[r.id]);
                return `
                  <label class="rubric-item">
                    <input type="checkbox" data-result-rubric-q="${q.no}" data-result-rubric-id="${escapeHtml(r.id)}" ${ck ? "checked" : ""}>
                    <span>${escapeHtml(r.label)} <strong>(${r.points} คะแนน)</strong></span>
                  </label>
                `;
              })
              .join("")}
          </div>
        </div>
      `;
    } else {
      essayGraderEl.hidden = true;
      essayGraderEl.innerHTML = "";
    }

    // Practice mistakes button state
    const mistakesBtn = document.getElementById("btn-practice-mistakes");
    mistakesBtn.disabled = submittedResult.wrongNos.length === 0;

    // Review filter pills
    document.querySelectorAll("[data-review-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.reviewFilter === reviewFilter);
    });

    // Item-by-item review list
    const filteredReview = evaluations.filter(({ ev }) => {
      if (reviewFilter === "wrong") return !ev.isCorrect;
      if (reviewFilter === "correct") return ev.isCorrect;
      return true;
    });

    const reviewListEl = document.getElementById("review-list");
    if (filteredReview.length === 0) {
      reviewListEl.innerHTML = `<div class="empty-state"><p>ไม่มีรายการข้อสอบในหมวดตัวกรองนี้</p></div>`;
      return;
    }

    reviewListEl.innerHTML = filteredReview
      .map(({ q, ev }) => {
        const badgeCls = ev.isCorrect ? "is-correct" : "is-wrong";
        const badgeText = ev.isEssay
          ? `อัตนัย ${formatPoints(ev.earnedPoints)}/${formatPoints(ev.maxPoints)} คะแนน`
          : ev.isCorrect
          ? `ถูกต้อง (+${formatPoints(ev.earnedPoints)})`
          : `ได้ 0/${formatPoints(ev.maxPoints)} คะแนน`;

        return `
          <div class="review-item">
            <div class="review-item-head">
              <h3>ข้อที่ ${q.no}</h3>
              <span class="review-badge ${badgeCls}">${badgeText}</span>
            </div>
            <div class="q-stem">${formatRichBlocks(q.question, { stripMarkdownTable: false })}</div>
            <div class="review-ans-compare">
              <span><strong>คำตอบของคุณ:</strong> ${escapeHtml(ev.userText)}</span>
              <span><strong>เฉลย:</strong> ${escapeHtml(ev.keyText)}</span>
            </div>
            <div class="feedback-exp">${formatInlineExam(q.explanation)}</div>
          </div>
        `;
      })
      .join("");
  }

  // -------------------------------------------------------------------------
  // Image Lightbox Dialog
  // -------------------------------------------------------------------------
  function openFigureDialog(src, caption) {
    const dlg = document.getElementById("figure-dialog");
    const wrap = document.getElementById("dialog-img-wrap");
    const cap = document.getElementById("dialog-caption");
    if (!dlg || !wrap || !src) return;
    const label = caption || "ภาพประกอบข้อสอบ";
    cap.textContent = label;
    wrap.innerHTML = `<img src="${escapeHtml(src)}" alt="${escapeHtml(label)}">`;
    if (typeof dlg.showModal === "function") {
      dlg.showModal();
    }
  }

  // -------------------------------------------------------------------------
  // Event Delegation & Keyboard Navigation
  // -------------------------------------------------------------------------
  function bindEvents() {
    // Brand Home button
    document.getElementById("brand-home-btn").addEventListener("click", () => {
      persistTutorSession();
      renderHome();
    });

    // Topbar Set Switcher
    document.querySelectorAll("[data-set-group]").forEach((btn) => {
      btn.addEventListener("click", () => {
        store.selectedGroup = btn.dataset.setGroup;
        saveStore();
        renderHome();
      });
    });

    // Font Size Switcher
    document.querySelectorAll(".font-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyFontScale(btn.dataset.fontScale));
    });

    // Mode Selector on Home
    document.querySelectorAll(".mode-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        store.selectedMode = btn.dataset.mode;
        saveStore();
        renderHome();
      });
    });

    // Reset Progress Inline Confirmation
    document.getElementById("btn-show-reset").addEventListener("click", () => {
      document.getElementById("reset-default-row").hidden = true;
      document.getElementById("reset-confirm-row").hidden = false;
    });
    document.getElementById("btn-cancel-reset").addEventListener("click", () => {
      document.getElementById("reset-confirm-row").hidden = true;
      document.getElementById("reset-default-row").hidden = false;
    });
    document.getElementById("btn-confirm-reset").addEventListener("click", () => {
      const keepFont = store.fontScale;
      const keepGroup = store.selectedGroup;
      store = defaultStore();
      store.fontScale = keepFont;
      store.selectedGroup = keepGroup;
      saveStore();
      document.getElementById("reset-confirm-row").hidden = true;
      document.getElementById("reset-default-row").hidden = false;
      renderHome();
    });

    // Delegated clicks inside main content
    document.getElementById("main-content").addEventListener("click", (e) => {
      const target = e.target;

      // Start Subject Button
      const startBtn = target.closest("[data-start-paper]");
      if (startBtn) {
        startSession(startBtn.dataset.startPaper, startBtn.dataset.startMode, "all");
        return;
      }

      // Quick Review Button
      const qrBtn = target.closest("[data-quick-paper]");
      if (qrBtn && !qrBtn.disabled) {
        startSession(qrBtn.dataset.quickPaper, "tutor", qrBtn.dataset.quickFilter);
        return;
      }

      // Zoom Figure
      const zoomEl = target.closest("[data-zoom-src]");
      if (zoomEl) {
        openFigureDialog(zoomEl.dataset.zoomSrc, zoomEl.dataset.zoomCaption);
        return;
      }

      if (!session) return;
      const q = session.paper.questions[session.currentNo - 1];

      // MCQ Choice Click
      const mcqBtn = target.closest("[data-mcq-choice]");
      if (mcqBtn && !mcqBtn.disabled) {
        session.answers[q.no] = Number(mcqBtn.dataset.mcqChoice);
        persistTutorSession();
        renderCurrentQuestion();
        renderPalette();
        return;
      }

      // True/False Table Button Click
      const tfBtn = target.closest("[data-tf-val]");
      if (tfBtn && !tfBtn.disabled) {
        const idx = Number(tfBtn.dataset.tfIndex);
        const val = tfBtn.dataset.tfVal;
        if (!Array.isArray(session.answers[q.no])) {
          session.answers[q.no] = new Array(q.meta.items.length).fill(null);
        }
        session.answers[q.no][idx] = val;
        persistTutorSession();
        renderCurrentQuestion();
        renderPalette();
        return;
      }

      // Word-Order Chip Click (place word into target slot)
      const woChip = target.closest("[data-wo-word]");
      if (woChip && !woChip.disabled) {
        const partId = woChip.dataset.woPart;
        const wordNum = Number(woChip.dataset.woWord);
        const partMeta = q.meta.parts.find((p) => p.id === partId);
        if (!session.answers[q.no]) {
          session.answers[q.no] = createDefaultWordOrderAnswer(q.meta);
        }
        const slots = session.answers[q.no][partId];
        let slotIdx = session.activeWordSlot[partId];
        if (
          slotIdx == null ||
          partMeta.fixed[String(slotIdx + 1)] ||
          slots[slotIdx] != null
        ) {
          slotIdx = slots.findIndex(
            (v, idx) => v == null && !partMeta.fixed[String(idx + 1)]
          );
        }
        if (slotIdx !== -1) {
          slots[slotIdx] = wordNum;
          const nextEmpty = slots.findIndex(
            (v, idx) => v == null && !partMeta.fixed[String(idx + 1)]
          );
          session.activeWordSlot[partId] = nextEmpty !== -1 ? nextEmpty : null;
          persistTutorSession();
          renderCurrentQuestion();
          renderPalette();
        }
        return;
      }

      // Word-Order Slot Click (remove filled word or select target slot)
      const woSlot = target.closest("[data-wo-slot]");
      if (woSlot && !woSlot.disabled) {
        const partId = woSlot.dataset.woPart;
        const slotIdx = Number(woSlot.dataset.woSlot);
        const slots = session.answers[q.no][partId];
        if (slots[slotIdx] != null) {
          slots[slotIdx] = null;
        }
        session.activeWordSlot[partId] = slotIdx;
        persistTutorSession();
        renderCurrentQuestion();
        renderPalette();
        return;
      }

      // Word-Order Reset Part
      const woReset = target.closest("[data-wo-reset]");
      if (woReset) {
        const partId = woReset.dataset.woReset;
        const fresh = createDefaultWordOrderAnswer(q.meta);
        session.answers[q.no][partId] = fresh[partId];
        session.activeWordSlot[partId] = null;
        persistTutorSession();
        renderCurrentQuestion();
        renderPalette();
        return;
      }

      // Palette Jump Button
      const jumpBtn = target.closest("[data-jump-no]");
      if (jumpBtn) {
        const jumpNo = Number(jumpBtn.dataset.jumpNo);
        if (!session.filteredNos.includes(jumpNo)) {
          session.filter = "all";
          recomputeFilteredQuestions(jumpNo);
          renderSessionHeader();
        } else {
          session.currentNo = jumpNo;
        }
        persistTutorSession();
        renderCurrentQuestion();
        renderPalette();
        document.getElementById("question-palette-aside").classList.remove("is-open");
        return;
      }

      // Tutor Filter Pills
      const filterBtn = target.closest("[data-filter]");
      if (filterBtn && session.mode === "tutor") {
        session.filter = filterBtn.dataset.filter;
        recomputeFilteredQuestions(session.currentNo);
        renderSessionHeader();
        renderCurrentQuestion();
        renderPalette();
        return;
      }

      // Result Review Filter Pills
      const revBtn = target.closest("[data-review-filter]");
      if (revBtn && session.submittedResult) {
        session.reviewFilter = revBtn.dataset.reviewFilter;
        renderExamResults();
      }
    });

    // Input & Checkbox Delegation (Numeric, Essay Textarea, Essay Rubric)
    document.getElementById("main-content").addEventListener("input", (e) => {
      if (!session) return;
      const q = session.paper.questions[session.currentNo - 1];

      if (e.target.id === "numeric-ans-input") {
        const digitsOnly = e.target.value.replace(/\D+/g, "");
        if (e.target.value !== digitsOnly) e.target.value = digitsOnly;
        session.answers[q.no] = digitsOnly;
        persistTutorSession();
        const checkBtn = document.getElementById("btn-check-answer");
        if (checkBtn) checkBtn.disabled = !isQuestionAnswered(q, digitsOnly);
        renderPalette();
        return;
      }

      if (e.target.id === "essay-summary-input") {
        if (!session.answers[q.no]) {
          session.answers[q.no] = { text: "", rubric: {} };
        }
        session.answers[q.no].text = e.target.value;
        persistTutorSession();

        const counter = document.getElementById("essay-counter");
        if (counter) {
          const textVal = e.target.value;
          const lineCount = textVal.trim() ? textVal.split("\n").length : 0;
          const charCount = textVal.trim().length;
          counter.classList.toggle("is-over", lineCount > 3 || charCount > 260);
          counter.innerHTML = `
            <span>จำนวนบรรทัดที่ขึ้นใหม่: ${lineCount} / 3 บรรทัด</span>
            <span>ความยาวข้อความ: ${charCount} ตัวอักษร (แนะนำประมาณ 160–240 ตัวอักษร)</span>
          `;
        }
        renderPalette();
      }
    });

    document.getElementById("main-content").addEventListener("change", (e) => {
      if (!session) return;

      // Rubric checkbox inside active question sheet
      if (e.target.dataset.essayRubric) {
        const q = session.paper.questions[session.currentNo - 1];
        if (!session.answers[q.no]) {
          session.answers[q.no] = { text: "", rubric: {} };
        }
        session.answers[q.no].rubric[e.target.dataset.essayRubric] = e.target.checked;
        persistTutorSession();
        return;
      }

      // Rubric checkbox inside Exam Result summary
      if (e.target.dataset.resultRubricId) {
        const qNo = Number(e.target.dataset.resultRubricQ);
        const rId = e.target.dataset.resultRubricId;
        if (!session.answers[qNo]) {
          session.answers[qNo] = { text: "", rubric: {} };
        }
        if (!session.answers[qNo].rubric) session.answers[qNo].rubric = {};
        session.answers[qNo].rubric[rId] = e.target.checked;
        renderExamResults();
      }
    });

    // Session Toolbar & Navigation Buttons
    document.getElementById("btn-exit-session").addEventListener("click", () => {
      persistTutorSession();
      renderHome();
    });

    document.getElementById("btn-reset-filter").addEventListener("click", () => {
      if (!session) return;
      session.filter = "all";
      recomputeFilteredQuestions(1);
      renderSessionHeader();
      renderCurrentQuestion();
      renderPalette();
    });

    document.getElementById("btn-bookmark").addEventListener("click", () => {
      if (!session) return;
      toggleBookmark(session.paperKey, session.currentNo);
      renderCurrentQuestion();
      renderPalette();
    });

    document.getElementById("btn-check-answer").addEventListener("click", () => {
      if (!session || session.mode !== "tutor") return;
      const q = session.paper.questions[session.currentNo - 1];
      session.checked[q.no] = true;
      const ev = evaluateQuestion(session.paper, q, session.answers[q.no]);
      recordOutcomeInWrongBank(session.paperKey, q.no, ev.isCorrect, ev.isEssay);
      persistTutorSession();
      renderSessionHeader();
      renderCurrentQuestion();
      renderPalette();
    });

    document.getElementById("btn-reveal-explanation").addEventListener("click", () => {
      if (!session || session.mode !== "tutor") return;
      session.revealed[session.currentNo] = true;
      renderCurrentQuestion();
    });

    document.getElementById("btn-prev-q").addEventListener("click", () => stepQuestion(-1));
    document.getElementById("btn-next-q").addEventListener("click", () => stepQuestion(1));

    // Mobile Palette Drawer Toggle
    document.getElementById("btn-toggle-palette").addEventListener("click", () => {
      const aside = document.getElementById("question-palette-aside");
      const open = aside.classList.toggle("is-open");
      document.getElementById("btn-toggle-palette").setAttribute("aria-expanded", String(open));
    });
    document.getElementById("btn-close-palette").addEventListener("click", () => {
      document.getElementById("question-palette-aside").classList.remove("is-open");
      document.getElementById("btn-toggle-palette").setAttribute("aria-expanded", "false");
    });

    // Exam Submit Confirmation Actions
    document.getElementById("btn-request-submit").addEventListener("click", requestExamSubmit);
    document.getElementById("btn-cancel-submit").addEventListener("click", () => {
      document.getElementById("exam-submit-strip").hidden = true;
    });
    document.getElementById("btn-confirm-submit").addEventListener("click", finalizeExamSubmission);

    // Result Screen Actions
    document.getElementById("btn-practice-mistakes").addEventListener("click", () => {
      if (!session) return;
      startSession(session.paperKey, "tutor", "wrong");
    });
    document.getElementById("btn-retake-exam").addEventListener("click", () => {
      if (!session) return;
      startSession(session.paperKey, "exam", "all");
    });
    document.getElementById("btn-result-home").addEventListener("click", renderHome);

    // Dialog Close
    const dlg = document.getElementById("figure-dialog");
    document.getElementById("btn-close-dialog").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });

    // Keyboard Shortcuts in Active Session
    document.addEventListener("keydown", (e) => {
      if (!session || document.getElementById("view-session").hidden) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (dlg.open) return;

      const q = session.paper.questions[session.currentNo - 1];
      const locked = session.mode === "tutor" && Boolean(session.checked[q.no]);

      if (q.type === "mcq" && !locked && ["1", "2", "3", "4"].includes(e.key)) {
        session.answers[q.no] = Number(e.key);
        persistTutorSession();
        renderCurrentQuestion();
        renderPalette();
      } else if (e.key === "ArrowLeft") {
        stepQuestion(-1);
      } else if (e.key === "ArrowRight") {
        stepQuestion(1);
      }
    });
  }

  function stepQuestion(delta) {
    if (!session || session.filteredNos.length === 0) return;
    const idx = session.filteredNos.indexOf(session.currentNo);
    const nextIdx = idx + delta;
    if (nextIdx >= 0 && nextIdx < session.filteredNos.length) {
      session.currentNo = session.filteredNos[nextIdx];
      persistTutorSession();
      renderCurrentQuestion();
      renderPalette();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // -------------------------------------------------------------------------
  // Bootstrap Application
  // -------------------------------------------------------------------------
  async function initApp() {
    applyFontScale(store.fontScale || "md");
    bindEvents();

    try {
      if (window.ONET_DATA && window.ONET_DATA.papers) {
        DATA = window.ONET_DATA;
      } else {
        const res = await fetch("data/questions.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        DATA = await res.json();
      }
      renderHome();
    } catch (err) {
      const loadingEl = document.getElementById("view-loading");
      loadingEl.innerHTML = `
        <h2>ไม่สามารถโหลดฐานข้อมูลข้อสอบได้</h2>
        <p style="margin-top:0.5rem;color:var(--ink-secondary);">กรุณาตรวจสอบว่าไฟล์ <code>data/questions.js</code> หรือ <code>data/questions.json</code> อยู่ในโฟลเดอร์เดียวกับแอปพลิเคชัน แล้วรีเฟรชหน้าเว็บอีกครั้ง (${escapeHtml(err.message)})</p>
      `;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
