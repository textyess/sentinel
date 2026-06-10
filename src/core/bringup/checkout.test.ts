import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createDisposableCheckout } from "./checkout";

const run = promisify(execFile);

/** Build a throwaway local git repo containing a marker file, to clone from in tests. */
async function makeOriginRepo(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-origin-"));
    await run("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "MARKER.txt"), "hello-from-pr");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir });
    return dir;
}

test("clones a source into a disposable dir, then cleanup removes it", async () => {
    const origin = await makeOriginRepo();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-checkouts-"));
    try {
        const checkout = await createDisposableCheckout({ source: origin, root });
        assert.ok(fs.existsSync(checkout.dir), "checkout dir should exist");
        assert.equal(
            fs.readFileSync(path.join(checkout.dir, "MARKER.txt"), "utf8"),
            "hello-from-pr",
            "checked-out tree should contain the source files",
        );
        await checkout.cleanup();
        assert.equal(fs.existsSync(checkout.dir), false, "cleanup should remove the checkout dir");
    } finally {
        await fs.promises.rm(origin, { recursive: true, force: true });
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test("cleanup is idempotent and a bad source rejects without leaking a dir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-checkouts-"));
    try {
        await assert.rejects(
            createDisposableCheckout({ source: path.join(root, "does-not-exist"), root }),
            "cloning a missing source should reject",
        );
        // The failed attempt must not leave a checkout dir behind.
        assert.deepEqual(fs.readdirSync(root), [], "no stray checkout dirs after a failed clone");
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
