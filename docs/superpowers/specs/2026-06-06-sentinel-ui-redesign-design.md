# Sentinel dashboard UI redesign — design

**Date:** 2026-06-06
**Status:** Approved (direction approved interactively; user delegated autonomous build + PR)

## Goal

Replace Sentinel's hand-rolled vanilla-JS dashboard (`web/index.html` + `web/app.js` +
`web/styles.css`) with a modern, component-driven SPA that an open-source developer is
proud to run and wants to star. The bar is **Linear-grade detail**: a cohesive neutral
palette with a single accent, crisp 1px borders, restrained purposeful motion, slide-overs
instead of modals where possible, and obsessive attention to spacing/typography.

Hard constraint from the user: **Vite + React + TypeScript + Tailwind + shadcn/ui**. No
Next.js (overkill for a localhost dashboard with no SSR/routing needs).

## Scope

In scope — full feature parity with the current dashboard, rebuilt:

- **Health** — GitHub auth, LLM creds, poller status indicators.
- **Projects** — list registered repos; register a new project (textyess or generic adapter
  with full auth config); set/clear baseline URL; build/re-crawl baseline; trigger a PR
  verify; remove a project. Surface readiness (baseline graph present, creds configured).
- **Runs gallery** — recorded runs with video, verdict (pass/fail/uncertain), confidence,
  PR link, summary; dismiss a run.
- **Live run** — subscribe to the SSE stream for a triggered run/crawl; show a phase
  stepper, streaming log, and the terminal verdict (or crawl coverage).
- **Settings** — edit non-secret config (base URL, LLM provider/model, AWS region,
  headless) and set/clear secrets (presence-only; values never leave the server).

Out of scope: changing any backend behavior, the safety guards, the API contract, or the
CLI. The redesign is **frontend-only plus the static-file serving change** needed to host a
built SPA. No new endpoints.

## Architecture

### Boundary

The backend (`src/server/*`, repo-agnostic `core/`, adapters) is unchanged except for how
it serves the frontend. The React app talks to the **existing** JSON + SSE API:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | `{ ghAuthOk, llmCredOk, pollerRunning }` |
| GET | `/api/projects` | `ProjectView[]` (record + `graphPresent` + `credsConfigured`) |
| POST | `/api/projects` | register a project |
| PATCH | `/api/projects/:id` | update `baselineUrl` |
| DELETE | `/api/projects/:id` | remove a project |
| POST | `/api/projects/:id/crawl` | start baseline crawl → `{ runId }` |
| POST | `/api/projects/:id/verify/:pr` | start PR verify → `{ runId }` |
| GET | `/api/runs` | `RunSummary[]` |
| GET | `/api/runs/:runId` | full `RunRecord` |
| DELETE | `/api/runs/:runId` | drop run + artifacts |
| GET | `/api/runs/:runId/video` | webm (range-aware) |
| GET | `/api/env`, PUT `/api/env` | settings presence/values + update |
| GET | `/api/events?runId=` | SSE: `progress` / `done` / `error` |

### Web app layout

`web/` becomes a **standalone Vite app** with its own `package.json`, `tsconfig.json`, and
dependency tree. Rationale:

- The repo's Biome (`biome check src`) and root `tsc` (`include: ["src/**/*.ts"]`) only scope
  `src/`, so a separate `web/` app does **not** fight the backend's lint/style rules (4-space
  indent, no `any`, named-exports-only) — shadcn components keep their own conventions.
- Frontend deps (React, Radix, Tailwind) stay out of the backend's dependency graph.

A root `pnpm-workspace.yaml` lists `web` so a single `pnpm install` at the repo root installs
both. `web/dist/` is already covered by the root `.gitignore` (`dist/`), so build output is
never committed.

```
web/
  package.json, vite.config.ts, tsconfig.json, components.json, index.html
  src/
    main.tsx, App.tsx, index.css        # theme tokens (oklch), Tailwind v4 layer
    lib/        api.ts (typed client), types.ts (DTO mirror), utils.ts (cn)
    hooks/      use-runs / use-projects / use-health / use-env (TanStack Query), use-live-run (SSE)
    components/
      ui/                               # shadcn primitives (button, card, dialog, sheet, …)
      app-shell, top-bar, health-indicator, theme-toggle
      projects/  project-list, project-row, register-project-dialog
      runs/      run-gallery, run-card
      live/      live-run-sheet, phase-stepper, run-log, verdict-callout
      settings/  settings-sheet
```

### Serving the SPA

`src/server/http.ts` currently serves three hardcoded files from `PACKAGE_ROOT/web`. Change
it to serve the Vite build from `PACKAGE_ROOT/web/dist`:

- `GET /assets/*` and other built files → serve the matching file under `web/dist`, guarded
  by a path-traversal check that keeps the resolved path inside `web/dist` (same pattern as
  the existing `assertWithinOutputDir`).
- Any other non-`/api` GET → serve `web/dist/index.html` (SPA fallback).
- If `web/dist/index.html` is missing, return a clear 503 telling the operator to run the web
  build. The API routes are untouched and still take priority.

This change does **not** touch the production preflight or read-only network guard — it only
swaps which static assets are served. The safety boundary is unaffected.

### Dev vs. prod

- **Prod / `pnpm ui`:** the Node server serves `web/dist`. A root `pnpm ui` first ensures the
  web build exists.
- **Dev:** `pnpm --filter web dev` runs the Vite dev server (HMR) with a proxy: `/api` and
  `/api/events` (SSE, `changeOrigin`, no buffering) → `http://127.0.0.1:4317` (the default
  `SENTINEL_UI_PORT`). Run the backend with `pnpm ui` (or a dev variant) alongside.

## Design system (Linear-grade)

- **Color:** OKLCH tokens via shadcn variable names, neutrals tinted toward a cool indigo hue
  (~265–277). Single accent = indigo (`primary`). Dark **and** light themes, system-aware,
  persisted (`next-themes`, used purely as a React provider — no Next.js). Status hues:
  pass = emerald, fail = rose, uncertain = amber, running = accent/blue, blocked = neutral —
  each with a low-alpha tint background via `color-mix`, never flat saturated fills.
- **Typography:** Inter (variable) for UI — the user asked for Linear's look, and Linear uses
  Inter; tight tracking + `font-feature-settings` on headings. A clean monospace (JetBrains
  Mono / Geist Mono) only where it earns it: the live-run log and code-ish values.
- **Space & motion:** 4px rhythm; varied, not uniform, padding. Motion is restrained —
  one staggered load reveal, a live-run pulse, ease-out-expo transitions, `transform`/`opacity`
  only, full `prefers-reduced-motion` support.
- **Components:** projects render as **list rows** with hover-revealed actions (Linear style),
  not heavy cards. Runs are a responsive gallery of video cards. Live run and settings are
  **right-side slide-over Sheets**; register-project is a Dialog (a focused form is the one
  justified modal).
- **The "not AI slop" test:** no glassmorphism, no purple→blue gradients, no neon-on-black,
  no identical icon-topped card grid, no gradient text. Tinted neutrals + one accent + real
  hierarchy.

## Data flow

- TanStack Query owns fetching/caching/polling: runs poll every 5s, health every 15s
  (matching current behavior), with `invalidateQueries` after mutations for instant updates.
- Mutations (register, crawl, verify, delete, save settings) use optimistic-feeling UX:
  disable + spinner on the triggering control, `sonner` toast on success/error.
- The live run is a dedicated SSE hook (`EventSource`) feeding the slide-over; on `done` it
  invalidates runs + projects so the gallery and readiness badges refresh.

## Error handling

- API client throws typed errors with the server's `{ error }` message; surfaced via toasts
  and inline form errors.
- Query error + empty states are first-class: every list teaches what to do next ("Tag
  Sentinel on a PR, or trigger one above") rather than a bare "nothing here".
- SSE `error` events append to the log; connection drops are handled without crashing the UI.

## Testing / verification

No unit-test harness exists in the repo today, so verification is:

1. `pnpm --filter web build` (Vite + `tsc` typecheck of the web app) must pass.
2. `pnpm typecheck` (backend `tsc --noEmit`) and `pnpm lint` (`biome check src`) must still
   pass after the `http.ts` change.
3. Manual smoke: `pnpm ui`, load the dashboard, confirm health/projects/runs render, register
   flow opens, settings loads, a live-run sheet subscribes to SSE.
4. Adversarial review pass (parallel agents): build correctness, Linear-polish critique,
   accessibility audit, and a safety check that no guard was weakened.

## Risks

- **Tailwind v4 + shadcn:** use the documented `@tailwindcss/vite` + CSS-variable setup; pin
  to current majors. Mitigated by building until green before PR.
- **SSE through the Vite dev proxy:** must disable response buffering / set `changeOrigin`.
  Prod path (same-origin server) is unaffected.
- **Build-output dependency:** the server needs `web/dist` to exist; `pnpm ui` ensures the
  build runs first, and a missing build returns a clear 503 with instructions.
