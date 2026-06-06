import * as fs from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { installReadOnlyGuard } from "../safety/read-only-guard";
import type { BlockedRequest, NetworkEvent, SafetyConfig } from "../types";
import { enableCursor } from "./cursor";

export interface DriverOptions {
    baseUrl: string;
    headless: boolean;
    safety: SafetyConfig;
    /** When set, a webm of the run is recorded here. */
    videoDir?: string;
    /** When set and the file exists, the context starts already authenticated. */
    storageStatePath?: string;
    viewport?: { width: number; height: number };
}

export interface DriverSession {
    browser: Browser;
    context: BrowserContext;
    page: Page;
    baseUrl: string;
    /** Mutating/telemetry requests the read-only guard prevented (populated during the run). */
    blocked: BlockedRequest[];
    /** Document/XHR/fetch responses observed during the run. */
    network: NetworkEvent[];
    /** Console errors and uncaught page errors observed during the run. */
    consoleErrors: string[];
    close(): Promise<{ videoPath: string | null }>;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const LOGGED_RESOURCE_TYPES = new Set(["document", "xhr", "fetch"]);
/** Console noise that is never PR signal — browser/extension chatter, not app errors. */
const CONSOLE_NOISE = /ResizeObserver loop|Non-Error promise rejection|extension:\/\//i;

/**
 * The deterministic substrate every phase drives through: a fresh Chromium
 * context with the read-only guard installed, service workers blocked (so no
 * request escapes interception), video recording, network capture, and optional
 * pre-authenticated storage state.
 */
export async function createSession(options: DriverOptions): Promise<DriverSession> {
    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    const browser = await chromium.launch({ headless: options.headless });

    try {
        const useStorageState =
            options.storageStatePath && fs.existsSync(options.storageStatePath) ? options.storageStatePath : undefined;

        if (options.videoDir) {
            fs.mkdirSync(options.videoDir, { recursive: true });
        }

        const context = await browser.newContext({
            baseURL: options.baseUrl,
            viewport,
            storageState: useStorageState,
            // context.route cannot intercept service-worker traffic, so block it
            // entirely — every request must flow through the page (and the guard).
            serviceWorkers: "block",
            recordVideo: options.videoDir ? { dir: options.videoDir, size: viewport } : undefined,
        });

        const blocked: BlockedRequest[] = [];
        const network: NetworkEvent[] = [];
        const consoleErrors: string[] = [];

        if (options.safety.readOnly) {
            await installReadOnlyGuard(context, options.safety, (event) => blocked.push(event));
        }

        // Only when recording: a visible cursor that glides to each click makes the video legible
        // (which click happened where, and the pointer travelling there).
        if (options.videoDir) {
            await enableCursor(context);
        }

        const page = await context.newPage();

        // A click during actuation might open a popup or trigger a download. Neither is
        // ever wanted: close popups (so no unguarded third-party flow runs) and cancel
        // downloads (so nothing hits disk or hangs the click).
        page.on("popup", (popup) => {
            popup.close().catch(() => {});
        });
        page.on("download", (download) => {
            download.cancel().catch(() => {});
        });
        page.on("console", (message) => {
            if (message.type() === "error") {
                const text = message.text();
                if (!CONSOLE_NOISE.test(text)) {
                    consoleErrors.push(text);
                }
            }
        });
        page.on("pageerror", (error) => {
            if (!CONSOLE_NOISE.test(error.message)) {
                consoleErrors.push(error.message);
            }
        });

        page.on("response", (response) => {
            const request = response.request();
            if (!LOGGED_RESOURCE_TYPES.has(request.resourceType())) {
                return;
            }
            network.push({
                method: request.method(),
                url: response.url(),
                status: response.status(),
                at: new Date().toISOString(),
            });
        });

        return {
            browser,
            context,
            page,
            baseUrl: options.baseUrl,
            blocked,
            network,
            consoleErrors,
            async close(): Promise<{ videoPath: string | null }> {
                const video = page.video();
                await context.close();
                await browser.close();
                if (!video) {
                    return { videoPath: null };
                }
                try {
                    return { videoPath: await video.path() };
                } catch {
                    // A run that closed before producing frames has no video path.
                    return { videoPath: null };
                }
            },
        };
    } catch (error) {
        await browser.close().catch(() => {});
        throw error;
    }
}
