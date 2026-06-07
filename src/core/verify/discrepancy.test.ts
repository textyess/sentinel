import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlRef } from "../graph/types";
import type { PageSkill } from "../skills/load";
import { destinationDrift, isSuccessfulClick, matchedSkillControl, missingControl, selectorStale } from "./discrepancy";

function ctrl(over: Partial<ControlRef> & Pick<ControlRef, "name">): ControlRef {
    return {
        role: over.role ?? "button",
        name: over.name,
        selectors: over.selectors ?? [],
        href: over.href ?? null,
        destructive: over.destructive ?? false,
        kind: over.kind ?? "action",
    };
}

function pageSkill(controls: ControlRef[], slug = "app-campaigns", route = "/campaigns"): PageSkill {
    return { route, skillSlug: slug, controls };
}

test("matchedSkillControl matches on role+name+href together", () => {
    const live = ctrl({ name: "Open", href: "/a" });
    const skill = pageSkill([
        ctrl({ name: "Open", href: "/b" }),
        ctrl({ name: "Open", href: "/a", selectors: ["#a"] }),
    ]);
    assert.equal(matchedSkillControl(skill, live)?.selectors[0], "#a");
    assert.equal(matchedSkillControl(null, live), null);
});

test("selectorStale fires when the working selector is not one the skill recorded", () => {
    const live = ctrl({ name: "Save", selectors: ["#live"] });
    const skill = pageSkill([ctrl({ name: "Save", selectors: ["#baseline"] })]);
    const d = selectorStale("/campaigns", skill, live, "#live");
    assert.equal(d?.kind, "selector-stale");
    assert.equal(d?.skillSlug, "app-campaigns");
});

test("selectorStale is null when the working selector is one the skill recorded", () => {
    const live = ctrl({ name: "Save", selectors: ["#baseline"] });
    const skill = pageSkill([ctrl({ name: "Save", selectors: ["#baseline"] })]);
    assert.equal(selectorStale("/campaigns", skill, live, "#baseline"), null);
});

test("selectorStale is null with no page skill, no matching control, or no used selector", () => {
    const live = ctrl({ name: "Save", selectors: ["#x"] });
    assert.equal(selectorStale("/campaigns", null, live, "#x"), null);
    assert.equal(
        selectorStale("/campaigns", pageSkill([ctrl({ name: "Other", selectors: ["#o"] })]), live, "#x"),
        null,
    );
    assert.equal(selectorStale("/campaigns", pageSkill([ctrl({ name: "Save", selectors: ["#b"] })]), live, null), null);
});

test("missingControl fires when the skill named a control resembling the target", () => {
    const d = missingControl("/campaigns", pageSkill([ctrl({ name: "New" })]), "New campaign");
    assert.equal(d?.kind, "missing-control");
    assert.equal(d?.skillSlug, "app-campaigns");
    assert.equal(missingControl("/campaigns", null, "New campaign"), null);
});

test("missingControl is null when the skill covers the route but never named the target", () => {
    // A hallucinated target, or a control the PR just added — an ordinary miss, not drift.
    assert.equal(missingControl("/campaigns", pageSkill([ctrl({ name: "Delete" })]), "New campaign"), null);
});

test("selectorStale is null when the working selector is any recorded one (not just the first)", () => {
    const live = ctrl({ name: "Save", selectors: ["#a", "#b"] });
    const skill = pageSkill([ctrl({ name: "Save", selectors: ["#a", "#b"] })]);
    assert.equal(selectorStale("/campaigns", skill, live, "#b"), null);
    // …but a selector the skill never recorded means self-heal fell through → stale.
    assert.equal(selectorStale("/campaigns", skill, live, "#c")?.kind, "selector-stale");
});

test("isSuccessfulClick is true only for a successful click/click-path", () => {
    assert.equal(isSuccessfulClick("click", true), true);
    assert.equal(isSuccessfulClick("click-path", true), true);
    assert.equal(isSuccessfulClick("click", false), false);
    assert.equal(isSuccessfulClick("goto", true), false);
    assert.equal(isSuccessfulClick("already", true), false);
});

test("destinationDrift fires for a real click that landed off the expected route", () => {
    const expectedSkill = pageSkill([], "app-flows", "/flows");
    const d = destinationDrift(expectedSkill, "/flows", "/home", true);
    assert.equal(d?.kind, "destination-drift");
    assert.equal(d?.route, "/flows");
    assert.equal(d?.skillSlug, "app-flows");
});

test("destinationDrift is null for non-clicks, matching routes, no skill, or unknown landed", () => {
    const skill = pageSkill([], "app-flows", "/flows");
    assert.equal(destinationDrift(skill, "/flows", "/home", false), null);
    assert.equal(destinationDrift(skill, "/flows", "/flows", true), null);
    assert.equal(destinationDrift(null, "/flows", "/home", true), null);
    assert.equal(destinationDrift(skill, "/flows", "", true), null);
});
