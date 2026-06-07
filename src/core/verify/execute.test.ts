import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlRef } from "../graph/types";
import type { PageSkill } from "../skills/load";
import { candidateSelectors } from "./execute";

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

function pageSkill(controls: ControlRef[]): PageSkill {
    return { route: "/campaigns", skillSlug: "app-campaigns", controls };
}

test("returns the live selectors unchanged when there is no page skill", () => {
    const live = ctrl({ name: "Save", selectors: ["#save"] });
    assert.deepEqual(candidateSelectors(live, null), ["#save"]);
});

test("prefers the skill's exact selectors first, then live as fallback", () => {
    const live = ctrl({ name: "Save", selectors: ["#save-live"] });
    const skill = pageSkill([ctrl({ name: "Save", selectors: ["[data-testid=save]", "#save-baseline"] })]);
    assert.deepEqual(candidateSelectors(live, skill), ["[data-testid=save]", "#save-baseline", "#save-live"]);
});

test("dedupes selectors shared between skill and live, keeping skill order", () => {
    const live = ctrl({ name: "Save", selectors: ["#save", "#save-live"] });
    const skill = pageSkill([ctrl({ name: "Save", selectors: ["#save"] })]);
    assert.deepEqual(candidateSelectors(live, skill), ["#save", "#save-live"]);
});

test("falls back to live selectors when no skill control matches", () => {
    const live = ctrl({ name: "Save", selectors: ["#save"] });
    const skill = pageSkill([ctrl({ name: "Delete", selectors: ["#delete"] })]);
    assert.deepEqual(candidateSelectors(live, skill), ["#save"]);
});

test("matches on role+name+href together, not name alone", () => {
    const live = ctrl({ name: "Open", href: "/a", selectors: ["#live"] });
    const skill = pageSkill([
        ctrl({ name: "Open", href: "/b", selectors: ["#wrong"] }),
        ctrl({ name: "Open", href: "/a", selectors: ["#right"] }),
    ]);
    assert.deepEqual(candidateSelectors(live, skill), ["#right", "#live"]);
});

test("candidateSelectors degrades to just the live selectors when the matched skill control has none", () => {
    const live = ctrl({ name: "Save", selectors: ["#save"] });
    const skill = pageSkill([ctrl({ name: "Save", selectors: [] })]);
    assert.deepEqual(candidateSelectors(live, skill), ["#save"]);
});
