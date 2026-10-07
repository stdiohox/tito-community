import type { NextConfig } from "next";

// Every page in this app is per-member and access can end at any second, so
// Cache Components (on by default in the scaffold) is turned off: nothing
// session-derived is cached anywhere, and each request re-reads access.
//
// The page Content-Security-Policy is NOT set here: it carries a per-request
// nonce, so src/proxy.ts sets it (see src/lib/csp.ts).

const nextConfig: NextConfig = {
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  experimental: {
    // Chart uploads go through a Server Action. The bucket caps files at 4 MB.
    serverActions: { bodySizeLimit: "5mb" },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Private community: nothing here should ever be indexed.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // Static, script-free fallback page, served without the proxy.
        source: "/offline.html",
        headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" }],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
