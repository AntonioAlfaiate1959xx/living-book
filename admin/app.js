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
    case "changes": return renderChanges();
    case "graph": return renderGraph();
    case "canon": return renderCanon();
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
      ${stat(t.claimNodes != null ? t.claimNodes : t.graphNodes, "Canon claim nodes", "")}
      ${stat(t.graphEdges, "Relationships", "")}
      ${stat(t.contradictions, "Contradictions", contraClass)}
      ${stat(t.openDisputes != null ? t.openDisputes : t.disputed, "Open disputes", (t.openDisputes || t.disputed) > 0 ? "warn" : "")}
    </div>

    <h2 class="section">Quick actions</h2>
    <div class="card">
      <div class="btn-row">
        <button class="btn btn-primary" id="qaReview">Run Canon review (6.5)</button>
        <button class="btn" id="qaConsistency">Run consistency check</button>
        <button class="btn" id="qaBuild">Build site (v2)</button>
        <button class="btn" data-goto="propose">Propose a question</button>
        <button class="btn" data-goto="canon">Canon &amp; disputes</button>
      </div>
      <div id="qaResult" class="help" style="margin-top:12px"></div>
    </div>

    <h2 class="section">System</h2>
    <div class="card">
      <div class="row-between"><span class="muted">Latest edition</span><strong>#${t.latestEdition}</strong></div>
      <div class="row-between"><span class="muted">Claim files on disk</span><strong>${t.claimFiles}</strong></div>
      <div class="row-between"><span class="muted">Active questions</span><strong>${t.active}</strong></div>
      <div class="row-between"><span class="muted">Latest Canon report</span><strong>${t.latestReport ? esc(t.latestReport) : "— none yet —"}</strong></div>
      <div class="row-between"><span class="muted">Live AI mode</span><strong>${s.apiKeyConfigured ? "available" : "disabled (no API key)"}</strong></div>
    </div>
  `;

  document.querySelectorAll("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelector(`.tab[data-view="${b.dataset.goto}"]`).click();
    })
  );
  document.getElementById("qaReview").addEventListener("click", () => runReview());
  document.getElementById("qaConsistency").addEventListener("click", runConsistency);
  document.getElementById("qaBuild").addEventListener("click", runBuild);
}

// Run Stage 6.5 (Canon & Consistency Review) from the dashboard.
async function runReview() {
  const box = document.getElementById("qaResult");
  if (box) box.innerHTML = `<span class="spinner"></span> Running Canon &amp; Consistency Review (Stage 6.5)…`;
  const r = await postJSON("/api/consistency-review", {});
  if (r.ok) {
    const su = r.summary || {};
    toast(`Canon review complete — ${su.created ?? "?"} created, ${su.disputeCount ?? 0} disputes`, (su.disputeCount || 0) ? "error" : "success");
    if (box) {
      const gitLine = r.gitPushed
        ? `<div style="color:var(--green)">✓ Committed &amp; pushed to GitHub.</div>`
        : (r.gitLog ? `<div style="color:var(--amber)">⚠ ${esc(r.gitLog)}</div>` : "");
      box.innerHTML = `✓ Report <strong>${esc(r.latestReport || "")}</strong> · `
        + `${su.created ?? 0} created · ${su.updated ?? 0} updated · ${su.unchanged ?? 0} unchanged · `
        + `<strong>${su.disputeCount ?? 0}</strong> open disputes · ${su.quarantineCount ?? 0} quarantined` + gitLine;
    }
    loadStatus();
  } else {
    toast("Canon review failed: " + r.error, "error");
    if (box) box.textContent = "Error: " + r.error;
  }
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

// ── Changes / Changelog ──────────────────────────────────────────────
const CHANGE_META = {
  initial:        { label: "First answer",   cls: "badge-blue"  },
  no_change:      { label: "No change",      cls: "badge-muted" },
  minor_update:   { label: "Minor update",   cls: "badge-green" },
  major_update:   { label: "Major update",   cls: "badge-red"   },
  new_source:     { label: "New source",     cls: "badge-amber" },
  source_removed: { label: "Source removed", cls: "badge-amber" },
};

function changeBadge(type) {
  const m = CHANGE_META[type] || { label: type || "change", cls: "badge-muted" };
  return `<span class="badge ${m.cls}">${esc(m.label)}</span>`;
}

async function renderChanges() {
  app.innerHTML = `<div class="empty"><span class="spinner"></span> Loading change history…</div>`;
  const r = await getJSON("/api/editions");
  // Newest first. Every ledger entry is shown; entries recorded before
  // change-detection existed simply have no `change` block and fall back
  // to their edition description.
  const eds = (r.editions || []).slice().reverse();

  const rows = eds.map((e) => {
    const c = e.change;
    const date = esc((e.created_at || "").slice(0, 10));
    const qList = []
      .concat(e.questions_updated || [], e.questions_added || [])
      .join(", ");

    if (!c) {
      // Legacy entry with no recorded classification.
      return `<div class="card change-card">
        <div class="row-between">
          <div><strong>Edition ${e.edition_number}</strong> ${changeBadge("no_change")}
            <span class="muted"> · ${qList ? esc(qList) : "—"}</span></div>
          <span class="muted">${date}</span>
        </div>
        <p style="margin:8px 0 0">${esc(e.description || "")}</p>
      </div>`;
    }

    const hasDiff = (c.oldAnswer || "").trim() || (c.newAnswer || "").trim();
    const diffBlock = hasDiff
      ? `<details style="margin-top:10px">
          <summary class="muted">Old vs new answer</summary>
          <div class="diff-grid">
            <div><div class="diff-h">Old</div><div class="diff-old">${esc(c.oldAnswer) || "<span class='muted'>— none —</span>"}</div></div>
            <div><div class="diff-h">New</div><div class="diff-new">${esc(c.newAnswer) || "<span class='muted'>— none —</span>"}</div></div>
          </div>
        </details>`
      : "";

    const srcNote = [];
    if ((c.addedSources || []).length) srcNote.push(`+${c.addedSources.length} source(s)`);
    if ((c.removedSources || []).length) srcNote.push(`−${c.removedSources.length} source(s)`);

    return `<div class="card change-card">
      <div class="row-between">
        <div>${changeBadge(c.changeType)}
          <span class="muted"> · Edition ${e.edition_number} · ${esc(c.id || qList || "")}</span></div>
        <span class="muted">${date}</span>
      </div>
      <p style="margin:8px 0 4px"><strong>${esc(c.question || "")}</strong></p>
      ${c.evidence ? `<p class="help" style="margin:0 0 4px">${esc(c.evidence)}</p>` : ""}
      ${srcNote.length ? `<p class="muted" style="margin:0">${esc(srcNote.join(" · "))}</p>` : ""}
      ${diffBlock}
    </div>`;
  });

  app.innerHTML = `
    <div class="row-between">
      <h2 class="section" style="margin-top:0">Changes <span class="muted">(all recorded changes, newest first)</span></h2>
      <button class="btn" id="reloadChanges">Reload</button>
    </div>
    <p class="help">Every refresh records what changed (old vs new answer), classified as a change type with evidence. This is the same history published in the book's appendix.</p>
    ${rows.join("") || `<div class="empty">No changes recorded yet.</div>`}
  `;
  document.getElementById("reloadChanges").addEventListener("click", renderChanges);
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

// ── Canon & Disputes (Stage 6.5) ─────────────────────────────────────
async function renderCanon() {
  app.innerHTML = `<div class="empty"><span class="spinner"></span> Loading Canon layer…</div>`;
  const [claims, disputes, reports] = await Promise.all([
    getJSON("/api/claims"),
    getJSON("/api/disputes"),
    getJSON("/api/reports"),
  ]);
  const ct = (claims && claims.totals) || { nodes: 0, suspected: 0, openDisputes: 0 };
  const allDisputes = (disputes && disputes.disputes) || [];
  const open = allDisputes.filter((d) => (d.status || "open") === "open");
  const resolved = allDisputes.filter((d) => (d.status || "open") !== "open");
  const reps = (reports && reports.reports) || [];

  app.innerHTML = `
    <div class="row-between">
      <h2 class="section" style="margin-top:0">Canon &amp; Consistency Review <span class="muted">(Stage 6.5 · non-blocking)</span></h2>
      <button class="btn btn-primary" id="canonRun">Run Canon review</button>
    </div>
    <p class="help">The Canon layer builds versioned <strong>claim nodes</strong> from every answer and flags <strong>suspected contradictions</strong> as open <strong>disputes</strong> for human review. Nothing is ever halted or deleted — you resolve each dispute here.</p>
    <div id="canonRunOut" class="help" style="margin:6px 0 14px"></div>

    <div class="grid grid-stats">
      ${stat(ct.nodes, "Claim nodes", "")}
      ${stat(ct.suspected, "Suspected claims", ct.suspected ? "bad" : "good")}
      ${stat(open.length, "Open disputes", open.length ? "warn" : "good")}
      ${stat(reps.length, "Reports", "")}
    </div>

    <h2 class="section">Open disputes ${open.length ? `<span class="badge badge-amber">${open.length}</span>` : ""}</h2>
    <div id="canonDisputes">
      ${open.length ? open.map(disputeCard).join("") : `<div class="card"><p class="muted">✓ No open disputes. The canon is internally consistent.</p></div>`}
    </div>

    ${resolved.length ? `
      <h2 class="section">Resolved disputes <span class="muted">(${resolved.length})</span></h2>
      <div>${resolved.map(disputeCard).join("")}</div>` : ""}

    <h2 class="section">Claim nodes by question</h2>
    <div class="card" style="padding:0; overflow:auto;">
      <table>
        <thead><tr><th>Question</th><th>Text</th><th>Nodes</th><th>Suspected</th><th>Open</th></tr></thead>
        <tbody>
          ${(claims.questions || []).map((q) => `
            <tr data-qid="${esc(q.questionId)}" class="canon-qrow">
              <td><strong>${esc(q.questionId)}</strong></td>
              <td class="q-text">${esc((q.questionText || "").slice(0, 90))}${(q.questionText||"").length > 90 ? "…" : ""}</td>
              <td>${q.nodeCount}</td>
              <td>${q.suspected ? `<span class="badge badge-red">${q.suspected}</span>` : "0"}</td>
              <td>${q.openDisputes ? `<span class="badge badge-amber">${q.openDisputes}</span>` : "0"}</td>
            </tr>`).join("") || `<tr><td colspan="5" class="empty">No claim nodes yet — run the Canon review.</td></tr>`}
        </tbody>
      </table>
    </div>

    <h2 class="section">Run reports</h2>
    <div class="card">
      ${reps.length ? reps.map((r) => {
        const su = r.summary || {};
        return `<div class="row-between canon-report" data-date="${esc(r.date)}" style="cursor:pointer;padding:6px 0">
          <span><strong>${esc(r.date)}</strong> <span class="muted">· ${su.created ?? "?"} created · ${su.disputeCount ?? 0} disputes · gate ${su.gate ?? "?"}</span></span>
          <span class="badge badge-blue">view</span>
        </div>`;
      }).join("") : `<p class="muted">No reports yet.</p>`}
    </div>
  `;

  document.getElementById("canonRun").addEventListener("click", async () => {
    await runReview();
    renderCanon();
  });
  document.querySelectorAll(".canon-qrow").forEach((tr) =>
    tr.addEventListener("click", () => openClaims(tr.dataset.qid))
  );
  document.querySelectorAll(".canon-report").forEach((row) =>
    row.addEventListener("click", () => openReport(row.dataset.date))
  );
  document.querySelectorAll("button[data-resolve]").forEach((b) =>
    b.addEventListener("click", () => openResolve(b.dataset.resolve))
  );
  // Stash disputes so the resolve dialog can look up detail without refetch.
  renderCanon._disputes = allDisputes;
}

function disputeCard(d) {
  const isOpen = (d.status || "open") === "open";
  const c = d.claims || [];
  const res = d.resolution;
  return `<div class="card change-card">
    <div class="row-between">
      <div>
        <span class="badge ${isOpen ? "badge-amber" : "badge-green"}">${isOpen ? "open" : "resolved"}</span>
        <span class="muted"> · ${esc(d.questionId)} · ${esc(d.reason || "conflict")} · overlap ${esc(String(d.topicalOverlap ?? ""))}</span>
      </div>
      <span class="muted">${esc((d.detectedAt || "").slice(0, 10))}</span>
    </div>
    ${d.questionText ? `<p style="margin:8px 0 4px"><strong>${esc(d.questionText)}</strong></p>` : ""}
    <div class="diff-grid" style="margin-top:8px">
      <div><div class="diff-h">Claim A <span class="muted">(${esc((c[0]||{}).claimId||"")})</span></div><div class="diff-old">${esc((c[0]||{}).claimText||"—")}</div></div>
      <div><div class="diff-h">Claim B <span class="muted">(${esc((c[1]||{}).claimId||"")})</span></div><div class="diff-new">${esc((c[1]||{}).claimText||"—")}</div></div>
    </div>
    ${d.detail ? `<p class="help" style="margin:8px 0 0">Reason: ${esc(d.reason)} — ${esc(d.detail)}</p>` : ""}
    ${res ? `<p class="help" style="margin:6px 0 0;color:var(--green)">Resolved as <strong>${esc(res.decision)}</strong>${res.note ? ` — ${esc(res.note)}` : ""} <span class="muted">(${esc(res.resolvedBy||"")}, ${esc((res.resolvedAt||"").slice(0,10))})</span></p>` : ""}
    <div class="btn-row" style="margin-top:10px">
      ${isOpen
        ? `<button class="btn btn-primary btn-sm" data-resolve="${esc(d.disputeId)}">Resolve…</button>`
        : `<button class="btn btn-sm" data-resolve="${esc(d.disputeId)}">Re-open / change…</button>`}
    </div>
  </div>`;
}

// Resolution dialog (in the shared modal).
function openResolve(disputeId) {
  const d = (renderCanon._disputes || []).find((x) => x.disputeId === disputeId);
  const isOpen = !d || (d.status || "open") === "open";
  openModal(`Resolve dispute`, `
    <p class="help">${d ? esc(d.questionId + " · " + (d.reason || "conflict")) : esc(disputeId)}</p>
    <div class="form">
      <div>
        <label>Decision</label>
        <select id="resDecision">
          <option value="resolved">Resolved (addressed / reconciled)</option>
          <option value="not_a_conflict">Not a real conflict (false positive)</option>
          <option value="dismissed">Dismissed (won't fix)</option>
          ${isOpen ? "" : `<option value="reopened">Re-open this dispute</option>`}
        </select>
      </div>
      <div>
        <label>Note (optional)</label>
        <textarea id="resNote" placeholder="How was this resolved? e.g. amended q012's answer to remove the contradiction."></textarea>
      </div>
      <div>
        <label>Resolved by (optional)</label>
        <input id="resBy" placeholder="your name" />
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="resSubmit">Apply</button></div>
      <div id="resOut" class="help"></div>
    </div>
  `);
  document.getElementById("resSubmit").addEventListener("click", async () => {
    const decision = document.getElementById("resDecision").value;
    const note = document.getElementById("resNote").value.trim();
    const resolvedBy = document.getElementById("resBy").value.trim();
    const out = document.getElementById("resOut");
    const btn = document.getElementById("resSubmit");
    btn.disabled = true;
    out.innerHTML = `<span class="spinner"></span> Applying…`;
    const r = await postJSON("/api/disputes/resolve", { disputeId, resolution: decision, note, resolvedBy });
    btn.disabled = false;
    if (r.ok) {
      toast(`Dispute ${r.status}`, "success");
      closeModal();
      loadStatus();
      renderCanon();
    } else {
      out.innerHTML = `<span style="color:var(--red)">Error: ${esc(r.error)}</span>`;
    }
  });
}

// Claim-node detail for a question (in the shared modal).
async function openClaims(qid) {
  openModal(`Claim nodes — ${qid}`, `<div class="empty"><span class="spinner"></span></div>`);
  const r = await getJSON("/api/claims/" + qid);
  if (!r.ok) { setModalBody(`<p class="muted">${esc(r.error)}</p>`); return; }
  const nodes = r.nodes || [];
  let body = `<p class="help">${esc(r.questionText || "")}</p>`;
  body += nodes.map((n) => {
    const conf = n.confidence || {};
    const csClass = n.contradictionStatus === "suspected" ? "badge-red"
      : n.contradictionStatus === "resolved" ? "badge-green" : "badge-muted";
    const dsClass = n.disputeStatus === "open" ? "badge-amber"
      : n.disputeStatus === "resolved" ? "badge-green" : "badge-muted";
    const srcs = (n.provenanceEdges || []).map((e) =>
      `<li><span class="muted">${esc(e.relation||"supports")}</span> ${esc(e.url||e.sourceId||"")} <span class="badge badge-muted">${esc(e.credibility||"")}</span></li>`).join("");
    return `<div class="card" style="margin-bottom:12px">
      <div class="row-between">
        <strong>${esc(n.claimId)}</strong>
        <span>v${esc(String(n.version||1))} · <span class="badge ${csClass}">${esc(n.contradictionStatus||"none")}</span> <span class="badge ${dsClass}">${esc(n.disputeStatus||"none")}</span></span>
      </div>
      <p style="margin:8px 0">${esc(n.claimText || "")}</p>
      <div class="row-between"><span class="muted">Confidence</span><strong>${esc(String(conf.score ?? ""))} (${esc(conf.level||"")})</strong></div>
      <div class="row-between"><span class="muted">Valid from</span><span>${esc((n.validityInterval||{}).validFrom || "")}</span></div>
      ${srcs ? `<details style="margin-top:6px"><summary class="muted">${(n.provenanceEdges||[]).length} source(s)</summary><ul>${srcs}</ul></details>` : ""}
      ${(n.contradicts||[]).length ? `<p class="help" style="margin:6px 0 0;color:var(--red)">Contradicts: ${esc((n.contradicts||[]).join(", "))}</p>` : ""}
    </div>`;
  }).join("") || `<p class="muted">No nodes.</p>`;
  setModalTitle(`Claim nodes — ${qid} (${nodes.length})`);
  setModalBody(body);
}

// Report viewer (renders the markdown as preformatted text in the modal).
async function openReport(date) {
  openModal(`Report — ${date}`, `<div class="empty"><span class="spinner"></span></div>`);
  const r = await getJSON("/api/reports/" + date);
  if (!r.ok) { setModalBody(`<p class="muted">${esc(r.error)}</p>`); return; }
  setModalBody(`<pre class="log" style="white-space:pre-wrap">${esc(r.markdown || "")}</pre>`);
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
