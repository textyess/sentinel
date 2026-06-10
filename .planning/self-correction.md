# Self-correction during verify runs

> Status: **Implemented** (Tier A step recovery + Tier B bounded replan).
> Created: 2026-06-10. Owner: Luis. Companion to `skills-execution-and-self-learning.md`.

Before this, `executePlan` was a one-shot linear run: a bad plan flowed through to the
verdict with no way to recover, even when the failure was plainly Sentinel's own mistake
(wrong page, misnamed control, lost precondition). Self-correction fixes that — without
ever correcting away the failures a QA run exists to catch.

---

## The core principle (what makes it safe)

The preview is the **changed app**, so "this step failed" is often *the PR's bug — the
very evidence the verdict is judging*. An over-eager recovery would launder regressions
into passes. Three non-negotiables fall out of that:

1. **Classify before correcting.** Every failed step is triaged (`recover.ts`):
   `app-error` (page broken, or the expectation simply isn't met on the right page),
   `agent-error`, `transient`, or `precondition-lost`. Only the agent's own failure
   classes are recoverable — `app-error` is NEVER recovered and stays in the evidence.
   Hard, non-LLM override: a step with console exceptions or failed requests is
   `app-error` without asking the model (`hardFailureClass`). Triage falls back to
   `app-error` on any model error, so classification can only fail safe.
2. **Recovery adds no capability.** Corrective and replanned steps are ordinary
   `PlanStep`s executed through the same `executeStep` path — destructive-control block,
   read-only network guard, and pacing all apply untouched. The recovery/replan prompts
   repeat the STRICT read-only rule (the replanner extends the planner's `PLAN_SYSTEM`
   verbatim, so the rules stay single-sourced).
3. **Everything is disclosed; nothing is silently healed.** Extra steps carry
   `origin: "recovery" | "replan"` (+ `recoveredFrom`), abandoned steps become `skipped`
   results, the manifest records `recoveries`/`replanned`, the judge prompt gets a
   self-correction note and origin tags, and a replanned run's confidence is capped at
   "medium" (`capConfidenceAfterReplan`) — recovery may rescue the run, never the
   verdict's certainty. The report page shows a "Sentinel corrected itself" card and
   tags the affected steps.

## Tier A — step-level recovery (`recover.ts`)

On a recoverable failure, the model proposes **at most one** grounded corrective step
(live controls + current route as grounding). Same action as the failed step = a
replacement retry (e.g. "the control is called 'Preferences'"); a different action
(e.g. "navigate back first") = a precursor, after which the original step gets one
retry. Budget: 1 attempt per failed step, `SENTINEL_MAX_RECOVERIES` (default 3) per run;
an attempt is only spent when a corrective step actually executes.

## Tier B — one bounded mid-run replan (`replan.ts`)

`REPLAN_AFTER_CONSECUTIVE_FAILURES` (2) consecutive unrecovered failures mean the PLAN
misread the app. The remaining steps are abandoned (recorded as `skipped`), and the
reasoner plans a revised remainder from wherever the browser actually is — given the PR,
the unchanged goal, everything executed so far, the abandoned steps, live controls, and
the same skills text the original planner saw (threaded through `PlanResult.skillsText`).
Budget: `SENTINEL_MAX_REPLANS` (default 1); the attempt is spent even when the replanner
returns nothing, so a collapsing run can't loop. The replan prompt explicitly says: if
the outcomes look like the app is broken, assert the breakage — don't route around it.

## Knobs

- `SENTINEL_SELF_CORRECT` (default true) — disable to get the old verbatim linear run
  (`selfCorrect: null` in `ExecuteOptions`).
- `SENTINEL_MAX_RECOVERIES` (default 3), `SENTINEL_MAX_REPLANS` (default 1). `numEnv`
  treats 0 as unset, so disabling goes through `SENTINEL_SELF_CORRECT`.

## Synergy with self-learning

Recovery steps run through the same discrepancy detection as planned steps, so a
recovery caused by baseline drift (stale selector, moved destination) still lands in
`skill-proposals.json` — detection-only, zero writes to `skills/`, exactly as
`skills-execution-and-self-learning.md` mandates.
