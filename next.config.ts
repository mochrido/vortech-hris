import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Attendance capture needs camera + geolocation for same-origin only;
  // microphone is unused.
  {
    key: "Permissions-Policy",
    value: "camera=(self), geolocation=(self), microphone=()",
  },
];

const nextConfig: NextConfig = {
  // Emit a self-contained standalone server bundle (`.next/standalone/server.js`)
  // so the production Docker image needs only Node, not full `node_modules`.
  output: "standalone",

  // Defense-in-depth HTTP security headers at the app layer (behind Caddy,
  // which sets its own). Applies to every route.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
