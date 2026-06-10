import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CreateProjectInput } from "@/lib/types";

export const keys = {
    health: ["health"] as const,
    adapters: ["adapters"] as const,
    projects: ["projects"] as const,
    runs: ["runs"] as const,
    env: ["env"] as const,
    githubAuth: ["github-auth"] as const,
};

export function useHealth() {
    return useQuery({
        queryKey: keys.health,
        queryFn: api.health,
        refetchInterval: 15_000,
    });
}

export function useAdapters(enabled: boolean) {
    return useQuery({ queryKey: keys.adapters, queryFn: api.adapters, enabled, staleTime: Number.POSITIVE_INFINITY });
}

export function useProjects() {
    return useQuery({ queryKey: keys.projects, queryFn: api.projects });
}

export function useRuns() {
    return useQuery({
        queryKey: keys.runs,
        queryFn: api.runs,
        refetchInterval: 5_000,
    });
}

const TERMINAL_STATUS: ReadonlySet<string> = new Set(["passed", "failed", "uncertain", "blocked", "errored"]);

export function useRunManifest(runId: string) {
    return useQuery({
        queryKey: [...keys.runs, runId, "manifest"] as const,
        queryFn: () => api.runManifest(runId),
        enabled: runId.length > 0,
        // Keep polling while the run is still settling (or its report isn't on disk yet); stop once terminal.
        refetchInterval: (query) => (query.state.data && TERMINAL_STATUS.has(query.state.data.status) ? false : 5_000),
    });
}

export function useEnv(enabled: boolean) {
    return useQuery({ queryKey: keys.env, queryFn: api.env, enabled });
}

export function useGithubAuth(enabled: boolean) {
    return useQuery({
        queryKey: keys.githubAuth,
        queryFn: api.githubAuth,
        enabled,
        // While a device-flow login is awaiting approval on github.com, poll so the
        // panel flips to "connected" the moment the server stores the token.
        refetchInterval: (query) => (query.state.data?.flow.state === "pending" ? 2_500 : false),
    });
}

export function useStartGithubLogin() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: api.startGithubLogin,
        onSuccess: (data) => qc.setQueryData(keys.githubAuth, data),
    });
}

export function useDisconnectGithub() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: api.disconnectGithub,
        onSuccess: (data) => {
            qc.setQueryData(keys.githubAuth, data);
            qc.invalidateQueries({ queryKey: keys.health });
            qc.invalidateQueries({ queryKey: keys.env });
        },
    });
}

export function useCreateProject() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateProjectInput) => api.createProject(body),
        onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
    });
}

export function useUpdateBaseline() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ id, baselineUrl }: { id: string; baselineUrl: string | null }) =>
            api.updateProject(id, { baselineUrl }),
        onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
    });
}

export function useDeleteProject() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api.deleteProject(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
    });
}

export function useCrawlProject() {
    return useMutation({ mutationFn: (id: string) => api.crawlProject(id) });
}

export function useGenerateSkills() {
    return useMutation({ mutationFn: (id: string) => api.generateSkills(id) });
}

export function useVerifyProject() {
    return useMutation({
        mutationFn: ({ id, pr }: { id: string; pr: number }) => api.verifyProject(id, pr),
    });
}

export function useAutodetect() {
    return useMutation({
        mutationFn: (body: { repo: string; baselineUrl: string | null; previewEnvIncludes?: string }) =>
            api.autodetect(body),
    });
}

export function useDeleteRun() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (runId: string) => api.deleteRun(runId),
        onSuccess: () => qc.invalidateQueries({ queryKey: keys.runs }),
    });
}

export function useUpdateEnv() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (updates: Record<string, string>) => api.updateEnv(updates),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: keys.env });
            qc.invalidateQueries({ queryKey: keys.health });
            qc.invalidateQueries({ queryKey: keys.projects });
        },
    });
}
