import * as path from "node:path";
import { loadEnvConfig } from "@/src/index";
import { fileResponse } from "@/src/server/files";
import { resolveRunArtifacts } from "@/src/server/indexer";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ runId: string; name: string }> }): Promise<Response> {
    try {
        const { runId, name } = await ctx.params;
        const artifacts = await resolveRunArtifacts(runId);
        if (!artifacts?.runDir) {
            return Response.json({ error: "unknown run" }, { status: 404 });
        }
        const base = path.basename(name);
        if (!base.endsWith(".png")) {
            return Response.json({ error: "not found" }, { status: 404 });
        }
        return await fileResponse(
            path.join(artifacts.runDir, "screenshots", base),
            "image/png",
            req.headers.get("range"),
            loadEnvConfig().outputDir,
        );
    } catch (error) {
        return errorResponse(error);
    }
}
