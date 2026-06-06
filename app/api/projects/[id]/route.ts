import { deleteProject, updateProject } from "@/src/server/api";
import { errorResponse, readJson } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
    try {
        const { id } = await ctx.params;
        return Response.json(await updateProject(id, await readJson(req)));
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
    try {
        const { id } = await ctx.params;
        await deleteProject(id);
        return Response.json({ ok: true });
    } catch (error) {
        return errorResponse(error);
    }
}
