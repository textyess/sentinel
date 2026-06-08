# Bespoke adapter (advanced, rarely needed)

Default to the no-code generic config. Reach for a bespoke adapter **only** when the app
needs real code the generic path can't express, for example:

- a custom `resolveDatastoreTargets()` (e.g. read a local `.env`/config to label a prod DB
  for the preflight),
- non-trivial diff → route mapping that `pagesPrefix` can't capture,
- fixed first-party app knowledge you'd rather keep in code than in a stored config.

A bespoke adapter is still **not** a core change. It lives under `src/adapters/` and is
registered through a **gitignored overlay** so no tracked file (and nothing in `src/core/`)
is edited.

## Steps

1. Copy the reference adapter:
   ```bash
   cp src/adapters/example.ts src/adapters/<id>.ts
   ```
   Implement the `RepoAdapter` contract there. Reuse `GENERIC_SAFETY_DEFAULTS` (imported from
   `./generic`) for telemetry/destructive/marker defaults — keep `allowedMutationPatterns`
   auth-only and `^`-anchored, and keep `readOnly` honest.

2. Register it from the private overlay (create it if absent):
   ```ts
   // src/adapters/private/index.ts   (gitignored — never committed)
   import type { registerBuiltinAdapter } from "../registry";
   import { createMyAppAdapter } from "../<id>";

   export function registerPrivateAdapters(register: typeof registerBuiltinAdapter): void {
       register("<id>", (env, overrides) =>
           createMyAppAdapter(overrides?.baseUrl ? { ...env, baseUrl: overrides.baseUrl } : env));
   }
   ```
   `builtins.ts` loads this overlay if present and ignores it otherwise — so the public build
   keeps compiling and you never touch `registry.ts`, `builtins.ts`, or `src/core/`.

3. Select it for CLI runs:
   ```bash
   SENTINEL_ADAPTER=<id> sentinel crawl
   SENTINEL_ADAPTER=<id> sentinel smoke
   ```
   (Built-in adapters resolve via `SENTINEL_ADAPTER`; the `--project` flag is for registered
   generic projects.)

## Hard rules

- Never edit anything under `src/core/`.
- Never edit `src/adapters/registry.ts` or `src/adapters/builtins.ts` — register via the
  overlay.
- `id` is the adapter kind and the output subdir; keep it filesystem-safe and stable.
- All app-specific strings (hosts, routes, labels) live in the adapter, never in core.

If none of the advanced needs apply, stop — the generic config is the right answer.
