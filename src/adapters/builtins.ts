/**
 * Built-in (first-party) adapter registration — the boundary between the
 * repo-agnostic engine and any app-specific adapter.
 *
 * The open-source core ships NO built-in: generic projects are configured
 * entirely from the dashboard. A deployment adds its own first-party app via a
 * gitignored overlay at src/adapters/private/index.ts that exports
 * `registerPrivateAdapters(register)`. It's loaded here if present and ignored
 * otherwise, so adding a first-party app never edits a tracked file or touches
 * core. See example.ts for the shape of a built-in adapter.
 *
 * The top-level await guarantees the overlay has registered before any consumer
 * resolves an adapter; the variable specifier keeps the public build compiling
 * when the overlay is absent.
 */
import { registerBuiltinAdapter } from "./registry";

const PRIVATE_OVERLAY: string = "./private/index";

try {
    const overlay = (await import(PRIVATE_OVERLAY)) as {
        registerPrivateAdapters?: (register: typeof registerBuiltinAdapter) => void;
    };
    overlay.registerPrivateAdapters?.(registerBuiltinAdapter);
} catch (error) {
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message ?? "";
    // Only swallow "overlay not found" — not a broken dependency inside the overlay.
    const isOverlayMissing =
        (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
        message.includes("private/index");
    if (!isOverlayMissing) {
        throw error;
    }
}
}
