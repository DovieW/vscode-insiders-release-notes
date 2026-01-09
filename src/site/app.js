const els = {
  repoBadge: document.getElementById("repoBadge"),
  runSelect: document.getElementById("runSelect"),
  runMeta: document.getElementById("runMeta"),
  labels: document.getElementById("labels"),
  searchInput: document.getElementById("searchInput"),
  prList: document.getElementById("prList"),
  count: document.getElementById("count"),
};

const state = {
  index: null,
  run: null,
  query: "",
  activeLabel: null,
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function setRepoBadge(text) {
  els.repoBadge.textContent = text;
}

function renderRunSelect() {
  const runs = state.index?.runs || [];

  els.runSelect.innerHTML = runs
    .map((r, i) => {
      const selected = i === 0 ? "selected" : "";
      return `<option value="${escapeHtml(r.path)}" ${selected}>${escapeHtml(r.title || r.id)}</option>`;
    })
    .join("");

  els.runSelect.disabled = runs.length === 0;
}

function uniqueLabels(prs) {
  const set = new Set();
  for (const pr of prs || []) {
    for (const l of pr.labels || []) set.add(l);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function renderLabels() {
  const labels = uniqueLabels(state.run?.prs || []);
  if (!labels.length) {
    els.labels.innerHTML = "";
    return;
  }

  const pills = [
    { name: "All", value: null },
    ...labels.map((l) => ({ name: l, value: l })),
  ];

  els.labels.innerHTML = pills
    .map((p) => {
      const active = state.activeLabel === p.value || (p.value === null && state.activeLabel === null);
      return `<button class="pill" type="button" data-label="${escapeHtml(p.value ?? "")}" data-active="${active}">${escapeHtml(p.name)}</button>`;
    })
    .join("");

  els.labels.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-label");
      state.activeLabel = v ? v : null;
      renderLabels();
      renderPrList();
    });
  });
}

function renderMeta() {
  const run = state.run;
  if (!run) {
    els.runMeta.innerHTML = "";
    return;
  }

  const truncated = run.wasTruncated
    ? `<span class="code">Compare appears truncated (${run.commitsReturned}/${run.totalCommits} commits returned)</span>`
    : "";

  els.runMeta.innerHTML = `
    <div>
      <span class="code">from</span> <span class="code">${escapeHtml(run.from.slice(0, 10))}</span>
      <span class="code">to</span> <span class="code">${escapeHtml(run.to.slice(0, 10))}</span>
      · <a href="${escapeHtml(run.compareUrl)}" target="_blank" rel="noreferrer">view compare</a>
      · <span class="code">generated</span> <span class="code">${escapeHtml(run.generatedAt)}</span>
      ${truncated ? ` · ${truncated}` : ""}
    </div>
  `;
}

function matches(pr) {
  const q = state.query.trim().toLowerCase();
  const label = state.activeLabel;

  const title = String(pr.title || "").toLowerCase();
  const okQuery = !q || title.includes(q) || String(pr.number).includes(q);
  const okLabel = !label || (pr.labels || []).includes(label);

  return okQuery && okLabel;
}

function renderPrList() {
  const prs = (state.run?.prs || []).filter(matches);

  els.count.textContent = `${prs.length}/${state.run?.prs?.length ?? 0}`;

  els.prList.innerHTML = prs
    .map((pr) => {
      const num = escapeHtml(pr.number);
      const title = escapeHtml(pr.title || "");
      const url = escapeHtml(pr.url || "#");
      const author = pr.author ? `@${escapeHtml(pr.author)}` : "";

      return `
        <li class="pr">
          <div class="pr-title">
            <a href="${url}" target="_blank" rel="noreferrer">${title}</a>
            <span class="code">#${num}</span>
          </div>
          <div class="pr-meta">
            ${author ? `<span>${author}</span>` : ""}
            ${pr.mergedAt ? `<span class="code">merged ${escapeHtml(pr.mergedAt.slice(0, 10))}</span>` : ""}
            ${(pr.labels || []).slice(0, 5).map((l) => `<span class="code">${escapeHtml(l)}</span>`).join(" ")}
          </div>
        </li>
      `;
    })
    .join("");
}

async function loadRun(path) {
  state.run = await loadJson(`data/${path}`);
  state.query = "";
  state.activeLabel = null;
  els.searchInput.value = "";

  renderMeta();
  renderLabels();
  renderPrList();
}

async function main() {
  try {
    state.index = await loadJson("data/index.json");
    setRepoBadge(state.index.repo || "(unknown repo)");

    renderRunSelect();

    const first = state.index.runs?.[0];
    if (first?.path) {
      await loadRun(first.path);
      els.runSelect.value = first.path;
    } else {
      els.runMeta.innerHTML = "No runs yet. Once the workflow runs, data will appear here.";
      els.count.textContent = "0/0";
      els.prList.innerHTML = "";
    }

    els.runSelect.addEventListener("change", async () => {
      const path = els.runSelect.value;
      if (path) await loadRun(path);
    });

    els.searchInput.addEventListener("input", () => {
      state.query = els.searchInput.value;
      renderPrList();
    });
  } catch (err) {
    setRepoBadge("Error");
    els.runMeta.innerHTML = `Failed to load data. If this is a fresh setup, run the workflow once.<br/><br/><span class="code">${escapeHtml(err?.message || String(err))}</span>`;
    console.error(err);
  }
}

main();
