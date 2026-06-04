# Sentinel — `@textyess/qa-agent`

An autonomous, persona-driven browser agent that **learns the app** by exploring it, then **tests PRs** by spinning them up, walking the affected flows in a real browser, recording video, and emitting a verdict on whether the PR makes sense.

Built as a repo-agnostic **core** + per-repo **adapters**, so the same engine can target other repositories later. TextYess is target #1.


## Status

Repo-agnostic core (`src/core/`) + per-repo adapter (`src/adapters/textyess.ts`). All runs are read-only against prod: a fail-safe **production preflight** + a **read-only network guard** (mutations fulfilled locally, never sent), with popups/downloads killed.

- **Phase 0 — foundation.** `guard` (preflight), `login`, `smoke`. Playwright driver with video + network/console capture + saved session; multi-step auth bootstrap.
- **Phase 1 — learn & map.** `crawl` → bounded BFS into an interaction graph (page-state nodes + ranked selectors + nav edges + screenshots), plus LLM-guided actuation (click expanders/tabs to reveal more). `sitemap` → readable Markdown map from the graph.
- **Phase 2 — PR replay.** `pr <N>` → resolve the PR's Vercel preview, map the diff to routes, re-walk the affected flows with video + console/network/control-diff vs the baseline + a redacted manifest.
- **Phase 3 — verify.** `verify <N>` (`--plan-only`) → the LLM plans a read-only browser test from the PR, a goal-directed executor runs it on the preview (navigate/click/type/assert, resolving the PR's new controls live, vision asserts), records video, and judges `pass / fail / uncertain` with evidence.

LLM via the Vercel AI SDK (Anthropic / OpenAI / **Bedrock**). Human-like pacing (think-pauses + adaptive dwell). Every LLM run prints its token cost and, with `LANGFUSE_*` set, exports one Langfuse trace per run.

## Setup

```bash
cp apps/qa-agent/.env.example apps/qa-agent/.env
# edit apps/qa-agent/.env: set SENTINEL_EMAIL / SENTINEL_PASSWORD and SENTINEL_BASE_URL
pnpm install
# one-time, if Playwright's Chromium isn't installed yet:
pnpm --filter @textyess/qa-agent exec playwright install chromium
```

`SENTINEL_BASE_URL` can be a local web app (`http://localhost:3000`, backed by `apps/web/.env`) or a deployed dashboard. Against prod, the seeded `onboarded-user@textyess.com` does **not** exist — supply a real account.

## Commands

```bash
# Safety preflight only — no browser, no app needed. Reports if a prod DB is in play.
pnpm --filter @textyess/qa-agent guard

# Log in once and save the authenticated session.
pnpm --filter @textyess/qa-agent login

# Phase 0 smoke: boot -> log in -> screenshot -> report blocked writes.
pnpm --filter @textyess/qa-agent smoke

# Typecheck.
pnpm --filter @textyess/qa-agent typecheck
```

Artifacts (videos, screenshots, sessions) land in `apps/qa-agent/.sentinel/` (gitignored).

## Safety model

Two independent signals decide whether to clamp to read-only, and **either one** is enough:

1. **Production preflight** scans every datastore/endpoint this run can touch — `apps/api/.env` `DB_SERVER`, `apps/brain0/.env` `MONGODB_URL` / `DATABASE_URL` / `NESTJS_API_URL`, the browser's API origin (`apps/web/.env` `NEXT_PUBLIC_BASE_URL`), and the target URL — against the adapter's `productionMarkers`.
2. **Remote-host fail-safe** — any target host that isn't local (`localhost`/`127.0.0.1`/`*.local`) is treated as potentially production, so an *undetected* prod host (e.g. `app.textyess.com`) can never become a silent write path.

When either fires, Sentinel **forces read-only** regardless of `SENTINEL_READ_ONLY`. The only way to enable writes against a prod/remote target is `SENTINEL_ALLOW_PROD_WRITES=true`. A fail-closed adapter (`failClosedOnProduction: true`) hard-stops instead; the TextYess adapter (prod approved for now) clamps to read-only.

The **read-only network guard** then aborts mutating requests in the browser (matching the auth allowlist against the URL *path* only, so query-string tricks can't smuggle a write), and **service workers are blocked** so no request escapes interception. Even a misclick on a destructive control can't reach the server.

## Layout

```
src/
  core/            # repo-agnostic engine
    safety/        # production-guard, read-only-guard, redact
    browser/       # Playwright driver (video, network capture, guard)
    auth/          # login recipe + storageState
    bringup/       # app reachability
    config.ts      # env + paths
    types.ts       # RepoAdapter contract
  adapters/        # per-repo config — textyess.ts holds all TextYess specifics
  commands.ts      # guard / login / smoke
  cli.ts           # `sentinel` CLI
```
