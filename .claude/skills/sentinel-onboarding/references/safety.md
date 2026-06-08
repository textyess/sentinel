# Safety boundary — never weaken it

Sentinel can run against production because of two independent guards. Onboarding must
preserve both. These mirror the non-negotiable rules in Sentinel's `CLAUDE.md`.

## 1. Production preflight (`src/core/safety/production-guard.ts`)

Before any browser session, the preflight clamps the run to read-only if **either**:
- a configured `productionMarker` matches a datastore target, **or**
- the target host is **not local** (anything but `localhost`/`127.0.0.1`/`*.local`).

The remote-host fail-safe is why a generic project needs no markers: any preview/prod URL is
treated as production and forced read-only. Writes require `SENTINEL_ALLOW_PROD_WRITES=true`,
which is deliberately **not** settable from the dashboard env API and which onboarding must
never set.

## 2. Read-only network guard (`src/core/safety/read-only-guard.ts`)

Every browser request is intercepted. Mutating methods (POST/PUT/PATCH/DELETE) are fulfilled
locally with a 423 — never sent — **except**:
- requests whose **path** matches `allowedMutationPatterns` (the auth allow-list), and
- GraphQL pure-`query` POSTs (reads-over-POST), via an exact parser.

Telemetry is answered with a benign 200 so SDKs stay quiet and nothing leaks.

## Invariants onboarding must keep

- **`allowedMutationPatterns` is auth-only and `^`-anchored.** It is the single write
  exception. Adding anything that isn't the login handshake punches a hole in the guard. The
  registry rejects unanchored patterns — don't work around that.
- **Never set `SENTINEL_ALLOW_PROD_WRITES`** (or flip `SENTINEL_READ_ONLY`). Generic
  adapters are hard-wired `readOnly: true`; the server forces read-only regardless.
- **Public apps get an empty allow-list.** With `authRequired: false` there is no auth POST
  to permit, so `allowedMutationPatterns` must be `[]`.
- **Reuse `GENERIC_SAFETY_DEFAULTS`** for telemetry/destructive/marker defaults. Don't
  hand-roll them, and don't import them into anything under `src/core/`.
- **Never edit `src/core/`.** Integration is a generic config or — rarely — an adapter file
  under `src/adapters/` (via the `private/index.ts` overlay). App-specific strings never
  belong in core.
- **Redact secrets before logging.** Any value that might carry a connection string or token
  goes through `redactSecret()` first. Reference credentials by env-var NAME only; never
  write real secrets to a file you create.

## Quick self-check before registering

- Does every `allowedMutationPatterns` entry start with `^` and describe an auth path only?
- Is `authRequired: false` paired with an empty `allowedMutationPatterns`?
- Are credentials referenced by NAME (`emailEnv`/`passwordEnv`), with no secret in the JSON?
- Did you avoid touching anything in `src/core/`?

`sentinel guard --project <slug>` prints the effective read-only state for a target — use it
to confirm read-only is active before a run.
