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

const INSIDERS_COMMITS_FEED = "https://update.code.visualstudio.com/api/commits/insider";

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

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function mdEscapeInline(text) {
  // Keep it simple: avoid accidentally breaking markdown links/lists.
  return String(text || "").replaceAll("\r", "").trim();
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
  // Keep it deterministic and “release-notes shaped”. Output should be markdown only.
  const prPayload = (pullRequests || []).map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr?.user?.login || null,
    merged_at: pr.merged_at || null,
    labels: Array.isArray(pr.labels) ? pr.labels.map((l) => l?.name).filter(Boolean) : [],
    body: pr.body ? String(pr.body).slice(0, 4000) : "",
  }));

  const input = {
    repo,
    defaultBranch,
    range: { fromSha, toSha, compareUrl },
    pullRequests: prPayload,
  };

  return {
    instructions:
      "You write concise, high-signal release notes for developers. " +
      "Given a list of merged PRs for a single build, produce clean Markdown suitable for a VitePress page. " +
      "Rules: (1) No preamble, just markdown content. (2) Do NOT use H1 headings (#); the page already has a title. Start sections at H2 (##) or below. " +
      "(3) Prefer short sections with bullet points. " +
      "(4) Every bullet MUST begin with exactly ONE of these bold labels (and only these): **new:**, **upgrade:**, **refactor:**, **remove:**, **fix:**. " +
      "Do not invent other labels. Use lowercase and include the colon exactly as shown. " +
      "Use **upgrade:** specifically for dependency upgrades / version bumps. " +
      "(5) Each bullet should include a PR link like [#12345](url). " +
      "(6) Group by theme/area when obvious from titles/labels; otherwise use a simple 'Highlights' + 'Other changes' structure. " +
      "Within EACH section, group bullets by label and order groups like this: new → upgrade → refactor → remove → fix (fixes always last). " +
      "Important: Do NOT create mini sections/subheadings for labels (e.g. '### New' / '### Fixes'). " +
      "Labels must appear as prefixes on bullet lines only (e.g. '- **new:** ...'). " +
      "(7) Call out breaking changes if clearly indicated, otherwise omit a breaking section.",
    input: JSON.stringify(input),
  };
}

function normalizeAiReleaseNotes(text) {
  // The prompt asks the model to *not* create label subheadings like "### New",
  // but models can still do it. This normalizer converts that pattern into
  // labeled bullets so the output stays consistent.
  const allowed = new Set(["new", "upgrade", "refactor", "remove", "fix"]);
  const labelHeading = /^(#{2,6})\s*\*\*?\s*(new|upgrade|refactor|remove|fix)(?:es)?\s*\*\*?\s*:??\s*$/i;
  const labeledBullet = /^\s*-\s+\*\*(new|upgrade|refactor|remove|fix):\*\*/i;
  const bullet = /^\s*-\s+/;

  let currentLabel = null;
  const out = [];

  for (const line of String(text || "").replaceAll("\r", "").split("\n")) {
    const m = labelHeading.exec(line.trim());
    if (m) {
      const l = String(m[2] || "").toLowerCase();
      currentLabel = allowed.has(l) ? l : null;
      // Drop the label heading line entirely.
      continue;
    }

    if (labeledBullet.test(line)) {
      // Reset label context once we see explicitly labeled bullets.
      currentLabel = null;
      out.push(line);
      continue;
    }

    if (currentLabel && bullet.test(line) && !labeledBullet.test(line)) {
      // Prefix unlabeled bullets under a label heading.
      out.push(line.replace(bullet, `- **${currentLabel}:** `));
      continue;
    }

    out.push(line);
  }

  return out.join("\n").trim();
}

async function generateAiReleaseNotes({ repo, defaultBranch, fromSha, toSha, compareUrl, pullRequests }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to generate release notes.");
  }
  if (!pullRequests?.length) {
    throw new Error("No PRs found for this build range; refusing to generate empty release notes.");
  }

  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const { instructions, input } = buildAiPrompt({ repo, defaultBranch, fromSha, toSha, compareUrl, pullRequests });

  const response = await client.responses.create({
    model: OPENAI_MODEL,
    instructions,
    input,
  });

  const text = normalizeAiReleaseNotes((response?.output_text || "").trim());
  if (!text) throw new Error("OpenAI returned empty release notes.");
  return text;
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
  for (const n of prNumbers) {
    try {
      const pr = await getPullRequest(repo, n);
      if (pr?.merged_at) prs.push(pr);
    } catch (err) {
      console.warn(`Failed to fetch PR #${n}: ${err?.message || err}`);
    }
  }

  prs.sort((a, b) => String(b.merged_at || "").localeCompare(String(a.merged_at || "")));
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
  aiReleaseNotes,
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

${aiReleaseNotes.trim()}
`;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(BUILDS_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const args = parseArgs(process.argv);
  const requestedBuildSha = args.buildSha;
  if (!requestedBuildSha) throw new Error("Missing required --build-sha <sha> argument.");
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
  if (!force && state?.lastProcessedBuildSha) {
    const lastIdx = insidersCommits.indexOf(state.lastProcessedBuildSha);
    if (lastIdx !== -1 && lastIdx <= buildIndex) {
      await rebuildBuildIndexes(TARGET_REPO);
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

  const aiReleaseNotes = await generateAiReleaseNotes({
    repo: TARGET_REPO,
    defaultBranch,
    fromSha: previousSha,
    toSha: buildSha,
    compareUrl,
    pullRequests,
  });

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
    aiReleaseNotes,
  });

  const filename = `${slug}.md`;
  const outPath = join(BUILDS_DIR, filename);
  await writeFile(outPath, md, "utf8");

  // Emit workflow artifacts for creating a GitHub Release (body should be AI notes only).
  await writeFile(OUT_RELEASE_NOTES_PATH, aiReleaseNotes.trim() + "\n", "utf8");

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
    pageFile: `docs/builds/${filename}`,
  };
  await writeFile(OUT_BUILD_META_PATH, JSON.stringify(meta, null, 2) + "\n", "utf8");

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

  console.log(`Wrote build page: docs/builds/${filename}`);
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
