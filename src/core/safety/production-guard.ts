import { logger } from "../logger";
import type { DatastoreTarget, RepoAdapter } from "../types";
import { redactSecret } from "./redact";

export interface ProductionMarkerHit {
    target: DatastoreTarget;
    marker: string;
}

export interface PreflightResult {
    productionDetected: boolean;
    /** True when the target host is not on the local machine. */
    remoteTarget: boolean;
    hits: ProductionMarkerHit[];
    /** The read-only setting actually in force after the preflight. */
    effectiveReadOnly: boolean;
    targets: DatastoreTarget[];
}

export class ProductionGuardError extends Error {
    readonly hits: ProductionMarkerHit[];
    constructor(message: string, hits: ProductionMarkerHit[]) {
        super(message);
        this.name = "ProductionGuardError";
        this.hits = hits;
    }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** Any target the browser drives that is not on the local machine is treated as potentially production. */
function isRemoteHost(urlOrValue: string): boolean {
    let hostname: string;
    try {
        hostname = new URL(urlOrValue).hostname;
    } catch {
        return false;
    }
    return !LOCAL_HOSTNAMES.has(hostname) && !hostname.endsWith(".local");
}

/**
 * The safety boundary the whole project hangs on. Two independent signals decide
 * whether to clamp to read-only:
 *   1. a production marker in any datastore/endpoint this run can touch, and
 *   2. a non-local target host (fail-safe: an *undetected* remote host must never
 *      become a silent write path).
 * Either one forces read-only unless the operator explicitly opts into writes.
 * Fail-closed adapters hard-stop instead.
 */
export async function runProductionPreflight(adapter: RepoAdapter, allowProdWrites: boolean): Promise<PreflightResult> {
    const targets = await adapter.resolveDatastoreTargets();
    const markers = adapter.safety.productionMarkers.map((source) => ({ source, re: new RegExp(source, "i") }));

    const hits: ProductionMarkerHit[] = [];
    for (const target of targets) {
        const match = markers.find((m) => m.re.test(target.value));
        if (match) {
            hits.push({ target, marker: match.source });
        }
    }

    const remoteTarget = isRemoteHost(adapter.baseUrl);
    const productionDetected = hits.length > 0 || remoteTarget;

    if (productionDetected && adapter.safety.failClosedOnProduction) {
        for (const hit of hits) {
            logger.error(`Production marker "${hit.marker}" in ${hit.target.label} (${hit.target.source})`);
        }
        if (remoteTarget) {
            logger.error(`Remote (non-local) target: ${adapter.baseUrl}`);
        }
        throw new ProductionGuardError(
            "Sentinel refused to run: a production/remote target was detected and fail-closed is enabled.",
            hits,
        );
    }

    // Detection clamps to read-only; writes require an explicit opt-in. A local,
    // marker-free target keeps the adapter's configured read-only setting.
    const effectiveReadOnly = productionDetected ? !allowProdWrites : adapter.safety.readOnly;

    if (hits.length > 0) {
        logger.warn("Production datastore(s) detected:");
        for (const hit of hits) {
            logger.warn(`  - ${hit.target.label} (${hit.target.source}) -> ${redactSecret(hit.target.value)}`);
        }
    }
    if (remoteTarget) {
        logger.warn(`Remote (non-local) target treated as potentially production: ${adapter.baseUrl}`);
    }
    if (productionDetected) {
        if (effectiveReadOnly) {
            logger.warn("Read-only is ENFORCED: every mutating request will be aborted at the network layer.");
        } else {
            logger.warn("WRITES ENABLED against a production/remote target (SENTINEL_ALLOW_PROD_WRITES=true).");
        }
    } else {
        logger.success("Local target, no production datastore detected.");
    }

    return { productionDetected, remoteTarget, hits, effectiveReadOnly, targets };
}
