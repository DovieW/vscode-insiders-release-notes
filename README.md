# Insiders Changelog (GitHub Pages)

This project generates a **per-build changelog page** for *actual VS Code Insiders builds* (not just “latest commits”) and publishes them as a **VitePress** site to GitHub Pages.

Each build page contains:

- **AI-written release notes** (OpenAI `gpt-4.1-mini`)
- The list of **merged PRs included in that build**

Additionally, each build creates a **GitHub Release** so users can subscribe to email notifications by watching releases.

## How it works

- `scripts/update-data.mjs`
  - Runs **for a specific Insiders build SHA** (from VS Code’s update service)
  - Computes the range **previous build SHA → build SHA**
  - Collects the merged PRs included in that range (commit → associated PRs)
  - **Fails if PRs > 100** (manual handling)
  - Calls OpenAI (`gpt-4.1-mini`) to generate the release notes (required)
  - Writes a build page to `docs/builds/*.md` and updates indexes
  - Writes `.out/build.json` + `.out/release-notes.md` for the workflow to publish a GitHub Release

- VitePress (`docs/`)
  - Builds the static site from Markdown pages
  - Deployed via GitHub Actions to GitHub Pages

- GitHub Actions
  - **Poll workflow** (every 30 minutes): detects new Insiders builds and dispatches build jobs (max 3 backfills)
  - **Build workflow**: generates the page + GitHub Release + deploys Pages

## Force a rebuild of a specific build

Sometimes you may want to regenerate a page for an existing build SHA (e.g. after changing formatting, sidebar labels, or layout).

Recommended: dispatch the build workflow with `force=true`:

- Workflow: **Generate changelog for an Insiders build**
- Input: `buildSha` = the commit SHA from the Insiders feed
- Input: `force` = `true`

This regenerates the Markdown and rebuilds/deploys Pages. It also avoids moving `data/insiders-state.json` backwards when rebuilding an older build.

Deleting a build page file alone usually isn't enough, because the generator uses `data/insiders-state.json` to decide what is already processed.

## Local usage

1. Create `.env` from `.env.example`
  - `OPENAI_API_KEY` is required (release notes are required)
  - `GITHUB_TOKEN` is recommended (avoids GitHub API rate limits)
2. Pick an Insiders build SHA from: `https://update.code.visualstudio.com/api/commits/insider`
3. Run:
  - `npm run update-data -- --build-sha <sha>`
  - `npm run docs:build`
  - `npm run docs:preview`

### WSL note (UNC path issue)

If `npm run docs:build` tries to start **CMD.EXE** and fails with something like:

- `UNC paths are not supported`
- `'vitepress' is not recognized...`

…you’re likely running the **Windows** `npm` inside WSL (e.g. `which npm` shows `/mnt/c/Program Files/nodejs/npm`).

Fix: use a Linux Node/npm install inside WSL (e.g. `nvm`, `apt`, or Linuxbrew) so `which npm` points to a Linux path.

## Configuration

- `TARGET_REPO` (default `microsoft/vscode`)
- `GITHUB_TOKEN` (recommended)
- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (default `gpt-4.1-mini`)

## Email notifications

Each generated build page also creates a **GitHub Release**.

Users can get emails by:

1. Clicking **Watch** on the repo
2. Choosing **Custom**
3. Enabling **Releases**

## Security note

Never commit a real token. Use GitHub Actions’ built-in `GITHUB_TOKEN` in CI, and a local `.env` for local runs.
