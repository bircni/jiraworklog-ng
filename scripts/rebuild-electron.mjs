// Installs the Electron-ABI prebuilt of better-sqlite3 into the standalone
// output so the native module matches Electron rather than the system Node used
// for `next build`. Runs against .next/standalone so the root node_modules stays
// system-ABI and `next build` / `next dev` keep working.
//
// Uses better-sqlite3's official prebuilt binaries via prebuild-install (no
// local C++ toolchain required).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = resolve(
  root,
  ".next",
  "standalone",
  "node_modules",
  "better-sqlite3",
);

if (!existsSync(moduleDir)) {
  console.error(
    "Missing better-sqlite3 in .next/standalone — run the build/prepare steps first.",
  );
  process.exit(1);
}

const electronPkg = JSON.parse(
  readFileSync(resolve(root, "node_modules", "electron", "package.json"), "utf8"),
);
const electronVersion = electronPkg.version;
const prebuildInstall = resolve(
  root,
  "node_modules",
  "prebuild-install",
  "bin.js",
);

console.log(
  `Installing better-sqlite3 prebuilt for Electron ${electronVersion} (${process.arch})…`,
);

const result = spawnSync(
  process.execPath,
  [
    prebuildInstall,
    "--runtime",
    "electron",
    "--target",
    electronVersion,
    "--arch",
    process.arch,
  ],
  { cwd: moduleDir, stdio: "inherit" },
);

if (result.status !== 0) {
  console.error("Failed to install the Electron prebuilt for better-sqlite3.");
  process.exit(result.status ?? 1);
}

console.log("better-sqlite3 Electron binary installed.");
