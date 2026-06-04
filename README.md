# 🛡 Sentinel

**An autonomous browser agent that learns your web app, then verifies pull requests with video — read-only, safe to point at production.**

Sentinel logs into your app and maps how it works. When a PR comes in, it **plans a browser test for the change, runs it on the PR's preview, records the screen, and judges whether the PR does what it claims** — `pass` / `fail` / `uncertain`, with evidence.

It never writes: every mutating request is blocked in the browser, so you can point it straight at a live environment.

---

## Why

A PR changes the UI. The diff looks fine and CI is green — but does the feature actually *work* in the browser? Normally a human has to pull the branch, click around, and check. Sentinel does that for you and hands back a video and a verdict.

## What it does

| Step | Command | |
|---|---|---|
| **Learn** | `crawl` · `sitemap` | crawl the running app into an interaction graph + a human-readable site map |
| **Replay a PR** | `pr <N>` | re-walk the affected flows on the PR's preview, with video + a diff vs the baseline |
| **Verify a PR** | `verify <N>` | the model **plans** a test from the PR, **runs** it on the preview (clicks, types, asserts — with vision), **records** it, and **judges** it |

Plus `guard` (safety preflight), `login`, and `smoke` (one-page sanity check).

## Read-only by design

Sentinel is safe to run against a live or production app:

- A **network guard** fulfils every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) locally — it never reaches your server. Telemetry gets a benign `200`; popups and downloads are killed.
- A **fail-safe preflight** clamps to read-only whenever the target is a remote host or matches a production marker. Writes require an explicit opt-in.

So even if the agent misclicks a "Delete", nothing happens to your data.

## Quick start

```bash
git clone https://github.com/textyess/Sentinel.git && cd Sentinel
pnpm install
pnpm exec playwright install chromium      # one-time

cp .env.example .env                        # then edit:
#   SENTINEL_BASE_URL                – where your app runs (a deployment, or http://localhost:3000)
#   SENTINEL_EMAIL / SENTINEL_PASSWORD – a test account to log in with
#   an LLM provider + key            – Anthropic, OpenAI, or AWS Bedrock

pnpm crawl                 # learn the app -> interaction graph
pnpm sitemap               # readable map of what it learned
pnpm verify <PR>           # plan + run + judge a PR (needs the GitHub CLI + a preview deploy)
```

Artifacts — videos, screenshots, the interaction graph, run manifests — land in `.sentinel/` (gitignored).

## Configuration

Everything is via `.env` (see [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `SENTINEL_BASE_URL` | the app to drive |
| `SENTINEL_EMAIL` / `SENTINEL_PASSWORD` | login credentials |
| `SENTINEL_READ_ONLY` / `SENTINEL_ALLOW_PROD_WRITES` | safety switches (read-only is forced on remote/prod targets) |
| `SENTINEL_LLM_PROVIDER` / `SENTINEL_LLM_MODEL` | `anthropic` · `openai` · `bedrock` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AWS_*` | provider credentials |
| `LANGFUSE_*` | optional — trace LLM cost per run |
| `SENTINEL_HUMAN_PACING` / `SENTINEL_PACE_MS` | human-like dwell + think-pauses |

The LLM layer is the **Vercel AI SDK**, so Anthropic, OpenAI, or Claude-on-Bedrock all work. Every run prints its token cost; with `LANGFUSE_*` set it also exports one trace per run.

## How it works

```
PR ──► plan      the model reads the PR (intent + diff) + the app map → a read-only to-do list
   ──► execute   a goal-directed runner drives the browser — navigate, click, type, assert (vision) —
                 resolving the PR's NEW controls live, recording video
   ──► judge     pass / fail / uncertain, with cited evidence
```

The engine is **repo-agnostic** (`src/core/`). Everything app-specific lives in an **adapter** (`src/adapters/`): the login recipe, route conventions, how to find a PR's preview, and the production markers.

## Supporting your app

Sentinel adapts to an app through a small adapter describing its login form, routes, preview lookup, and safety markers. The repository ships a reference adapter as a worked example you can copy.

> **Roadmap:** config-driven onboarding — a `sentinel init` that auto-detects the framework, login, and preview setup and generates an adapter for *any* app — plus a GitHub App that auto-verifies PRs and a local UI for browsing runs.

## Layout

```
src/
  core/         # repo-agnostic engine
    safety/     # production preflight, read-only network guard, redaction
    browser/    # Playwright driver (video, network/console capture)
    graph/      # interaction-graph model + extraction
    crawler/    # the learning crawl + LLM-guided actuation
    pr/         # GitHub plumbing + PR replay
    verify/     # plan -> execute -> judge
    reasoner/   # LLM layer (Vercel AI SDK)
    human/      # human-like pacing
  adapters/     # per-app config (login, routes, preview, safety)
  cli.ts        # the `sentinel` CLI
```

## Contributing

Issues and PRs welcome. `pnpm typecheck` and `pnpm lint` should pass; the codebase uses [Biome](https://biomejs.dev) (4-space indent, double quotes, named exports).

## License

[MIT](LICENSE). Maintained by [TextYess](https://github.com/textyess).
