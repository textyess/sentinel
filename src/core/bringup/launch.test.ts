import assert from "node:assert/strict";
import * as net from "node:net";
import { test } from "node:test";
import { launchLocalApp } from "./launch";

/** A trivial HTTP server that echoes back whether two env vars reached the child. */
const ECHO_ENV_SERVER =
    "node -e \"const http=require('http');http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({probe:process.env.PROBE||null,secret:process.env.SENTINEL_FAKE_SECRET||null}))}).listen(process.env.PORT,'127.0.0.1')\"";

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

test("brings up an app, forwards declared env, scrubs Sentinel secrets, and tears down", async () => {
    const port = await freePort();
    // A secret in Sentinel's own env must NOT leak into the spawned PR app.
    process.env.SENTINEL_FAKE_SECRET = "must-not-leak";
    const app = await launchLocalApp(
        { runCmd: ECHO_ENV_SERVER, port, env: { PROBE: "declared-ok" }, readyTimeoutMs: 15_000 },
        { cwd: process.cwd() },
    );
    try {
        const body = (await (await fetch(app.baseUrl)).json()) as { probe: string | null; secret: string | null };
        assert.equal(body.probe, "declared-ok", "recipe-declared env should reach the app");
        assert.equal(body.secret, null, "Sentinel's own secret must be scrubbed from the child env");
        assert.equal(typeof app.logs(), "string");
    } finally {
        await app.stop();
        delete process.env.SENTINEL_FAKE_SECRET;
    }
    // After teardown the port is free again — nothing is listening.
    await assert.rejects(fetch(app.baseUrl), "app should be unreachable after stop()");
});

test("fails fast with captured logs when the app crashes before binding", async () => {
    const port = await freePort();
    await assert.rejects(
        launchLocalApp(
            { runCmd: "node -e \"console.error('boom'); process.exit(1)\"", port, readyTimeoutMs: 8_000 },
            { cwd: process.cwd() },
        ),
        /bring-up failed/i,
    );
});
