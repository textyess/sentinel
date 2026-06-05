import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { loadEnvConfig, logger, PACKAGE_ROOT } from "../index";
import {
    createProject,
    deleteProject,
    deleteRun,
    getHealth,
    getProjects,
    getRun,
    getRuns,
    triggerCrawl,
    triggerVerify,
    updateProject,
} from "./api";
import { getEnvPresence, updateEnv } from "./env-api";
import { HttpError } from "./errors";
import { resolveRunArtifacts } from "./indexer";
import { subscribe } from "./sse";

function msg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) {
            throw new HttpError(413, "Request body too large.");
        }
        chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) {
        return {};
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "Invalid JSON body.");
    }
}

/** Reject any artifact path that escapes the output directory (read-any-file guard). */
function assertWithinOutputDir(target: string): string {
    const root = path.resolve(loadEnvConfig().outputDir);
    const resolved = path.resolve(target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new HttpError(403, "Forbidden path.");
    }
    return resolved;
}

type Range = { start: number; end: number };

function parseRange(header: string, size: number): Range | "unsatisfiable" | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match) {
        return null;
    }
    const startRaw = match[1];
    const endRaw = match[2];
    if (!startRaw && !endRaw) {
        return null; // "bytes=-" — malformed, fall back to a full response
    }
    const start = startRaw ? Number.parseInt(startRaw, 10) : 0;
    const end = endRaw ? Number.parseInt(endRaw, 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end)) {
        return null;
    }
    if (start > end || start >= size) {
        return "unsatisfiable";
    }
    return { start, end: Math.min(end, size - 1) };
}

async function serveFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    filePath: string,
    contentType: string,
): Promise<void> {
    const safe = assertWithinOutputDir(filePath);
    let stat: fs.Stats;
    try {
        stat = await fsp.stat(safe);
    } catch {
        sendJson(res, 404, { error: "not found" });
        return;
    }
    const rangeHeader = req.headers.range;
    const range = rangeHeader ? parseRange(rangeHeader, stat.size) : null;
    if (range === "unsatisfiable") {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
    }
    if (range) {
        res.writeHead(206, {
            "Content-Type": contentType,
            "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": range.end - range.start + 1,
        });
        fs.createReadStream(safe, { start: range.start, end: range.end }).pipe(res);
        return;
    }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(safe).pipe(res);
}

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    const entry = STATIC_FILES[pathname];
    if (!entry) {
        sendJson(res, 404, { error: "not found" });
        return;
    }
    try {
        const body = await fsp.readFile(path.join(PACKAGE_ROOT, "web", entry.file));
        res.writeHead(200, { "Content-Type": entry.type });
        res.end(body);
    } catch {
        sendJson(res, 404, { error: "not found" });
    }
}

async function serveVideo(req: http.IncomingMessage, res: http.ServerResponse, runId: string): Promise<void> {
    const artifacts = await resolveRunArtifacts(runId);
    if (!artifacts?.videoPath) {
        sendJson(res, 404, { error: "no recording for this run" });
        return;
    }
    await serveFile(req, res, artifacts.videoPath, "video/webm");
}

async function serveScreenshot(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    runId: string,
    name: string,
): Promise<void> {
    const artifacts = await resolveRunArtifacts(runId);
    if (!artifacts?.runDir) {
        sendJson(res, 404, { error: "unknown run" });
        return;
    }
    const base = path.basename(name);
    if (!base.endsWith(".png")) {
        sendJson(res, 404, { error: "not found" });
        return;
    }
    await serveFile(req, res, path.join(artifacts.runDir, "screenshots", base), "image/png");
}

async function handleApiJson(
    method: string,
    segs: string[],
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<void> {
    if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, await getHealth());
        return;
    }
    if (method === "GET" && pathname === "/api/projects") {
        sendJson(res, 200, await getProjects());
        return;
    }
    if (method === "POST" && pathname === "/api/projects") {
        sendJson(res, 201, await createProject(await readBody(req)));
        return;
    }
    if (method === "GET" && pathname === "/api/env") {
        sendJson(res, 200, await getEnvPresence());
        return;
    }
    if (method === "PUT" && pathname === "/api/env") {
        sendJson(res, 200, await updateEnv(await readBody(req)));
        return;
    }
    if (method === "PATCH" && segs[1] === "projects" && segs.length === 3) {
        sendJson(res, 200, await updateProject(decodeURIComponent(segs[2] ?? ""), await readBody(req)));
        return;
    }
    if (method === "POST" && segs[1] === "projects" && segs.length === 4 && segs[3] === "crawl") {
        sendJson(res, 202, await triggerCrawl(decodeURIComponent(segs[2] ?? ""), await readBody(req)));
        return;
    }
    if (method === "DELETE" && segs[1] === "projects" && segs.length === 3) {
        await deleteProject(decodeURIComponent(segs[2] ?? ""));
        sendJson(res, 200, { ok: true });
        return;
    }
    if (method === "GET" && pathname === "/api/runs") {
        sendJson(res, 200, await getRuns());
        return;
    }
    if (method === "GET" && segs[1] === "runs" && segs.length === 3) {
        const run = await getRun(decodeURIComponent(segs[2] ?? ""));
        if (run) {
            sendJson(res, 200, run);
        } else {
            sendJson(res, 404, { error: "not found" });
        }
        return;
    }
    if (method === "DELETE" && segs[1] === "runs" && segs.length === 3) {
        await deleteRun(decodeURIComponent(segs[2] ?? ""));
        sendJson(res, 200, { ok: true });
        return;
    }
    if (method === "POST" && segs[1] === "projects" && segs.length === 5 && segs[3] === "verify") {
        const result = await triggerVerify(decodeURIComponent(segs[2] ?? ""), Number.parseInt(segs[4] ?? "", 10));
        sendJson(res, 202, result);
        return;
    }
    sendJson(res, 404, { error: "not found" });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const method = req.method ?? "GET";
    const segs = url.pathname.split("/").filter(Boolean);
    try {
        if (method === "GET" && url.pathname === "/api/events") {
            const runId = url.searchParams.get("runId");
            if (!runId) {
                sendJson(res, 400, { error: "runId required" });
                return;
            }
            subscribe(runId, res); // owns the response from here
            return;
        }
        if (method === "GET" && segs[0] === "api" && segs[1] === "runs" && segs.length === 4 && segs[3] === "video") {
            await serveVideo(req, res, decodeURIComponent(segs[2] ?? ""));
            return;
        }
        if (
            method === "GET" &&
            segs[0] === "api" &&
            segs[1] === "runs" &&
            segs.length === 5 &&
            segs[3] === "screenshots"
        ) {
            await serveScreenshot(req, res, decodeURIComponent(segs[2] ?? ""), decodeURIComponent(segs[4] ?? ""));
            return;
        }
        if (segs[0] === "api") {
            await handleApiJson(method, segs, url.pathname, req, res);
            return;
        }
        if (method === "GET") {
            await serveStatic(res, url.pathname);
            return;
        }
        sendJson(res, 404, { error: "not found" });
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status >= 500) {
            logger.warn(`HTTP ${method} ${url.pathname}: ${msg(error)}`);
        }
        if (!res.headersSent) {
            sendJson(res, status, { error: msg(error) });
        }
    }
}

export function startHttpServer(port: number): http.Server {
    const server = http.createServer((req, res) => {
        void handle(req, res);
    });
    server.listen(port, "127.0.0.1");
    return server;
}
