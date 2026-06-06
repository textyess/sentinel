import { loadEnvConfig } from "@/src/index";
import { fileResponse } from "@/src/server/files";
import { resolveRunArtifacts } from "@/src/server/indexer";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }): Promise<Response> {
    try {
        const { runId } = await ctx.params;
        const artifacts = await resolveRunArtifacts(runId);
        if (!artifacts?.videoPath) {
            return Response.json({ error: "no recording for this run" }, { status: 404 });
        }
        return await fileResponse(
            artifacts.videoPath,
            "video/webm",
            req.headers.get("range"),
            loadEnvConfig().outputDir,
        );
    } catch (error) {
        return errorResponse(error);
    }
}
