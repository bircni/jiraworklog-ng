import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone) so Electron can run it as a
  // forked Node process without the full project/node_modules tree.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: ["http://localhost:3877", "http://127.0.0.1:3877"],
};

export default nextConfig;
