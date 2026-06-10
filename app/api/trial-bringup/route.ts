import { triggerTrialBringUp } from "@/src/server/api";
import { errorResponse, readJson } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
    try {
        return Response.json(await triggerTrialBringUp(await readJson(req)), { status: 202 });
    } catch (error) {
        return errorResponse(error);
    }
}
