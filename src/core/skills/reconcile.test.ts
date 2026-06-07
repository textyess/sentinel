import assert from "node:assert/strict";
import { test } from "node:test";
import { previewSourceRefusal } from "./reconcile";

test("previewSourceRefusal allows a null signal (a plain re-crawl)", () => {
    assert.equal(previewSourceRefusal(null, "https://app.test"), null);
});

test("previewSourceRefusal refuses when the signal's source URL is the crawl target", () => {
    assert.match(
        previewSourceRefusal({ targetUrl: "https://app.test" }, "https://app.test/") ?? "",
        /Refusing to promote/,
    );
    assert.match(
        previewSourceRefusal({ targetUrl: "https://app.test/" }, "https://app.test") ?? "",
        /Refusing to promote/,
    );
});

test("previewSourceRefusal allows a preview source distinct from the baseline", () => {
    assert.equal(previewSourceRefusal({ targetUrl: "https://pr-11.preview.test" }, "https://app.test"), null);
});

test("previewSourceRefusal refuses host-case and default-port variants of the crawl target", () => {
    assert.match(
        previewSourceRefusal({ targetUrl: "https://APP.test" }, "https://app.test") ?? "",
        /Refusing to promote/,
    );
    assert.match(
        previewSourceRefusal({ targetUrl: "https://app.test:443/" }, "https://app.test") ?? "",
        /Refusing to promote/,
    );
});
