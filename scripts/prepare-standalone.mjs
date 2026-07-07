// Prepares the Next.js standalone output for packaging by copying the assets
// that `output: "standalone"` does not include (static chunks and public/).
// Run after `next build`, before electron-builder.

import { cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = resolve(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error(
    "Missing .next/standalone — run `next build` with output: 'standalone' first.",
  );
  process.exit(1);
}

// Static assets served at /_next/static.
cpSync(
  resolve(root, ".next", "static"),
  resolve(standalone, ".next", "static"),
  { recursive: true },
);

// public/ assets, if present.
const publicDir = resolve(root, "public");
if (existsSync(publicDir)) {
  cpSync(publicDir, resolve(standalone, "public"), { recursive: true });
}

console.log("Standalone output prepared for packaging.");
