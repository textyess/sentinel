import type { AuthStrategy, RegExpSource } from "../types";

/** Per-field confidence the dashboard surfaces beside each proposed value. */
export type OnboardConfidence = "high" | "medium" | "low";

/** Where a proposed value came from, shown to the human reviewing the proposal. */
export interface FieldMeta {
    confidence: OnboardConfidence;
    /** Short human label, e.g. "login screen", "login form action", "repo: Next.js (App Router)". */
    source: string;
}

/**
 * A repo-agnostic proposal for a generic project's config, inferred by observing the
 * live app (and optionally a light repo scan). Field provenance lives in `fieldMeta`
 * keyed by the dotted field path (e.g. "auth.loginPath").
 *
 * `allowedMutationPatterns` is PROPOSED only — it is the read-only safety boundary and
 * must be confirmed by a human before it is ever applied. The detector never widens it
 * beyond the app's own login endpoint.
 */
export interface OnboardProposal {
    auth: AuthStrategy;
    /** False when the app serves content without a login — the engine then skips sign-in. */
    authRequired: boolean;
    previewEnvIncludes: string;
    pagesPrefix: string | null;
    knownRoutes: string[];
    allowedMutationPatterns: RegExpSource[];
    fieldMeta: Record<string, FieldMeta>;
    notes: string[];
}
