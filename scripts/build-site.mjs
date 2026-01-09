#!/usr/bin/env node

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const SRC_SITE = join(ROOT, "src", "site");
const DATA_DIR = join(ROOT, "data");
const DIST = join(ROOT, "dist");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  await cp(SRC_SITE, DIST, { recursive: true });

  // If there’s no data yet (fresh repo), still build the site.
  if (await exists(DATA_DIR)) {
    await cp(DATA_DIR, join(DIST, "data"), { recursive: true });
  }

  console.log("Built dist/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
