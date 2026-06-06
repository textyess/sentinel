import type {
    CreateProjectInput,
    EnvPresence,
    Health,
    ProjectView,
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

    projects: () => request<ProjectView[]>("/api/projects"),
    createProject: (body: CreateProjectInput) =>
        request<ProjectView>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
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
    verifyProject: (id: string, pr: number) =>
        request<TriggerResult>(`/api/projects/${encodeURIComponent(id)}/verify/${pr}`, {
            method: "POST",
        }),

    runs: () => request<RunSummary[]>("/api/runs"),
    deleteRun: (runId: string) =>
        request<{ ok: true }>(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),

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
