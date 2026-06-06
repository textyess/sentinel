import type { NextConfig } from "next";

// The engine (src/core/config.ts) derives PACKAGE_ROOT from import.meta.url, which
// points into the bundle once Next compiles it. Pin it to the launch directory —
// always the repo root for `next dev` / `next start` and the CLI — so .env loading,
// the .sentinel output dir, and graph paths all resolve correctly.
process.env.SENTINEL_PACKAGE_ROOT ||= process.cwd();

const nextConfig: NextConfig = {
    // Heavy / native / dynamic-require backend deps must stay out of the bundle and
    // run as plain Node modules inside the route handlers and the poller.
    serverExternalPackages: ["playwright", "langfuse"],
    // The repo lints with Biome, not ESLint.
    eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
