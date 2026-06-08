import assert from "node:assert/strict";
import { test } from "node:test";
import { isReservedSecretEnvName, resolvePersistedRecipe } from "./recipe";

test("merges non-secret literals with looked-up secret env values", () => {
    // An app's OWN secret (not a Sentinel-reserved name) resolves normally.
    process.env.MYAPP_DB_URL = "postgres://localhost/app";
    try {
        const { recipe, missingSecrets } = resolvePersistedRecipe({
            runCmd: "npm run dev",
            port: 3000,
            env: { NEXT_PUBLIC_API: "https://staging.api" },
            secretEnv: ["MYAPP_DB_URL"],
        });
        assert.equal(recipe.env?.NEXT_PUBLIC_API, "https://staging.api", "literal config passes through");
        assert.equal(recipe.env?.MYAPP_DB_URL, "postgres://localhost/app", "app secret is resolved by name");
        assert.deepEqual(missingSecrets, []);
    } finally {
        delete process.env.MYAPP_DB_URL;
    }
});

test("reports missing/empty secret env vars instead of throwing", () => {
    delete process.env.MYAPP_TEST_ABSENT;
    const { recipe, missingSecrets } = resolvePersistedRecipe({
        runCmd: "npm start",
        port: 8080,
        secretEnv: ["MYAPP_TEST_ABSENT"],
    });
    assert.deepEqual(missingSecrets, ["MYAPP_TEST_ABSENT"]);
    assert.equal(recipe.env?.MYAPP_TEST_ABSENT, undefined, "an unresolved secret is never injected");
    assert.equal(recipe.runCmd, "npm start");
});

test("REFUSES to resolve env vars reserved for Sentinel's own credentials", () => {
    // These would be Sentinel's own secrets sitting in its process.env.
    process.env.GH_TOKEN = "sentinel-gh-token";
    process.env.AWS_SECRET_ACCESS_KEY = "sentinel-aws-secret";
    process.env.SENTINEL_EMAIL = "sentinel@example.com";
    try {
        const { recipe, rejectedSecrets } = resolvePersistedRecipe({
            runCmd: "npm run dev",
            port: 3000,
            secretEnv: ["GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "SENTINEL_EMAIL", "DATABASE_URL"],
        });
        assert.deepEqual(
            [...rejectedSecrets].sort(),
            ["AWS_SECRET_ACCESS_KEY", "GH_TOKEN", "SENTINEL_EMAIL"],
            "Sentinel's own credential names must be refused",
        );
        assert.equal(recipe.env?.GH_TOKEN, undefined, "Sentinel's GitHub token must never reach the PR child");
        assert.equal(recipe.env?.AWS_SECRET_ACCESS_KEY, undefined);
        assert.equal(recipe.env?.SENTINEL_EMAIL, undefined);
    } finally {
        delete process.env.GH_TOKEN;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.SENTINEL_EMAIL;
    }
});

test("isReservedSecretEnvName flags Sentinel secrets but allows an app's own secrets", () => {
    for (const reserved of [
        "SENTINEL_PASSWORD",
        "AWS_ACCESS_KEY_ID",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
    ]) {
        assert.equal(isReservedSecretEnvName(reserved), true, `${reserved} should be reserved`);
    }
    for (const allowed of ["DATABASE_URL", "STRIPE_API_KEY", "NEXT_PUBLIC_FOO", "MY_APP_TOKEN"]) {
        assert.equal(isReservedSecretEnvName(allowed), false, `${allowed} should be allowed`);
    }
});
