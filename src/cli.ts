import { Command } from "commander";
import { runCrawl, runGuard, runLogin, runPr, runSiteMap, runSmoke, runVerify } from "./commands";
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

program.command("guard").description("Run the production / read-only preflight only.").action(wrap(runGuard));

program.command("login").description("Log in and save an authenticated browser session.").action(wrap(runLogin));

program
    .command("smoke")
    .description("Phase 0: boot -> log in -> screenshot -> report blocked writes.")
    .action(wrap(runSmoke));

program
    .command("crawl")
    .description("Phase 1: autonomously map the app into an interaction graph.")
    .option("--max-pages <n>", "maximum unique page states to map", "40")
    .option("--no-interact", "disable LLM-guided actuation (follow links only)")
    .option("--actuations-per-page <n>", "max controls to actuate per page when interacting", "6")
    .action((opts: { maxPages: string; interact: boolean; actuationsPerPage: string }) =>
        wrap(() =>
            runCrawl(
                parsePositiveInt(opts.maxPages, 40),
                opts.interact !== false,
                parsePositiveInt(opts.actuationsPerPage, 6),
            ),
        )(),
    );

program
    .command("sitemap")
    .description("Phase 1: synthesize a human-readable site map from the latest interaction graph.")
    .action(wrap(runSiteMap));

program
    .command("pr")
    .argument("<number>", "pull request number")
    .description("Phase 2: replay a PR's affected flows against its web preview deployment, with video.")
    .option("--base-url <url>", "target URL override (e.g. a specific preview deployment)")
    .option("--max-flows <n>", "maximum flows to replay", "12")
    .action((numberArg: string, opts: { baseUrl?: string; maxFlows: string }) =>
        wrap(() => runPr(parsePositiveInt(numberArg, 0), opts.baseUrl ?? null, parsePositiveInt(opts.maxFlows, 12)))(),
    );

program
    .command("verify")
    .argument("<number>", "pull request number")
    .description("Phase 3: plan a browser test for a PR, run it on the preview (read-only, recorded), and judge it.")
    .option("--base-url <url>", "target URL override (e.g. a specific preview deployment)")
    .option("--plan-only", "generate and print the to-do plan without executing it")
    .action((numberArg: string, opts: { baseUrl?: string; planOnly?: boolean }) =>
        wrap(() => runVerify(parsePositiveInt(numberArg, 0), opts.baseUrl ?? null, Boolean(opts.planOnly)))(),
    );

await program.parseAsync(process.argv);
