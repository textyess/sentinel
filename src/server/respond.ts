import { logger } from "../index";
import { HttpError } from "./errors";

const MAX_BODY_BYTES = 1_000_000;

/** Map any thrown error to a JSON Response, honoring HttpError's status. Logs unexpected 5xx. */
export function errorResponse(error: unknown): Response {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) {
        logger.warn(`API ${status}: ${message}`);
    }
    return Response.json({ error: message }, { status });
}

/** Parse a request body as JSON; empty → {}, malformed → 400, oversized → 413. */
export async function readJson(req: Request): Promise<unknown> {
    if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
        throw new HttpError(413, "Request body too large.");
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
        throw new HttpError(413, "Request body too large.");
    }
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, "Invalid JSON body.");
    }
}
