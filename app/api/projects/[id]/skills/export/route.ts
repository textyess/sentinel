import { exportSkillsArchive } from "@/src/server/api";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
    try {
        const { id } = await ctx.params;
        const { filename, body } = await exportSkillsArchive(id);
        return new Response(new Uint8Array(body), {
            status: 200,
            headers: {
                "Content-Type": "application/gzip",
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Content-Length": String(body.length),
            },
        });
    } catch (error) {
        return errorResponse(error);
    }
}
