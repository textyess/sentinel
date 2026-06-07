import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ControlRef, CoverageReport, InteractionGraph, PageNode } from "../graph/types";
import { loadPageSkillIndex } from "./load";
import type { ImportedIndex, SkillPackManifest } from "./types";

const ADAPTER = "app";

function control(over: Partial<ControlRef> & Pick<ControlRef, "name">): ControlRef {
    return {
        role: over.role ?? "link",
        name: over.name,
        selectors: over.selectors ?? [`role=link[name=${JSON.stringify(over.name)}i]`],
        href: over.href ?? null,
        destructive: over.destructive ?? false,
        kind: over.kind ?? "navigation",
    };
}

function node(id: string, url: string, controls: ControlRef[]): PageNode {
    return {
        id,
        url,
        rawUrlSample: `https://app.test${url}`,
        title: url,
        routeArea: url.split("/")[1] ?? null,
        controlCount: controls.length,
        controls,
        screenshot: null,
        visitedAt: "2026-06-07T00:00:00.000Z",
        flagged: [],
    };
}

function graphOf(nodes: PageNode[]): InteractionGraph {
    const byId: Record<string, PageNode> = {};
    for (const n of nodes) {
        byId[n.id] = n;
    }
    const coverage: CoverageReport = {
        routesSeeded: [],
        routesReached: [],
        routesUnreached: [],
        areasReached: [],
        nodeCount: nodes.length,
        edgeCount: 0,
        blockedWrites: 0,
        notes: [],
    };
    return {
        repoId: ADAPTER,
        baseUrl: "https://app.test",
        gitSha: "abc123",
        createdAt: "2026-06-07T00:00:00.000Z",
        nodes: byId,
        edges: [],
        coverage,
    };
}

/** Write the given skills files into a throwaway output dir and run `fn` against it. */
function withSkills(
    files: { pack?: SkillPackManifest; imported?: ImportedIndex },
    fn: (outputDir: string) => void,
): void {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-skills-"));
    try {
        const skillsDir = path.join(outputDir, ADAPTER, "skills");
        fs.mkdirSync(skillsDir, { recursive: true });
        if (files.pack) {
            fs.writeFileSync(path.join(skillsDir, "pack.json"), JSON.stringify(files.pack));
        }
        if (files.imported) {
            fs.writeFileSync(path.join(skillsDir, "imported.json"), JSON.stringify(files.imported));
        }
        fn(outputDir);
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
}

function packOf(areas: SkillPackManifest["areas"]): SkillPackManifest {
    const routeIndex: Record<string, string> = {};
    for (const area of areas) {
        for (const route of area.routes) {
            routeIndex[route] = area.slug;
        }
    }
    return {
        source: ADAPTER,
        baseUrl: "https://app.test",
        gitSha: "abc123",
        createdAt: "2026-06-07T00:00:00.000Z",
        general: `${ADAPTER}-navigation`,
        areas,
        routeIndex,
    };
}

test("returns null when no skill pack or imported index exists", () => {
    withSkills({}, (outputDir) => {
        const graph = graphOf([node("n1", "/campaigns", [control({ name: "New" })])]);
        assert.equal(loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]), null);
    });
});

test("projects the baseline graph's controls onto the affected area, verbatim", () => {
    const pack = packOf([
        { area: "campaigns", slug: "app-campaigns", routes: ["/campaigns", "/campaigns/:id"] },
        { area: "settings", slug: "app-settings", routes: ["/settings"] },
    ]);
    const newBtn = control({
        role: "button",
        name: "New campaign",
        selectors: ['role=button[name="New campaign"i]', "#new-campaign"],
        kind: "action",
    });
    const del = control({ role: "button", name: "Delete", destructive: true, kind: "action" });
    const graph = graphOf([
        node("c1", "/campaigns", [newBtn, del]),
        node("c2", "/campaigns/:id", [control({ name: "Back" })]),
        node("s1", "/settings", [control({ name: "Save" })]),
    ]);

    withSkills({ pack }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]);
        assert.ok(index, "index should be built");

        const page = index.get("/campaigns");
        assert.ok(page);
        assert.equal(page.skillSlug, "app-campaigns");
        // Selectors come through unchanged — the exact data stays exact.
        assert.deepEqual(page.controls, [newBtn, del]);

        // The dynamic child route is in the same selected area.
        assert.equal(index.get("/campaigns/:id")?.skillSlug, "app-campaigns");

        // A non-overlapping area is not selected.
        assert.equal(index.get("/settings"), null);

        assert.deepEqual(index.routes, ["/campaigns", "/campaigns/:id"]);
        assert.deepEqual(index.slugs, ["app-campaigns"]);
    });
});

test("preserves destructive controls (never filters them)", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const del = control({ role: "button", name: "Delete all", destructive: true, kind: "action" });
    const graph = graphOf([node("c1", "/campaigns", [control({ name: "View" }), del])]);

    withSkills({ pack }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]);
        const controls = index?.get("/campaigns")?.controls ?? [];
        assert.ok(controls.some((c) => c.destructive && c.name === "Delete all"));
    });
});

test("merges and dedupes controls across page states sharing a route", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const a = control({ name: "A" });
    const b = control({ name: "B" });
    const c = control({ name: "C" });
    const graph = graphOf([node("c1", "/campaigns", [a, b]), node("c2", "/campaigns", [b, c])]);

    withSkills({ pack }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]);
        const names = (index?.get("/campaigns")?.controls ?? []).map((x) => x.name);
        assert.deepEqual(names, ["A", "B", "C"]);
    });
});

test("returns null when the pack covers no affected route", () => {
    const pack = packOf([{ area: "settings", slug: "app-settings", routes: ["/settings"] }]);
    const graph = graphOf([node("s1", "/settings", [control({ name: "Save" })])]);

    withSkills({ pack }, (outputDir) => {
        assert.equal(loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]), null);
    });
});

test("returns null when an owned route has no matching graph node", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    // Graph has a different route only — nothing to project.
    const graph = graphOf([node("o1", "/other", [control({ name: "X" })])]);

    withSkills({ pack }, (outputDir) => {
        assert.equal(loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]), null);
    });
});

test("imported (non-general) skills contribute; general imported skills are ignored", () => {
    const imported: ImportedIndex = {
        skills: [
            { slug: "ext-inbox", area: "inbox", routes: ["/inbox"], source: "other-app", general: false },
            { slug: "ext-nav", area: null, routes: ["/inbox"], source: "other-app", general: true },
        ],
    };
    const graph = graphOf([node("i1", "/inbox", [control({ name: "Compose" })])]);

    withSkills({ imported }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/inbox"]);
        assert.equal(index?.get("/inbox")?.skillSlug, "ext-inbox");
        assert.deepEqual(index?.slugs, ["ext-inbox"]);
    });
});

test("unions a pack and an imported index when both are present", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const imported: ImportedIndex = {
        skills: [{ slug: "ext-inbox", area: "inbox", routes: ["/inbox"], source: "other-app", general: false }],
    };
    const graph = graphOf([
        node("c1", "/campaigns", [control({ name: "New" })]),
        node("i1", "/inbox", [control({ name: "Compose" })]),
    ]);

    withSkills({ pack, imported }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns", "/inbox"]);
        assert.equal(index?.get("/campaigns")?.skillSlug, "app-campaigns");
        assert.equal(index?.get("/inbox")?.skillSlug, "ext-inbox");
        assert.deepEqual(index?.routes, ["/campaigns", "/inbox"]);
        assert.deepEqual(index?.slugs, ["app-campaigns", "ext-inbox"]);
    });
});

test("attributes a route owned by both pack and imported to the pack", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const imported: ImportedIndex = {
        skills: [
            { slug: "ext-campaigns", area: "campaigns", routes: ["/campaigns"], source: "other-app", general: false },
        ],
    };
    const graph = graphOf([node("c1", "/campaigns", [control({ name: "New" })])]);

    withSkills({ pack, imported }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]);
        assert.equal(index?.get("/campaigns")?.skillSlug, "app-campaigns");
        assert.deepEqual(index?.slugs, ["app-campaigns"]);
    });
});

test("sorts routes and slugs regardless of insertion order", () => {
    const pack = packOf([
        { area: "zeta", slug: "app-zeta", routes: ["/zeta"] },
        { area: "alpha", slug: "app-alpha", routes: ["/alpha"] },
    ]);
    const graph = graphOf([
        node("z1", "/zeta", [control({ name: "Z" })]),
        node("a1", "/alpha", [control({ name: "A" })]),
    ]);

    withSkills({ pack }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/zeta", "/alpha"]);
        assert.deepEqual(index?.routes, ["/alpha", "/zeta"]);
        assert.deepEqual(index?.slugs, ["app-alpha", "app-zeta"]);
    });
});

test("keeps controls with the same role+name but different href", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const graph = graphOf([
        node("c1", "/campaigns", [
            control({ name: "Open", href: "/campaigns/a" }),
            control({ name: "Open", href: "/campaigns/b" }),
        ]),
    ]);

    withSkills({ pack }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]);
        const hrefs = (index?.get("/campaigns")?.controls ?? []).map((c) => c.href);
        assert.deepEqual(hrefs, ["/campaigns/a", "/campaigns/b"]);
    });
});

test("does not collapse distinct nameless controls with different selectors", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const filter = control({ role: "button", name: "", selectors: ["#filter"], kind: "action" });
    const sort = control({ role: "button", name: "", selectors: ["#sort"], kind: "action" });
    const graph = graphOf([node("c1", "/campaigns", [filter, sort])]);

    withSkills({ pack }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]);
        const selectors = (index?.get("/campaigns")?.controls ?? []).map((c) => c.selectors[0]);
        assert.deepEqual(selectors, ["#filter", "#sort"]);
    });
});

test("keeps both selector sets when the same control shifts selectors across states", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const stateA = control({
        role: "button",
        name: "Save",
        selectors: ["#save", "[data-testid=save]"],
        kind: "action",
    });
    const stateB = control({ role: "button", name: "Save", selectors: ["#save"], kind: "action" });
    const graph = graphOf([node("c1", "/campaigns", [stateA]), node("c2", "/campaigns", [stateB])]);

    withSkills({ pack }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]);
        const selectorSets = (index?.get("/campaigns")?.controls ?? []).map((c) => c.selectors);
        assert.deepEqual(selectorSets, [["#save", "[data-testid=save]"], ["#save"]]);
    });
});

test("collapses an exact-duplicate control seen on two states", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const same = control({ role: "button", name: "Save", selectors: ["#save"], kind: "action" });
    const graph = graphOf([node("c1", "/campaigns", [same]), node("c2", "/campaigns", [{ ...same }])]);

    withSkills({ pack }, (outputDir) => {
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]);
        assert.equal((index?.get("/campaigns")?.controls ?? []).length, 1);
    });
});

test("omits a route whose only graph node has no controls (and can null the index)", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns"] }]);
    const graph = graphOf([node("c1", "/campaigns", [])]);

    withSkills({ pack }, (outputDir) => {
        assert.equal(loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns"]), null);
    });
});

test("selects the whole area when the affected route is a child of an owned route", () => {
    const pack = packOf([{ area: "campaigns", slug: "app-campaigns", routes: ["/campaigns", "/campaigns/:id"] }]);
    const graph = graphOf([
        node("c1", "/campaigns", [control({ name: "New" })]),
        node("c2", "/campaigns/:id", [control({ name: "Back" })]),
    ]);

    withSkills({ pack }, (outputDir) => {
        // The affected route is the dynamic child; the parent must still be pulled in.
        const index = loadPageSkillIndex(outputDir, ADAPTER, graph, ["/campaigns/:id"]);
        assert.deepEqual(index?.routes, ["/campaigns", "/campaigns/:id"]);
    });
});
