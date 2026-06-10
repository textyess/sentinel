import { z } from "zod";
import type { InteractionGraph } from "../graph/types";
import type { Reasoner } from "../reasoner/types";
import { routesOpenedBy } from "./navigate";
import type { TestPlan } from "./types";

const PLAN_SCHEMA = z.object({
    goal: z.string(),
    startRoute: z.string(),
    steps: z
        .array(
            z.object({
                action: z.enum(["navigate", "click", "type", "select", "hover", "scroll", "assert", "wait"]),
                target: z.string(),
                value: z.string().nullable(),
                expect: z.string(),
                reason: z.string(),
            }),
        )
        .max(18),
    notes: z.array(z.string()),
});

/** Shared with the mid-run replanner (`replan.ts`) so the read-only rules stay single-sourced. */
export const PLAN_SYSTEM =
    "You are a QA engineer planning a READ-ONLY browser test that demonstrates a specific PR's change actually " +
    "works in the UI. Produce a short, concrete, ordered plan of browser steps that exercises EXACTLY what the PR " +
    "changed (open the new tab/panel/control, interact with it, and assert the result renders). " +
    "STRICT read-only rule: never include steps that create, save, send, delete, pay, publish, or otherwise write " +
    "data. If completing the feature would require a write, instead 'assert' that the relevant form/submit control " +
    "is present and stop there. Ground every target in the provided app map (real routes and control names). " +
    "The agent moves through the app like a real user: a 'navigate' step is carried out by finding and clicking " +
    "the app's own menu/sidebar/nav link to that route — never by editing the URL bar — so use 'navigate' (target " +
    '= the destination path ONLY, e.g. "/settings", with no descriptive words) for page changes and do NOT add ' +
    "separate steps just to open the menu. " +
    "Some sidebar/menu controls only open a submenu and have no page of their own — the map marks these " +
    '"(opens … ; use navigate)"; they are NOT click targets, so to reach a page inside such a group emit a single ' +
    "'navigate' to that destination path and never 'click' the group label. " +
    'Prefer 6-12 focused steps. Each step: action, target (human description; a bare path like "/settings" for ' +
    "navigate), value (for type/select, else null), expect (what should be visibly true), reason (tie to the PR). " +
    "When a navigation guide is provided, use it to choose real routes and control names and to steer clear of the " +
    "destructive controls it lists.";

/** A compact map of the affected pages + their controls, so the planner targets things that exist. */
function affectedDigest(graph: InteractionGraph, routes: string[]): string {
    const nodes = Object.values(graph.nodes).filter((n) =>
        routes.length === 0
            ? n.url === "/home"
            : routes.some((r) => n.url === r || n.url.startsWith(`${r}/`) || n.routeArea === r.replace(/^\//, "")),
    );
    if (nodes.length === 0) {
        return "(no matching pages in the baseline map; navigate to the affected routes directly)";
    }
    return nodes
        .slice(0, 8)
        .map((node) => {
            const controls = node.controls
                .filter((c) => c.name)
                .slice(0, 24)
                .map((c) => {
                    // A control with no href that the map saw open a route is a disclosure
                    // (a sidebar group toggle / menu opener): clicking it only expands a
                    // submenu, so surface where it leads and steer the plan to navigate there
                    // rather than click a label that goes nowhere on its own.
                    const opens = c.href ? [] : routesOpenedBy(graph, c.role, c.name);
                    return opens.length > 0
                        ? `${c.role}:"${c.name}" (opens ${opens.join(", ")}; use navigate)`
                        : `${c.role}:"${c.name}"`;
                })
                .join(", ");
            return `### ${node.url}\n  controls: ${controls}`;
        })
        .join("\n");
}

export interface PlanContext {
    title: string;
    body: string;
    changedFiles: string[];
    affectedRoutes: string[];
    /** Truncated unified diff of the changed web files (optional signal). */
    diffExcerpt: string;
    /** Distilled navigation skills for the affected area(s), if a skill pack exists. */
    skills?: string;
}

export async function generatePlan(
    reasoner: Reasoner,
    context: PlanContext,
    graph: InteractionGraph,
): Promise<TestPlan> {
    const prompt = `PR: ${context.title}

Description:
${context.body || "(none)"}

Affected routes: ${context.affectedRoutes.join(", ") || "(none — start at /home)"}
Changed files (${context.changedFiles.length}):
${context.changedFiles.slice(0, 40).join("\n")}

App map of the affected pages (real routes + controls you can target):
${affectedDigest(graph, context.affectedRoutes)}
${context.skills ? `\nNavigation guide (distilled skills for the affected area(s)):\n${context.skills}\n` : ""}
Diff excerpt (what changed):
${context.diffExcerpt || "(not available)"}

Plan a read-only browser test that demonstrates this PR's change.`;

    return reasoner.generateObject({
        prompt,
        system: PLAN_SYSTEM,
        schema: PLAN_SCHEMA,
        maxTokens: 2500,
        telemetryLabel: "plan",
    });
}
