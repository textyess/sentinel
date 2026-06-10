/**
 * GitHub OAuth Device Flow — lets a human mint a GitHub token by approving a
 * one-time code on github.com instead of hand-creating a PAT and pasting it into
 * .env. Device flow needs only a PUBLIC client id (no secret, no redirect URL),
 * so it works for a localhost dashboard and a headless deployment alike.
 *
 * The resulting token is consumed by the `gh` CLI via the GH_TOKEN env var — the
 * caller is responsible for persisting it (and for never logging it).
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

/**
 * The GitHub CLI's public OAuth client id. Sentinel performs every GitHub
 * operation through the `gh` binary, so authorizing under gh's own client
 * identity yields exactly the kind of token gh expects (the grant shows up as
 * "GitHub CLI" in the user's authorized apps). Operators who prefer their own
 * OAuth App (with device flow enabled) can override via SENTINEL_GITHUB_CLIENT_ID.
 */
export const DEFAULT_DEVICE_CLIENT_ID = "178c6fc778ccc68e1d6a";

/** Matches gh's own minimum scopes, so `gh auth status` and all pr/api commands work. */
export const DEVICE_FLOW_SCOPE = "repo read:org";

export interface DeviceCodeGrant {
    /** Server-side secret half of the grant — must never reach a browser or a log. */
    deviceCode: string;
    /** The short code the human types on github.com. */
    userCode: string;
    /** Where the human enters the code (https://github.com/login/device). */
    verificationUri: string;
    /** Seconds until the grant expires. */
    expiresIn: number;
    /** Minimum seconds between token polls. */
    interval: number;
}

export type DevicePollResult =
    | { kind: "pending" }
    | { kind: "slow-down"; intervalSeconds: number }
    | { kind: "token"; token: string }
    | { kind: "denied" }
    | { kind: "expired" }
    | { kind: "error"; message: string };

async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: new URLSearchParams(params).toString(),
    });
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`Unexpected response from ${url} (HTTP ${response.status}).`);
    }
    return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

/** Begin a device-flow login: ask GitHub for a user code the human approves on github.com. */
export async function requestDeviceCode(clientId: string, scope: string): Promise<DeviceCodeGrant> {
    const data = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope });
    const error = asString(data.error);
    if (error) {
        const description = asString(data.error_description);
        throw new Error(`GitHub rejected the device-flow start: ${description ?? error}`);
    }
    const deviceCode = asString(data.device_code);
    const userCode = asString(data.user_code);
    const verificationUri = asString(data.verification_uri);
    if (!deviceCode || !userCode || !verificationUri) {
        throw new Error("GitHub's device-flow response was missing required fields.");
    }
    return {
        deviceCode,
        userCode,
        verificationUri,
        expiresIn: typeof data.expires_in === "number" ? data.expires_in : 900,
        interval: typeof data.interval === "number" ? data.interval : 5,
    };
}

/** One token poll. The caller owns the loop (honoring `interval` / slow-down). */
export async function pollDeviceToken(clientId: string, deviceCode: string): Promise<DevicePollResult> {
    let data: Record<string, unknown>;
    try {
        data = await postForm(ACCESS_TOKEN_URL, {
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
    } catch (error) {
        // A transient network failure shouldn't kill the flow — treat it as "try again".
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    const token = asString(data.access_token);
    if (token) {
        return { kind: "token", token };
    }
    switch (asString(data.error)) {
        case "authorization_pending":
            return { kind: "pending" };
        case "slow_down":
            return { kind: "slow-down", intervalSeconds: typeof data.interval === "number" ? data.interval : 10 };
        case "access_denied":
            return { kind: "denied" };
        case "expired_token":
            return { kind: "expired" };
        default:
            return {
                kind: "error",
                message: asString(data.error_description) ?? asString(data.error) ?? "Unknown device-flow error.",
            };
    }
}

/** The authenticated account's login for a freshly minted token, or null when unreadable. */
export async function fetchTokenLogin(token: string): Promise<string | null> {
    try {
        const response = await fetch(USER_URL, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        });
        if (!response.ok) {
            return null;
        }
        const parsed: unknown = await response.json();
        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }
        return asString((parsed as Record<string, unknown>).login);
    } catch {
        return null;
    }
}
