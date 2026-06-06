import type { NextConfig } from "next";

// The engine (src/core/config.ts) derives PACKAGE_ROOT from import.meta.url, which
// points into the bundle once Next compiles it. Pin it to the launch directory —
// always the repo root for `next dev` / `next start` and the CLI — so .env loading,
// the .sentinel output dir, and graph paths all resolve correctly.
process.env.SENTINEL_PACKAGE_ROOT ||= process.cwd();

const nextConfig: NextConfig = {
    // The engine (src/index.ts) re-exports the Playwright driver, so every route
    // handler + instrumentation transitively imports playwright-core, which carries a
    // native `fsevents.node` and optional native deps. These must NOT be bundled —
    // they run as plain Node `require()`s server-side. Missing the full set makes
    // `next dev` fail with "fsevents.node is not supported in the browser".
    serverExternalPackages: [
        "playwright",
        "playwright-core",
        "langfuse",
        "fsevents",
        "electron",
        "bufferutil",
        "utf-8-validate",
    ],
    // The repo lints with Biome, not ESLint.
    eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
