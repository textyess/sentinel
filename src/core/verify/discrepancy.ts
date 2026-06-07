import type { ControlRef } from "../graph/types";
import type { PageSkill } from "../skills/load";
import type { SkillDiscrepancy } from "./types";

/**
 * Pure detection of skill-vs-live divergences. Every function takes already-gathered
 * facts (no browser, no LLM) and returns a discrepancy or null, so they are exhaustively
 * unit-testable. The executor calls them with what it observed during a real step; the
 * results are inert signal — they never alter execution and never touch `skills/`.
 */

/** The skill's record of a live control, matched by role+name+href; null if the skill has none. */
export function matchedSkillControl(pageSkill: PageSkill | null, live: ControlRef): ControlRef | null {
    if (!pageSkill) {
        return null;
    }
    return (
        pageSkill.controls.find(
            (control) => control.role === live.role && control.name === live.name && control.href === live.href,
        ) ?? null
    );
}

/**
 * selector-stale: the click/fill only succeeded on a selector the skill did NOT record
 * (`used` is the selector that worked). When the skill had a matching control with
 * recorded selectors and none of them was the one that worked, self-heal fell through to
 * a live selector — the skill's recorded selectors have drifted and should be refreshed.
 */
export function selectorStale(
    route: string,
    pageSkill: PageSkill | null,
    live: ControlRef,
    used: string | null,
): SkillDiscrepancy | null {
    if (!pageSkill || used === null) {
        return null;
    }
    const skillControl = matchedSkillControl(pageSkill, live);
    if (!skillControl || skillControl.selectors.length === 0 || skillControl.selectors.includes(used)) {
        return null;
    }
    return {
        kind: "selector-stale",
        route,
        skillSlug: pageSkill.skillSlug,
        detail: `"${skillControl.name}": recorded selectors ${JSON.stringify(skillControl.selectors)} did not resolve; live selector "${used}" was used.`,
    };
}

/** Case-insensitive, either-way containment — the planner's free-text target vs a verbatim control name. */
function nameMatches(controlName: string, target: string): boolean {
    if (controlName === "") {
        return false;
    }
    const name = controlName.toLowerCase();
    const goal = target.toLowerCase();
    return name.includes(goal) || goal.includes(name);
}

/**
 * missing-control: the step's target control was not found live, AND the skill actually
 * recorded a control resembling that target — so a control the skill relied on is gone.
 * Returns null when no skill covers the route, or when the skill never named anything like
 * the target: that's an ordinary miss (a hallucinated target, or a control the PR just
 * added), not stale-skill drift. Without this guard every failed resolve on a skill-covered
 * route would be mislabelled as drift and pollute the proposals/verdict.
 */
export function missingControl(route: string, pageSkill: PageSkill | null, target: string): SkillDiscrepancy | null {
    if (!pageSkill) {
        return null;
    }
    const named = pageSkill.controls.find((control) => nameMatches(control.name, target));
    if (!named) {
        return null;
    }
    return {
        kind: "missing-control",
        route,
        skillSlug: pageSkill.skillSlug,
        detail: `control "${named.name}" the skill recorded for ${route} was not found (target: "${target}").`,
    };
}

/**
 * True only for a real, *successful* in-app click — the one navigation that can evidence
 * drift. A URL-bar fallback ("goto"), a no-op ("already"), or a failed/login-bounced nav
 * (`ok === false`) must never count, or an auth bounce reads as baseline drift.
 */
export function isSuccessfulClick(method: string, ok: boolean): boolean {
    return ok && (method === "click" || method === "click-path");
}

/**
 * destination-drift: a real user click landed on a different templated route than the
 * skill expected. Gated on `isRealClick` (never from a URL-bar fallback) and on a skill
 * actually covering the expected route, so the divergence is measured against a baseline
 * expectation rather than the unknown.
 */
export function destinationDrift(
    expectedSkill: PageSkill | null,
    expected: string,
    landed: string,
    isRealClick: boolean,
): SkillDiscrepancy | null {
    if (!isRealClick || !expectedSkill || landed === "" || landed === expected) {
        return null;
    }
    return {
        kind: "destination-drift",
        route: expected,
        skillSlug: expectedSkill.skillSlug,
        detail: `a real click toward ${expected} landed on ${landed}.`,
    };
}
