import { triggerSkills } from "@/src/server/api";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
    try {
        const { id } = await ctx.params;
        return Response.json(await triggerSkills(id), { status: 202 });
    } catch (error) {
        return errorResponse(error);
    }
}
