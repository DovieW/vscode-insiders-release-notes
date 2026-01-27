# Refactor / Re-engineering TODO

These are larger cleanups that feel worthwhile, but were out of scope for the current change.

## Release generation
- **Move “release body” composition out of the GitHub Actions workflow and into `scripts/update-data.mjs`.**
  - Today, the workflow assembles `.out/release-body.md` from `.out/build.json` + `.out/release-notes.md`.
  - Having the generator produce the *final* release body would:
    - keep the workflow slimmer
    - make the release formatting testable locally
    - reduce shell quoting/formatting edge cases

## Navbar UI customizations
- **Consider overriding the VitePress navbar component instead of relying on CSS selectors.**
  - The current approach works, but CSS selectors may become brittle if VitePress changes classnames/structure.
  - A small custom theme component could explicitly omit the “extra” (three-dot) flyout.

## Validation
- **Add a lightweight check (script or test) that validates the release header format.**
  - Example: ensure the build page URL, commit URL, previous URL, and compare URL are present in the generated release body.

## Installer links
- **Document (or encode) the VS Code update service semantics more explicitly.**
  - `/api/update/<platform>/insider/<currentVersion>` can return **204 No Content** when `currentVersion` is already the latest.
  - This repo only needs “download the current Insiders build”, so we now use `/latest` endpoints for installer links.
  - If we ever want “download the exact build for this changelog page”, we’ll need a different source of truth (the update service doesn’t appear to support historical lookup by commit SHA via that endpoint).
