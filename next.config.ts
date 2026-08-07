import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained standalone server bundle (`.next/standalone/server.js`)
  // so the production Docker image needs only Node, not full `node_modules`.
  output: "standalone",
};

export default nextConfig;
