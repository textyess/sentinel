import { disconnectGithub, getGithubAuth, startGithubLogin } from "@/src/server/github-auth";
import { errorResponse } from "@/src/server/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    try {
        return Response.json(getGithubAuth());
    } catch (error) {
        return errorResponse(error);
    }
}

export async function POST(): Promise<Response> {
    try {
        return Response.json(await startGithubLogin());
    } catch (error) {
        return errorResponse(error);
    }
}

export async function DELETE(): Promise<Response> {
    try {
        return Response.json(disconnectGithub());
    } catch (error) {
        return errorResponse(error);
    }
}
