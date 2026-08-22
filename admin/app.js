"use strict";

// ── API helpers ──────────────────────────────────────────────────────
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let data;
  try {
    data = await res.json();
  } catch (_) {
    data = { ok: false, error: `HTTP ${res.status}` };
  }
  return data;
}
const getJSON = (p) => api(p);
const postJSON = (p, body) => api(p, { method: "POST", body: JSON.stringify(body || {}) });

// ── State ────────────────────────────────────────────────────────────
const state = {
  view: "dashboard",
  status: null,
  questions: [],
  filter: { text: "", status: "all" },
};

const app = document.getElementById("app");

// ── Utilities ────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, kind) {
  const el = document.getElementById("toast");
  el.className = "toast " + (kind || "");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 4200);
}

function statusBadge(s) {
  const map = { active: "badge-green", proposed: "badge-amber", deprecated: "badge-muted" };
  return `<span class="badge ${map[s] || "badge-muted"}">${esc(s)}</span>`;
}

// ── Tab switching ────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    state.view = t.dataset.view;
    render();
  });
});
document.getElementById("refreshStatusBtn").addEventListener("click", loadStatus);
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});

// ── Status ───────────────────────────────────────────────────────────
async function loadStatus() {
  state.status = await getJSON("/api/status");
  const badge = document.getElementById("apiKeyBadge");
  if (state.status.apiKeyConfigured) {
    badge.className = "badge badge-green";
    badge.textContent = "API key: configured";
  } else {
    badge.className = "badge badge-amber";
    badge.textContent = "API key: not set (mock only)";
  }
  if (state.view === "dashboard") render();
}

// ── Router ───────────────────────────────────────────────────────────
function render() {
  switch (state.view) {
    case "dashboard": return renderDashboard();
    case "questions": return renderQuestions();
    case "propose": return renderPropose();
    case "editions": return renderEditions();
    case "graph": return renderGraph();
    case "logs": return renderLogs();
  }
}

// ── Dashboard ────────────────────────────────────────────────────────
function renderDashboard() {
  const s = state.status;
  if (!s) { app.innerHTML = `<div class="empty"><span class="spinner"></span> Loading…</div>`; return; }
  const t = s.totals;
  const contraClass = t.contradictions === 0 ? "good" : "bad";
  app.innerHTML = `
    <div class="grid grid-stats">
      ${stat(t.questions, "Questions", "")}
      ${stat(t.answered, "Answered", "good")}
      ${stat(t.proposed, "Proposed", t.proposed > 0 ? "warn" : "")}
      ${stat(t.editions, "Editions", "")}
      ${stat(t.graphNodes, "Claim nodes", "")}
      ${stat(t.graphEdges, "Relationships", "")}
      ${stat(t.contradictions, "Contradictions", contraClass)}
      ${stat(t.disputed, "Disputed claims", t.disputed > 0 ? "warn" : "")}
    </div>

    <h2 class="section">Quick actions</h2>
    <div class="card">
      <div class="btn-row">
        <button class="btn btn-primary" id="qaConsistency">Run consistency check</button>
        <button class="btn btn-primary" id="qaBuild">Build site (v2)</button>
        <button class="btn" data-goto="propose">Propose a question</button>
        <button class="btn" data-goto="questions">Refresh an answer</button>
      </div>
      <div id="qaResult" class="help" style="margin-top:12px"></div>
    </div>

    <h2 class="section">System</h2>
    <div class="card">
      <div class="row-between"><span class="muted">Latest edition</span><strong>#${t.latestEdition}</strong></div>
      <div class="row-between"><span class="muted">Claim files on disk</span><strong>${t.claimFiles}</strong></div>
      <div class="row-between"><span class="muted">Active questions</span><strong>${t.active}</strong></div>
      <div class="row-between"><span class="muted">Live AI mode</span><strong>${s.apiKeyConfigured ? "available" : "disabled (no API key)"}</strong></div>
    </div>
  `;

  document.querySelectorAll("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelector(`.tab[data-view="${b.dataset.goto}"]`).click();
    })
  );
  document.getElementById("qaConsistency").addEventListener("click", runConsistency);
  document.getElementById("qaBuild").addEventListener("click", runBuild);
}

function stat(num, label, cls) {
  return `<div class="card stat ${cls || ""}"><div class="num">${num}</div><div class="label">${label}</div></div>`;
}

async function runConsistency() {
  const box = document.getElementById("qaResult");
  if (box) box.innerHTML = `<span class="spinner"></span> Running consistency check…`;
  const r = await postJSON("/api/consistency");
  if (r.ok) {
    toast(`Consistency: ${r.nodeCount} nodes, ${r.edgeCount} relationships, ${r.contradictions.length} contradictions`, r.contradictions.length ? "error" : "success");
    if (box) box.innerHTML = `✓ ${r.nodeCount} nodes · ${r.edgeCount} relationships · <strong>${r.contradictions.length}</strong> contradictions · ${r.disputed.length} disputed`;
    loadStatus();
  } else {
    toast("Consistency check failed: " + r.error, "error");
    if (box) box.textContent = "Error: " + r.error;
  }
}

async function runBuild() {
  const box = document.getElementById("qaResult");
  if (box) box.innerHTML = `<span class="spinner"></span> Building site…`;
  const r = await postJSON("/api/build");
  if (r.ok) {
    toast("Site built successfully (docs/index.html)", "success");
    if (box) box.innerHTML = `<pre class="log">${esc(r.output)}</pre>`;
  } else {
    toast("Build failed", "error");
    if (box) box.innerHTML = `<pre class="log">${esc(r.output || r.error)}</pre>`;
  }
}

// ── Questions ────────────────────────────────────────────────────────
async function renderQuestions() {
  app.innerHTML = `<div class="empty"><span class="spinner"></span> Loading questions…</div>`;
  const r = await getJSON("/api/questions");
  state.questions = r.questions || [];
  drawQuestions();
}

function drawQuestions() {
  const f = state.filter;
  let rows = state.questions;
  if (f.status !== "all") rows = rows.filter((q) => q.status === f.status);
  if (f.text) {
    const t = f.text.toLowerCase();
    rows = rows.filter((q) => q.question.toLowerCase().includes(t) || q.id.includes(t));
  }

  app.innerHTML = `
    <div class="filters">
      <input id="qSearch" placeholder="Search by text or ID…" value="${esc(f.text)}" />
      <select id="qStatus">
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="proposed">Proposed</option>
        <option value="deprecated">Deprecated</option>
      </select>
      <span class="muted">${rows.length} of ${state.questions.length}</span>
    </div>
    <div class="card" style="padding:0; overflow:auto;">
      <table>
        <thead><tr>
          <th>ID</th><th>Status</th><th>Ch.</th><th class="q-text">Question</th>
          <th>Claims</th><th>Sources</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${rows.map(qRow).join("") || `<tr><td colspan="7" class="empty">No matches</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById("qStatus").value = f.status;
  document.getElementById("qSearch").addEventListener("input", (e) => { f.text = e.target.value; drawQuestions(); });
  document.getElementById("qStatus").addEventListener("change", (e) => { f.status = e.target.value; drawQuestions(); });

  document.querySelectorAll("tbody tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openQuestion(tr.dataset.id);
    });
  });
  document.querySelectorAll("button[data-refresh]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); openRefresh(b.dataset.refresh); })
  );
}

function qRow(q) {
  const disp = q.disputedCount > 0 ? `<span class="badge badge-amber" title="disputed aspects">⚠ ${q.disputedCount}</span>` : "";
  return `<tr data-id="${q.id}">
    <td><strong>${esc(q.id)}</strong></td>
    <td>${statusBadge(q.status)}</td>
    <td>${esc(q.chapter ?? "")}</td>
    <td class="q-text">${esc(q.question)} ${disp}</td>
    <td>${q.claimCount}</td>
    <td>${q.sourceCount}</td>
    <td><button class="btn btn-sm" data-refresh="${q.id}">Refresh</button></td>
  </tr>`;
}

// ── Question detail modal ────────────────────────────────────────────
async function openQuestion(id) {
  openModal(`Loading ${id}…`, `<div class="empty"><span class="spinner"></span></div>`);
  const r = await getJSON("/api/questions/" + id);
  if (!r.ok) { setModalBody(`<p class="muted">${esc(r.error)}</p>`); return; }
  const e = r.entry;
  const claim = r.claim;
  let body = `
    <div class="card" style="margin-bottom:16px;">
      <div class="row-between"><h3 style="margin:0">${esc(e.id)} ${statusBadge(e.status)}</h3>
        <button class="btn btn-primary btn-sm" id="modalRefresh">Refresh answer</button></div>
      <p style="margin:10px 0 4px"><strong>${esc(e.question)}</strong></p>
      <p class="help">Chapter ${esc(e.chapter ?? "?")} · added in edition ${e.added_in_edition ?? "—"}</p>
      ${e.rationale ? `<p class="muted">${esc(e.rationale)}</p>` : ""}
    </div>`;

  if (claim) {
    body += `<div class="card" style="margin-bottom:16px;">
      <div class="row-between"><span class="muted">Current edition</span><strong>#${claim.current_edition}</strong></div>
      <div class="row-between"><span class="muted">Claims</span><strong>${(claim.claims||[]).length}</strong></div>
      <div class="row-between"><span class="muted">Disputed aspects</span><strong>${(claim.disputed_aspects||[]).length}</strong></div>
    </div>`;
    body += `<h3>Rendered preview</h3><div class="claim-preview">${r.html || "<p class='muted'>No preview</p>"}</div>`;
  } else {
    body += `<div class="card"><p class="muted">No answer yet — this question has no claim file. Use “Refresh answer” to generate the first answer.</p></div>`;
  }
  setModalTitle(`${e.id}`);
  setModalBody(body);
  const rb = document.getElementById("modalRefresh");
  if (rb) rb.addEventListener("click", () => openRefresh(id));
}

// ── Refresh dialog (in modal) ────────────────────────────────────────
function openRefresh(id) {
  const liveDisabled = state.status && !state.status.apiKeyConfigured;
  openModal(`Refresh ${id}`, `
    <p>Generate a fresh answer for <strong>${esc(id)}</strong>.</p>
    <div class="form">
      <div>
        <label>Pipeline</label>
        <div class="mode-toggle" id="pipelineToggle">
          <span class="chip active" data-pipeline="single">Single-shot</span>
          <span class="chip" data-pipeline="ensemble">Multi-agent ensemble</span>
        </div>
        <p class="help">Ensemble runs Research → Verification → Synthesis (reliability-first).</p>
      </div>
      <div>
        <label>Mode</label>
        <div class="mode-toggle" id="modeToggle">
          <span class="chip active" data-mode="mock">Mock (offline)</span>
          <span class="chip ${liveDisabled ? "" : ""}" data-mode="live" ${liveDisabled ? 'style="opacity:.4;pointer-events:none"' : ""}>Live AI${liveDisabled ? " (no key)" : ""}</span>
        </div>
        <p class="help">${liveDisabled ? "Set ABACUS_API_KEY on the server to enable live mode." : "Live mode calls the Abacus.AI API."}</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="doRefresh">Run refresh</button>
      </div>
      <div id="refreshOut" class="help"></div>
    </div>
  `);
  let pipeline = "single", mode = "mock";
  document.querySelectorAll("#pipelineToggle .chip").forEach((c) =>
    c.addEventListener("click", () => {
      document.querySelectorAll("#pipelineToggle .chip").forEach((x) => x.classList.remove("active"));
      c.classList.add("active"); pipeline = c.dataset.pipeline;
    })
  );
  document.querySelectorAll("#modeToggle .chip").forEach((c) =>
    c.addEventListener("click", () => {
      document.querySelectorAll("#modeToggle .chip").forEach((x) => x.classList.remove("active"));
      c.classList.add("active"); mode = c.dataset.mode;
    })
  );
  document.getElementById("doRefresh").addEventListener("click", async () => {
    const out = document.getElementById("refreshOut");
    const btn = document.getElementById("doRefresh");
    btn.disabled = true;
    out.innerHTML = `<span class="spinner"></span> Running ${pipeline} · ${mode}… (live mode may take up to a minute)`;
    const r = await postJSON("/api/refresh", { questionId: id, mock: mode === "mock", ensemble: pipeline === "ensemble" });
    btn.disabled = false;
    if (r.ok) {
      const res = r.result || {};
      toast(`Refreshed ${id} → edition ${res.edition}`, "success");
      const gitLine = res.gitPushed
        ? `<div style="color:var(--green)">✓ Pushed to GitHub — public site will update shortly.</div>`
        : (res.gitLog
            ? `<div style="color:var(--amber)">⚠ Not pushed: ${esc(res.gitLog)}</div>`
            : "");
      out.innerHTML = `✓ Edition ${res.edition} · ${res.claims != null ? res.claims + " claims" : ""} · ${res.sources != null ? res.sources + " sources" : ""}` + gitLine;
      loadStatus();
    } else {
      toast("Refresh failed: " + r.error, "error");
      out.innerHTML = `<span style="color:var(--red)">Error: ${esc(r.error)}</span>`;
    }
  });
}

// ── Propose ──────────────────────────────────────────────────────────
function renderPropose() {
  app.innerHTML = `
    <h2 class="section">Propose a new question</h2>
    <div class="card">
      <div class="form">
        <div>
          <label for="pQuestion">Question</label>
          <textarea id="pQuestion" placeholder="How can AI help identify students with learning disabilities?"></textarea>
        </div>
        <div>
          <label for="pChapter">Chapter</label>
          <input id="pChapter" placeholder="e.g. 4" />
          <p class="help">Chapter number or name this question belongs to.</p>
        </div>
        <div>
          <label for="pRationale">Rationale</label>
          <textarea id="pRationale" placeholder="Why this question matters and should be added."></textarea>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" id="pSubmit">Propose question</button>
        </div>
        <div id="pOut" class="help"></div>
      </div>
    </div>
    <p class="help">Proposed questions are added with status <span class="badge badge-amber">proposed</span> and have no answer until you refresh them from the Questions tab.</p>
  `;
  document.getElementById("pSubmit").addEventListener("click", async () => {
    const question = document.getElementById("pQuestion").value.trim();
    const chapter = document.getElementById("pChapter").value.trim();
    const rationale = document.getElementById("pRationale").value.trim();
    const out = document.getElementById("pOut");
    if (!question || !chapter) { out.innerHTML = `<span style="color:var(--red)">Question and chapter are required.</span>`; return; }
    out.innerHTML = `<span class="spinner"></span> Submitting…`;
    const r = await postJSON("/api/propose", { question, chapter, rationale });
    if (r.ok) {
      toast(`Proposed ${r.entry.id}`, "success");
      out.innerHTML = `✓ Added <strong>${esc(r.entry.id)}</strong> with status <span class="badge badge-amber">proposed</span>. Refresh it from the Questions tab to generate an answer.`;
      document.getElementById("pQuestion").value = "";
      document.getElementById("pChapter").value = "";
      document.getElementById("pRationale").value = "";
      loadStatus();
    } else {
      toast("Propose failed", "error");
      out.innerHTML = `<span style="color:var(--red)">Error: ${esc(r.error)}</span>`;
    }
  });
}

// ── Editions ─────────────────────────────────────────────────────────
async function renderEditions() {
  app.innerHTML = `<div class="empty"><span class="spinner"></span> Loading…</div>`;
  const r = await getJSON("/api/editions");
  const eds = (r.editions || []).slice().reverse();
  app.innerHTML = `
    <h2 class="section">Edition ledger <span class="muted">(immutable, append-only)</span></h2>
    <div class="card" style="padding:0; overflow:auto;">
      <table>
        <thead><tr><th>#</th><th>Created</th><th>Description</th><th>Updated</th><th>Added</th><th>Author</th></tr></thead>
        <tbody>
          ${eds.map((e) => `<tr>
            <td><strong>${e.edition_number}</strong></td>
            <td class="muted">${esc((e.created_at||"").slice(0,19).replace("T"," "))}</td>
            <td>${esc(e.description || "")}</td>
            <td>${(e.questions_updated||[]).length}</td>
            <td>${(e.questions_added||[]).length}</td>
            <td class="muted">${esc(e.author || "")}</td>
          </tr>`).join("") || `<tr><td colspan="6" class="empty">No editions</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

// ── Consistency graph ────────────────────────────────────────────────
async function renderGraph() {
  app.innerHTML = `<div class="empty"><span class="spinner"></span> Loading…</div>`;
  const r = await getJSON("/api/graph");
  const contradictions = r.contradictions || [];
  const disputed = r.disputed || [];
  app.innerHTML = `
    <div class="row-between">
      <h2 class="section" style="margin-top:0">Consistency graph</h2>
      <button class="btn btn-primary" id="rerun">Re-run check</button>
    </div>
    <div class="grid grid-stats">
      ${stat((r.nodes||[]).length, "Claim nodes", "")}
      ${stat((r.edges||[]).length, "Relationships", "")}
      ${stat(contradictions.length, "Contradictions", contradictions.length ? "bad" : "good")}
      ${stat(disputed.length, "Disputed", disputed.length ? "warn" : "")}
    </div>
    <h2 class="section">Contradictions</h2>
    <div class="card">
      ${contradictions.length ? contradictions.map((c) => `<div class="row-between"><span>${esc(JSON.stringify(c))}</span></div>`).join("") : `<p class="muted">✓ No contradictions detected.</p>`}
    </div>
    <p class="help">Generated at ${esc(r.generated_at || "")}</p>
  `;
  document.getElementById("rerun").addEventListener("click", async () => {
    const r2 = await postJSON("/api/consistency");
    if (r2.ok) { toast("Consistency re-run complete", "success"); renderGraph(); loadStatus(); }
    else toast("Failed: " + r2.error, "error");
  });
}

// ── Logs ─────────────────────────────────────────────────────────────
async function renderLogs() {
  app.innerHTML = `<div class="empty"><span class="spinner"></span> Loading logs…</div>`;
  const r = await getJSON("/api/logs");
  app.innerHTML = `
    <div class="row-between">
      <h2 class="section" style="margin-top:0">Orchestration log <span class="muted">(last 300 lines)</span></h2>
      <button class="btn" id="reloadLog">Reload</button>
    </div>
    <pre class="log">${esc(r.log || "(empty)")}</pre>`;
  document.getElementById("reloadLog").addEventListener("click", renderLogs);
}

// ── Modal helpers ────────────────────────────────────────────────────
function openModal(title, body) {
  setModalTitle(title); setModalBody(body);
  document.getElementById("modal").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal").classList.add("hidden"); }
function setModalTitle(t) { document.getElementById("modalTitle").textContent = t; }
function setModalBody(html) { document.getElementById("modalBody").innerHTML = html; }

// ── Boot ─────────────────────────────────────────────────────────────
loadStatus().then(render);
