---
name: sentinel-onboarding
description: Onboard a web app into Sentinel — autonomous, read-only browser QA that verifies pull requests with video evidence. Use when the user wants to set up Sentinel, add automated PR/QA verification to their app, integrate the "@sentinel" PR bot, or wire up browser-based regression checks. Inspects the app's framework, login, and routes, registers a no-code project, and runs a validated baseline crawl.
metadata:
  version: 0.1.0
---

# Sentinel onboarding

> **Two meanings of "skill" here.** This is a hand-written *onboarding* skill that sets
> Sentinel up for your app. It is unrelated to the *navigation skills* Sentinel's crawler
> auto-generates under `src/core/skills/` (stored in `.sentinel/<project>/skills/`). Don't
> conflate them.

## What this does

One guided flow: inspect the target app → propose a no-code Sentinel project config →
scaffold credential env-var **names** → register the project → run a baseline crawl +
login check → confirm a PR diff maps to sensible routes → explain how to trigger runs
(`@sentinel` on a PR). It turns Sentinel's manual first-run setup into a single skill.

## When to use

Trigger on: "set up Sentinel", "add PR QA / browser tests", "wire up @sentinel", "verify my
PRs in a browser". **Do not** use for non-web apps, or auth that isn't email+password
(OAuth / SSO / magic links) — see [Limitations](#limitations--follow-ups).

## How Sentinel relates to your app

Sentinel is an external bot **pointed at** your app (a local dev server or a deployed
preview) — it is never copied into your repo. It crawls the app once into a baseline
interaction graph, then on each PR opens the preview deployment **read-only**, walks the
diff-affected flows on camera, and posts a pass / fail / uncertain verdict.

## Prerequisites

- **Node 22+** and a **Sentinel checkout** (this skill clones `textyess/sentinel` if absent).
- **`gh` authenticated** (PR + preview resolution): `gh auth login`, or set `GH_TOKEN`.
- **An LLM key** (Anthropic by default): `ANTHROPIC_API_KEY` (OpenAI / Bedrock also work —
  see Sentinel's `.env.example`).
- **A real test account** on the target app (deployed environments rarely have local seed
  users).

## Procedure

Work through these in order. Read the target repo to answer as much as possible; ask the
user only for what the code can't tell you. Never invent credentials and never weaken the
safety boundary — read `references/safety.md` first.

### 1. Locate Sentinel

- If the current directory is already a Sentinel checkout (it has `src/cli.ts` and a
  `package.json` named `sentinel-qa-agent`), use it in place.
- Otherwise clone and install it next to the target repo:
  ```bash
  git clone https://github.com/textyess/sentinel ../sentinel
  (cd ../sentinel && npm install && npx playwright install chromium)
  ```
- Run the `sentinel …` commands (steps 6–7) **from the Sentinel checkout**, e.g.
  `npx tsx src/cli.ts <cmd>` (the examples use `sentinel <cmd>` for brevity). The
  `build-config.mjs` helper in step 4 is different — it's part of *this skill*, run from the
  skill's own directory (see step 4).

### 2. Detect the config from the target repo's source

Assemble a `GenericProjectConfig` by reading the user's code — more reliable than Sentinel's
live auto-detect because you open the actual files. Determine:

- **Framework & router → `pagesPrefix`** — see `references/framework-routes.md`.
- **Login recipe → `auth`** — open the login page/component and extract `loginPath`,
  `emailLabel`, `passwordLabel`, the submit button text (→ `submitNamePattern`), the
  post-login landing path (→ `authenticatedUrlPattern`), and public no-auth routes
  (`publicRoutes`). See `references/auth-detection.md`.
- **Auth endpoint → `allowedMutationPatterns`** — find the POST the login submits to; write
  it as exactly ONE `^`-anchored path regex (e.g. `^/api/auth/login$`). **Auth only.**
  Standard handshakes are already allow-listed; add only what's app-specific.
- **Auth required?** If the app serves content with no login, set `authRequired: false`
  (then `allowedMutationPatterns` must be empty).
- **Preview env → `previewEnvIncludes`** — the substring identifying the app's web preview
  deployment (often `web`); check `vercel.json` / CI config / deployment names.
- **Credentials → env-var NAMES** — never raw secrets. Default `SENTINEL_<SLUG>_EMAIL` /
  `_PASSWORD` (slug = lowercased `owner-name`).

Full field reference: `references/config-fields.md`.

### 3. Choose generic (default) vs. bespoke adapter

Default to the no-code generic config below. Only when routing/safety needs real code (a
custom datastore preflight, non-trivial diff→route mapping) write a bespoke adapter via the
gitignored `src/adapters/private/index.ts` overlay — **never edit `src/core/`**. See
`references/bespoke-adapter.md`.

### 4. Build & validate the config

Write the project body (the `POST /api/projects` shape) and validate it locally with this
skill's `scripts/build-config.mjs` helper — same checks the registry enforces (regexes
compile; each mutation pattern is `^`-anchored). The helper is **skill-local**: run it from
this skill's own directory (where this `SKILL.md` lives — `.claude/skills/sentinel-onboarding/`
for a project install, or your global skills dir for `-g`), **not** from the Sentinel
checkout. Use the absolute path to this skill if unsure:

```bash
# reads JSON from --in or stdin, prints a normalized, validated config:
node <path-to-this-skill>/scripts/build-config.mjs --in draft.json > project.json
```

Set `baselineUrl` to the URL Sentinel should crawl (a stable dev/staging URL).

### 5. Scaffold credentials

In the Sentinel checkout, `cp .env.example .env` (if needed) and add the credential env-var
names + LLM key. Leave the secret VALUES for the user to paste — never write real secrets to
disk yourself:

```
SENTINEL_<SLUG>_EMAIL=
SENTINEL_<SLUG>_PASSWORD=
ANTHROPIC_API_KEY=
```

### 6. Register, baseline-crawl, validate login

```bash
sentinel register --config project.json     # writes the project record
sentinel crawl --project <slug>             # baseline graph (logs in; required before verify)
sentinel smoke --project <slug>             # proves the login recipe (skip for public apps)
```

A completed crawl already proves login works; `smoke` is an explicit re-check that also
screenshots the landing page.

### 7. Round-trip a PR diff

Confirm the config maps a representative diff to routes:

```bash
sentinel affected-routes --project <slug> --files "app/foo/page.tsx,src/lib/x.ts"
```

Sensible routes (or an explained empty set) means the config round-trips. Note the
App-Router `page.tsx → /foo/page` behavior documented in `references/framework-routes.md`.

### 8. Summarize & hand off

Tell the user: the project slug, the config path, the baseline graph location
(`.sentinel/<slug>/graph/latest.json`), how to trigger a run (comment `@sentinel` on a PR
once the bot is deployed — point them to Sentinel's `DEPLOY.md`), and any fields you guessed
that they should double-check (low-confidence auth labels, `previewEnvIncludes`).

For a one-off local check without the bot, every run command takes `--project <slug>`, so
`sentinel verify <PR#> --project <slug>` runs the full plan → execute → judge pipeline
against that PR's preview (likewise `pr`, `sitemap`, `skills`).

## Validation / success criteria

- `sentinel register` exits 0 and `.sentinel/server/projects.json` contains the project.
- `sentinel crawl --project <slug>` produces `.sentinel/<slug>/graph/latest.json`.
- `sentinel smoke --project <slug>` logs in and reports no blocked auth writes (authed apps).
- `sentinel affected-routes` returns routes for a representative page change.

## Failure modes & fixes

| Symptom | Fix |
| --- | --- |
| `No registered project "<slug>"` | Run `sentinel register` first; the slug is the lowercased `owner-name`. |
| `each pattern must be anchored with ^` | An `allowedMutationPatterns` entry isn't `^`-anchored. Auth path only. |
| "I need a baseline crawl first" / verify blocked | Run `sentinel crawl --project <slug>`. |
| Login fails on `smoke` | Re-check `emailLabel`/`passwordLabel`/`submitNamePattern` against the live page; set `emailFallbackSelector`. |
| No preview found on a PR | Make `previewEnvIncludes` match the deployment name. |

## Limitations / follow-ups

- **Email+password auth only** today. OAuth / SSO / magic links are out of scope (follow-up).
- **Non-web targets** are out of scope.

## Safety (non-negotiable)

Read `references/safety.md`. Never widen `allowedMutationPatterns` beyond authentication;
never set `SENTINEL_ALLOW_PROD_WRITES`; never edit `src/core/`; redact secrets before
logging. Sentinel forces read-only against any remote/production target regardless of config.
