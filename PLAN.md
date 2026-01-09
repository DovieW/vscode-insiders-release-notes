# Project plan: Insiders Changelog → GitHub Pages

Goal: generate a **per-build changelog page** for *actual VS Code Insiders builds* and publish it to GitHub Pages, with a **GitHub Release per build** so users can subscribe to email notifications.

## What we’re building

- **Data generator (Node script)**
  - Runs for a **specific Insiders build SHA** (the commit SHA used to produce the published Insiders build).
  - Resolve the previous Insiders build SHA from the Insiders commits feed.
  - Fetch the compare range and collect **merged PRs included in that build** (commit → associated PRs).
  - **Fail if PR count > 100** (manual handling).
  - Send PR info to OpenAI (`gpt-4.1-mini`) to generate a polished Markdown release note section.
  - Write a **build page** to `docs/builds/*.md` (AI notes + PR list + metadata).
  - Update indexes and update `data/insiders-state.json`.

- **Static docs site (VitePress)**
  - Served as pure static files (no backend).
  - Build pages are Markdown, so each build is a first-class page URL.
  - Theme, navigation, and sidebar come from VitePress.

- **GitHub Actions + GitHub Pages**
  - **Poll workflow** (every 30 minutes): checks for new Insiders builds and dispatches the build workflow.
    - Detection source of truth: `https://update.code.visualstudio.com/api/commits/insider`
    - Canonical “latest build” endpoint (Windows): `https://update.code.visualstudio.com/api/update/win32-x64-archive/insider/latest`
    - Backfill policy: run up to **3** builds if multiple are missed.
  - **Build workflow**: for one build SHA
    - Generate the page (AI required)
    - Commit to `master`
    - Create a **GitHub Release** (body is AI notes only)
    - Build + deploy Pages

## Why build-based (not run-based)

We explicitly key pages to **published Insiders builds** (build commit SHAs) rather than “whatever changed since last run”. This ensures the PR list and AI summary match what users actually received in their Insiders update.

## Files and conventions

- `data/insiders-state.json` — last processed Insiders build SHA
- `docs/builds/*.md` — one Markdown changelog page per build
- `docs/builds/index.md` — build list page
- `docs/.vitepress/config.mjs` — VitePress config (nav/sidebar/base)

## Notifications

- Each build also creates a GitHub Release (pre-release) so watchers can subscribe to “Releases” for emails.

## Follow-ups (optional)

- Improve build page titles (e.g. include VS Code Insiders version if we can reliably resolve it in CI).
- Add grouping heuristics (e.g. by area label prefix).
- Add caching/backoff if GitHub API rate limits are hit.
