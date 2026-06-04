# CLAUDE.md — `@textyess/qa-agent` (Sentinel)


## Non-negotiable rules

1. **Keep `core/` repo-agnostic.** No TextYess strings (emails, ports, route names, connection-string fragments) in `src/core/`. They belong ONLY in `src/adapters/textyess.ts`. Adding a second repo must be a new adapter file, not a core change.
2. **Never weaken the safety boundary.** The production preflight (`core/safety/production-guard.ts`) and the read-only network guard (`core/safety/read-only-guard.ts`) are the reason this can run against prod. Don't add code paths that bypass them. Mutating requests are aborted unless they match the adapter's `allowedMutationPatterns` (auth only).
3. **Redact before logging.** Any connection string / token goes through `redactSecret()` first.

## Conventions

- TypeScript ESM, run via `tsx`. `tsc --noEmit` is the `build`/`typecheck` task.
- Biome style (repo root config): 4-space indent, double quotes, semicolons, trailing commas, named exports only, no `any`, no `==`.
- `noUncheckedIndexedAccess` is on — guard array/record access.
- No requirement/ticket IDs in comments (repo-wide rule). Explain WHY.

## Phase map

- **Phase 0 (done):** safety guards, Playwright driver, auth, `guard`/`login`/`smoke` commands.
- **Phase 1 (next):** Agno-driven crawler that reads the accessibility tree, clicks unvisited controls, and persists an interaction graph (nodes = page states, edges = control→action→state + API side-effects). Honor the destructive-control denylist (`safety.destructiveControlPatterns`) before clicking.
- **Phase 2:** `gh pr checkout` in an isolated worktree, map diff→affected routes, replay with self-healing selectors, record video.
- **Phase 3:** judge PR claim vs observed behavior; structured pass/fail/uncertain verdict + persona PR comment.
