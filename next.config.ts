import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone) so Electron can run it as a
  // forked Node process without the full project/node_modules tree.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // Electron loads the app from http://127.0.0.1, which Next treats as a
  // cross-origin host in dev (default is localhost only). Without 127.0.0.1
  // here the HMR WebSocket upgrade is rejected and the client never hydrates.
  // Entries must be bare hostnames — full URLs never match.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
