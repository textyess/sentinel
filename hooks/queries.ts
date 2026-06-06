import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CreateProjectInput } from "@/lib/types";

export const keys = {
    health: ["health"] as const,
    adapters: ["adapters"] as const,
    projects: ["projects"] as const,
    runs: ["runs"] as const,
    env: ["env"] as const,
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

export function useEnv(enabled: boolean) {
    return useQuery({ queryKey: keys.env, queryFn: api.env, enabled });
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

export function useVerifyProject() {
    return useMutation({
        mutationFn: ({ id, pr }: { id: string; pr: number }) => api.verifyProject(id, pr),
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
