import { subscribe } from "@/src/server/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
    const runId = new URL(req.url).searchParams.get("runId");
    if (!runId) {
        return Response.json({ error: "runId required" }, { status: 400 });
    }

    const encoder = new TextEncoder();
    let cleanup: () => void = () => {};

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            // Flush headers + open the stream immediately so EventSource connects
            // even before the first progress line arrives.
            controller.enqueue(encoder.encode(": connected\n\n"));
            cleanup = subscribe(runId, (chunk) => {
                controller.enqueue(encoder.encode(chunk));
            });
            req.signal.addEventListener("abort", () => {
                cleanup();
                try {
                    controller.close();
                } catch {
                    // already closed
                }
            });
        },
        cancel() {
            cleanup();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        },
    });
}
