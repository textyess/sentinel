import { HttpError } from "./errors";

/** Map any thrown error to a JSON Response, honoring HttpError's status. */
export function errorResponse(error: unknown): Response {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status });
}

/** Parse a request body as JSON; empty body → {}, malformed → HttpError(400). */
export async function readJson(req: Request): Promise<unknown> {
    const text = await req.text();
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, "Invalid JSON body.");
    }
}
