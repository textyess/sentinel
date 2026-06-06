# Contributing to Sentinel

Thanks for your interest. Sentinel is an autonomous, persona-driven browser agent
that learns a web app and tests PRs against it with video evidence. This guide
covers local setup, the architecture rules that keep it safe and repo-agnostic,
and how to add support for a new app.

## Local setup

```bash
pnpm install
cp .env.example .env   # fill in credentials for the app you want to drive
pnpm typecheck         # tsc --noEmit — the build/CI gate
pnpm lint              # biome check src
```

Sentinel is TypeScript ESM run via `tsx`; there is no build step (`pnpm build`
is `tsc --noEmit`). Node >= 22.

Common entry points:

- `pnpm guard` / `pnpm login` / `pnpm smoke` — CLI safety + auth checks
- `pnpm crawl` — build a baseline interaction graph for an app
- `pnpm verify` — replay a PR's affected flows and judge a verdict
- `pnpm ui` — the local dashboard (tag Sentinel on a PR → recorded run + verdict)

## Architecture rules (non-negotiable)

1. **Keep `src/core/` repo-agnostic.** No app-specific strings (emails, ports,
   route names, hostnames, connection-string fragments) belong in `core/`. They
   live in an adapter. The core depends only on the `RepoAdapter` contract in
   `src/core/types.ts`.
2. **Never weaken the safety boundary.** The production preflight
   (`core/safety/production-guard.ts`) and the read-only network guard
   (`core/safety/read-only-guard.ts`) are what make it safe to run against a
   real deployment. Mutating requests are aborted unless they match the
   adapter's `allowedMutationPatterns` (auth only). Don't add code paths that
   bypass these.
3. **Redact before logging.** Any connection string / token goes through
   `redactSecret()` first.

## Adding support for a new app

There are two ways, depending on how the app's knowledge is configured:

### 1. Generic adapter (no code) — preferred

Register the app from the dashboard (`pnpm ui`): provide the repo, a login
recipe (paths/labels/patterns), the preview-env hint, and the **names** of the
env vars that hold the test credentials (raw secrets are never stored, only
referenced). This is the right path for most apps. The full config shape is
`GenericProjectConfig` in `src/adapters/generic.ts`.

### 2. Built-in adapter (code) — for first-party apps with fixed knowledge

When an app's routes, ports, and safety markers are fixed and known in code,
ship a built-in adapter. Copy `src/adapters/example.ts` as a starting point —
it implements the `RepoAdapter` contract — then register it as a
`BuiltinAdapterFactory`.

Built-in adapters register through `src/adapters/builtins.ts`, which loads an
optional, gitignored overlay at `src/adapters/private/index.ts` if present. This
keeps app-specific adapters out of the open-source surface: a deployment drops
its adapter file into `src/adapters/private/` and exports
`registerPrivateAdapters(register)` — no tracked file or core code changes.

Adding an app must never require editing `src/core/`.

## Style

Biome (config at the repo root): 4-space indent, double quotes, semicolons,
trailing commas, named exports only, no `any`, no `==`. `noUncheckedIndexedAccess`
is on — guard array/record access. Explain *why* in comments, not *what*.

Run `pnpm format` to auto-fix, and make sure `pnpm typecheck` and `pnpm lint`
are clean before opening a PR.
