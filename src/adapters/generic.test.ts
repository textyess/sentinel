import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenericAdapter, type GenericProjectConfig } from "./generic";

/**
 * Locks the PR-diff -> routes mapping that the onboarding skill relies on for its
 * "config round-trips a real PR" check. Exercised through the public adapter
 * (`createGenericAdapter(...).affectedRoutes`), which is exactly the path verify/replay use.
 */
function configWith(pagesPrefix: string | undefined): GenericProjectConfig {
    return {
        auth: {
            loginPath: "/login",
            emailLabel: "Email",
            passwordLabel: "Password",
            submitNamePattern: "log\\s*in",
            authenticatedUrlPattern: "/(home|dashboard)(/|\\?|#|$)",
            publicRoutes: ["/login"],
        },
        emailEnv: "SENTINEL_ACME_EMAIL",
        passwordEnv: "SENTINEL_ACME_PASSWORD",
        previewEnvIncludes: "web",
        pagesPrefix,
        allowedMutationPatterns: ["^/api/auth/login$"],
    };
}

function routesFor(pagesPrefix: string | undefined, files: string[]): { routes: string[]; notes: string[] } {
    return createGenericAdapter("acme-web", "acme/web", configWith(pagesPrefix)).affectedRoutes(files);
}

test("maps Pages Router files to routes and drops trailing index", () => {
    assert.deepEqual(routesFor("src/pages/", ["src/pages/settings.tsx"]).routes, ["/settings"]);
    assert.deepEqual(routesFor("src/pages/", ["src/pages/index.tsx"]).routes, ["/"]);
    assert.deepEqual(routesFor("src/pages/", ["src/pages/blog/index.tsx"]).routes, ["/blog"]);
});

test("supports pages/, app/routes/ (Remix), and strips js/ts extensions", () => {
    assert.deepEqual(routesFor("pages/", ["pages/about.jsx"]).routes, ["/about"]);
    assert.deepEqual(routesFor("app/routes/", ["app/routes/dashboard.ts"]).routes, ["/dashboard"]);
});

test("App Router page.tsx is NOT special-cased — yields /x/page (documented caveat)", () => {
    // Only a trailing `index` is dropped; `page`/`route`/`layout` are not. The most common
    // target (Next App Router) therefore maps app/settings/page.tsx -> /settings/page, which
    // relies on downstream fuzzy (startsWith) matching against the baseline graph.
    assert.deepEqual(routesFor("app/", ["app/settings/page.tsx"]).routes, ["/settings/page"]);
});

test("a leading dynamic/group segment yields no route and a skippedDynamic note", () => {
    const dyn = routesFor("app/", ["app/[lang]/settings/page.tsx"]);
    assert.deepEqual(dyn.routes, []);
    assert.ok(dyn.notes.some((n) => /dynamic/i.test(n)));

    const group = routesFor("app/", ["app/(marketing)/about/page.tsx"]);
    assert.deepEqual(group.routes, []);
});

test("a non-leading dynamic segment truncates to the literal prefix", () => {
    assert.deepEqual(routesFor("app/", ["app/settings/[id]/page.tsx"]).routes, ["/settings"]);
});

test("files outside the prefix produce no routes but a broad-impact note", () => {
    const out = routesFor("app/", ["lib/utils.ts"]);
    assert.deepEqual(out.routes, []);
    assert.ok(out.notes.some((n) => /outside the pages prefix/i.test(n)));
});

test("no pagesPrefix returns no routes with an explanatory note", () => {
    const none = routesFor(undefined, ["app/x/page.tsx"]);
    assert.deepEqual(none.routes, []);
    assert.ok(none.notes.some((n) => /No pages prefix/i.test(n)));
});

test("dedupes routes and always flags the mapping as approximate", () => {
    const dup = routesFor("src/pages/", ["src/pages/a.tsx", "src/pages/a.tsx"]);
    assert.deepEqual(dup.routes, ["/a"]);
    assert.ok(dup.notes.some((n) => /approximate/i.test(n)));
});
