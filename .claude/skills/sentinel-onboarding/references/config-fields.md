# `GenericProjectConfig` — field reference

The no-code integration is a single JSON object. The CLI `register` command and the
dashboard both validate it with the same Zod schema, so the rules below are enforced — a
config that breaks them is rejected, never persisted.

## The registration body (`POST /api/projects` shape)

```jsonc
{
  "repo": "owner/name",            // REQUIRED, must match /^[^/\s]+\/[^/\s]+$/
  "adapterKind": "generic",        // REQUIRED, "generic" for the no-code path
  "previewEnvIncludes": "web",     // optional, default "web"
  "mentionHandle": "@sentinel",    // optional, default "@sentinel"
  "baselineUrl": "https://staging.example.com",  // optional but set it — the URL crawled for the baseline
  "adapter": { /* GenericProjectConfig, REQUIRED for adapterKind "generic" */ }
}
```

The project `id` (and its output subdir) is `slug(repo)` — lowercased `owner/name` with
non-alphanumerics collapsed to hyphens (`acme/Web` → `acme-web`).

## `adapter` (`GenericProjectConfig`)

| Field | Req? | Type | Notes |
| --- | --- | --- | --- |
| `auth` | **yes** | object | Login recipe — see below. Present even for public apps (fields are inert when `authRequired: false`). |
| `authRequired` | no | boolean | Default `true`. `false` = public app: Sentinel skips login, needs no credentials, and `allowedMutationPatterns` is forced to `[]`. |
| `emailEnv` | no | string | NAME of the env var holding the test email. Defaults to `SENTINEL_<SLUG>_EMAIL`. **Never the secret itself.** |
| `passwordEnv` | no | string | NAME of the env var holding the test password. Defaults to `SENTINEL_<SLUG>_PASSWORD`. |
| `previewEnvIncludes` | no | string | Default `"web"`. Substring identifying the web preview deployment. |
| `pagesPrefix` | no | string | Route-file prefix used to map a PR diff to routes (e.g. `app/`, `src/pages/`). **Include the trailing slash.** Omit it and diffs map to no routes (verify replays a default set). See `framework-routes.md`. |
| `knownRoutes` | no | string[] | Seed routes to accelerate crawling. |
| `allowedMutationPatterns` | **yes** | string[] | Mutating requests allowed through the read-only guard. **Auth only.** Each entry must start with `^` and be a valid regex (matched against the URL *path*). |
| `productionMarkers` | no | string[] | Connection-string/host fragments marking a prod datastore. Usually unnecessary — the remote-host fail-safe already clamps non-local targets to read-only. |
| `destructiveControlPatterns` | no | string[] | Override the default never-click denylist. Omit to use `GENERIC_SAFETY_DEFAULTS`. |

## `auth` (`GenericAuthConfig`)

| Field | Req? | Type | Notes |
| --- | --- | --- | --- |
| `loginPath` | yes | string | Path of the login page, e.g. `/login`. |
| `emailLabel` | yes | string | Accessible label of the email field, matched exactly. |
| `passwordLabel` | yes | string | Accessible label of the password field, matched exactly. |
| `submitNamePattern` | yes | regex string | Accessible-name pattern of the submit button, e.g. `log\\s*in`. Must compile. |
| `authenticatedUrlPattern` | yes | regex string | URL pattern the app lands on once authenticated, e.g. `/(home\|dashboard)(/\|\\?\|#\|$)`. Must compile. |
| `emailFallbackSelector` | no | string | CSS fallback if the label match misses, e.g. `input[type="email"]`. |
| `passwordFallbackSelector` | no | string | CSS fallback for the password field. |
| `publicRoutes` | yes | string[] | Routes that never require auth (the crawler may visit them logged-out). Include `loginPath`, signup, reset, etc. |

## What the engine fills in for you

`createGenericAdapter` derives the rest at run time, so you never set them:

- `baseUrl` — empty at rest; the per-run preview URL is injected for each PR (baseline uses
  `baselineUrl` / `SENTINEL_BASE_URL`).
- `ports` — `{ web: 443 }`.
- `safety.readOnly` — always `true` for generic projects.
- `safety.allowedMutationPatterns` — your auth-only list **plus** built-in standard auth
  endpoints (`/login`, `/sign-in`, `/sso`, `/oauth`, `/saml`, `/auth/{session,token,…}`),
  matched on path. (A public app gets `[]`.)
- `safety.telemetryPatterns` / `destructiveControlPatterns` / `productionMarkers` —
  `GENERIC_SAFETY_DEFAULTS` unless you override.
- `credentials` — resolved from `process.env[emailEnv]` / `[passwordEnv]`, falling back to
  `SENTINEL_EMAIL` / `SENTINEL_PASSWORD`.

## Minimal example (auth-gated Next.js App Router app)

```json
{
  "repo": "acme/web",
  "adapterKind": "generic",
  "previewEnvIncludes": "web",
  "baselineUrl": "https://staging.acme.dev",
  "adapter": {
    "auth": {
      "loginPath": "/login",
      "emailLabel": "Email",
      "passwordLabel": "Password",
      "submitNamePattern": "log\\s*in",
      "authenticatedUrlPattern": "/(dashboard|home)(/|\\?|#|$)",
      "emailFallbackSelector": "input[type=\"email\"]",
      "publicRoutes": ["/login", "/signup", "/reset-password"]
    },
    "authRequired": true,
    "previewEnvIncludes": "web",
    "pagesPrefix": "app/",
    "allowedMutationPatterns": ["^/api/auth/login$"]
  }
}
```
