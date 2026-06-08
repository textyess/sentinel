import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePersistedRecipe } from "./recipe";

test("merges non-secret literals with looked-up secret env values", () => {
    process.env.SENTINEL_TEST_DB_URL = "postgres://localhost/app";
    try {
        const { recipe, missingSecrets } = resolvePersistedRecipe({
            runCmd: "npm run dev",
            port: 3000,
            env: { NEXT_PUBLIC_API: "https://staging.api" },
            secretEnv: ["SENTINEL_TEST_DB_URL"],
        });
        assert.equal(recipe.env?.NEXT_PUBLIC_API, "https://staging.api", "literal config passes through");
        assert.equal(recipe.env?.SENTINEL_TEST_DB_URL, "postgres://localhost/app", "secret is resolved by name");
        assert.deepEqual(missingSecrets, []);
    } finally {
        delete process.env.SENTINEL_TEST_DB_URL;
    }
});

test("reports missing/empty secret env vars instead of throwing", () => {
    delete process.env.SENTINEL_TEST_ABSENT;
    const { recipe, missingSecrets } = resolvePersistedRecipe({
        runCmd: "npm start",
        port: 8080,
        secretEnv: ["SENTINEL_TEST_ABSENT"],
    });
    assert.deepEqual(missingSecrets, ["SENTINEL_TEST_ABSENT"]);
    assert.equal(recipe.env?.SENTINEL_TEST_ABSENT, undefined, "an unresolved secret is never injected");
    assert.equal(recipe.runCmd, "npm start");
});
