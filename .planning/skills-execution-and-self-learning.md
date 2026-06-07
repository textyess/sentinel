# Skills at execution time + continuous self-learning

> Status: **Phase A in progress** (the rest planned, not implemented).
> Created: 2026-06-07. Owner: Luis. Tracking: this doc (supersedes the "issue #11" option).

Make the navigation skill pack do two new things during a PR verify run:

1. **Feature 1** — reach the *executor*, not just the planner, so steps re-use the exact
   selectors the baseline crawl recorded.
2. **Feature 2** — notice when a skill has drifted from live behavior and record that as
   inert signal, **without ever writing to `skills/` from a verify run.**

---

## The core principle (what makes it safe)

Verify runs against the **PR preview = the changed app**, while skills are derived from the
**baseline (production) crawl**. So a "this button goes to the wrong page" discrepancy is
*usually the PR's intended change* — the very thing the verdict is judging — **not** a stale
skill. Two non-negotiables fall out of that:

1. **A verify run never writes to `skills/`.** Self-learning during a PR review only ever
   produces an inert `skill-proposals.json` in the run directory (same redacted, disposable
   family as `manifest.json`). The *only* writer of canonical skills stays
   `generateSkillPack`, reachable only from the baseline crawl. Enforced structurally: the
   verify path imports nothing from `generate.ts`/`author.ts`.
2. **A discrepancy degrades confidence and feeds the verdict — it is never silently
   "self-healed."** The step still executes against live behavior (so a real regression
   still shows), and the divergence is recorded + surfaced to the judge as "baseline expected
   X, preview showed Y — weigh against the PR claim," never auto-treated as a defect or a fix.

So "continuous learning" happens, but a proposal only becomes a real skill change **out of
band** — re-derived from a fresh baseline crawl after merge (or an explicit human accept),
never copied from a preview.

---

## Feature 1 — Load the page's skill during execution (low-risk, ships alone)

Today skills only reach the **planner** (`verify/run.ts:121` → `generatePlan`). This makes
them available to the **executor** too:

- A new `loadPageSkillIndex(outputDir, adapterId, graph, routes)` in `skills/load.ts` builds
  a per-route `PageSkill` lookup. **Key refinement:** it reads the selectors / destinations /
  destructive flags straight from the **baseline graph's `PageNode.controls`** (verbatim
  `control.selectors`, `control.href`), and uses `pack.json` / `imported.json` only to map a
  live route → owning skill. So execution never re-parses SKILL.md prose — the exact data
  stays exact.
- `executeStep` computes the live route key, looks up the page skill, and for `click` / `type`
  **prefers the skill's exact selector first, with the live `extractControls` selectors as
  fallback** (`clickBySelectors` already self-heals down the list). Always still routed through
  the existing destructive-block + read-only guard — skills only *add* candidate selectors,
  never bypass safety.
- For `navigate`, it passes the skill's expected destination so a clicked link's landed route
  can be compared to what the skill said.
- Fully additive: `null` skill index → today's behavior, unchanged.

---

## Feature 2 — Continuous self-learning (detection-only during the run)

While executing, capture skill-vs-live divergences as structured signal (no new browser
actions):

- **Three discrepancy kinds:** `selector-stale` (skill selector failed but the live one for
  the same control worked), `missing-control` (skill names a control the page no longer has),
  `destination-drift` (a clicked link landed on a different templated route than the skill
  expected).
- **Only learn from a real user action** — recorded only when the agent actually clicked
  through (`navigate` method `click` / `click-path`), never from a URL-bar fallback.
- Discrepancies become step observations, feed a one-line note into the verdict prompt, and —
  if any exist — get written to `${runDir}/skill-proposals.json` (redacted, hrefs
  query-stripped, stamped with PR #, headSha, baseline gitSha, target URL, `status:
  "proposed"`). The run/report page shows a "skill may be out of date" note. **Zero writes to
  `skills/`.**
- **Promotion** (the only thing that mutates `skills/`) is a separate `skills reconcile` /
  `promote` step: re-crawl the **baseline** read-only, re-run `generateSkillPack` for the
  drifted routes, re-emit the code-owned Selectors / Destructive / Safety, re-validate — and
  refuse any input whose source URL is the PR preview. Human-accept or post-merge gated, never
  auto.

---

## Phased rollout (each phase is shippable on its own)

| Phase | What | Risk |
|---|---|---|
| **A** | `loadPageSkillIndex` as pure data from the graph + unit tests | none (no wiring) |
| **B** | Thread it into `executeStep` / `navigate` — selector-first + expected destination (Feature 1) | low, additive |
| **C** | In-memory discrepancy detection (no disk writes) | low |
| **D** | Write inert `skill-proposals.json` + surface in the verdict/report | low — still zero `skills/` writes |
| **E** | `skills reconcile` / `promote` — the only path that edits `skills/`, baseline-gated | the careful one |

A–B alone is a real win (faster, more stable execution) with no learning-loop risk; C–D add
visibility; E is where the human/automation policy gets decided.

---

## AI SDK "agent skills" alignment

Reference: <https://ai-sdk.dev/cookbook/guides/agent-skills>

The Vercel AI SDK's agent-skills guide describes a **pattern**, not an importable API: a
`SKILL.md` (YAML frontmatter `name` + `description`, Markdown body), progressive disclosure
(load names+descriptions first, then the full body when a task matches via a `loadSkill`
tool), and bundled `scripts/` `references/` `assets/`. Loaded shape:
`{ skillDirectory, content }`.

How this maps onto Sentinel:

- **Already aligned.** Our pack mirrors a `.claude/skills/` layout (`skills/types.ts`):
  `SKILL.md` with `name` + `description` frontmatter, prose body, bundled screenshots. A
  generated skill drops straight into another agent's skill dir — including an AI-SDK agent
  using this exact pattern. No change needed to be compatible.
- **The prose/progressive-disclosure half is the *planner* path** (`loadSkillsForRoutes` →
  `generatePlan`). That is the moral equivalent of the AI SDK's `loadSkill` → prompt
  injection; we select by route-overlap deterministically instead of letting the model pick,
  which is the right call for a safety-bounded QA agent (deterministic, auditable).
- **Phase A is intentionally NOT the AI-SDK loader.** The executor needs *exact selectors*,
  not prose. Re-parsing SKILL.md to recover a selector would lose precision and contradict the
  core principle ("the exact data stays exact"). `loadPageSkillIndex` therefore reads the
  structured `ControlRef`s from the baseline graph and uses the pack only for route → slug
  provenance. This is a complement to the AI-SDK pattern, layered beneath it, not a
  replacement.

---

## Code-grounded validation (verified against the tree, 2026-06-07)

- ✅ **"Skills only reach the planner" is true.** `verify/run.ts:121` feeds
  `loadSkillsForRoutes` into `generatePlan`; `executePlan` / `ExecuteOptions`
  (`verify/execute.ts:16`) receive only the `graph`. Feature 1 is the missing wire.
- ✅ **The structural firewall holds today.** The entire `verify/` path imports exactly one
  thing from skills — `loadSkillsForRoutes` from `skills/load.ts` (`run.ts:16`) — and
  `load.ts` imports only `skills/types`. Nothing in `verify/` reaches `generate.ts` /
  `author.ts`. Keeping `loadPageSkillIndex` in `load.ts` preserves this.
- ✅ **`loadPageSkillIndex` reading the graph verbatim is feasible.** `ControlRef`
  (`graph/types.ts:9`) already carries `selectors: string[]`, `href`, `destructive`, `kind`
  on every `PageNode.controls`. We reuse `ControlRef` directly — no parallel type.
- ✅ **Selector-first + self-heal works.** `clickBySelectors(page, selectors[], timeoutMs)`
  (`browser/interact.ts:26`) already walks a ranked list.
- ✅ **Greenfield.** No `loadPageSkillIndex` / `skill-proposals` / discrepancy code exists yet.

### Gaps the original plan understated

1. **`NavOutcome` has no structured landed-route field** (`verify/navigate.ts:16` is
   `{ method, ok, observation }`; the landed route is only embedded in observation strings).
   Feature 1's "compare landed route to the skill's expected destination" and Feature 2's
   `destination-drift` need a small structured addition (`landed?: string` +
   `expectedDestination` threaded into `NavigateOptions`). **Belongs to Phase B**, not A.
2. **Phase E is two new capabilities, not one.** `runCrawlForProject` (`crawler/run.ts:51`,
   `RunCrawlArgs`) has no route allow-list, **and** `generateSkillPack` (`skills/generate.ts:140`)
   regenerates the whole pack via `groupByArea(graph)` with no per-area scoping. Ship Phase E
   with a **full** re-crawl + full re-gen first; add route-scoping to both later.
3. **`StepResult` needs a discrepancy field** (`verify/types.ts:24`) for Feature 2; that
   ripples into the manifest schema and the report page. **Phase C/D.**

### Working-tree caveat

The branch `luisbeqja/study-phase-breakdown` is mid-flight on an adjacent skills-via-dashboard
effort: `load.ts`, `types.ts`, `generate.ts`, `verify/run.ts`, `verify/types.ts`, server
`runner.ts` / `api.ts` / `sse.ts`, and new `app/api/projects/[id]/skills/` routes are all
uncommitted. Phase A's `load.ts` change is purely additive (a new exported function appended
to the file) to minimize tangling with that WIP.

---

## Open questions + grounded answers

1. **Promotion trigger** (Phase E): dashboard button, `sentinel skills promote` CLI, or an
   automatic post-merge gate (headSha is an ancestor of `main`)? → CLI-first (the `skills`
   surface is `generate` / `export` / `import` today; no `reconcile` / `promote` yet), but
   note nascent dashboard infra already exists (`app/api/projects/[id]/skills/route.ts`,
   `.../skills/export/route.ts`). Keep all three open; ship CLI + manual first.
2. **Scoped re-crawl** (Phase E): confirmed needed and it's *two* allow-list additions
   (`RunCrawlArgs` **and** `generateSkillPack`). Ship full re-crawl/re-gen first.
3. **Click-step destination drift**: detect drift on `click` steps that change the route, not
   just `navigate` steps? Recommended, but depends on the structured `landed` field from gap
   #1 landing first (click steps go through `extractControls` + `clickBySelectors`, not
   `navigateLikeUser`).

---

## Decisions log

- **Test runner: `node:test` via `tsx`.** The repo has zero tests and no test dependency.
  Node 22 ships a stable built-in runner; running it through `tsx` keeps the "ESM, run via
  tsx" convention with **no new dependency**. A `test` script is added to `package.json`.
- **`PageSkill` reuses `ControlRef` verbatim** (no parallel control type) to honor "the exact
  data stays exact."
- **Control dedup is by full identity** (role + name + href + kind + the exact selector list),
  so only a genuinely identical control seen on two page states collapses. Two distinct
  nameless controls keep their separate selectors, and a control whose selectors shifted
  between states contributes both sets — nothing recorded is dropped (every selector widens the
  executor's self-heal pool). *(Hardened after the Phase A review — the first cut keyed on
  role + name + href only, which collapsed nameless icon-buttons and discarded shifted
  selectors.)*
- **Shared-route owner precedence: pack over imported.** A route owned by both a pack area and
  an imported skill is attributed to the locally-generated pack. Only the `skillSlug`
  provenance differs; controls come from the graph and are identical either way.
- **`PageSkill.controls` alias the graph's `ControlRef` objects by reference** (no clone) — safe
  for Phase A (read-only). **Phase B note:** when the executor mutates a control (e.g. appends a
  healed selector), clone it or treat the array as readonly first.
- **`loadPageSkillIndex` never filters destructive controls** — it surfaces the `destructive`
  flag so the executor's existing destructive-block guard stays the single enforcement point.
- **`null` when no skill pack/imported index selects for the affected routes**, mirroring
  `loadSkillsForRoutes`'s null contract → Feature 1 is a pure enrichment that activates only
  after `sentinel skills` has run.

## Progress log

- **2026-06-07** — Phase A implemented: `loadPageSkillIndex` (+ helpers, `PageSkill` /
  `PageSkillIndex` types) in `skills/load.ts`, with `node:test` unit tests and a `test` script.
  An adversarial multi-agent review (5 dimensions → per-finding refutation) ran: 8 in-scope
  findings confirmed and applied (dedup-key correctness fix, +9 tests, precedence docs), 4
  correctly rejected. Gate green: 16 tests pass, `tsc --noEmit` clean, biome clean. Not yet
  wired into the executor — that is Phase B.
- **2026-06-07** — Phase B implemented: `NavOutcome.landed` (structured, threaded through every
  return in `navigate.ts`); `ExecuteOptions.pageSkills`; exported `candidateSelectors`
  (skill-selectors-first + live fallback, deduped, matched by role+name+href) used for
  click/hover/type/select; `loadPageSkillIndex` built + logged in `run.ts`; `pageSkillsUsed` added
  to the manifest. Safety unchanged — the live control still clears the destructive guard; the
  skill only *adds* candidate selectors. +5 unit tests. Gate green (21 tests, `tsc` clean, biome
  clean, no null bytes). Integration-checked against the real `textyess-sentinel` baseline graph:
  `/campaigns` → campaigns skill (24 controls, verbatim ranked selectors, destructive flags
  preserved); child `/campaigns/:id` selects the same area; `/nonexistent` → null. Next: Phase C
  (record skill-vs-live discrepancies; consumes `NavOutcome.landed` for destination-drift).
- **2026-06-07** — Phase C implemented: pure `verify/discrepancy.ts` (`matchedSkillControl`,
  `selectorStale`, `missingControl`, `destinationDrift`), new `SkillDiscrepancy` / `DiscrepancyKind`
  types and an optional `StepResult.discrepancies`. `interact.ts` gained tracked
  `clickBySelectorsTracked` / `fillBySelectorsTracked` (return the winning selector; the boolean
  variants are now thin wrappers, so `navigate.ts` is untouched). `executeStep` detects all three
  kinds from **real actions only** — nav drift gated on method click/click-path; click-step drift on
  a route-changing href; selector-stale when self-heal fell through to a live selector; missing-control
  when the skill knew the page but the control is gone — attaches them to the step and notes them in
  the observation. Detection-only; no `skills/` writes (discrepancies do ride along in the run
  manifest, which is expected — the dedicated proposals file + verdict note come in Phase D). +7 unit
  tests. Gate green (28 tests, `tsc` clean, biome clean, no null bytes). Next: Phase D.
- **2026-06-07** — Phase D implemented: `verify/proposals.ts` (`buildSkillProposals` — deduped,
  counted-by-kind, stamped with PR#/headSha/baseline gitSha/target URL/`status:"proposed"`; plus
  `discrepancyVerdictNote`). `run.ts` writes the inert, redacted `${runDir}/skill-proposals.json`
  when any discrepancy exists (**never** to `skills/`) and logs a warning; `judgeVerdict` feeds the
  drift note into the verdict prompt (framed as divergence-from-baseline to weigh, not a defect).
  Server passthrough: `StepResultView.discrepancies` (server + frontend `lib/types.ts`) +
  `toStepResultView`. Report: a "Navigation skill may be out of date" note on the run-report page
  listing the drift. +4 unit tests. Gate green (32 tests, full-project `tsc` incl. frontend `.tsx`,
  biome clean, no null bytes). Verified the on-disk artifact serializes through `redactSecret`.
  Next: Phase E (the careful one — baseline-gated `skills reconcile`/`promote`).
- **2026-06-07** — Phase E implemented: `core/skills/reconcile.ts` — `previewSourceRefusal` (the
  safety gate: refuse promoting when the drift signal's source URL equals the crawl target) and
  `reconcileSkillPack` (re-crawl the BASELINE read-only, re-derive via `generateSkillPack` — the
  only non-`runSkills` path that rewrites `skills/`, never copying preview data). CLI `skills promote
  [--proposals <path>] [--max-pages] [--actuations-per-page]` wired via `runSkillsPromote`. Ships full
  re-crawl + full re-gen (route-scoping deferred per open Q2). +3 gate unit tests; `skills promote
  --help` registered and verified. Gate green (35 tests, `tsc` clean, biome clean, no null bytes).
  **All phases A–E implemented.** Final comprehensive adversarial review next, then stop.
- **2026-06-07** — B–E adversarial review (5 dimensions, 25 agents, per-finding refutation): 16 of 20
  confirmed (collapsing to ~5 distinct issues), 4 correctly rejected. Applied:
  1. **`missingControl` over-fired** (medium) — it flagged drift for any skill-covered route even when
     the skill never named the target (LLM-hallucinated target / PR-added control). Now requires the
     skill to have recorded a control whose name resembles the target.
  2. **Login/failed-nav false drift** (medium) — navigate + click destination-drift fired on a bounce
     to login. Navigate now gates on `isSuccessfulClick(method, ok)`; click-step gates on
     `!isLoginPath(...)`.
  3. **`previewSourceRefusal` case/default-port evasion** (low, safety gate) — now normalizes via URL
     `origin`+path so `https://APP.test` / `:443` variants of the crawl target are still refused.
  4. **`runSkillsPromote` unvalidated proposals JSON** (low) — validates `targetUrl`/`proposals` shape
     before it feeds the gate, with a clear error.
  +5 tests (missing-control no-match, selector-stale multi-selector, `isSuccessfulClick`, case/port
  refusal, empty matched selectors). Acknowledged-but-deferred: `executeStep`-level integration tests
  (it isn't exported; the gating decisions were extracted into the now-tested pure helpers instead).
  **Feature complete.** Final gate green: 40 tests, `tsc` clean, `npm run lint` clean (143 files), no
  null bytes.
</content>
</invoke>
