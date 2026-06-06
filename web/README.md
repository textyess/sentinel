# Sentinel dashboard (`web/`)

The Sentinel control panel — a Vite + React + TypeScript + Tailwind + shadcn/ui single-page
app. It talks to the JSON + SSE API served by `src/server/`. No router, no SSR: one page,
slide-over panels, and an `EventSource` stream for live runs.

## Develop

From the repo root (a pnpm workspace), install once:

```bash
pnpm install
```

Run the backend and the Vite dev server side by side:

```bash
pnpm ui:server   # the node:http + SSE API on http://127.0.0.1:4317
pnpm web:dev     # Vite + HMR on http://127.0.0.1:5173, proxying /api to the server
```

Open http://127.0.0.1:5173. The proxy target follows `SENTINEL_UI_PORT`.

## Build

```bash
pnpm ui:build    # tsc --noEmit && vite build -> web/dist
```

`pnpm ui` (from the root) runs this build, then serves `web/dist` from the Node server on
http://127.0.0.1:4317.

## Layout

```
src/
  main.tsx, App.tsx, index.css   # entry, composition, theme tokens (OKLCH)
  lib/        api client, DTO types, helpers
  hooks/      TanStack Query hooks + the SSE live-run hook
  components/
    ui/       shadcn/ui primitives
    projects/ runs/ live/ settings/   feature views
```

## Design

Cool-tinted neutral palette with a single indigo accent, light + dark (system-aware), built
on OKLCH tokens in `src/index.css`. Status hues (pass / fail / uncertain / running / blocked)
are reserved for verdicts. Motion is restrained and respects `prefers-reduced-motion`.
