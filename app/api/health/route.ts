import { getHealth } from "@/src/server/api";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    try {
        return Response.json(await getHealth());
    } catch (error) {
        return errorResponse(error);
    }
}
