import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnvConfig, logger, SENTINEL } from "../index";
import { loadServerConfig } from "./config";
import { startHttpServer } from "./http";
import { startPoller, stopPoller } from "./poller";

function main(): void {
    const env = loadEnvConfig();
    const config = loadServerConfig();
    fs.mkdirSync(path.join(env.outputDir, "server"), { recursive: true });

    const server = startHttpServer(config.port);
    startPoller();

    logger.banner("dashboard");
    logger.success(`${SENTINEL.name} dashboard → http://127.0.0.1:${config.port}`);
    logger.info(`Watching registered repos for @-mentions every ${Math.round(config.pollMs / 1000)}s (read-only).`);

    let shuttingDown = false;
    const shutdown = (): void => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        logger.info("Shutting down ...");
        stopPoller();
        server.close(() => process.exit(0));
        // Don't let lingering SSE connections hold the process open forever.
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main();
