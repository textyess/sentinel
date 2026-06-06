import { getRunManifest } from "@/src/server/api";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
    try {
        const { runId } = await ctx.params;
        const manifest = await getRunManifest(runId);
        return manifest
            ? Response.json(manifest)
            : Response.json({ error: "no report for this run yet" }, { status: 404 });
    } catch (error) {
        return errorResponse(error);
    }
}
