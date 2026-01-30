(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const STORAGE = {
    stars: "j1200k_stars_v1",
    stats: "j1200k_stats_v1",
    settings: "j1200k_settings_v1",
    data: "j1200k_data_v1",
    multiTypingOff: "j1200k_multi_typing_off_v1"
  };

  const defaultSettings = () => ({
    showReadings: "off",
    mcCount: 4,
    multiTyping: "on"
  });

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  let DATA = null;
  let items = [];
  async function loadData() {
    const stored = loadJSON(STORAGE.data, null);
    if (stored && stored.items) return stored;
    const res = await fetch("data/kanji.json");
    return await res.json();
  }

  let starred = new Set(loadJSON(STORAGE.stars, []));
  function isStarred(id) { return starred.has(id); }
  function toggleStar(id) {
    if (starred.has(id)) starred.delete(id); else starred.add(id);
    saveJSON(STORAGE.stars, Array.from(starred));
    renderStarsUI();
    if (!$("#tab-view").classList.contains("hidden")) renderKanjiList();
    if (!$("#tab-stats").classList.contains("hidden")) renderStats();
  }

  function renderStarsUI() {
    const btn = $("#btnStar");
    if (btn && current) btn.textContent = isStarred(current.id) ? "★" : "☆";
    const quick = $("#btnQuickStar");
    if (quick && current) quick.textContent = isStarred(current.id) ? "★ Star" : "☆ Star";
  }

  let stats = loadJSON(STORAGE.stats, {
    total: 0, correct: 0, wrong: 0, streakBest: 0,
    byId: {}, bySection: {}
  });
  function ensureObj(map, key, init) { if (!map[key]) map[key] = init(); return map[key]; }
  function markStat(id, section, ok) {
    stats.total += 1;
    if (ok) stats.correct += 1; else stats.wrong += 1;
    const s1 = ensureObj(stats.byId, id, () => ({c:0,w:0}));
    if (ok) s1.c += 1; else s1.w += 1;
    const s2 = ensureObj(stats.bySection, String(section), () => ({c:0,w:0}));
    if (ok) s2.c += 1; else s2.w += 1;
    saveJSON(STORAGE.stats, stats);
  }

  let settings = loadJSON(STORAGE.settings, defaultSettings());
  let multiTypingOff = new Set(loadJSON(STORAGE.multiTypingOff, []));

  function setTab(tab) {
    $$(".tab").forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    ["study","view","stats","settings"].forEach(t => {
      $("#tab-"+t).classList.toggle("hidden", t !== tab);
    });
    if (tab === "view") renderKanjiList();
    if (tab === "stats") renderStats();
    if (tab === "settings") renderSettings();
  }
  $$(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

  let session = null;
  let queue = [], idx = 0, streak = 0;
  let current = null;
  let locked = false;

  function shuffle(a) {
    for (let i=a.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [a[i],a[j]]=[a[j],a[i]];
    }
    return a;
  }
  function clampInt(v, min, max) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return min;
    return Math.max(min, Math.min(max, n));
  }
  function pickMode(selMode) { return selMode !== "mixed" ? selMode : (Math.random()<0.5 ? "k2m":"m2k"); }
  function pickAnswerType(selAnswer) { return selAnswer !== "mixed" ? selAnswer : (Math.random()<0.5 ? "mc":"typing"); }

  function getPool() {
    const section = $("#selSection").value;
    const starOnly = $("#chkStarOnly").checked;
    let pool = items;
    if (section !== "all") pool = pool.filter(x => String(x.section) === section);
    if (starOnly) pool = pool.filter(x => isStarred(x.id));
    return pool.slice();
  }
  function autoQuestionCount(len) { return Math.max(5, Math.min(20, len)); }

  function startSession() {
    const pool = getPool();
    if (!pool.length) {
      alert("No items in that selection. (If Starred only is on, star something first.)");
      return;
    }
    const selMode = $("#selMode").value;
    const selAnswer = $("#selAnswer").value;
    const mcCount = parseInt(settings.mcCount, 10) || 4;

    const qCount = $("#chkAuto").checked ? autoQuestionCount(pool.length) : clampInt($("#numQ").value, 5, 200);
    const usePool = shuffle(pool.slice());
    queue = [];
    while (queue.length < qCount) queue.push(...usePool);
    queue = queue.slice(0, qCount);

    session = { selMode, selAnswer, mcCount, total: qCount, curMode: "k2m", curAnswerType: "mc", mcPack: null };
    idx = 0; streak = 0; locked = false;

    $("#studySetup").classList.add("hidden");
    $("#studySession").classList.remove("hidden");

    nextQuestion();
  }

  function stopSession() {
    session = null; queue = []; current = null;
    $("#studySetup").classList.remove("hidden");
    $("#studySession").classList.add("hidden");
    $("#feedback").textContent = ""; $("#feedback").className = "feedback";
    $("#btnNext").disabled = true;
    const inputs = $$("#typingInputs input");
    inputs.forEach(input => { input.value = ""; });
    locked = false;
  }

  function setPrompt(mode, item) {
    const showReadings = settings.showReadings === "on";
    if (mode === "k2m") {
      $("#promptMain").textContent = item.kanji;
      $("#promptSub").textContent = showReadings ? `読み: ${(item.readings||[]).join(" / ")}` : "";
    } else {
      $("#promptMain").textContent = item.meaning;
      $("#promptSub").textContent = "";
    }
  }

  function buildChoices(mode, item, count) {
    const correct = mode === "k2m" ? item.meaning : item.kanji;
    const field = mode === "k2m" ? "meaning" : "kanji";
    const distractors = shuffle(items.filter(x => x.id !== item.id)).slice(0, Math.max(0, count-1));
    const opts = shuffle([correct, ...distractors.map(x => x[field])]).slice(0, count);
    if (!opts.includes(correct)) opts[Math.floor(Math.random()*opts.length)] = correct;
    return { correct, options: opts };
  }

  function escapeHtml(s) {
    return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  }

  function renderAnswerUI(answerType, mcPack=null) {
    $("#mcArea").classList.toggle("hidden", answerType !== "mc");
    $("#typingArea").classList.toggle("hidden", answerType !== "typing");

    $("#btnNext").disabled = true;
    $("#feedback").textContent = "";
    $("#feedback").className = "feedback";
    locked = false;

    if (answerType === "mc") {
      const host = $("#mcGrid"); host.innerHTML = "";
      const labels = ["1","2","3","4"];
      mcPack.options.forEach((opt, i) => {
        const btn = document.createElement("button");
        btn.className = "mcBtn";
        btn.dataset.option = opt;
        btn.innerHTML = `<div class="mcLbl">${labels[i]||""}</div><div class="mcText">${escapeHtml(opt)}</div>`;
        btn.addEventListener("click", () => checkMC(i, mcPack));
        host.appendChild(btn);
      });
    } else {
      renderTypingInputs();
    }
  }

  function nextQuestion() {
    if (!session) return;
    if (idx >= queue.length) {
      $("#sessionProgress").textContent = "Done 🎉";
      $("#promptMain").textContent = "Session complete";
      $("#promptSub").textContent = "";
      $("#mcArea").classList.add("hidden");
      $("#typingArea").classList.add("hidden");
      $("#feedback").textContent = "";
      $("#btnNext").disabled = true;
      current = null;
      return;
    }

    current = queue[idx];
    const mode = pickMode(session.selMode);
    const answerType = pickAnswerType(session.selAnswer);
    session.curMode = mode;
    session.curAnswerType = answerType;

    $("#sessionProgress").textContent = `Question ${idx+1}/${session.total} • Streak ${streak}`;
    setPrompt(mode, current);
    renderStarsUI();

    if (answerType === "mc") {
      const pack = buildChoices(mode, current, session.mcCount);
      session.mcPack = pack;
      renderAnswerUI("mc", pack);
    } else {
      session.mcPack = null;
      renderAnswerUI("typing");
    }
  }

  function markFeedback(ok, extra="") {
    const fb = $("#feedback");
    fb.textContent = ok ? `✅ Correct${extra ? " • "+extra : ""}` : `❌ Not quite${extra ? " • "+extra : ""}`;
    fb.className = ok ? "feedback good" : "feedback bad";
  }

  function checkMC(i, pack) {
    if (!session || locked) return;
    const chosen = pack.options[i];
    const ok = chosen === pack.correct;
    locked = true;
    const buttons = $$("#mcGrid .mcBtn");
    buttons.forEach(btn => {
      const opt = btn.dataset.option;
      if (opt === pack.correct) btn.classList.add("correct");
    });
    if (ok) {
      streak += 1;
      stats.streakBest = Math.max(stats.streakBest, streak);
      markFeedback(true);
    } else {
      streak = 0;
      const wrongBtn = buttons.find(btn => btn.dataset.option === chosen);
      if (wrongBtn) wrongBtn.classList.add("wrong");
      markFeedback(false, `Answer: ${pack.correct}`);
    }
    markStat(current.id, current.section, ok);

    const instant = $("#chkInstantNext").checked;
    if (ok && instant) {
      setTimeout(() => {
        idx += 1; locked = false; nextQuestion();
      }, 650);
    } else {
      $("#btnNext").disabled = false;
    }
  }

  function splitMeanings(meaning) {
    return String(meaning)
      .split(";")
      .map(part => part.trim())
      .filter(Boolean);
  }
  function hasMultipleMeanings(item) { return splitMeanings(item.meaning).length > 1; }
  function isMultiTypingActive(item, mode) {
    if (mode !== "k2m") return false;
    if (settings.multiTyping !== "on") return false;
    if (!hasMultipleMeanings(item)) return false;
    return !multiTypingOff.has(item.id);
  }
  function normalizeTyping(s) { return String(s).trim().replace(/\s+/g," ").toLowerCase(); }
  function renderTypingInputs() {
    const host = $("#typingInputs");
    host.innerHTML = "";
    const mode = session?.curMode;
    const useMulti = current && isMultiTypingActive(current, mode);
    const inputsNeeded = useMulti ? splitMeanings(current.meaning).length : 1;
    for (let i = 0; i < inputsNeeded; i += 1) {
      const input = document.createElement("input");
      input.className = "typingInput";
      input.autocomplete = "off";
      input.autocorrect = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.placeholder = inputsNeeded > 1 ? `Answer ${i + 1}` : "Type your answer…";
      host.appendChild(input);
    }
    const first = host.querySelector("input");
    if (first) first.focus();
  }
  function checkTyping() {
    if (!session || locked) return;
    const mode = session.curMode;
    const expected = mode === "k2m" ? current.meaning : current.kanji;
    let ok = false;
    if (mode === "k2m" && isMultiTypingActive(current, mode)) {
      const expectedParts = splitMeanings(expected).map(part => normalizeTyping(part));
      const inputs = $$("#typingInputs input").map(input => normalizeTyping(input.value));
      const uniqueInputs = new Set(inputs.filter(Boolean));
      ok = inputs.length === expectedParts.length
        && inputs.every(val => expectedParts.includes(val))
        && uniqueInputs.size === expectedParts.length;
    } else {
      const got = $$("#typingInputs input")[0]?.value || "";
      const normalized = normalizeTyping(got);
      ok = mode === "k2m"
        ? splitMeanings(expected).some(part => normalizeTyping(part) === normalized)
        : normalizeTyping(expected) === normalized;
    }
    locked = true;
    if (ok) {
      streak += 1;
      stats.streakBest = Math.max(stats.streakBest, streak);
      markFeedback(true);
    } else {
      streak = 0;
      markFeedback(false, `Answer: ${expected}`);
    }
    markStat(current.id, current.section, ok);
    $("#btnNext").disabled = false;
  }

  $("#btnCheck").addEventListener("click", () => checkTyping());
  $("#btnNext").addEventListener("click", () => { if (!session) return; idx += 1; locked = false; nextQuestion(); });
  $("#btnStart").addEventListener("click", () => startSession());
  $("#btnPracticeStarred").addEventListener("click", () => { $("#chkStarOnly").checked = true; startSession(); });
  $("#btnStop").addEventListener("click", () => stopSession());
  $("#btnStar").addEventListener("click", () => current && toggleStar(current.id));
  $("#btnQuickStar").addEventListener("click", () => current && toggleStar(current.id));
  $("#chkAuto").addEventListener("change", () => { $("#numQ").disabled = $("#chkAuto").checked; });

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "`" || e.key === "~") {
      if (current) { e.preventDefault(); toggleStar(current.id); }
      return;
    }
    if (!session || !current) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (session.curAnswerType === "typing") {
        if (!locked) checkTyping(); else $("#btnNext").click();
      } else {
        if (locked) $("#btnNext").click();
      }
      return;
    }
    if (session.curAnswerType === "mc" && !locked) {
      if (["1","2","3","4"].includes(e.key)) {
        const i = parseInt(e.key, 10) - 1;
        const pack = session.mcPack;
        if (pack && i >= 0 && i < pack.options.length) { e.preventDefault(); checkMC(i, pack); }
      }
    }
  });

  function renderKanjiList() {
    const q = ($("#viewSearch").value || "").trim().toLowerCase();
    const starOnly = $("#viewStarOnly").checked;
    const host = $("#kanjiList");
    host.innerHTML = "";
    let list = items.slice();
    if (starOnly) list = list.filter(x => isStarred(x.id));
    if (q) {
      list = list.filter(x =>
        x.kanji.includes(q) ||
        x.meaning.toLowerCase().includes(q) ||
        (x.readings || []).some(r => r.toLowerCase().includes(q))
      );
    }
    list.forEach(x => {
      const showMultiToggle = hasMultipleMeanings(x);
      const multiEnabled = showMultiToggle && !multiTypingOff.has(x.id);
      const row = document.createElement("div");
      row.className = "itemRow";
      row.innerHTML = `
        <div class="left">
          <div class="bigKanji">${escapeHtml(x.kanji)}</div>
          <div>
            <div class="meaning">${escapeHtml(x.meaning)}</div>
            <div class="tags">Lesson ${x.section} • ${escapeHtml(x.category || "")}</div>
            ${showMultiToggle ? `
            <label class="mini multiToggle">
              <input type="checkbox" class="multiToggleInput" data-id="${escapeHtml(x.id)}" ${multiEnabled ? "checked" : ""} />
              Multi typing answers
            </label>` : ""}
          </div>
        </div>
        <button class="btn starBtn">${isStarred(x.id) ? "★" : "☆"}</button>
      `;
      row.querySelector("button").addEventListener("click", () => toggleStar(x.id));
      const toggle = row.querySelector(".multiToggleInput");
      if (toggle) {
        toggle.addEventListener("change", (e) => {
          const id = e.target.dataset.id;
          if (!id) return;
          if (e.target.checked) multiTypingOff.delete(id);
          else multiTypingOff.add(id);
          saveJSON(STORAGE.multiTypingOff, Array.from(multiTypingOff));
        });
      }
      host.appendChild(row);
    });
    if (!list.length) host.innerHTML = `<div class="hint"><p class="small muted">No results.</p></div>`;
  }
  $("#viewSearch").addEventListener("input", () => renderKanjiList());
  $("#viewStarOnly").addEventListener("change", () => renderKanjiList());

  $("#btnExportStars").addEventListener("click", () => {
    const payload = { version:1, stars: Array.from(starred) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "JAPN1200_Kanji_stars.json";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  $("#fileImportStars").addEventListener("change", async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      if (Array.isArray(payload.stars)) {
        starred = new Set(payload.stars);
        saveJSON(STORAGE.stars, Array.from(starred));
        renderKanjiList(); renderStarsUI();
        alert("Stars imported ✅");
      } else alert("Invalid stars file.");
    } catch { alert("Import failed."); }
    e.target.value = "";
  });

  function pct(c,t){ return t ? Math.round((c/t)*100) : 0; }

  function renderStats() {
    const top = $("#statsTop"); top.innerHTML = "";
    const cards = [
      {k:"Total", v: stats.total},
      {k:"Correct", v: stats.correct},
      {k:"Wrong", v: stats.wrong},
      {k:"Accuracy", v: `${pct(stats.correct, stats.total)}%`},
      {k:"Best streak", v: stats.streakBest},
      {k:"Starred", v: starred.size}
    ];
    cards.forEach(c => {
      const div = document.createElement("div");
      div.className = "field";
      div.innerHTML = `<span>${escapeHtml(c.k)}</span><div style="font-size:20px;font-weight:900">${escapeHtml(c.v)}</div>`;
      top.appendChild(div);
    });

    const hard = Object.entries(stats.byId).map(([id, s]) => {
      const t = s.c + s.w;
      const miss = t ? (s.w / t) : 0;
      const it = items.find(x => x.id === id);
      return { id, miss, t, kanji: it?.kanji || id, meaning: it?.meaning || "" };
    }).filter(x => x.t >= 3).sort((a,b) => b.miss - a.miss).slice(0, 10);

    const hardHost = $("#hardList"); hardHost.innerHTML = "";
    if (!hard.length) hardHost.innerHTML = `<div class="hint"><p class="small muted">Answer a few questions first (3+ per kanji) and this will populate.</p></div>`;
    else hard.forEach(x => {
      const row = document.createElement("div");
      row.className = "itemRow";
      row.innerHTML = `
        <div class="left">
          <div class="bigKanji">${escapeHtml(x.kanji)}</div>
          <div>
            <div class="meaning">${escapeHtml(x.meaning)}</div>
            <div class="tags">Miss rate: ${Math.round(x.miss*100)}% • Attempts: ${x.t}</div>
          </div>
        </div>
        <button class="btn starBtn">${isStarred(x.id) ? "★" : "☆"}</button>
      `;
      row.querySelector("button").addEventListener("click", () => toggleStar(x.id));
      hardHost.appendChild(row);
    });

    const secHost = $("#sectionStats"); secHost.innerHTML = "";
    const secs = Object.entries(stats.bySection).sort((a,b) => parseInt(a[0],10)-parseInt(b[0],10));
    if (!secs.length) secHost.innerHTML = `<div class="hint"><p class="small muted">No section stats yet.</p></div>`;
    else secs.forEach(([sec, s]) => {
      const t = s.c + s.w;
      const row = document.createElement("div");
      row.className = "itemRow";
      row.innerHTML = `<div class="left"><div class="meaning">Lesson ${escapeHtml(sec)}</div><div class="tags">Accuracy: ${pct(s.c,t)}% • Attempts: ${t}</div></div>`;
      secHost.appendChild(row);
    });
  }

  $("#btnResetStats").addEventListener("click", () => {
    if (!confirm("Reset stats?")) return;
    stats = { total:0, correct:0, wrong:0, streakBest:0, byId:{}, bySection:{} };
    saveJSON(STORAGE.stats, stats);
    renderStats();
    alert("Stats reset ✅");
  });

  function renderSettings() {
    $("#selReadings").value = settings.showReadings || "off";
    $("#selMcCount").value = String(settings.mcCount || 4);
    $("#selMultiTyping").value = settings.multiTyping || "on";
  }
  $("#selReadings").addEventListener("change", (e) => { settings.showReadings = e.target.value; saveJSON(STORAGE.settings, settings); });
  $("#selMcCount").addEventListener("change", (e) => { settings.mcCount = parseInt(e.target.value,10); saveJSON(STORAGE.settings, settings); });
  $("#selMultiTyping").addEventListener("change", (e) => { settings.multiTyping = e.target.value; saveJSON(STORAGE.settings, settings); });

  $("#btnExportData").addEventListener("click", () => {
    const payload = { version:1, items };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "JAPN1200_Kanji_data.json";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  $("#fileImportData").addEventListener("change", async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      if (Array.isArray(payload.items) && payload.items.length) {
        saveJSON(STORAGE.data, payload);
        alert("Data imported ✅ Reloading…");
        location.reload();
      } else alert("Invalid data file.");
    } catch { alert("Import failed."); }
    e.target.value = "";
  });

  $("#btnResetAll").addEventListener("click", () => {
    if (!confirm("Reset EVERYTHING? (data override, stars, stats, settings)")) return;
    Object.values(STORAGE).forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  function renderSections() {
    const sel = $("#selSection"); sel.innerHTML = "";
    const sections = Array.from(new Set(items.map(x => String(x.section)))).sort((a,b)=>parseInt(a,10)-parseInt(b,10));
    const optAll = document.createElement("option");
    optAll.value = "all"; optAll.textContent = "All";
    sel.appendChild(optAll);
    sections.forEach(s => {
      const o = document.createElement("option");
      o.value = s; o.textContent = `Lesson ${s}`;
      sel.appendChild(o);
    });
  }

  async function init() {
    DATA = await loadData();
    items = DATA.items || [];
    renderSections();
    $("#chkAuto").dispatchEvent(new Event("change"));
    setTab("study");
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(()=>{}));
    }
  }
  init();
})();
