import { triggerCrawl } from "@/src/server/api";
import { errorResponse, readJson } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
    try {
        const { id } = await ctx.params;
        return Response.json(await triggerCrawl(id, await readJson(req)), { status: 202 });
    } catch (error) {
        return errorResponse(error);
    }
}
