import { Command } from "commander";
import {
    runAffectedRoutes,
    runCrawl,
    runGuard,
    runLogin,
    runPr,
    runRegister,
    runSiteMap,
    runSkills,
    runSkillsExport,
    runSkillsImport,
    runSkillsPromote,
    runSmoke,
    runVerify,
} from "./commands";
import { logger } from "./core/logger";
import { SENTINEL } from "./persona";

function wrap(fn: () => Promise<void>): () => Promise<void> {
    return async () => {
        try {
            await fn();
        } catch (error) {
            logger.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    };
}

function parsePositiveInt(value: string, fallback: number): number {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const program = new Command();

program.name("sentinel").description(`${SENTINEL.name} — ${SENTINEL.tagline}`).version("0.0.1");

const PROJECT_OPT = "drive a registered project (the no-code generic path) instead of the built-in adapter";

program
    .command("guard")
    .description("Run the production / read-only preflight only.")
    .option("--project <slug>", PROJECT_OPT)
    .action((opts: { project?: string }) => wrap(() => runGuard(opts.project))());

program
    .command("login")
    .description("Log in and save an authenticated browser session.")
    .option("--project <slug>", PROJECT_OPT)
    .action((opts: { project?: string }) => wrap(() => runLogin(opts.project))());

program
    .command("smoke")
    .description("Phase 0: boot -> log in -> screenshot -> report blocked writes.")
    .option("--project <slug>", PROJECT_OPT)
    .action((opts: { project?: string }) => wrap(() => runSmoke(opts.project))());

program
    .command("register")
    .description("Register a project from a JSON config so the CLI can drive the no-code generic path.")
    .requiredOption("--config <path>", "path to the project config JSON (the POST /api/projects body)")
    .action((opts: { config: string }) => wrap(() => runRegister(opts.config))());

program
    .command("affected-routes")
    .description("Print the routes a PR's changed files map to for a registered project (PR-diff round-trip check).")
    .requiredOption("--project <slug>", "registered project slug")
    .requiredOption("--files <csv>", "comma-separated changed file paths")
    .action((opts: { project: string; files: string }) => wrap(() => runAffectedRoutes(opts.project, opts.files))());

program
    .command("crawl")
    .description("Phase 1: autonomously map the app into an interaction graph.")
    .option("--max-pages <n>", "maximum unique page states to map", "40")
    .option("--no-interact", "disable LLM-guided actuation (follow links only)")
    .option("--actuations-per-page <n>", "max controls to actuate per page when interacting", "6")
    .option("--project <slug>", PROJECT_OPT)
    .action((opts: { maxPages: string; interact: boolean; actuationsPerPage: string; project?: string }) =>
        wrap(() =>
            runCrawl(
                parsePositiveInt(opts.maxPages, 40),
                opts.interact !== false,
                parsePositiveInt(opts.actuationsPerPage, 6),
                opts.project,
            ),
        )(),
    );

program
    .command("sitemap")
    .description("Phase 1: synthesize a human-readable site map from the latest interaction graph.")
    .option("--project <slug>", PROJECT_OPT)
    .action((opts: { project?: string }) => wrap(() => runSiteMap(opts.project))());

const skills = program
    .command("skills")
    .description("Phase 1: project the latest interaction graph into a loadable navigation skill pack.")
    .option("--project <slug>", PROJECT_OPT)
    .action((opts: { project?: string }) => wrap(() => runSkills(opts.project))());

skills
    .command("export [outDir]")
    .description("Export a portable copy of the skill pack (selectors stripped, safety note rewritten).")
    .option("--project <slug>", PROJECT_OPT)
    .action((outDir: string | undefined, opts: { project?: string }) =>
        wrap(() => runSkillsExport(outDir ?? null, opts.project))(),
    );

skills
    .command("import <dir>")
    .description("Import a navigation skill pack (descriptive only — scripts and tool grants are not imported).")
    .option("--overwrite", "overwrite skills that already exist")
    .option("--project <slug>", PROJECT_OPT)
    .action((dir: string, opts: { overwrite?: boolean; project?: string }) =>
        wrap(() => runSkillsImport(dir, Boolean(opts.overwrite), opts.project))(),
    );

skills
    .command("promote")
    .description(
        "Reconcile the skill pack from a fresh BASELINE re-crawl — the only path that rewrites skills/. Refuses preview-sourced input.",
    )
    .option("--proposals <path>", "a verify run's skill-proposals.json — used as a drift gate + report, never copied")
    .option("--max-pages <n>", "maximum unique page states to map", "40")
    .option("--actuations-per-page <n>", "max controls to actuate per page", "6")
    .option("--project <slug>", PROJECT_OPT)
    .action((opts: { proposals?: string; maxPages: string; actuationsPerPage: string; project?: string }) =>
        wrap(() =>
            runSkillsPromote(
                opts.proposals ?? null,
                parsePositiveInt(opts.maxPages, 40),
                parsePositiveInt(opts.actuationsPerPage, 6),
                opts.project,
            ),
        )(),
    );

program
    .command("pr")
    .argument("<number>", "pull request number")
    .description("Phase 2: replay a PR's affected flows against its web preview deployment, with video.")
    .option("--base-url <url>", "target URL override (e.g. a specific preview deployment)")
    .option("--max-flows <n>", "maximum flows to replay", "12")
    .option("--project <slug>", PROJECT_OPT)
    .action((numberArg: string, opts: { baseUrl?: string; maxFlows: string; project?: string }) =>
        wrap(() =>
            runPr(
                parsePositiveInt(numberArg, 0),
                opts.baseUrl ?? null,
                parsePositiveInt(opts.maxFlows, 12),
                opts.project,
            ),
        )(),
    );

program
    .command("verify")
    .argument("<number>", "pull request number")
    .description("Phase 3: plan a browser test for a PR, run it on the preview (read-only, recorded), and judge it.")
    .option("--base-url <url>", "target URL override (e.g. a specific preview deployment)")
    .option("--plan-only", "generate and print the to-do plan without executing it")
    .option("--project <slug>", PROJECT_OPT)
    .action((numberArg: string, opts: { baseUrl?: string; planOnly?: boolean; project?: string }) =>
        wrap(() =>
            runVerify(parsePositiveInt(numberArg, 0), opts.baseUrl ?? null, Boolean(opts.planOnly), opts.project),
        )(),
    );

await program.parseAsync(process.argv);
