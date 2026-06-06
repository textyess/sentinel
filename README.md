# Sentinel

An autonomous, persona-driven browser agent that **learns an app** by exploring it, then **tests PRs** by spinning them up, walking the affected flows in a real browser, recording video, and emitting a verdict on whether the PR makes sense.

Built as a repo-agnostic **core** + per-app **adapters**, so the same engine can target any web app. Read-only by design — safe to point at a live environment.

## Status

Repo-agnostic core (`src/core/`) + per-app adapter (`src/adapters/`). All runs are read-only: a fail-safe **production preflight** + a **read-only network guard** (mutations fulfilled locally, never sent), with popups/downloads killed.

- **Phase 0 — foundation.** `guard` (preflight), `login`, `smoke`. Playwright driver with video + network/console capture + saved session; multi-step auth bootstrap.
- **Phase 1 — learn & map.** `crawl` → bounded BFS into an interaction graph (page-state nodes + ranked selectors + nav edges + screenshots), plus LLM-guided actuation (click expanders/tabs to reveal more). `sitemap` → readable Markdown map from the graph.
- **Phase 2 — PR replay.** `pr <N>` → resolve the PR's preview deployment, map the diff to routes, re-walk the affected flows with video + console/network/control-diff vs the baseline + a redacted manifest.
- **Phase 3 — verify.** `verify <N>` (`--plan-only`) → the LLM plans a read-only browser test from the PR, a goal-directed executor runs it on the preview (navigate/click/type/assert, resolving the PR's new controls live, vision asserts), records video, and judges `pass / fail / uncertain` with evidence.

LLM via the Vercel AI SDK (Anthropic / OpenAI / **Bedrock**). Human-like pacing (think-pauses + adaptive dwell). Every LLM run prints its token cost and, with `LANGFUSE_*` set, exports one Langfuse trace per run.

## Setup

```bash
cp .env.example .env
# edit .env: set SENTINEL_EMAIL / SENTINEL_PASSWORD and SENTINEL_BASE_URL
pnpm install
# one-time, if Playwright's Chromium isn't installed yet:
pnpm exec playwright install chromium
```

`SENTINEL_BASE_URL` can be a local app (`http://localhost:3000`) or a deployed environment. Supply a real test account for `SENTINEL_EMAIL` / `SENTINEL_PASSWORD`, and an LLM provider + key (Anthropic / OpenAI / AWS Bedrock).

## Commands

```bash
# Safety preflight only — no browser, no app needed. Reports if a prod target is in play.
pnpm guard

# Log in once and save the authenticated session.
pnpm login

# Phase 0 smoke: boot -> log in -> screenshot -> report blocked writes.
pnpm smoke

# Phase 1: crawl the app into an interaction graph, then synthesize a site map.
pnpm crawl
pnpm sitemap

# Phase 2: replay a PR's affected flows against its preview (needs the GitHub CLI).
pnpm pr <N>

# Phase 3: plan a browser test for a PR, run it on the preview, record + judge.
pnpm verify <N>          # add --plan-only to just generate the to-do plan

# Dashboard: a local UI to register repos, watch live runs, and browse the video
# gallery. Tag Sentinel (e.g. "@sentinel") on a PR and it records a run + posts a
# verdict back. One server (UI + API) on http://127.0.0.1:4317.
pnpm dev                 # Next.js dev server with hot-reload (also: pnpm ui)
pnpm build && pnpm start # production build, then serve

# Typecheck.
pnpm typecheck
```

Artifacts (videos, screenshots, the interaction graph, run manifests) land in `.sentinel/` (gitignored).

## Dashboard

The dashboard is a single **Next.js** app (`app/`) — one server handles both the UI and the
API, so `pnpm dev` (or `pnpm build && pnpm start`) is all it takes. The UI is React + Tailwind +
shadcn/ui; the API is a set of route handlers that wrap the same read-only engine the CLI uses,
with live runs streamed over SSE and the mention poller started from `instrumentation.ts`.

- **Register a project** — a GitHub repo (`owner/name`) with a generic adapter you configure in the form (login recipe, preview-env hint, and the *names* of the env vars holding its test credentials — secrets are never stored, only referenced). First-party apps with fixed, in-code knowledge can ship a built-in adapter instead (see `src/adapters/example.ts`).
- **Tag to trigger** — the server polls registered repos for PR comments that `@`-mention Sentinel. On a mention it resolves the PR's preview deployment, walks the affected flows in a recorded browser, judges `pass / fail / uncertain`, and posts the verdict back as a comment (with a hidden marker so it never replies to itself).
- **Watch + gallery** — live progress streams over SSE while a run is in flight; finished runs land in a video gallery, each linked to its PR and verdict.

Every dashboard run is forced read-only and goes through the same production preflight + network guard as the CLI. It targets repos that publish PR **preview deployments** and already have a baseline interaction graph (`pnpm crawl`); a project missing either is flagged in the UI, and Sentinel replies that it needs a baseline crawl rather than failing silently.

## Safety model

Two independent signals decide whether to clamp to read-only, and **either one** is enough:

1. **Production preflight** scans the datastores/endpoints a run can touch — connection strings and API origins the adapter knows about — against the adapter's `productionMarkers`.
2. **Remote-host fail-safe** — any target host that isn't local (`localhost`/`127.0.0.1`/`*.local`) is treated as potentially production, so an *undetected* prod host can never become a silent write path.

When either fires, Sentinel **forces read-only** regardless of `SENTINEL_READ_ONLY`. The only way to enable writes against a prod/remote target is `SENTINEL_ALLOW_PROD_WRITES=true`. An adapter can also opt into hard-stop (`failClosedOnProduction: true`) instead of clamping.

The **read-only network guard** then fulfils mutating requests locally (matching the auth allowlist against the URL *path* only, so query-string tricks can't smuggle a write), and **service workers are blocked** so no request escapes interception. Even a misclick on a destructive control can't reach the server.

## Layout

```
src/
  core/         # repo-agnostic engine
    safety/     # production preflight, read-only network guard, redaction
    browser/    # Playwright driver (video, network/console capture, guard)
    auth/       # login recipe + storageState
    graph/      # interaction-graph model + extraction
    crawler/    # the learning crawl + LLM-guided actuation
    pr/         # GitHub plumbing + PR replay
    verify/     # plan -> execute -> judge
    reasoner/   # LLM layer (Vercel AI SDK)
    human/      # human-like pacing
    config.ts   # env + paths
    types.ts    # RepoAdapter contract
  adapters/     # per-app config (login, routes, preview, safety)
  server/       # dashboard services: API logic, poller, runner, SSE hub, store
  cli.ts        # the `sentinel` CLI
app/            # Next.js dashboard: UI (page + components) + API route handlers
components/     # shadcn/ui + feature components
instrumentation.ts  # starts the mention poller on server boot
```

## License

[MIT](LICENSE).
