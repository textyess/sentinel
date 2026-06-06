import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is served by Sentinel's own Node server in production (it reads
// `web/dist`). In dev we run Vite's HMR server and proxy the API — including the
// SSE stream — to that server (default port 4317, override with SENTINEL_UI_PORT).
const API_TARGET = `http://127.0.0.1:${process.env.SENTINEL_UI_PORT ?? "4317"}`;

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "./src"),
        },
    },
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: API_TARGET,
                changeOrigin: true,
                // Server-Sent Events must stream, not buffer.
                configure: (proxy) => {
                    proxy.on("proxyRes", (proxyRes) => {
                        if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
                            proxyRes.headers["cache-control"] = "no-cache, no-transform";
                        }
                    });
                },
            },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        // Sentinel runs on localhost only; sourcemaps keep the bundle debuggable.
        sourcemap: true,
    },
});
