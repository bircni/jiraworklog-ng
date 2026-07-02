import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: ["http://localhost:3877", "http://127.0.0.1:3877"],
};

export default nextConfig;
