import type { EnvConfig } from "../core/config";
import type { RepoAdapter } from "../core/types";
import type { ProjectRecord } from "../server/types";
import { createGenericAdapter } from "./generic";

/**
 * A built-in (first-party) adapter: it carries fixed app knowledge and needs no
 * per-project config — only the run env and an optional baseUrl override. The
 * open-source core registers NONE of these; a private deployment registers its
 * own via {@link registerBuiltinAdapter} in builtins.ts, so adding a first-party
 * app is one registration plus one adapter file, never a core change.
 */
export type BuiltinAdapterFactory = (env: EnvConfig, overrides?: { baseUrl?: string }) => RepoAdapter;

const BUILTINS = new Map<string, BuiltinAdapterFactory>();

/** The reserved kind for the config-driven adapter; it is never a built-in. */
export const GENERIC_KIND = "generic";

export function registerBuiltinAdapter(kind: string, factory: BuiltinAdapterFactory): void {
    if (kind === GENERIC_KIND) {
        throw new Error(`"${GENERIC_KIND}" is reserved for the config-driven adapter.`);
    }
    BUILTINS.set(kind, factory);
}

export function builtinAdapterFactory(kind: string): BuiltinAdapterFactory | undefined {
    return BUILTINS.get(kind);
}

/** Adapter kinds the dashboard can offer: the config-driven generic one plus any registered built-ins. */
export function adapterKinds(): string[] {
    return [GENERIC_KIND, ...BUILTINS.keys()];
}

export function isAdapterKind(kind: string): boolean {
    return kind === GENERIC_KIND || BUILTINS.has(kind);
}

/**
 * Resolve the {@link RepoAdapter} for a registered project. "generic" is
 * config-driven (from the registration form); any other kind must be a
 * registered built-in. `overrides.baseUrl` is the resolved preview URL for a run.
 */
export function adapterForProject(
    project: ProjectRecord,
    env: EnvConfig,
    overrides?: { baseUrl?: string },
): RepoAdapter {
    if (project.adapterKind === GENERIC_KIND) {
        if (!project.adapter) {
            throw new Error(`Project ${project.id} is '${GENERIC_KIND}' but has no adapter config.`);
        }
        return createGenericAdapter(project.id, project.repo, project.adapter, overrides);
    }
    const factory = BUILTINS.get(project.adapterKind);
    if (!factory) {
        throw new Error(`Project ${project.id} uses unknown adapter '${project.adapterKind}'.`);
    }
    return factory(env, overrides);
}
