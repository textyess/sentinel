import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { HttpError } from "./errors";

/** Reject any path that escapes `root` (read-any-file guard). */
export function assertWithin(root: string, target: string): string {
    const base = path.resolve(root);
    const resolved = path.resolve(target);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
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
        return null;
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

function webStream(stream: fs.ReadStream): ReadableStream<Uint8Array> {
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

/**
 * Stream a file as a Response, honoring a Range header. The resolved path is guarded
 * to stay within `root` (the run output dir) so an id can never read an arbitrary file.
 */
export async function fileResponse(
    filePath: string,
    contentType: string,
    rangeHeader: string | null,
    root: string,
): Promise<Response> {
    const safe = assertWithin(root, filePath);
    let stat: fs.Stats;
    try {
        stat = await fsp.stat(safe);
    } catch {
        return Response.json({ error: "not found" }, { status: 404 });
    }

    const range = rangeHeader ? parseRange(rangeHeader, stat.size) : null;
    if (range === "unsatisfiable") {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    if (range) {
        return new Response(webStream(fs.createReadStream(safe, { start: range.start, end: range.end })), {
            status: 206,
            headers: {
                "Content-Type": contentType,
                "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
                "Accept-Ranges": "bytes",
                "Content-Length": String(range.end - range.start + 1),
            },
        });
    }
    return new Response(webStream(fs.createReadStream(safe)), {
        status: 200,
        headers: {
            "Content-Type": contentType,
            "Content-Length": String(stat.size),
            "Accept-Ranges": "bytes",
        },
    });
}
