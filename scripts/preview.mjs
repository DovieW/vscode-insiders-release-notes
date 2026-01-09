#!/usr/bin/env node

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const rel = decoded.replace(/^\/+/, "");
  return rel.includes("..") ? null : rel;
}

const server = http.createServer(async (req, res) => {
  try {
    const rel = safePath(req.url || "/");
    if (!rel) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    const requested = rel === "" ? "index.html" : rel;
    let filePath = join(ROOT, requested);

    // SPA-ish fallback: serve index.html for unknown top-level routes
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) filePath = join(filePath, "index.html");
    } catch {
      if (!requested.includes(".") && !requested.startsWith("data/")) {
        filePath = join(ROOT, "index.html");
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }

    const buf = await readFile(filePath);
    const type = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

server.listen(PORT, () => {
  console.log(`Preview server running on http://localhost:${PORT}`);
});
