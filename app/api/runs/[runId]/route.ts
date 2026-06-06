import { deleteRun, getRun } from "@/src/server/api";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
    try {
        const { runId } = await ctx.params;
        const run = await getRun(runId);
        return run ? Response.json(run) : Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
    try {
        const { runId } = await ctx.params;
        await deleteRun(runId);
        return Response.json({ ok: true });
    } catch (error) {
        return errorResponse(error);
    }
}
