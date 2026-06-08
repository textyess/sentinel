# Framework → `pagesPrefix`, and how diffs map to routes

`pagesPrefix` is the only config that drives PR-diff → route mapping. Set it to the
directory (with trailing slash) that holds the app's route files.

## Detection table

| Framework signal (repo root) | `pagesPrefix` | Framework |
| --- | --- | --- |
| `next.config.*` + `app/` | `app/` | Next.js App Router |
| `next.config.*` + `pages/` | `pages/` | Next.js Pages Router |
| `next.config.*` + `src/app/` | `src/app/` | Next.js App Router (src) |
| `next.config.*` + `src/pages/` | `src/pages/` | Next.js Pages Router (src) |
| `remix.config.*` + `app/routes/` | `app/routes/` | Remix |
| `remix.config.*` (no routes dir) | `app/` | Remix |
| `astro.config.*` | `src/pages/` | Astro |
| `nuxt.config.*` | `pages/` | Nuxt |
| `src/pages/` \| `src/app/` \| `src/routes/` | that dir | Vite / CRA SPA |
| `pages/` | `pages/` | generic |

**Monorepos** (`apps/` or `packages/` at the root): the route dir is ambiguous — pick the
web app's, e.g. `apps/web/app/` or `apps/web/src/pages/`. Ask the user which app Sentinel
should test.

If you can't infer a convention, omit `pagesPrefix`. Diffs then map to no routes and verify
replays a default spread — degraded but safe.

## How `affectedRoutes(changedFiles)` works

For each changed file:
1. Skip it unless it starts with `pagesPrefix`.
2. Strip the prefix and the `.ts/.tsx/.js/.jsx` extension.
3. Drop a trailing `index` segment (`blog/index` → `/blog`; bare `index` → `/`).
4. If the **first** remaining segment is dynamic/framework (`[id]`, `[...slug]`, `_app`,
   `(group)`), skip the file (no concrete route) and add a note.
5. A dynamic segment **later** truncates to the literal prefix before it
   (`settings/[id]/page` → `/settings`).
6. Otherwise emit `/joined/segments`.

Files outside the prefix set a "broad UI impact" note; the result is deduped and always
carries "coverage may be approximate".

### Important caveat: App Router `page.tsx`

Only a trailing `index` is dropped — **`page`, `route`, and `layout` are not**. So in a Next
App Router project:

- `app/settings/page.tsx` → `/settings/page` (not `/settings`)
- `app/(marketing)/about/page.tsx` → skipped (leading group)
- `app/blog/[slug]/page.tsx` → `/blog`

`/settings/page` won't exactly equal a `/settings` graph node, but verify falls back to a
`startsWith`/route-area fuzzy match, so it still selects the right flows in practice. Mention
this to the user when validating with `sentinel affected-routes`; it's expected, not a bug.
(A precise fix would live in `src/adapters/generic.ts` — never in `src/core/`.)

## Validate it

```bash
sentinel affected-routes --project <slug> --files "app/foo/page.tsx,src/lib/x.ts"
```

Expect the page file to produce a route (or an explained skip for a dynamic/group segment)
and non-route files to be ignored.
