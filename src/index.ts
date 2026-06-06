/**
 * Public surface of the Sentinel package. Phase 1 (the autonomous crawler) and
 * later phases import the engine from here rather than reaching into core/ paths.
 */
export { adapterForProject, adapterKinds, getAdapter, isAdapterKind, registerBuiltinAdapter } from "./adapters";
export type { GenericAuthConfig, GenericProjectConfig } from "./adapters/generic";
export { createGenericAdapter, GENERIC_SAFETY_DEFAULTS } from "./adapters/generic";
export type { BuiltinAdapterFactory } from "./adapters/registry";
export type { LoginResult } from "./core/auth/login";
export { performLogin } from "./core/auth/login";
export { ensureAppReachable } from "./core/bringup/app";
export type { DriverOptions, DriverSession } from "./core/browser/driver";
export { createSession } from "./core/browser/driver";
export { clickBySelectors, fillBySelectors } from "./core/browser/interact";
export type { EnvConfig } from "./core/config";
export { loadEnvConfig, PACKAGE_ROOT, REPO_ROOT } from "./core/config";
export { applyEnvVar, EnvFileWriteError, encodeEnvValue, writeEnvFileVar } from "./core/config/env-file";
export type { ActuateOptions, DiscoveredLink } from "./core/crawler/actuate";
export { actuateForDiscovery } from "./core/crawler/actuate";
export type { CrawlOptions } from "./core/crawler/crawler";
export { crawl } from "./core/crawler/crawler";
export type { RunCrawlArgs, RunCrawlResult } from "./core/crawler/run";
export { runCrawlForProject } from "./core/crawler/run";
export { extractControls, stateSignature } from "./core/graph/extract";
export type { SavedGraph } from "./core/graph/store";
export { currentGitSha, graphScreenshotDir, loadGraph, saveGraph } from "./core/graph/store";
export type {
    ControlKind,
    ControlRef,
    CoverageReport,
    EdgeVia,
    GraphEdge,
    InteractionGraph,
    PageNode,
} from "./core/graph/types";
export { normalizePath, resolveInternalPath, stripQuery } from "./core/graph/url";
export { humanDwell, type PacingOptions, thinkPause } from "./core/human/pacing";
export type { LogLine } from "./core/logger";
export { addProgressSink, logger, runWithProgress } from "./core/logger";
export type { RunTotals } from "./core/observability/langfuse";
export { endRun, runTotals, startRun } from "./core/observability/langfuse";
export type { DetectInput } from "./core/onboard/detect";
export { detectProjectConfig } from "./core/onboard/detect";
export type { RepoScanResult } from "./core/onboard/repo-scan";
export { scanRepo } from "./core/onboard/repo-scan";
export type { FieldMeta, OnboardConfidence, OnboardProposal } from "./core/onboard/types";
export type { IssueComment, PrMeta } from "./core/pr/github";
export {
    detectRepo,
    getChangedFiles,
    getPrDiff,
    getPrMeta,
    isGhAuthenticated,
    listIssueComments,
    listRepoDir,
    postPrComment,
    resolveProductionUrl,
    resolveWebPreviewUrl,
    uploadReleaseAsset,
} from "./core/pr/github";
export type { ReplayOptions } from "./core/pr/replay";
export { replayFlows, selectFlows } from "./core/pr/replay";
export type { FlowResult, PrRunManifest } from "./core/pr/types";
export { createReasoner, llmCredentialIssue } from "./core/reasoner/ai-sdk-reasoner";
export type { GenerateObjectOptions, GenerateTextOptions, Reasoner } from "./core/reasoner/types";
export type { PreflightResult, ProductionMarkerHit } from "./core/safety/production-guard";
export { ProductionGuardError, runProductionPreflight } from "./core/safety/production-guard";
export { installReadOnlyGuard } from "./core/safety/read-only-guard";
export { redactSecret } from "./core/safety/redact";
export { synthesizeSiteMap } from "./core/sitemap/synthesize";
export type {
    AuthStrategy,
    BlockedRequest,
    Credentials,
    DatastoreTarget,
    NetworkEvent,
    PortMap,
    RegExpSource,
    RepoAdapter,
    SafetyConfig,
} from "./core/types";
export type { ExecuteOptions } from "./core/verify/execute";
export { executePlan, judgeVerdict } from "./core/verify/execute";
export type { PlanContext } from "./core/verify/plan";
export { generatePlan } from "./core/verify/plan";
export type { PlanArgs, PlanResult, RunVerifyArgs, RunVerifyResult } from "./core/verify/run";
export { planForProject, runVerifyForProject } from "./core/verify/run";
export type { PlanStep, StepResult, TestPlan, Verdict, VerifyManifest } from "./core/verify/types";
export { SENTINEL } from "./persona";
