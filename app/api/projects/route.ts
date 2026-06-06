import { createProject, getProjects } from "@/src/server/api";
import { errorResponse, readJson } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    try {
        return Response.json(await getProjects());
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(req: Request): Promise<Response> {
    try {
        return Response.json(await createProject(await readJson(req)), { status: 201 });
    } catch (error) {
        return errorResponse(error);
    }
}
