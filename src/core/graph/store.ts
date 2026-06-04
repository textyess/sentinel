import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecret } from "../safety/redact";
import type { InteractionGraph } from "./types";

function graphDir(outputDir: string, repoId: string): string {
    return path.join(outputDir, repoId, "graph");
}

export function graphScreenshotDir(outputDir: string, repoId: string): string {
    return path.join(graphDir(outputDir, repoId), "screenshots");
}

/** Best-effort local repo HEAD sha, used to key graphs so they diff across PRs. */
export function currentGitSha(cwd: string): string | null {
    try {
        const sha = execSync("git rev-parse --short HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .trim();
        return sha || null;
    } catch {
        return null;
    }
}

export interface SavedGraph {
    graphFile: string;
    latestFile: string;
}

export function saveGraph(graph: InteractionGraph, outputDir: string): SavedGraph {
    const dir = graphDir(outputDir, graph.repoId);
    fs.mkdirSync(dir, { recursive: true });
    const key = graph.gitSha ?? "nosha";
    const graphFile = path.join(dir, `${key}.json`);
    const latestFile = path.join(dir, "latest.json");
    // The graph is a persisted (potentially committed) artifact — strip any
    // credentials / tokens that leaked into captured URLs before it touches disk.
    const json = redactSecret(JSON.stringify(graph, null, 2));
    fs.writeFileSync(graphFile, json);
    fs.writeFileSync(latestFile, json);
    return { graphFile, latestFile };
}

export function loadGraph(file: string): InteractionGraph {
    return JSON.parse(fs.readFileSync(file, "utf8")) as InteractionGraph;
}
