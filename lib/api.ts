import type {
    Adapters,
    CreateProjectInput,
    EnvPresence,
    GithubAuthView,
    Health,
    ProjectRecord,
    ProjectView,
    RunManifestView,
    RunSummary,
    TriggerResult,
} from "./types";

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
        const message =
            (data && typeof data === "object" && "error" in data && typeof data.error === "string"
                ? data.error
                : null) ?? `${res.status} ${res.statusText}`;
        throw new ApiError(message, res.status);
    }
    return data as T;
}

export const api = {
    health: () => request<Health>("/api/health"),

    adapters: () => request<Adapters>("/api/adapters"),

    projects: () => request<ProjectView[]>("/api/projects"),
    createProject: (body: CreateProjectInput) =>
        request<ProjectRecord>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
    updateProject: (id: string, body: { baselineUrl: string | null }) =>
        request<ProjectView>(`/api/projects/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify(body),
        }),
    deleteProject: (id: string) =>
        request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
    crawlProject: (id: string) =>
        request<TriggerResult>(`/api/projects/${encodeURIComponent(id)}/crawl`, {
            method: "POST",
            body: JSON.stringify({}),
        }),
    generateSkills: (id: string) =>
        request<TriggerResult>(`/api/projects/${encodeURIComponent(id)}/skills`, { method: "POST" }),
    verifyProject: (id: string, pr: number) =>
        request<TriggerResult>(`/api/projects/${encodeURIComponent(id)}/verify/${pr}`, {
            method: "POST",
        }),
    autodetect: (body: { repo: string; baselineUrl: string | null; previewEnvIncludes?: string }) =>
        request<TriggerResult>("/api/autodetect", { method: "POST", body: JSON.stringify(body) }),

    runs: () => request<RunSummary[]>("/api/runs"),
    runManifest: (runId: string) => request<RunManifestView>(`/api/runs/${encodeURIComponent(runId)}/manifest`),
    deleteRun: (runId: string) => request<{ ok: true }>(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),

    githubAuth: () => request<GithubAuthView>("/api/github/auth"),
    startGithubLogin: () => request<GithubAuthView>("/api/github/auth", { method: "POST" }),
    disconnectGithub: () => request<GithubAuthView>("/api/github/auth", { method: "DELETE" }),

    env: () => request<EnvPresence>("/api/env"),
    updateEnv: (updates: Record<string, string>) =>
        request<{ ok: true; applied: string[] }>("/api/env", {
            method: "PUT",
            body: JSON.stringify({ updates }),
        }),
};

/** SSE endpoint for a run's live progress. */
export function eventsUrl(runId: string): string {
    return `/api/events?runId=${encodeURIComponent(runId)}`;
}

/** Download URL for a project's portable skill pack (a `.tar.gz`). */
export function skillsExportUrl(projectId: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/skills/export`;
}
