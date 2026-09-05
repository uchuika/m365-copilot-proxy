#!/usr/bin/env node
// Thin launcher for the built Nitro server.
// Usage: m365-proxy [port]   (default 4141, or $PORT)
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const port = process.argv[2] || process.env.PORT || "4141";
process.env.PORT = String(port);
process.env.NITRO_PORT = String(port);

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../.output/server/index.mjs");

// import() takes a URL, not a bare path. On Windows `resolve()` yields
// `C:\...`, which the ESM loader rejects as an unsupported `c:` scheme
// (ERR_UNSUPPORTED_ESM_URL_SCHEME) — so the launcher never reached the server.
await import(pathToFileURL(entry).href);
