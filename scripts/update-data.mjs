#!/usr/bin/env node

import "dotenv/config";
import OpenAI from "openai";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const STATE_PATH = join(DATA_DIR, "insiders-state.json");

const DOCS_DIR = new URL("../docs/", import.meta.url).pathname;
const BUILDS_DIR = join(DOCS_DIR, "builds");
const BUILDS_INDEX_PATH = join(BUILDS_DIR, "index.md");
const HOME_PATH = join(DOCS_DIR, "index.md");

const TARGET_REPO = process.env.TARGET_REPO || "microsoft/vscode";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const OUT_DIR = join(new URL("../", import.meta.url).pathname, ".out");
const OUT_RELEASE_NOTES_PATH = join(OUT_DIR, "release-notes.md");
const OUT_BUILD_META_PATH = join(OUT_DIR, "build.json");
const OUT_INSTALLERS_JSON_PATH = join(OUT_DIR, "installers.json");
const OUT_INSTALLERS_MD_PATH = join(OUT_DIR, "installers.md");
const OUT_SYSTEM_PROMPT_PATH = join(OUT_DIR, "system-prompt.md");
const OUT_USER_PROMPT_PATH = join(OUT_DIR, "user-prompt.md");

const INSIDERS_COMMITS_FEED = "https://update.code.visualstudio.com/api/commits/insider";

const INSIDERS_UPDATE_API_BASE = "https://update.code.visualstudio.com/api/update";
const INSIDERS_LATEST_AVAILABLE_UPDATE_URL = "https://update.code.visualstudio.com/api/update/win32-x64-user/insider/latest";

function shortSha(sha) {
  return (sha || "").slice(0, 7);
}

function resolveShaPrefixOrThrow({ shas, input, label }) {
  const value = String(input || "").trim();
  if (!value) throw new Error(`Missing ${label}.`);

  // Fast path: full SHA in feed.
  if (shas.includes(value)) return value;

  // Common UX: user provides a git-style short SHA. Allow unique prefixes.
  const matches = shas.filter((s) => s.startsWith(value));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const sample = matches.slice(0, 8).map(shortSha).join(", ");
    throw new Error(
      `${label} '${value}' is ambiguous (${matches.length} matches in insiders feed). ` +
      `Please provide a longer prefix. Matches include: ${sample}${matches.length > 8 ? ", ..." : ""}`,
    );
  }

  throw new Error(
    `${label} '${value}' was not found in the insiders feed. ` +
    `Make sure you're using a commit SHA from ${INSIDERS_COMMITS_FEED}.`,
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--build-sha") out.buildSha = argv[++i];
    else if (a === "--previous-sha") out.previousSha = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "--latest") out.latest = true;
    else if (a === "--preview") out.preview = true;
    else if (a === "--out") out.outPath = argv[++i];
  }
  return out;
}

async function readJsonIfExists(path) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function githubJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      Accept: extraHeaders.Accept || "application/vnd.github+json",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "insiders-changes-site",
      ...extraHeaders,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub error ${res.status} ${res.statusText}: ${body}`);
  }

  return res.json();
}

async function getRepoInfo(repo) {
  return githubJson(`https://api.github.com/repos/${repo}`);
}

async function getBranchHeadSha(repo, branch) {
  const data = await githubJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`);
  return data?.sha;
}

async function getCompare(repo, from, to) {
  return githubJson(`https://api.github.com/repos/${repo}/compare/${from}...${to}`);
}

async function getCommit(repo, sha) {
  return githubJson(`https://api.github.com/repos/${repo}/commits/${sha}`);
}

async function getRepoFileJsonViaRaw(repo, sha, path) {
  const url = `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
  const res = await fetch(url, { headers: { "User-Agent": "insiders-changes-site" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

async function getInsidersBuildCommits() {
  const res = await fetch(INSIDERS_COMMITS_FEED, { headers: { "User-Agent": "insiders-changes-site" } });
  if (!res.ok) throw new Error(`Failed to fetch insiders commits feed: ${res.status} ${res.statusText}`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) throw new Error("Insiders commits feed returned no commits.");
  return list;
}

async function getLatestAvailableInsidersBuildSha() {
  const res = await fetch(INSIDERS_LATEST_AVAILABLE_UPDATE_URL, { headers: { "User-Agent": "insiders-changes-site" } });
  if (!res.ok) {
    throw new Error(`Failed to fetch latest available Insiders build: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const sha = json?.version;
  if (!sha || typeof sha !== "string") throw new Error("Latest available Insiders response missing 'version' SHA.");
  return sha;
}

async function getPullsForCommit(repo, sha) {
  // https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28#list-pull-requests-associated-with-a-commit
  return githubJson(
    `https://api.github.com/repos/${repo}/commits/${sha}/pulls`,
    {
      // Some GitHub instances historically required the groot preview for this endpoint.
      Accept: "application/vnd.github+json,application/vnd.github.groot-preview+json",
    },
  );
}

async function getPullRequest(repo, number) {
  return githubJson(`https://api.github.com/repos/${repo}/pulls/${number}`);
}

async function getIssueCommentsForPullRequest(repo, number) {
  // PRs are issues, so issue comments live on /issues/:number/comments
  // https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#list-issue-comments
  return githubJson(`https://api.github.com/repos/${repo}/issues/${number}/comments?per_page=100`);
}

async function getPullRequestReviews(repo, number) {
  // Copilot “Pull request overview” is commonly posted as a PR review.
  // https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28#list-reviews-for-a-pull-request
  return githubJson(`https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=100`);
}

function extractCopilotSummariesFromComments(comments) {
  // We only want the “summary style” comments people leave by mentioning @copilot,
  // or comments authored by a Copilot bot user.
  const out = [];
  const list = Array.isArray(comments) ? comments : [];

  for (const c of list) {
    const author = String(c?.user?.login || "").toLowerCase();
    const body = String(c?.body || "").trim();
    if (!body) continue;

    const mentionsCopilot = /(^|\s)@copilot\b/i.test(body);
    const isCopilotAuthor = author.includes("copilot");
    if (!mentionsCopilot && !isCopilotAuthor) continue;

    // Keep it short to avoid token blow-ups.
    out.push(body.slice(0, 1200));
    if (out.length >= 2) break;
  }

  return out;
}

function extractCopilotSummariesFromReviews(reviews) {
  const out = [];
  const list = Array.isArray(reviews) ? reviews : [];

  for (const r of list) {
    const author = String(r?.user?.login || "").toLowerCase();
    const body = String(r?.body || "").trim();
    if (!body) continue;

    // We primarily care about Copilot-authored reviews.
    const isCopilotAuthor = author.includes("copilot");
    if (!isCopilotAuthor) continue;

    out.push(body.slice(0, 1200));
    if (out.length >= 2) break;
  }

  return out;
}

function mergeCopilotSummaries({ commentSummaries, reviewSummaries }) {
  const merged = [];
  for (const s of [...(reviewSummaries || []), ...(commentSummaries || [])]) {
    const v = String(s || "").trim();
    if (!v) continue;
    if (merged.includes(v)) continue;
    merged.push(v);
    if (merged.length >= 3) break;
  }
  return merged;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function mdEscapeInline(text) {
  // Keep it simple: avoid accidentally breaking markdown links/lists.
  return String(text || "").replaceAll("\r", "").trim();
}

function mdEscapeEmphasis(text) {
  // Escape characters that commonly break bold/italic markdown.
  return mdEscapeInline(text)
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("`", "\\`");
}

async function getInsidersInstallerLinksForBuild(buildSha) {
  // Best-effort: this is just convenience links to official Microsoft-hosted binaries.
  // We do NOT redistribute or upload these binaries into GitHub.
  const platforms = [
    { id: "win32-x64-user", label: "Windows (User Setup, x64)" },
    { id: "win32-x64", label: "Windows (System Setup, x64)" },
    { id: "win32-arm64-user", label: "Windows (User Setup, ARM64)" },
    { id: "win32-arm64", label: "Windows (System Setup, ARM64)" },
    { id: "darwin", label: "macOS (Intel)" },
    { id: "darwin-arm64", label: "macOS (Apple Silicon)" },
    { id: "linux-x64", label: "Linux (tar.gz, x64)" },
    { id: "linux-arm64", label: "Linux (tar.gz, ARM64)" },
    { id: "linux-deb-x64", label: "Linux (deb, x64)" },
    { id: "linux-deb-arm64", label: "Linux (deb, ARM64)" },
    { id: "linux-rpm-x64", label: "Linux (rpm, x64)" },
    { id: "linux-rpm-arm64", label: "Linux (rpm, ARM64)" },
  ];

  const results = [];
  for (const p of platforms) {
    const url = `${INSIDERS_UPDATE_API_BASE}/${p.id}/insider/${buildSha}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "insiders-changes-site" } });
      if (!res.ok) {
        results.push({ ...p, ok: false, status: res.status, url: null });
        continue;
      }
      const data = await res.json();
      results.push({ ...p, ok: true, status: res.status, url: data?.url || null });
    } catch (err) {
      results.push({ ...p, ok: false, status: 0, url: null, error: String(err?.message || err) });
    }
  }

  return results.filter((r) => r.ok && r.url);
}

function buildInstallersMarkdown(links) {
  if (!Array.isArray(links) || links.length === 0) return "";

  const lines = [];
  lines.push("## Installers");
  lines.push("");
  lines.push("Official download links for this Insiders build:");
  lines.push("");
  for (const l of links) {
    lines.push(`- ${mdEscapeInline(l.label)}: ${l.url}`);
  }
  lines.push("");

  return lines.join("\n");
}

async function rebuildBuildIndexes(repo) {
  await mkdir(BUILDS_DIR, { recursive: true });

  const files = (await readdir(BUILDS_DIR))
    .filter((f) => f.endsWith(".md") && f !== "index.md")
    .filter((f) => f.includes("-insider"));
  const sorted = files.sort((a, b) => b.localeCompare(a));

  // Group by minor version when filename contains something like: YYYY-MM-DD_HH-mmZ_1.109.0-insider_<sha>.md
  const groups = new Map();
  for (const f of sorted) {
    const slug = f.replace(/\.md$/, "");
    const parts = slug.split("_");
    const versionPart = parts.find((p) => /\d+\.\d+\.\d+-insider/.test(p)) || "other";
    const minor = versionPart !== "other" ? versionPart.split(".").slice(0, 2).join(".") : "Other";
    if (!groups.has(minor)) groups.set(minor, []);
    groups.get(minor).push({ slug, version: versionPart });
  }

  const groupOrder = Array.from(groups.keys()).sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : b.localeCompare(a)));
  const lines = [];
  if (!sorted.length) {
    lines.push("Build pages will appear here after the workflow generates the first build.");
  } else {
    for (const g of groupOrder) {
      lines.push(`## ${mdEscapeInline(g)}`);
      for (const item of groups.get(g)) {
        // IMPORTANT: avoid leading '/' so project pages work under a base path.
        lines.push(`- [${mdEscapeInline(buildLabelFromSlug(item.slug))}](./${encodeURIComponent(item.slug)})`);
      }
      lines.push("");
    }
  }

  const buildsIndex = `# Builds\n\n${lines.join("\n").trim()}\n`;
  await writeFile(BUILDS_INDEX_PATH, buildsIndex, "utf8");

  // Root page: redirect to Builds (this repo only really has one destination).
  // We generate this file so the workflow can't accidentally re-introduce a separate "home".
  const home = `---\ntitle: Builds\n---\n\n<script setup>\nimport { onMounted } from 'vue'\nimport { withBase } from 'vitepress'\n\nonMounted(() => {\n  // Use a hard redirect so it works even when served as a static site.
  window.location.replace(withBase('/builds/'))\n})\n</script>\n\nRedirecting to **[Builds](./builds/)**...\n`;
  await writeFile(HOME_PATH, home, "utf8");
}

function buildAiPrompt({ repo, defaultBranch, fromSha, toSha, compareUrl, pullRequests }) {
  // Keep it deterministic. Output should be machine-mergeable.
  const prPayload = (pullRequests || []).map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr?.user?.login || null,
    merged_at: pr.merged_at || null,
    labels: Array.isArray(pr.labels) ? pr.labels.map((l) => l?.name).filter(Boolean) : [],
    body: pr.body ? String(pr.body).slice(0, 4000) : "",
    copilot_summaries: Array.isArray(pr.copilot_summaries) ? pr.copilot_summaries : [],
  }));

  const input = {
    repo,
    defaultBranch,
    range: { fromSha, toSha, compareUrl },
    // The final markdown is assembled programmatically. The model only supplies the per-PR label + explainer.
    // Expected rendering (for each PR):
    // - **✨** [#123](url) **Title**
    //   > explainer...
    labelOptions: ["add", "fix", "refactor", "upgrade"],
    pullRequests: prPayload,
  };

  return {
    instructions:
      "You write simple, easy-to-understand explainers for developers. " +
      "Given a list of merged PRs for a single build, generate ONE short explainer per PR. " +
      "Output format: STRICT JSON object ONLY (no markdown, no code fences). " +
      "Keys are PR numbers as strings. Values are objects with exactly: { label, explainer }. " +
      "label must be one of: add, fix, refactor, upgrade. " +
      "explainer must be 1-2 sentences. " +
      "Rules: (1) Keep explainers plain-English and concrete (what changed + who benefits). " +
      "(2) Do NOT mention @copilot. Some PRs include 'copilot_summaries' - treat them as helpful context. " +
      "(3) Avoid jargon. If you must use a technical term, add a tiny parenthetical. " +
      "(4) Do not hallucinate: if context is unclear, say something like 'Internal maintenance/refactoring; no user-visible change expected.' " +
      "(5) Keep each explainer under 220 characters.",
    input: JSON.stringify(input),
  };
}

function extractJsonObjectFromText(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = s.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function clampExplainer(text) {
  const t = String(text || "").replaceAll("\r", "").replaceAll("\n", " ").trim();
  if (!t) return "Internal maintenance/refactoring; no user-visible change expected.";
  return t.length > 220 ? (t.slice(0, 217).trimEnd() + "...") : t;
}

function normalizePrChangeLabel(labelRaw) {
  const v = String(labelRaw || "").trim().toLowerCase();
  if (!v) return "refactor";
  if (v === "add" || v === "added" || v === "new") return "add";
  if (v === "fix" || v === "fixed" || v === "bugfix" || v === "bug") return "fix";
  if (v === "refactor" || v === "cleanup" || v === "internal") return "refactor";
  if (v === "upgrade" || v === "bump" || v === "deps" || v === "dependency") return "upgrade";
  return "refactor";
}

function normalizeExplainerEntry(entry) {
  // Back-compat: older model output was a string.
  if (typeof entry === "string") {
    return { label: "refactor", explainer: clampExplainer(entry) };
  }

  const obj = entry && typeof entry === "object" ? entry : {};
  return {
    label: normalizePrChangeLabel(obj.label),
    explainer: clampExplainer(obj.explainer),
  };
}

function labelToEmoji(label) {
  // Deterministic rendering, independent of the model.
  // User-requested mapping:
  // - add      -> ✨
  // - fix      -> 🐛
  // - refactor -> 🔨
  // - upgrade  -> ⬆️
  switch (String(label || "").toLowerCase()) {
    case "add":
      return "✨";
    case "fix":
      return "🐛";
    case "refactor":
      return "🔨";
    case "upgrade":
      return "⬆️";
    default:
      return "🔨";
  }
}

function buildExplainersMarkdown({ pullRequests, explainersByNumber }) {
  const prs = Array.isArray(pullRequests) ? pullRequests : [];
  if (!prs.length) return "";

  const order = ["add", "fix", "refactor", "upgrade"];
  const buckets = new Map(order.map((k) => [k, []]));

  const lines = [];
  lines.push("## Changes");
  lines.push("");
  lines.push("Each item has a plain-English explainer under it:");
  lines.push("");

  // Sort/group by the model's label choice.
  for (const pr of prs) {
    const n = pr?.number;
    const entryRaw = n != null ? explainersByNumber?.[String(n)] : null;
    const entry = normalizeExplainerEntry(entryRaw);
    const key = buckets.has(entry.label) ? entry.label : "refactor";
    buckets.get(key).push({ pr, entry });
  }

  for (const k of order) {
    for (const { pr, entry } of buckets.get(k)) {
      const n = pr?.number;
      const title = mdEscapeEmphasis(pr?.title || "");
      const url = pr?.html_url;
      const emoji = labelToEmoji(entry.label);

      if (n && url) {
        lines.push(`- **${emoji}** [#${n}](${url}) **${title || "(untitled change)"}**`);
      } else if (n) {
        lines.push(`- **${emoji}** #${n} **${title || "(untitled change)"}**`);
      } else {
        lines.push(`- **${emoji}** **${title || "(untitled change)"}**`);
      }
      // Use a markdown quote instead of a nested list item.
      lines.push(`  > ${entry.explainer}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function generateAiExplainers({ repo, defaultBranch, fromSha, toSha, compareUrl, pullRequests }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to generate explainers.");
  }
  if (!pullRequests?.length) {
    throw new Error("No PRs found for this build range; refusing to generate empty explainers.");
  }

  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const { instructions, input } = buildAiPrompt({ repo, defaultBranch, fromSha, toSha, compareUrl, pullRequests });

  // Debug artifacts: write the exact prompts we send to the API.
  // - `instructions` acts like a system/developer prompt (behavior)
  // - `input` is the user payload (the PR details JSON)
  await writeFile(OUT_SYSTEM_PROMPT_PATH, String(instructions || "").trim() + "\n", "utf8");
  try {
    const pretty = JSON.stringify(JSON.parse(input), null, 2);
    await writeFile(OUT_USER_PROMPT_PATH, pretty + "\n", "utf8");
  } catch {
    await writeFile(OUT_USER_PROMPT_PATH, String(input || "").trim() + "\n", "utf8");
  }

  const response = await client.responses.create({
    model: OPENAI_MODEL,
    instructions,
    input,
  });

  const raw = (response?.output_text || "").trim();
  const json = extractJsonObjectFromText(raw);
  if (!json || typeof json !== "object") throw new Error("OpenAI did not return a valid JSON object for explainers.");

  // Validate shape (best-effort): values should be objects with {label, explainer}.
  // We keep backwards compatibility with older string-only values.
  for (const [k, v] of Object.entries(json)) {
    if (typeof v === "string") continue;
    if (!v || typeof v !== "object") throw new Error(`Invalid explainer value for PR ${k}; expected object or string.`);
    if (typeof v.explainer !== "string") throw new Error(`Invalid explainer for PR ${k}; expected string.`);
    if (typeof v.label !== "string") throw new Error(`Invalid label for PR ${k}; expected string.`);
  }
  return json;
}

async function collectMergedPullRequestsForRange({ repo, commits }) {
  const prNumbers = new Set();

  for (const c of commits) {
    const sha = c?.sha;
    if (!sha) continue;
    try {
      const pulls = await getPullsForCommit(repo, sha);
      for (const pr of pulls || []) {
        if (typeof pr?.number === "number") prNumbers.add(pr.number);
      }
    } catch (err) {
      // Best-effort: if this endpoint is unavailable/rate-limited, don't fail the whole run.
      console.warn(`Failed to resolve PRs for commit ${shortSha(sha)}: ${err?.message || err}`);
    }
  }

  const prs = [];
  // Safety valve: PR ranges can be large, and fetching comments is extra API traffic.
  // We'll enrich only the first N PRs (most recently merged after sorting) by default.
  const MAX_PRS_WITH_COMMENT_ENRICHMENT = 40;

  for (const n of prNumbers) {
    try {
      const pr = await getPullRequest(repo, n);
      if (!pr?.merged_at) continue;

      // Best-effort: enrich PR with @copilot summaries (or copilot-bot authored comments).
      // If GitHub rate limits, we still want the build to proceed.
      pr.copilot_summaries = [];

      prs.push(pr);
    } catch (err) {
      console.warn(`Failed to fetch PR #${n}: ${err?.message || err}`);
    }
  }

  prs.sort((a, b) => String(b.merged_at || "").localeCompare(String(a.merged_at || "")));

  // Enrich the newest PRs first (these are also the most likely to have recent @copilot summaries).
  for (const pr of prs.slice(0, MAX_PRS_WITH_COMMENT_ENRICHMENT)) {
    try {
      // Best-effort: pull both issue comments and PR reviews. Copilot summaries show up in either.
      const [comments, reviews] = await Promise.all([
        getIssueCommentsForPullRequest(repo, pr.number),
        getPullRequestReviews(repo, pr.number),
      ]);
      pr.copilot_summaries = mergeCopilotSummaries({
        commentSummaries: extractCopilotSummariesFromComments(comments),
        reviewSummaries: extractCopilotSummariesFromReviews(reviews),
      });
    } catch (err) {
      pr.copilot_summaries = [];
      console.warn(`Failed to fetch comments for PR #${pr.number}: ${err?.message || err}`);
    }
  }

  return prs;
}

function formatUtcParts(iso) {
  const d = new Date(iso);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return { date: `${y}-${m}-${day}`, time: `${hh}-${mm}Z`, display: `${y}-${m}-${day} ${hh}:${mm} UTC` };
}

function formatUtcTimeForUi(timePart) {
  // Example: "00-50Z" -> "00:50Z" (more readable, and can be swapped client-side to local time).
  const m = /^([0-9]{2})-([0-9]{2})Z$/.exec(String(timePart || ""));
  if (!m) return String(timePart || "");
  return `${m[1]}:${m[2]}Z`;
}

function buildLabelFromSlug(slug) {
  // Expected slug format:
  // YYYY-MM-DD_HH-mmZ_1.109.0-insider_7c62052
  const parts = String(slug || "").split("_");
  const date = parts[0];
  const timePart = parts[1];
  const timeUi = formatUtcTimeForUi(timePart);
  if (date && timeUi) return `${date} - ${timeUi}`;
  return String(slug || "");
}

function buildPageMarkdown({
  repo,
  defaultBranch,
  fromSha,
  toSha,
  compareUrl,
  totalCommits,
  commits,
  version,
  buildTitleUtc,
  installersMd,
  explainersMd,
}) {
  const title = mdEscapeInline(buildTitleUtc);
  const warning = totalCommits > commits.length
    ? `\n> ⚠️ GitHub compare returned ${commits.length} of ${totalCommits} commits for this range. This changelog may be incomplete.\n`
    : "";

  return `---
title: "${title}"
---

# ${title}

Commit: [${mdEscapeInline(shortSha(toSha))}](https://github.com/${repo}/commit/${toSha}) · Previous: [${mdEscapeInline(shortSha(fromSha))}](https://github.com/${repo}/commit/${fromSha}) · Compare: [GitHub](${compareUrl})
Version: \`${mdEscapeInline(version)}\` · Branch: \`${mdEscapeInline(defaultBranch)}\` · Upstream: [${mdEscapeInline(repo)}](https://github.com/${repo})
${warning}

${(installersMd || "").trim()}

${(explainersMd || "").trim()}
`;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(BUILDS_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const args = parseArgs(process.argv);
  const preview = Boolean(args.preview);
  const requestedBuildSha = args.latest
    ? await getLatestAvailableInsidersBuildSha()
    : args.buildSha;

  if (!requestedBuildSha) {
    throw new Error("Missing required --build-sha <sha> argument (or pass --latest).");
  }
  const force = Boolean(args.force);

  const state = (await readJsonIfExists(STATE_PATH)) || { repo: TARGET_REPO };

  const insidersCommits = await getInsidersBuildCommits();
  const buildSha = resolveShaPrefixOrThrow({ shas: insidersCommits, input: requestedBuildSha, label: "Build SHA" });
  const buildIndex = insidersCommits.indexOf(buildSha);
  if (buildIndex === -1) throw new Error(`Internal error: resolved build SHA missing from feed: ${buildSha}`);

  const requestedPreviousSha = args.previousSha || insidersCommits[buildIndex + 1];
  if (!requestedPreviousSha) {
    throw new Error(`No previous build SHA available for ${buildSha} (it may be the oldest in the feed).`);
  }
  const previousSha = resolveShaPrefixOrThrow({ shas: insidersCommits, input: requestedPreviousSha, label: "Previous SHA" });

  const repoInfo = await getRepoInfo(TARGET_REPO);
  const defaultBranch = repoInfo?.default_branch || "main";

  // If we've already processed this build or a newer one, do nothing (unless forced).
  // In --preview mode, we always generate output for local testing.
  if (!preview && !force && state?.lastProcessedBuildSha) {
    const lastIdx = insidersCommits.indexOf(state.lastProcessedBuildSha);
    if (lastIdx !== -1 && lastIdx <= buildIndex) {
      if (!preview) {
        await rebuildBuildIndexes(TARGET_REPO);
      }
      console.log(`Build already processed (state at ${shortSha(state.lastProcessedBuildSha)}). Skipping ${shortSha(buildSha)}.`);
      console.log("Tip: re-run with --force to regenerate the page for this build SHA.");
      return;
    }
  }

  const buildCommit = await getCommit(TARGET_REPO, buildSha);
  const buildIso = buildCommit?.commit?.committer?.date || buildCommit?.commit?.author?.date;
  if (!buildIso) throw new Error(`Unable to resolve commit date for build SHA ${buildSha}.`);
  const timeParts = formatUtcParts(buildIso);
  const buildTitleUtc = `${timeParts.date} - ${formatUtcTimeForUi(timeParts.time)}`;

  const pkg = await getRepoFileJsonViaRaw(TARGET_REPO, buildSha, "package.json");
  const baseVersion = pkg?.version;
  if (!baseVersion) throw new Error("Unable to resolve VS Code version from package.json at build SHA.");
  const version = `${baseVersion}-insider`;

  const compare = await getCompare(TARGET_REPO, previousSha, buildSha);
  const commits = compare?.commits || [];
  const totalCommits = typeof compare?.total_commits === "number" ? compare.total_commits : commits.length;
  const compareUrl = compare?.html_url || `https://github.com/${TARGET_REPO}/compare/${previousSha}...${buildSha}`;

  const pullRequests = await collectMergedPullRequestsForRange({ repo: TARGET_REPO, commits });
  if (pullRequests.length > 100) {
    throw new Error(`Too many PRs for this build (${pullRequests.length}). Refusing to generate; handle manually.`);
  }

  const explainersByNumber = await generateAiExplainers({
    repo: TARGET_REPO,
    defaultBranch,
    fromSha: previousSha,
    toSha: buildSha,
    compareUrl,
    pullRequests,
  });

  const explainersMd = buildExplainersMarkdown({ pullRequests, explainersByNumber });

  const installers = await getInsidersInstallerLinksForBuild(buildSha);
  const installersMd = buildInstallersMarkdown(installers);

  const slug = `${timeParts.date}_${timeParts.time}_${version}_${shortSha(buildSha)}`;

  const md = buildPageMarkdown({
    repo: TARGET_REPO,
    defaultBranch,
    fromSha: previousSha,
    toSha: buildSha,
    compareUrl,
    totalCommits,
    commits,
    version,
    buildTitleUtc,
    installersMd,
    explainersMd,
  });

  const filename = `${slug}.md`;
  const pagePath = join(BUILDS_DIR, filename);
  const previewPath = args.outPath ? String(args.outPath) : join(OUT_DIR, "preview.md");

  if (preview) {
    await writeFile(previewPath, md, "utf8");
    console.log(`Wrote preview markdown: ${previewPath}`);
  } else {
    await writeFile(pagePath, md, "utf8");
  }

  // Emit workflow artifacts for creating a GitHub Release.
  // We keep AI notes as the main body and append official installer links (as links, not binaries).
  const releaseNotes = `${(explainersMd || "").trim()}\n\n${(installersMd || "").trim()}\n`.trim() + "\n";
  await writeFile(OUT_RELEASE_NOTES_PATH, releaseNotes, "utf8");

  // Also emit installer links as standalone artifacts that can be attached to the Release.
  await writeFile(OUT_INSTALLERS_JSON_PATH, JSON.stringify({ buildSha, installers }, null, 2) + "\n", "utf8");
  await writeFile(OUT_INSTALLERS_MD_PATH, (installersMd || "").trim() + "\n", "utf8");

  const tag = `insiders/${version}/${timeParts.date.replaceAll("-", "")}-${timeParts.time.replaceAll("-", "")}/${shortSha(buildSha)}`;
  const releaseTitle = `VS Code Insiders ${version} — ${timeParts.display}`;

  const meta = {
    tag,
    title: releaseTitle,
    buildSha,
    previousSha,
    version,
    slug,
    notesFile: OUT_RELEASE_NOTES_PATH,
    pageFile: preview ? null : `docs/builds/${filename}`,
  };
  await writeFile(OUT_BUILD_META_PATH, JSON.stringify(meta, null, 2) + "\n", "utf8");

  if (!preview) {
    // When force-rebuilding an older build, do NOT move the state backwards.
    let nextLastProcessedBuildSha = buildSha;
    if (state?.lastProcessedBuildSha) {
      const lastIdx = insidersCommits.indexOf(state.lastProcessedBuildSha);
      if (lastIdx !== -1 && lastIdx < buildIndex) {
        // lastIdx smaller => state SHA is newer than the one we're processing.
        nextLastProcessedBuildSha = state.lastProcessedBuildSha;
      }
    }

    const nextState = {
      repo: TARGET_REPO,
      defaultBranch,
      lastProcessedBuildSha: nextLastProcessedBuildSha,
      lastProcessedVersion: version,
      lastProcessedAt: new Date().toISOString(),
    };
    await writeFile(STATE_PATH, JSON.stringify(nextState, null, 2) + "\n", "utf8");

    await rebuildBuildIndexes(TARGET_REPO);
  }

  if (!preview) console.log(`Wrote build page: docs/builds/${filename}`);
  console.log(`PRs: ${pullRequests.length} | Compare: ${compareUrl}`);
  console.log(`Release tag: ${tag}`);
  if (totalCommits > commits.length) {
    console.warn(`Warning: compare commit list appears truncated (${commits.length}/${totalCommits}).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
