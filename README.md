# Insiders Changes (GitHub Pages)

This project periodically captures “what changed since the last run” for a target GitHub repo (default: `microsoft/vscode`) and publishes a static, searchable UI to GitHub Pages.

## How it works

- `scripts/update-data.mjs`:
  - Reads `data/state.json` (last processed commit SHA)
  - Fetches the latest SHA on the default branch
  - Computes a compare range and resolves commits → PRs
  - Writes a snapshot to `data/runs/*.json` and updates `data/index.json`

- `scripts/build-site.mjs`:
  - Copies `src/site/` → `dist/`
  - Copies `data/` → `dist/data/`

The GitHub Actions workflow runs on a schedule, commits updated JSON back to the repo, then deploys `dist/` to GitHub Pages.

## Local usage

1. Create `.env` from `.env.example` (optional but recommended for higher rate limits)
2. Run:
   - `npm run update-data`
   - `npm run build`
   - `npm run preview`

### Troubleshooting (WSL / odd npm shell config)

If `npm run …` tries to execute via `cmd.exe` (UNC path error), run the scripts directly:

- `node scripts/update-data.mjs`
- `node scripts/build-site.mjs`
- `node scripts/preview.mjs`

## Configuration

- `TARGET_REPO` (default `microsoft/vscode`)
- `GITHUB_TOKEN` (recommended)

## Security note

Never commit a real token. Use GitHub Actions’ built-in `GITHUB_TOKEN` in CI, and a local `.env` for local runs.
