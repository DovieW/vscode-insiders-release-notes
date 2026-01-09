# Project plan: Insiders Changes → GitHub Pages

Goal: a GitHub Actions workflow that periodically captures what changed since the last run (treating each run like an “Insiders release”), then deploys a clean web UI to GitHub Pages for browsing/searching those changes.

## What we’re building

- **Data generator (Node scripts)**
  - Determine the target repo (default: `microsoft/vscode`).
  - Read the last processed commit SHA from `data/state.json`.
  - Fetch the latest commit SHA on the repo’s default branch.
  - If it changed, fetch the compare range and map commits → PRs.
  - Write a run file to `data/runs/*.json` and update `data/index.json`.
  - Update `data/state.json` to the latest SHA.

- **Static site**
  - Served as pure static files (no backend).
  - Reads `data/index.json` + selected `data/runs/*.json`.
  - Lets you pick a run (commit range), search PR titles, and click through to GitHub.

- **GitHub Actions + GitHub Pages**
  - Scheduled (daily) and manually runnable.
  - Step 1: run the data update script and **commit/push** any changed JSON back to the default branch.
  - Step 2: build `dist/` from `src/site/` + `data/` and deploy to Pages.

## Why “per Insiders release” (run-based) vs day-based

Instead of “yesterday’s PRs”, each run captures **the diff since the last published run** (commit range). This matches how Insiders feels in practice: “what changed since the last update”.

## Files and conventions

- `data/state.json` — last processed commit SHA
- `data/runs/*.json` — immutable snapshots per run
- `data/index.json` — list of available runs for the UI
- `src/site/*` — static UI assets
- `dist/*` — build output (deployed)

## Follow-ups (optional)

- Add label-based filtering (store PR labels in run JSON).
- Add grouping heuristics (e.g. by area label prefix).
- Add a “diff view” between two runs.
- Add caching/backoff if GitHub API rate limits are hit.
