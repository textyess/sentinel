# Deriving the `auth` recipe from source

Goal: read the target app's login UI + handler and produce a `GenericAuthConfig` plus the
single auth `allowedMutationPatterns` entry. Prefer reading the code; only fall back to the
live page when the code is ambiguous.

## 1. `loginPath`

Find the route that renders the sign-in form:
- **Next.js App Router:** `app/login/page.tsx`, `app/(auth)/sign-in/page.tsx` → `/login`,
  `/sign-in`. A leading route group `(auth)` is not part of the URL.
- **Next.js Pages Router:** `pages/login.tsx` → `/login`.
- **Remix:** `app/routes/login.tsx` or `app/routes/_auth.login.tsx` → `/login`.
- Generic SPA: search for a `<Route path="/login">` / router config entry.

If the app redirects unauthenticated users somewhere, that target is usually `loginPath`.

## 2. `emailLabel` / `passwordLabel`

These are matched against the field's **accessible name**. In priority order, read from the
login component:
1. A `<label htmlFor=…>` whose text labels the input (use the visible text, e.g. `Email`).
2. `aria-label` on the input.
3. `placeholder` (last resort).

Use the exact human text (`Email`, `Email address`, `Work email`, `Password`). If the field
has no robust label, set the fallback selector instead:
- `emailFallbackSelector: "input[type=\"email\"]"`
- `passwordFallbackSelector: "input[type=\"password\"]"`

## 3. `submitNamePattern`

Take the submit button's visible text and turn it into a case-insensitive regex where
whitespace is flexible:
- `Log in` → `log\\s*in`
- `Sign in` → `sign\\s*in`
- `Continue` → `continue`

The pattern must compile as a `RegExp`. Keep it specific to the submit button so it doesn't
match other controls.

## 4. `authenticatedUrlPattern`

The URL the app lands on right after a successful login. Read the post-login redirect:
- `router.push("/dashboard")`, `redirect("/home")`, NextAuth `callbackUrl`, etc.
- Express it as a path-anchored regex, e.g. `/(dashboard|home|app)(/|\\?|#|$)`.

This is often a guess — flag it to the user to confirm after the first login. The default
`/(home|dashboard|app|overview|account)(/|\\?|#|$)` is a reasonable fallback.

## 5. `publicRoutes`

Routes reachable without a session — include `loginPath` plus links visible on the login
page: `/signup`, `/register`, `/reset-password`, `/forgot-password`, `/terms`, marketing
pages. The crawler may visit these logged-out.

## 6. The auth endpoint → `allowedMutationPatterns`

The read-only guard blocks every mutating request **except** the auth handshake. You must
allow the login POST and nothing else.

- Find where the login form/handler submits:
  - A `<form action="/api/login">` → `^/api/login$`.
  - `fetch("/api/auth/callback/credentials", { method: "POST" })` (NextAuth) →
    `^/api/auth/callback/credentials$` (NextAuth's core routes are also covered by the
    built-in defaults, so you can often leave this empty).
  - A GraphQL `login` mutation hitting `/graphql` → you generally **cannot** allow this
    safely (it shares the path with all mutations); prefer a dedicated REST auth route, or
    accept that login may need the dedicated endpoint. Ask the user.
- Anchor it: each pattern starts with `^` and is matched against the URL **path** only.
- **Auth only.** Never add `/logout`, `/signup` writes, or anything that mutates app data.

Standard handshakes are already allow-listed by Sentinel, so you only add an app-specific
endpoint when login is a background `fetch` to a non-standard path. When in doubt, leave
`allowedMutationPatterns` empty and confirm login works via `sentinel smoke`; if the login
POST is blocked, add the one anchored path you saw in the network panel.

## Public apps (no login)

If the app serves its content without authentication, set `authRequired: false`. Then the
`auth` block is inert (keep sensible defaults), credentials aren't needed, and
`allowedMutationPatterns` must be empty. Skip `sentinel smoke` (there's no login to prove);
the baseline `crawl` is the validation.

## OAuth / SSO / magic links

Out of scope for now — these need an interactive or token-based flow Sentinel's
email+password recipe can't drive. Note it to the user as a follow-up.
