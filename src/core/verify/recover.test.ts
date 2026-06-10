import assert from "node:assert/strict";
import { test } from "node:test";
import {
    capConfidenceAfterReplan,
    hardFailureClass,
    isRecoverable,
    isReplacement,
    selfCorrectionVerdictNote,
} from "./recover";
import type { PlanStep, Verdict } from "./types";

function step(over: Partial<PlanStep>): PlanStep {
    return {
        action: over.action ?? "click",
        target: over.target ?? "Save settings",
        value: over.value ?? null,
        expect: over.expect ?? "settings saved banner",
        reason: over.reason ?? "exercise the PR change",
    };
}

test("hardFailureClass forces app-error on console errors", () => {
    assert.equal(hardFailureClass({ consoleErrors: ["TypeError: x is undefined"], networkErrors: [] }), "app-error");
});

test("hardFailureClass forces app-error on failed requests", () => {
    assert.equal(hardFailureClass({ consoleErrors: [], networkErrors: [{ url: "/api/x", status: 500 }] }), "app-error");
});

test("hardFailureClass returns null on a clean step (the model gets to triage)", () => {
    assert.equal(hardFailureClass({ consoleErrors: [], networkErrors: [] }), null);
});

test("isRecoverable rejects app-error and accepts the agent's own failure classes", () => {
    assert.equal(isRecoverable("app-error"), false);
    assert.equal(isRecoverable("agent-error"), true);
    assert.equal(isRecoverable("transient"), true);
    assert.equal(isRecoverable("precondition-lost"), true);
});

test("isReplacement: same action means the corrective step IS the retry", () => {
    assert.equal(isReplacement(step({ action: "click" }), step({ action: "click", target: "Preferences" })), true);
});

test("isReplacement: a different action is a precursor, so the original gets retried", () => {
    assert.equal(isReplacement(step({ action: "click" }), step({ action: "navigate", target: "/settings" })), false);
});

test("capConfidenceAfterReplan downgrades high to medium only on a replanned run", () => {
    const high: Verdict = { outcome: "pass", confidence: "high", summary: "s", evidence: [] };
    assert.equal(capConfidenceAfterReplan(high, true).confidence, "medium");
    assert.equal(capConfidenceAfterReplan(high, false).confidence, "high");
});

test("capConfidenceAfterReplan leaves medium/low untouched and preserves the outcome", () => {
    const low: Verdict = { outcome: "fail", confidence: "low", summary: "s", evidence: ["e"] };
    const capped = capConfidenceAfterReplan(low, true);
    assert.equal(capped.confidence, "low");
    assert.equal(capped.outcome, "fail");
    assert.deepEqual(capped.evidence, ["e"]);
});

test("selfCorrectionVerdictNote is empty for a clean run", () => {
    assert.equal(selfCorrectionVerdictNote(0, false), "");
});

test("selfCorrectionVerdictNote discloses recoveries and the replan", () => {
    const note = selfCorrectionVerdictNote(2, true);
    assert.match(note, /2 step\(s\)/);
    assert.match(note, /regenerated mid-run/);
    assert.match(selfCorrectionVerdictNote(1, false), /corrected its own/);
    assert.match(selfCorrectionVerdictNote(0, true), /regenerated mid-run/);
});
