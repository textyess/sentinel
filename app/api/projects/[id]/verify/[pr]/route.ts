import { triggerVerify } from "@/src/server/api";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; pr: string }> }): Promise<Response> {
    try {
        const { id, pr } = await ctx.params;
        return Response.json(await triggerVerify(id, Number.parseInt(pr, 10)), { status: 202 });
    } catch (error) {
        return errorResponse(error);
    }
}
