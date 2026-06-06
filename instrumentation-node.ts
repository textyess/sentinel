// Node-only boot work. Imported exclusively from instrumentation.ts under the
// `NEXT_RUNTIME === "nodejs"` guard, so the heavy engine (Playwright, etc.) is never
// part of the edge instrumentation bundle.
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnvConfig } from "@/src/index";
import { startPoller } from "@/src/server/poller";

const env = loadEnvConfig();
fs.mkdirSync(path.join(env.outputDir, "server"), { recursive: true });
startPoller();
