const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;

/** Collapse a dynamic path segment (an id) to ":id" so /flows/abc and /flows/def map to one node. */
function templateSegment(segment: string): string {
    if (OBJECT_ID.test(segment) || UUID.test(segment) || NUMERIC.test(segment) || LONG_HEX.test(segment)) {
        return ":id";
    }
    return segment;
}

export interface NormalizedPath {
    /** Path with dynamic segments templated, e.g. "/inbox/c/:id". */
    path: string;
    /** First (literal) path segment, e.g. "inbox". */
    area: string | null;
}

export function normalizePath(rawUrl: string, baseUrl: string): NormalizedPath {
    let pathname: string;
    try {
        pathname = new URL(rawUrl, baseUrl).pathname;
    } catch {
        pathname = rawUrl;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
        return { path: "/", area: null };
    }
    const templatedFirst = templateSegment(segments[0] ?? "");
    return {
        path: `/${segments.map(templateSegment).join("/")}`,
        // A templated id is not a meaningful area name.
        area: templatedFirst === ":id" ? null : templatedFirst,
    };
}

/** The pathname of a URL, or the input unchanged if it can't be parsed. */
export function pathnameOf(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
}

/** Drop the query string and hash, keeping origin + path — a safe, re-navigable restore target. */
export function stripQuery(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.origin + parsed.pathname;
    } catch {
        return url;
    }
}

/** True when a landed URL is the login page (session lost / auth wall), matched on path boundary. */
export function isLoginPath(url: string, loginPath: string): boolean {
    // A root/empty loginPath would match every page ("/" startsWith makes the bounce check
    // meaningless), so treat it as "no detectable login route" and never flag.
    if (!loginPath || loginPath === "/") {
        return false;
    }
    const pathname = pathnameOf(url);
    return pathname === loginPath || pathname.startsWith(`${loginPath}/`);
}

/** Resolve an href to an internal path, or null if it is external / non-navigational. */
export function resolveInternalPath(href: string | null, baseUrl: string): string | null {
    if (!href) {
        return null;
    }
    const lowered = href.toLowerCase();
    if (
        href.startsWith("#") ||
        lowered.startsWith("mailto:") ||
        lowered.startsWith("tel:") ||
        lowered.startsWith("javascript:")
    ) {
        return null;
    }
    try {
        const target = new URL(href, baseUrl);
        if (target.origin !== new URL(baseUrl).origin) {
            return null;
        }
        // Drop the query string: it would never match the path-only dedup key, and
        // query-driven view state (tabs, filters) is mapped via interaction, not
        // navigation. This also keeps one-time tokens out of the persisted graph.
        return target.pathname;
    } catch {
        return null;
    }
}
