import type { NextConfig } from "next";

// Every page in Bizzy is per-user and permission-checked at request time, so
// the experimental prerendering features the template enables are switched off:
// nothing here may be cached or shared between users.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // CSV imports are posted through a server action (default limit: 1 MB).
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
