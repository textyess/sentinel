/**
 * Repo-agnostic contracts. The Sentinel core depends ONLY on these types.
 * Everything specific to a repository (TextYess ports, login labels, route
 * names, prod connection strings) lives in an adapter that satisfies
 * {@link RepoAdapter} — so adding a second repo is a new adapter file, not new
 * core code.
 */

/** A string that will be compiled into a RegExp (case-insensitive) by the core. */
export type RegExpSource = string;

export interface PortMap {
    web: number;
    api?: number;
    worker?: number;
    brain0?: number;
    gateway?: number;
}

export interface Credentials {
    email: string;
    password: string;
}

/** How the core logs into the app under test. */
export interface AuthStrategy {
    /** Path (relative to baseUrl) of the login page, e.g. "/login". */
    loginPath: string;
    /** Accessible label of the email field, matched exactly. */
    emailLabel: string;
    /** Accessible label of the password field, matched exactly. */
    passwordLabel: string;
    /** Accessible-name pattern of the submit button, e.g. "log\\s*in". */
    submitNamePattern: RegExpSource;
    /** URL pattern the app lands on once authenticated. */
    authenticatedUrlPattern: RegExpSource;
    /** Optional CSS fallback for the email field if the label match misses (e.g. 'input[type="email"]'). */
    emailFallbackSelector?: string;
    /** Optional CSS fallback for the password field if the label match misses. */
    passwordFallbackSelector?: string;
    /** Routes that never require auth (the crawler may visit them without a session). */
    publicRoutes: string[];
}

/**
 * The safety envelope. The read-only guard and the production preflight read
 * exclusively from here, so a repo can tune what counts as "destructive" or
 * "production" without touching the engine.
 */
export interface SafetyConfig {
    /** When true, mutating network requests are aborted (except {@link allowedMutationPatterns}). */
    readOnly: boolean;
    /** Mutating requests whose URL matches one of these are allowed (needed to authenticate). */
    allowedMutationPatterns: RegExpSource[];
    /** Telemetry/analytics endpoints — dropped quietly in read-only mode. */
    telemetryPatterns: RegExpSource[];
    /** Accessible-name patterns for controls Sentinel must never click (Phase 1 click guard). */
    destructiveControlPatterns: RegExpSource[];
    /** Connection-string / host fragments that indicate a production datastore. */
    productionMarkers: RegExpSource[];
    /** If true, refuse to run when a production marker is detected. */
    failClosedOnProduction: boolean;
}

/** A datastore/endpoint the preflight checks against {@link SafetyConfig.productionMarkers}. */
export interface DatastoreTarget {
    /** Human label, e.g. "apps/api DB_SERVER". */
    label: string;
    /** Where the value came from, e.g. "apps/api/.env". */
    source: string;
    /** The connection string / URL (redacted before logging). */
    value: string;
}

export interface RepoAdapter {
    /** Stable id, used in output paths, e.g. "textyess". */
    id: string;
    displayName: string;
    /** The web app Sentinel drives. */
    baseUrl: string;
    ports: PortMap;
    auth: AuthStrategy;
    safety: SafetyConfig;
    /** Optional seed list of known routes to accelerate Phase 1 crawling. */
    knownRoutes: string[];
    /** Login credentials, or null when not configured yet. */
    credentials: Credentials | null;
    /** Resolve the datastores/endpoints this run will touch, for the prod preflight. */
    resolveDatastoreTargets(): Promise<DatastoreTarget[]>;
    /** Substring identifying the web app's preview deployment environment (e.g. "web"). */
    previewEnvIncludes: string;
    /** Map a PR's changed files to affected route paths, with caveats about coverage. */
    affectedRoutes(changedFiles: string[]): { routes: string[]; notes: string[] };
}

export interface BlockedRequest {
    method: string;
    url: string;
    reason: "mutation" | "telemetry";
    at: string;
}

export interface NetworkEvent {
    method: string;
    url: string;
    status: number;
    at: string;
}
