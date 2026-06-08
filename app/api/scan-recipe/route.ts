import { scanRepoRecipe } from "@/src/server/api";
import { errorResponse, readJson } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
    try {
        return Response.json(await scanRepoRecipe(await readJson(req)));
    } catch (error) {
        return errorResponse(error);
    }
}
