# Analysis: self-hosting the PR branch instead of requiring a preview environment

**Status:** analysis only — no implementation.
**Date:** 2026-06-08
**Question:** Today the agent can only verify a PR if the repo deploys a preview environment for it. Many repos don't. How hard is it to let Sentinel start the project itself from the PR branch and test that instead?

---

## TL;DR

The honest answer: **starting a process is easy; producing a *working* app generically is hard, and running untrusted PR code inside Sentinel's container is a security change, not a feature.**

- A happy-path prototype for the *easy subset* of projects (self-contained frontends, or frontends that point at an existing shared backend, with no required secrets) is roughly **3–5 days**. The plumbing — checkout, install, run the dev command, wait for health, tear down — is small and reuses code that already exists.
- A version that works for *real* projects (env vars, secrets, lifecycle robustness, declarative config in onboarding) is **2–4 weeks**.
- Handling apps that need a backend + database + seed data is **multi-week to open-ended**, and is genuinely project-specific.
- Doing it *safely* — because you are now executing arbitrary PR-authored install/build/run scripts next to your GitHub token, LLM keys, and every other project's credentials — is its own **multi-week** workstream and likely forces an architectural change.

The blocker is not the mechanics of `npm run dev`. It's three things: **environment/secrets**, **backend dependencies**, and **untrusted-code isolation**. The preview-environment approach sidesteps all three by letting the project's own CI do the hard part. Any self-hosting design has to either reproduce that work or push it back to where the knowledge and secrets already live (the project's own CI).

My recommendation is a **declarative, opt-in "run recipe"** (fits the existing adapter/generic-config pattern cleanly) plus serious consideration of running the build/start in the **project's own GitHub Actions**, not in Sentinel's always-on container. Details and a phased plan below.

---

## How it works today (grounded in the code)

Sentinel never runs the target repo's code. It drives a browser against a URL that is *already serving*.

1. **Trigger** — `@sentinel` mention picked up by the poller (`src/server/poller.ts`) or a manual API/CLI call.
2. **Resolve the URL** — `resolveWebPreviewUrl(repo, headSha, previewEnvIncludes)` in `src/core/pr/github.ts` queries the **GitHub Deployments API** for the PR's head SHA, finds a deployment whose environment name contains the project's `previewEnvIncludes` substring (e.g. `"web"`) *and* `"preview"`, then returns the first deployment status with `state === "success"` and an `environment_url`. No ready preview → the run is **blocked** ("No ready preview deployment found for PR yet").
3. **Get the diff** — `gh pr diff <n> --name-only`, mapped to affected routes by the adapter's `affectedRoutes()`.
4. **Drive & judge** — point Chromium at that URL, run an LLM-planned set of steps, record video, judge pass/fail/uncertain, write `manifest.json`.

The whole safety story rests on the fact that **the target is a remote URL and Sentinel only makes network requests to it**:

- `production-guard.ts` inspects `adapter.resolveDatastoreTargets()` and forces read-only when it sees a production/remote target.
- `read-only-guard.ts` intercepts every Playwright request and blocks mutations except `allowedMutationPatterns` (auth only).

There is **no checkout, no install, no build, no spawn** anywhere in the verify path. The only nod to local bring-up is `ensureAppReachable()` in `src/core/bringup/app.ts` — an HTTP health-probe with a 60s timeout. Its docstring already names the gap:

> "For 'work in prod' this is usually instant (a running dev stack or a deployment); **a full local PR bring-up will hang here until the stack is healthy.**" — `src/core/bringup/app.ts:9-14`

And its error message literally tells a human to "Start it first — e.g. `pnpm dev:app`." So the seam for this feature already exists; it just expects a human (or a deployment) to have started the app.

---

## What "start the project yourself" actually requires

Decomposing the problem from "get the source" to "browser can drive a real app":

| # | Sub-problem | Difficulty | Why |
|---|---|---|---|
| 1 | **Acquire the source** | Easy | `gh pr checkout` into an isolated git worktree. Phase 2 in the roadmap already intended this ("`gh pr checkout` in an isolated worktree"). |
| 2 | **Install dependencies** | Easy–Medium | Detect the package manager from the lockfile (npm/pnpm/yarn/bun). Slow (minutes), can fail on private registries, native modules, or the wrong Node version. |
| 3 | **Know the start command + port** | Medium | Read `package.json` scripts, but which one (`dev` vs `start`) and on what port? Ports must be allocated and discovered, then handed to the browser as `baseUrl`. |
| 4 | **Provide environment variables** | **Hard** | Most apps refuse to boot, or boot broken, without env: API base URLs, feature flags, third-party keys. A preview already has these injected by the project's CI. Reproducing that generically is the crux. |
| 5 | **Provide secrets** | **Hard** | A subset of (4) but worse: DB passwords, OAuth client secrets, API tokens. Sentinel would need to *store and inject* these per project — new secret-management surface and new blast radius. |
| 6 | **Satisfy backend dependencies** | **Hard → open-ended** | A frontend usually needs an API + database + seed data + sometimes auth/payment providers. Options: point at a shared staging backend (then read-only really matters), or spin up the whole stack (docker-compose, migrations, seeds) — effectively reproducing the dev environment. |
| 7 | **Determine readiness** | Medium | `ensureAppReachable` proves the *socket* answers, not that the app is *healthy*. A 200 on `/` while the backend is missing is a false "ready" that yields a misleading verdict. |
| 8 | **Lifecycle & resources** | Medium | Spawn a process tree, capture its logs, enforce timeouts, kill on done/crash/timeout, reclaim ports, clean `node_modules` and worktrees. Heavy builds strain the single-process, concurrency-1 container. |
| 9 | **Isolate untrusted code** | **Hard / architectural** | See below — this is the big one. |

**Sub-problems 1–3 and 7–8 are the "days" part. Sub-problems 4–6 and 9 are the "weeks-to-open-ended" part.** Don't let the easy demo (a self-contained app that boots with `next dev`) create the impression the whole thing is a few days.

---

## The two things that make this genuinely hard

### 1. Reproducing the environment is the actual problem

The reason previews work is that the **project's own CI/CD already solved env + secrets + backend** for that repo. Vercel/Netlify/etc. inject the right variables and the app talks to the right (preview or shared) backend. Sentinel gets a finished, correct artifact for free.

Self-hosting means re-solving that per project. For a narrow class it's trivial (static site, or a frontend you can point at an existing staging API by setting one base-URL var). For the general case — an app that needs its own database with migrations and seed data, plus auth and third-party services — you are building "spin up an arbitrary team's dev environment from scratch, automatically." That is the same problem Gitpod, Codespaces, Nixpacks, and Railway's builders attack, and none of them fully automate it; they all rely on the project declaring how it builds and runs. Sentinel should not try to out-infer them.

There's also a **fidelity** cost: a locally-started instance is an *approximation* of the deployment, not the deployment. Different env, missing services, or stubbed backends produce false passes and false fails. The preview is the source of truth; a self-hosted instance is a best-effort stand-in. That's an acceptable trade for repos with *no* preview at all, but it should be a conscious one, and verdicts from self-hosted runs probably deserve a lower-confidence label.

### 2. You'd be executing untrusted code next to your secrets

This is the part most likely to be underestimated. Today Sentinel **never runs target-repo code** — it only sends HTTP to a URL. The moment you `npm install` and `npm run dev` on a PR branch, you execute arbitrary, attacker-controllable code:

- `postinstall`/build scripts run with the container's privileges.
- That container holds the **GitHub token (write-capable enough to comment on PRs), LLM API keys, and the stored credentials of every project Sentinel manages.**
- A malicious PR (or a compromised dependency) can read all of it and exfiltrate over the network.

The current architecture's selling point (per `DEPLOY.md`) is "outbound-only, no inbound, safe to point at prod read-only." Running untrusted PR code in the always-on poller process quietly discards that posture. This isn't covered by the existing read-only/production guards — those govern the *browser's* network traffic, not a spawned dev server. It's a **new threat axis**, and it intersects with the spirit of non-negotiable rule #2 ("never weaken the safety boundary").

Mitigations all cost real work: per-run ephemeral container/microVM, dropped/scoped secrets during build, egress allow-listing, no Sentinel credentials present in the build sandbox. Most of these imply splitting "build & run the PR" out of the always-on process into a disposable runner — an architectural change, not a function addition.

---

## What the codebase already gives us (and what's missing)

**Already there / reusable:**
- The worktree-checkout intent (Phase 2 roadmap) and `gh` plumbing in `src/core/pr/github.ts`.
- `ensureAppReachable()` — health-gate for "is it serving yet." Already written for this case.
- Container awareness: `SENTINEL_NO_SANDBOX`, headless Chromium, `/data` volume, Dockerfile with `gh`/`git`/`tini`.
- The adapter has `ports: PortMap` and `resolveDatastoreTargets()` — the right hooks to describe a locally-started app and feed the prod guard.
- The generic config + `ProjectRecord` + onboarding skill give a clean, established place to add per-project declarative settings without touching `core/`.
- `baseUrl` is already an injected override (`resolveAdapter` precedence: explicit → `project.baselineUrl` → env), so swapping in a locally-allocated URL is a one-line concept.

**Missing entirely:**
- Any process spawn / package-manager detection / build orchestration.
- Per-project secret storage and env-var injection for a *target app* (today env vars are Sentinel's own creds, not the app's runtime env).
- Backend/datastore bring-up.
- Untrusted-code isolation.
- A runner model that tolerates minutes-long heavyweight builds (current concurrency is 1 per always-on container).

---

## Design options

### Option A — Declarative "run recipe" executed in Sentinel's container
Add an optional `runRecipe` to the generic config / `ProjectRecord`: `{ packageManager?, installCmd, runCmd, port, readyPath?, envMap }`, plus a place to store the app's secrets. On verify, if no preview is found, check out the PR worktree, run install + run, wait on `ensureAppReachable`, point the browser at `http://localhost:<port>`, tear everything down after.

- **Pros:** fits the existing adapter/onboarding pattern; minimal core surface; the project owner supplies the knowledge Sentinel can't infer.
- **Cons:** executes untrusted code in the always-on process (security); doesn't solve backend bring-up by itself; resource pressure on the single container.

### Option B — Build/run in the project's own CI (GitHub Actions), Sentinel consumes the URL
Ship a reusable GitHub Action that the project adds once. On a `@sentinel` mention (or PR open), the Action builds and serves the branch *in the project's own CI*, where the env and secrets already live, exposes a temporary URL (tunnel or the Action's own preview), and reports it back. Sentinel just verifies that URL — exactly its current flow.

- **Pros:** **preserves Sentinel's security posture** (no untrusted code in Sentinel's container, no foreign secrets stored by Sentinel); env/secrets handled where they already exist; scales with the project's CI, not Sentinel's box.
- **Cons:** requires a one-time change in the target repo (less "no-code"); needs a URL-exposure mechanism; latency of a CI run.

This is effectively "help projects that lack a preview *gain a disposable one*," which is a smaller and safer problem than "reproduce any dev environment inside Sentinel."

### Option C — Fully automatic detection (no recipe), via a buildpack
Lean on Nixpacks/Railpack-style buildpacks to infer install/build/run automatically; no per-project config.

- **Pros:** closest to true "no-code."
- **Cons:** buildpacks infer *build/run*, not *env/secrets/backend* — so it still fails exactly where the hard part is, while adding a heavy dependency. Highest effort, lowest marginal payoff. **Recommend against as a starting point.**

---

## Recommendation

1. **Don't pursue Option C first.** Auto-inferring the run is the least valuable 80% and skips the hard 20% (env, secrets, backend).
2. **Build Option A as a tiered MVP, scoped to the tractable subset**, behind an explicit opt-in flag per project, and **treat self-hosted verdicts as lower-confidence** than preview-based ones. Start with: a declarative recipe, the easy frontends, and frontends that point at an existing shared/staging backend via one env var. This is the 3–5 day prototype → 2–4 week real-world version.
3. **Treat untrusted-code isolation as a first-class requirement, not a follow-up.** Even the MVP should run the build/start with Sentinel's own secrets (GitHub token, LLM keys, other projects' creds) *absent* from the environment, and ideally in a disposable sub-environment. If that means a separate ephemeral runner, design for it early — retrofitting isolation is painful.
4. **Seriously evaluate Option B in parallel**, especially for the security-sensitive and backend-heavy cases. For many teams, "add one GitHub Action" is an acceptable trade for not handing their repo's runtime secrets to a third-party bot, and it keeps Sentinel's clean outbound-only posture intact. A/B can coexist: recipe for simple repos, CI-offload for complex/sensitive ones, preview-detection when a preview exists.
5. **Keep `core/` repo-agnostic.** The recipe and any spawn logic belong in adapter/server land plus a new `core/bringup` module that takes a declarative recipe as input — never hard-coded per repo. Feed the locally-started app's backend target into `resolveDatastoreTargets()` so the production guard keeps working unchanged.

---

## Ideal onboarding flow (your vision, made concrete)

The self-hosting feature only matters if a non-technical user can set it up themselves. The right delivery vehicle is a **guided onboarding wizard** that branches on "do you have a preview?" — and the "no" branch is where the run-recipe from above gets captured.

### Why today's onboarding doesn't do this

The current `RegisterProjectDialog` (`components/projects/register-project-dialog.tsx`) is a single flat form, and it bakes in the preview assumption:

- `previewEnvIncludes` is a required-ish text field defaulted to `"web"` — there is **no "do you have a preview?" question at all**. The flow presumes one exists.
- **Auto-detect needs a live URL first.** The button calls `detect.ts`, which *observes a running app's login page* to propose config. So a user with no preview and no deployed URL has nothing to point it at — chicken-and-egg.

That's the UX gap you're describing. The fix isn't a tweak to the form; it's a stepwise flow with a real branch.

### The wizard

**Step 1 — Connect the repo.** User enters `owner/name` (later: a GitHub App install + repo picker). On continue, run a **bring-up scan** — an extension of the existing `scanRepo` (`src/core/onboard/repo-scan.ts`), which already reads repo files clone-free from the GitHub API to infer framework + `pagesPrefix`. Extend it to also detect: package manager (from the lockfile), `dev`/`start` scripts and the likely port, presence of `Dockerfile` / `docker-compose.yml`, the variable *names* in `.env.example`, and monorepo/workspace layout. This pre-fills everything downstream.

**Step 2 — Preview environment? (auto-answered, not just asked).** Don't make the user guess — Sentinel already has the machinery (`resolveWebPreviewUrl`) to look at recent PRs and check the GitHub Deployments API. Pre-fill the answer: *"We found preview deployments named `…-web-preview` on your recent PRs"* → default **Yes**; none found → default **No**. User can override.
- **Yes →** confirm `previewEnvIncludes`, validate live by resolving the latest PR's preview URL (green check), then jump to Step 5. This is the high-fidelity path, unchanged.
- **No →** go to Step 3.

**Step 3 — How to start your app (the no-preview branch).** Present the **run recipe** pre-filled from the Step 1 scan, editable: install command, run command, port, ready-check path. Two things the scan can't fully infer, so the user supplies them here:
- **Env vars / secrets** — show the names harvested from `.env.example`, ask for values of the ones needed to boot, flag the secret-looking ones, and store them as Sentinel-managed secrets (reusing the `env-api` plumbing).
- **Backend** — if `docker-compose.yml` was detected, offer *"start the whole stack with `docker compose up`"* as the recipe (this is the cleanest answer to the backend problem). Otherwise ask: no backend / point at an existing staging backend via one base-URL var / full stack via compose.

**Step 4 — Prove it (trial bring-up).** The agent checks out the default branch in an isolated sandbox, runs the recipe, waits on `ensureAppReachable`, and screenshots `/`. Stream the logs live — the SSE + `RunLog` infrastructure the autodetect flow already uses (`useLiveRun`) drops straight in. ✅ reachable → show the screenshot and move on; ❌ → show the failing step and captured logs so the user fixes the recipe *now*, not at the first PR. **This is the step that earns the phrase "the agent understands how to start your repo"** — it doesn't infer it by magic, it *proves* it by doing it once. It's also the first run of the untrusted-code sandbox, so the isolation requirements from the analysis above apply here first.

**Step 5 — Login & routes (shared by both branches).** Run the existing autodetect (`detect.ts`) against a live URL — the *preview* URL on the Yes branch, or the *freshly-started trial instance's* URL on the No branch. **This is the elegant part: the Step 4 trial doubles as the live URL that today's autodetect already needs.** Same code, just fed a different URL — the chicken-and-egg problem dissolves. `pagesPrefix` is already known from Step 1.

**Step 6 — Baseline & finish.** Run the baseline crawl (existing), show the sitemap, register the `ProjectRecord` (now also carrying the run recipe + secret references), and tell the user the `@sentinel` handle. Done.

### What's reusable vs. net-new

| Step | Mostly reuses | Net-new |
|---|---|---|
| 1 Connect repo | `scanRepo` (extend it) | bring-up fields (pkg manager, scripts, port, compose, `.env.example` names) |
| 2 Preview? | `resolveWebPreviewUrl` / Deployments API | the auto-answered branch UI |
| 3 Run recipe | `env-api` for secrets | recipe schema + capture UI; backend question |
| 4 Trial bring-up | `ensureAppReachable`, `useLiveRun`/SSE, `RunLog` | sandboxed checkout + run + teardown (the engine from Tiers 0/1/3) |
| 5 Login & routes | `detect.ts` autodetect (unchanged) | feed it the trial URL on the no-preview branch |
| 6 Baseline & register | crawl + `createProject` | persist the recipe in `ProjectRecord` |

The takeaway: **the only genuinely new heavy machinery is Step 3's recipe capture and Step 4's sandboxed trial.** Steps 1, 2, 5, 6 are mostly *rewiring detectors that already exist* into a stepwise flow. The wizard reframing is largely frontend over the current API — and it would noticeably improve onboarding even for repos that *do* have a preview.

### Calibrating "the agent understands how to start it"

Worth being precise about the expectation, because it sets the product promise: the agent **proposes** a recipe from the repo scan, **proves** it with a one-time trial bring-up, and **asks** for the few things it can't infer (secrets, backend choice). The trial is what converts "the user typed some commands" into "Sentinel has actually started this app and can do it again per PR." For self-contained and compose-based repos this feels close to magic; for repos needing bespoke secrets or external services, it's an honest guided dialog — which is still a large UX leap over today's flat form.

---

## Effort & complexity estimate

| Tier | Scope | Rough effort |
|---|---|---|
| **0 — Prototype** | Worktree checkout + pkg-manager detect + run a *configured* dev command + `ensureAppReachable` + port alloc + teardown, for a self-contained frontend. Happy path, no isolation, no secrets. | **3–5 days** |
| **1 — Usable for real frontends** | Declarative `runRecipe` schema in generic config / `ProjectRecord`; onboarding UI + CLI; per-project env/secret storage + injection; log capture; timeouts; crash handling; lower-confidence verdict labeling. | **2–4 weeks** |
| **2 — Backend/datastore bring-up** | docker-compose orchestration, migrations, seed data; wire local backend into `resolveDatastoreTargets()` so the prod/read-only guard stays correct. Project-specific. | **multi-week → open-ended** |
| **3 — Safe untrusted-code execution** | Ephemeral per-run sandbox (container/microVM), secret scoping/removal during build, egress allow-listing; likely split execution out of the always-on poller process. | **multi-week; partly architectural** |
| **Onboarding wizard** | Stepwise flow with the preview Yes/No branch; rewire `scanRepo` + Deployments-API + `detect.ts` into steps; recipe-capture + trial-bring-up UI (the trial engine itself is Tiers 0/1/3). | **~1–2 weeks** for the wizard shell + preview path; no-preview steps inherit the tiers above |
| **B — CI-offload alternative** | Reusable GitHub Action that builds/serves the branch in the project's CI and reports a URL back; Sentinel consumes it via the existing path. | **~1–2 weeks for a solid v1**, mostly outside Sentinel's core |

A *demo* is days. A feature that's *robust, general, and safe* is dominated by Tiers 2–3 (and/or Option B), not by Tier 0's mechanics.

---

## Risks & open questions

- **Security posture regression.** Running PR code in the always-on container is the single biggest risk; it can leak the GitHub token, LLM keys, and other projects' credentials. Must be designed for, not bolted on. (Touches non-negotiable rule #2.)
- **Fidelity.** A self-hosted instance ≠ the real deployment. How do we label/communicate lower confidence so a self-hosted "pass" isn't read as a deployment-grade guarantee?
- **Backend reality.** What fraction of target repos can actually run with *no* backend, or against a shared staging backend by setting one base-URL var? That fraction defines how much value Tier 1 alone delivers. Worth sampling real candidate repos before committing.
- **Resource model.** Heavy installs/builds vs. the single-process, concurrency-1 container. Do we need an ephemeral-runner architecture (which also helps isolation)?
- **Secret custody.** Are we comfortable *storing* customers' app secrets to inject them? Option B avoids this; Option A requires it.
- **Readiness ≠ health.** Need a stronger signal than "socket answers" before judging, or verdicts will be polluted by half-booted apps.
- **Cleanup guarantees.** Orphaned processes, leaked ports, ballooning disk from worktrees + `node_modules` across runs.

## Suggested next step

Before any build: pull a sample of, say, 10–15 real candidate repos that lack previews and classify each by *how* it would have to be brought up (self-contained / shared-backend-via-env / needs-full-stack / needs-secrets). That single data point decides whether Tier 1 (Option A) is enough, whether Option B is the better bet, and how much of Tier 2 you can't avoid. Happy to run that classification next if you want.
