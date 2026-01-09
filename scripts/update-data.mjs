#!/usr/bin/env node

import "dotenv/config";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const RUNS_DIR = join(DATA_DIR, "runs");
const STATE_PATH = join(DATA_DIR, "state.json");
const INDEX_PATH = join(DATA_DIR, "index.json");

const TARGET_REPO = process.env.TARGET_REPO || "microsoft/vscode";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function shortSha(sha) {
  return (sha || "").slice(0, 7);
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

async function getPullsForCommit(repo, sha) {
  // This endpoint historically required a preview header.
  return githubJson(`https://api.github.com/repos/${repo}/commits/${sha}/pulls`, {
    Accept: "application/vnd.github.groot-preview+json",
  });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function rebuildIndex(repo) {
  const files = await readdir(RUNS_DIR);
  const runFiles = files.filter((f) => f.endsWith(".json"));

  const runs = [];
  for (const f of runFiles) {
    const full = join(RUNS_DIR, f);
    const data = await readJsonIfExists(full);
    if (!data?.id) continue;

    runs.push({
      id: data.id,
      title: data.title,
      generatedAt: data.generatedAt,
      prCount: data.prCount,
      from: data.from,
      to: data.to,
      compareUrl: data.compareUrl,
      path: `runs/${f}`,
    });
  }

  runs.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));

  const index = {
    repo,
    updatedAt: new Date().toISOString(),
    runs,
  };

  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n", "utf8");
}

async function main() {
  await mkdir(RUNS_DIR, { recursive: true });

  const state = await readJsonIfExists(STATE_PATH);

  const repoInfo = await getRepoInfo(TARGET_REPO);
  const defaultBranch = repoInfo?.default_branch || "main";

  const latestSha = await getBranchHeadSha(TARGET_REPO, defaultBranch);
  if (!latestSha) throw new Error("Failed to resolve latest branch head SHA.");

  if (!state?.lastSha) {
    const initState = {
      repo: TARGET_REPO,
      defaultBranch,
      lastSha: latestSha,
      initializedAt: new Date().toISOString(),
      note: "Initialized without generating a run (no prior baseline).",
    };

    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(initState, null, 2) + "\n", "utf8");
    await rebuildIndex(TARGET_REPO);
    console.log(`Initialized state at ${shortSha(latestSha)} (${TARGET_REPO}@${defaultBranch}).`);
    return;
  }

  const fromSha = state.lastSha;
  const toSha = latestSha;

  if (fromSha === toSha) {
    await rebuildIndex(TARGET_REPO);
    console.log(`No change since last run (still at ${shortSha(toSha)}).`);
    return;
  }

  const compare = await getCompare(TARGET_REPO, fromSha, toSha);
  const commits = compare?.commits || [];
  const totalCommits = typeof compare?.total_commits === "number" ? compare.total_commits : commits.length;
  const compareUrl = compare?.html_url || `https://github.com/${TARGET_REPO}/compare/${fromSha}...${toSha}`;

  const prMap = new Map();

  for (const c of commits) {
    const sha = c?.sha;
    if (!sha) continue;

    const pulls = await getPullsForCommit(TARGET_REPO, sha);
    for (const pr of pulls || []) {
      if (!pr?.number) continue;
      if (prMap.has(pr.number)) continue;

      prMap.set(pr.number, {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        author: pr.user?.login || null,
        mergedAt: pr.merged_at || null,
        labels: Array.isArray(pr.labels) ? pr.labels.map((l) => l?.name).filter(Boolean) : [],
      });
    }
  }

  const prs = Array.from(prMap.values()).sort((a, b) => b.number - a.number);
  const prCount = prs.length;

  const generatedAt = new Date().toISOString();
  const id = `${todayUtc()}_${shortSha(fromSha)}-${shortSha(toSha)}`;
  const title = `${todayUtc()} — ${shortSha(fromSha)}…${shortSha(toSha)} (${prCount} PRs)`;

  const run = {
    id,
    title,
    repo: TARGET_REPO,
    defaultBranch,
    from: fromSha,
    to: toSha,
    compareUrl,
    generatedAt,
    commitsReturned: commits.length,
    totalCommits,
    wasTruncated: totalCommits > commits.length,
    prCount,
    prs,
  };

  const filename = `${todayUtc()}_${shortSha(fromSha)}-${shortSha(toSha)}.json`;
  const runPath = join(RUNS_DIR, filename);
  await writeFile(runPath, JSON.stringify(run, null, 2) + "\n", "utf8");

  const nextState = {
    repo: TARGET_REPO,
    defaultBranch,
    lastSha: toSha,
    updatedAt: generatedAt,
  };
  await writeFile(STATE_PATH, JSON.stringify(nextState, null, 2) + "\n", "utf8");

  await rebuildIndex(TARGET_REPO);

  console.log(`Wrote run: ${filename}`);
  console.log(`PRs: ${prCount} | Compare: ${compareUrl}`);
  if (run.wasTruncated) {
    console.warn(`Warning: compare commit list appears truncated (${commits.length}/${totalCommits}).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
