import { getRuns } from "@/src/server/api";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    try {
        return Response.json(await getRuns());
    } catch (error) {
        return errorResponse(error);
    }
}
