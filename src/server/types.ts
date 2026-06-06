import type { GenericProjectConfig } from "../adapters/generic";
import type { Verdict } from "../core/verify/types";

/** Which adapter backs a registered project: "generic" (config-driven) or a registered built-in kind. */
export type AdapterKind = string;

/**
 * A registered project. Credentials are referenced by env-var NAME inside the
 * generic adapter config — never stored as raw secrets.
 */
export interface ProjectRecord {
    /** Filesystem-safe slug (also the adapter id / output subdir). */
    id: string;
    /** "owner/name". */
    repo: string;
    displayName: string;
    adapterKind: AdapterKind;
    /** Substring identifying the preview deployment environment (e.g. "web"). */
    previewEnvIncludes: string;
    /** The mention that triggers a run, e.g. "@sentinel". */
    mentionHandle: string;
    /** Generic adapter config; null for built-in adapters. */
    adapter: GenericProjectConfig | null;
    /** URL the baseline crawl maps (verify still targets the PR preview). Null → fall back to SENTINEL_BASE_URL. */
    baselineUrl?: string | null;
    createdAt: string;
}

export type MentionState = "pending" | "claimed" | "done" | "errored";

export interface HandledMention {
    commentId: number;
    pr: number;
    state: MentionState;
    runId: string | null;
    /** Bounded retries while the preview deployment is not yet ready. */
    retries: number;
    at: string;
}

/** Per-project dedupe ledger — the crash-safe record of which mentions were handled. */
export interface MentionLedger {
    repo: string;
    /** ISO timestamp; only advanced after a fully successful poll batch. */
    lastPolledAt: string | null;
    /** Keyed by String(GitHub comment id). */
    handled: Record<string, HandledMention>;
}

export type RunStatus = "queued" | "running" | "passed" | "failed" | "uncertain" | "blocked" | "errored";

/** Per-field provenance for an auto-detected config, surfaced beside each value in the UI. */
export interface AutodetectFieldMeta {
    confidence: "high" | "medium" | "low";
    source: string;
}

/**
 * The output of an "autodetect" onboarding run: a proposed generic-project config a
 * human reviews before registering. `adapter.emailEnv`/`passwordEnv` are env-var NAMES
 * (derived from the repo), never raw secrets. `allowedMutationPatterns` is the read-only
 * safety boundary and is proposed only — applied solely after explicit confirmation.
 */
export interface AutodetectProposal {
    repo: string;
    baselineUrl: string;
    previewEnvIncludes: string;
    /** False when the detector found the app needs no login. */
    authRequired: boolean;
    adapter: GenericProjectConfig;
    fieldMeta: Record<string, AutodetectFieldMeta>;
    notes: string[];
}

export interface RunRecord {
    runId: string;
    projectId: string;
    repo: string;
    pr: number;
    title: string;
    /** Absent is treated as "verify"; "crawl" and "autodetect" runs are excluded from the gallery. */
    kind?: "verify" | "crawl" | "autodetect";
    status: RunStatus;
    /** The comment id that triggered the run, or null for a manual trigger. */
    triggerCommentId: number | null;
    runDir: string | null;
    manifestPath: string | null;
    /** Absolute path on disk — NEVER sent to the browser (exposed as a URL instead). */
    videoPath: string | null;
    verdict: Verdict | null;
    /** Set only for "autodetect" runs — the proposed config the dashboard pre-fills. */
    proposedConfig?: AutodetectProposal | null;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
}

/** Gallery DTO — what the browser sees (absolute paths become URLs). */
export interface RunSummary {
    runId: string;
    projectId: string;
    repo: string;
    pr: number;
    title: string;
    outcome: Verdict["outcome"] | null;
    confidence: Verdict["confidence"] | null;
    summary: string;
    /** URL (/api/runs/:runId/video) or null when no recording exists. */
    videoUrl: string | null;
    createdAt: string;
    status: RunStatus;
}

export interface ServerConfig {
    port: number;
    pollMs: number;
    maxConcurrent: number;
    maxPreviewRetries: number;
    /**
     * Where run recordings are hosted so the PR comment can link them. "releases"
     * uploads each recording as a release asset (GitHub blob storage, never committed)
     * and links it; "off" keeps recordings local-only (dashboard link only).
     */
    videoPublish: "off" | "releases";
    /** Release tag used as the artifact bucket when videoPublish === "releases". */
    videoReleaseTag: string;
}
