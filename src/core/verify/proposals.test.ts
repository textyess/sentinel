import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSkillProposals, discrepancyVerdictNote } from "./proposals";
import type { SkillDiscrepancy } from "./types";

const META = {
    pr: 11,
    headSha: "abc",
    baselineGitSha: "def",
    targetUrl: "https://preview.test",
    createdAt: "2026-06-07T00:00:00.000Z",
};

function disc(over: Partial<SkillDiscrepancy>): SkillDiscrepancy {
    return {
        kind: over.kind ?? "selector-stale",
        route: over.route ?? "/campaigns",
        skillSlug: over.skillSlug ?? "app-campaigns",
        detail: over.detail ?? "x",
    };
}

test("buildSkillProposals returns null with no discrepancies", () => {
    assert.equal(buildSkillProposals([], META), null);
});

test("buildSkillProposals dedupes, counts by kind, and stamps metadata", () => {
    const file = buildSkillProposals(
        [
            disc({ kind: "selector-stale", detail: "a" }),
            disc({ kind: "selector-stale", detail: "a" }),
            disc({ kind: "destination-drift", route: "/flows", detail: "b" }),
            disc({ kind: "missing-control", detail: "c" }),
        ],
        META,
    );
    assert.ok(file);
    assert.equal(file.proposals.length, 3);
    assert.equal(file.status, "proposed");
    assert.equal(file.pr, 11);
    assert.equal(file.baselineGitSha, "def");
    assert.deepEqual(file.summary, { "selector-stale": 1, "missing-control": 1, "destination-drift": 1 });
});

test("discrepancyVerdictNote is empty with none and names the kinds/routes otherwise", () => {
    assert.equal(discrepancyVerdictNote([]), "");
    const note = discrepancyVerdictNote([
        disc({ kind: "destination-drift", route: "/flows", detail: "landed on /home" }),
    ]);
    assert.match(note, /destination-drift/);
    assert.match(note, /\/flows/);
});

test("discrepancyVerdictNote caps the list at 8 and notes the remainder", () => {
    const note = discrepancyVerdictNote(Array.from({ length: 11 }, (_, i) => disc({ detail: `d${i}` })));
    assert.match(note, /and 3 more/);
});
