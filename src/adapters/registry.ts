import type { EnvConfig } from "../core/config";
import type { RepoAdapter } from "../core/types";
import type { ProjectRecord } from "../server/types";
import { createGenericAdapter } from "./generic";
import { createTextyessAdapter } from "./textyess";

/**
 * Resolve the {@link RepoAdapter} for a registered project. The CLI's
 * {@link getAdapter} stays TextYess-default and untouched; the server resolves
 * adapters here so it never bakes app knowledge into core.
 */
export function adapterForProject(
    project: ProjectRecord,
    env: EnvConfig,
    overrides?: { baseUrl?: string },
): RepoAdapter {
    if (project.adapterKind === "textyess") {
        return createTextyessAdapter(overrides?.baseUrl ? { ...env, baseUrl: overrides.baseUrl } : env);
    }
    if (!project.adapter) {
        throw new Error(`Project ${project.id} is 'generic' but has no adapter config.`);
    }
    return createGenericAdapter(project.id, project.repo, project.adapter, overrides);
}
