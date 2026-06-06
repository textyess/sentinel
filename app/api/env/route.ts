import { getEnvPresence, updateEnv } from "@/src/server/env-api";
import { errorResponse, readJson } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    try {
        return Response.json(await getEnvPresence());
    } catch (error) {
        return errorResponse(error);
    }
}

export async function PUT(req: Request): Promise<Response> {
    try {
        return Response.json(await updateEnv(await readJson(req)));
    } catch (error) {
        return errorResponse(error);
    }
}
