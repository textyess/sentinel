import {
    applyEnvVar,
    DEFAULT_DEVICE_CLIENT_ID,
    DEVICE_FLOW_SCOPE,
    type DeviceCodeGrant,
    fetchTokenLogin,
    logger,
    pollDeviceToken,
    requestDeviceCode,
} from "../index";
import { singleton } from "./singleton";

/**
 * Dashboard-driven "Connect GitHub" via the OAuth device flow. The browser only
 * ever sees the user code + verification URL; the device code stays in this
 * module and the minted token goes straight to applyEnvVar("GH_TOKEN") — neither
 * is ever included in a status payload or a log line.
 */

export type GithubLoginFlow =
    | { state: "idle" }
    | { state: "pending"; userCode: string; verificationUri: string; expiresAt: string }
    | { state: "connected"; login: string | null }
    | { state: "error"; message: string };

export interface GithubAuthView {
    flow: GithubLoginFlow;
    /** Whether GH_TOKEN is currently set (via this flow, manual paste, or the host env). */
    tokenSet: boolean;
}

interface FlowStore {
    current: GithubLoginFlow;
    /** Bumped on every start/cancel so a superseded poll loop knows to stop. */
    generation: number;
}

const flowStore = singleton<FlowStore>("githubLoginFlow", () => ({ current: { state: "idle" }, generation: 0 }));

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clientId(): string {
    return process.env.SENTINEL_GITHUB_CLIENT_ID || DEFAULT_DEVICE_CLIENT_ID;
}

async function pollUntilSettled(grant: DeviceCodeGrant, generation: number): Promise<void> {
    let intervalMs = Math.max(grant.interval, 5) * 1000;
    const deadline = Date.now() + grant.expiresIn * 1000;
    while (Date.now() < deadline) {
        await sleep(intervalMs);
        if (flowStore.generation !== generation) {
            return; // cancelled or superseded by a newer flow
        }
        const result = await pollDeviceToken(clientId(), grant.deviceCode);
        switch (result.kind) {
            case "pending":
                continue;
            case "slow-down":
                intervalMs = Math.max(result.intervalSeconds, 5) * 1000;
                continue;
            case "token": {
                const login = await fetchTokenLogin(result.token);
                try {
                    applyEnvVar("GH_TOKEN", result.token);
                } catch (error) {
                    // EnvFileWriteError carries the key name only, never the token value.
                    const message = error instanceof Error ? error.message : String(error);
                    flowStore.current = { state: "error", message: `Could not save the token: ${message}` };
                    return;
                }
                flowStore.current = { state: "connected", login };
                logger.success(`GitHub connected${login ? ` as @${login}` : ""} — GH_TOKEN saved to .env`);
                return;
            }
            case "denied":
                flowStore.current = { state: "error", message: "Authorization was denied on github.com." };
                return;
            case "expired":
                flowStore.current = { state: "error", message: "The code expired before it was approved. Try again." };
                return;
            case "error":
                // Could be transient (network blip) — keep polling until the grant expires.
                logger.debug(`GitHub device-flow poll failed: ${result.message}`);
                continue;
        }
    }
    flowStore.current = { state: "error", message: "The code expired before it was approved. Try again." };
}

export function getGithubAuth(): GithubAuthView {
    return { flow: flowStore.current, tokenSet: Boolean(process.env.GH_TOKEN) };
}

/** Start (or return the still-pending) device-flow login. */
export async function startGithubLogin(): Promise<GithubAuthView> {
    const current = flowStore.current;
    if (current.state === "pending" && Date.parse(current.expiresAt) > Date.now()) {
        return getGithubAuth(); // idempotent: an open flow keeps its code
    }
    const grant = await requestDeviceCode(clientId(), DEVICE_FLOW_SCOPE);
    flowStore.generation += 1;
    flowStore.current = {
        state: "pending",
        userCode: grant.userCode,
        verificationUri: grant.verificationUri,
        expiresAt: new Date(Date.now() + grant.expiresIn * 1000).toISOString(),
    };
    // Fire-and-forget: the browser observes progress by polling getGithubAuth().
    void pollUntilSettled(grant, flowStore.generation);
    return getGithubAuth();
}

/**
 * Cancel a pending flow, or — when none is pending — clear the stored GH_TOKEN.
 * Two-phase so cancelling an approval-in-progress never wipes a working token.
 */
export function disconnectGithub(): GithubAuthView {
    const wasPending = flowStore.current.state === "pending";
    flowStore.generation += 1; // stops any in-flight poll loop
    flowStore.current = { state: "idle" };
    if (!wasPending) {
        applyEnvVar("GH_TOKEN", "");
    }
    return getGithubAuth();
}
