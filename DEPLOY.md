# Deploying Sentinel as a team bot

This guide gets you from a clone to a running bot that **your whole team can trigger
by tagging `@sentinel` on a pull request**. The result: anyone opens a PR, comments
`@sentinel`, and a recorded browser run + a pass/fail/uncertain verdict (with a video
reviewers can watch) shows up on the PR.

## How it works (and why deployment is simple)

Sentinel runs as **one always-on process** — the Next.js dashboard, its API, the
mention poller, and the Playwright browser engine all live in a single container.

The key property: **it only ever reaches outbound.** Every 30s it polls GitHub for
new `@sentinel` mentions (`gh api …`), opens the PR's preview deployment in a browser,
and posts the verdict back. There is **no inbound webhook**, so the bot needs **no
public URL, no domain, no TLS, no ingress**. You just need it *running* somewhere
that stays up.

Two consequences:

- **The team needs nothing.** No accounts, no install, no access. They tag `@sentinel`
  and read the result in the PR.
- **The dashboard is admin-only and can stay private.** Results post to the PR, so
  nobody but whoever sets it up ever opens the dashboard. Keep it bound to localhost
  (or behind Tailscale/your VPN). It currently has **no login**, and it can read/write
  env vars and trigger runs — so do **not** expose it on a public URL without putting
  an auth proxy in front.

## What you need first

1. **A GitHub bot account + token.** Create a dedicated GitHub account (e.g. `sentinel`),
   add it to the repo(s) with **write** access (it needs to comment), and generate a
   **Personal Access Token**:
   - Classic token scope: `repo` for private repos, or `public_repo` for public ones.
   - It must be able to read PRs/comments, post comments, and create/upload releases
     (recordings are uploaded as release assets under the `sentinel-artifacts` tag).
   - Using a **fine-grained** PAT instead? Grant **Contents: Read and write** (for the
     release-asset upload) plus **Pull requests** and **Issues: Read and write** —
     otherwise comments post but recordings silently fail to publish.
   - Using the bot's *own* token means `@sentinel` is a real mention and verdicts are
     posted under the bot's identity instead of a teammate's.

   This is `GH_TOKEN`. (A GitHub App is a nicer long-term identity but more setup and
   isn't required — start with a bot PAT.)

2. **An LLM key.** Simplest is Anthropic: set `SENTINEL_LLM_PROVIDER=anthropic` and
   `ANTHROPIC_API_KEY=…`. (OpenAI and AWS Bedrock are also supported — see `.env.example`.)

3. **A test login for the app under test.** `SENTINEL_EMAIL` / `SENTINEL_PASSWORD`
   (a real account on the target app — locally-seeded test users usually don't exist
   on a deployed environment). For multiple repos, use per-project credential vars
   (`SENTINEL_PROJECT_<REPO>_EMAIL` / `_PASSWORD`).

4. **The target repo must publish PR preview deployments** (e.g. Vercel previews).
   Sentinel resolves the preview URL from the PR's GitHub deployments and runs against
   it. No preview → it replies that it can't find one yet.

## Option A — Railway (recommended for always-on)

Railway keeps the process up, gives you a persistent volume, and builds the Dockerfile
directly. No public URL is required for the bot to work.

1. Push this repo to GitHub (your fork/clone).
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo. It detects
   `railway.json` and builds the `Dockerfile`.
3. **Add a volume** mounted at **`/data`** (Service → Volumes). This is required —
   without it, a redeploy wipes the baseline crawl and the bot will reply "I need a
   baseline crawl first" to everyone. The mount path must be exactly `/data` (the
   image's `SENTINEL_OUTPUT_DIR`); a volume at any other path — or overriding
   `SENTINEL_OUTPUT_DIR` away from the mount — silently persists nothing.
4. **Set variables** (Service → Variables): `GH_TOKEN`, `ANTHROPIC_API_KEY` (+
   `SENTINEL_LLM_PROVIDER=anthropic`), `SENTINEL_EMAIL`, `SENTINEL_PASSWORD`, and any
   per-project credential vars. `SENTINEL_OUTPUT_DIR=/data`, `SENTINEL_UI_HOST=0.0.0.0`,
   and `SENTINEL_NO_SANDBOX=true` are already baked into the image.
5. Deploy. To reach the dashboard for first-run setup, use Railway's
   **private networking** or a temporary public domain you remove afterward (remember:
   the dashboard has no auth — don't leave it publicly reachable).

## Option B — Docker / docker-compose (any host or VPS)

Runs the same image anywhere Docker runs — a cheap always-on VPS, a home server, or
your own machine.

```bash
cp .env.example .env
# edit .env: GH_TOKEN, ANTHROPIC_API_KEY (+ SENTINEL_LLM_PROVIDER=anthropic),
#            SENTINEL_EMAIL, SENTINEL_PASSWORD
docker compose up -d --build
```

- The dashboard is published on **`127.0.0.1:4317`** only (see `docker-compose.yml`) —
  private by default. To administer it from another machine, tunnel in
  (`ssh -L 4317:127.0.0.1:4317 your-host`) rather than opening the port publicly.
- State persists in the `sentinel-data` volume.
- Logs: `docker compose logs -f`. You should see `Poller started (every 30s).`

> The bot reacts to mentions only while the process is up. On a laptop that means
> "while it's awake" — for a true team bot, use an always-on host (Railway/VPS).

## First-run setup (one time, by the admin)

1. Open the dashboard (`http://127.0.0.1:4317`, privately).
2. **Register the repo** — enter `owner/name`. Auto-detect can propose the login recipe
   and preview-env hint from the live app; confirm it. Set the mention handle (default
   `@sentinel`) and the credential env-var names.
3. **Run a baseline crawl** for the project. This is **required before verification** —
   Sentinel diffs PRs against this baseline interaction graph. Without it, every mention
   gets "I need a baseline crawl first."
4. Confirm health: the dashboard reports GitHub auth ✓, LLM ✓, and that the poller is
   running.

That's it — the bot is live.

## How the team uses it

On any PR in a registered repo, comment:

```
@sentinel
```

Sentinel resolves the PR's preview deployment, walks the affected flows in a recorded
browser (read-only — it never writes to your app), judges `pass / fail / uncertain`,
and posts the verdict back as a comment with a link to the recording. It re-checks for
a few minutes if the preview isn't ready yet.

## Things worth knowing

- **One run at a time.** Concurrency is capped at 1 (`SENTINEL_MAX_CONCURRENT`) because
  LLM cost/trace state is process-global. Simultaneous tags queue and run sequentially;
  each run takes a few minutes. Fine for a small team; a busy repo will see a backlog.
- **Read-only, always.** Server runs force read-only regardless of env: mutating
  requests are blocked at the network layer. Safe to point at a live preview.
- **Recordings** are uploaded to a `sentinel-artifacts` GitHub release (private repos
  keep them access-gated to people with repo access). Set `SENTINEL_VIDEO_PUBLISH=off`
  to keep them local-only.
- **Dashboard link in comments.** Set `SENTINEL_DASHBOARD_URL` to your dashboard's URL
  if you expose one; otherwise the "view run" link points at localhost (harmless when
  the dashboard is private — the watchable recording link still works for everyone).

## Configuration reference

| Variable | Purpose | Default |
| --- | --- | --- |
| `GH_TOKEN` | Bot account token for `gh` (poll, comment, upload) | — (required when deployed) |
| `SENTINEL_LLM_PROVIDER` | `anthropic` \| `openai` \| `bedrock` | `anthropic` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AWS_*` | LLM credentials for the chosen provider | — |
| `SENTINEL_EMAIL` / `SENTINEL_PASSWORD` | Test login for the app under test | — |
| `SENTINEL_PROJECT_<REPO>_EMAIL` / `_PASSWORD` | Per-project test credentials (multi-repo) | — |
| `SENTINEL_OUTPUT_DIR` | Where state/recordings are written (mount a volume here) | `/data` (image) |
| `SENTINEL_UI_HOST` | Interface the dashboard binds to | `0.0.0.0` (image) / `127.0.0.1` (local) |
| `SENTINEL_UI_PORT` / `PORT` | Dashboard port (`PORT` wins, for hosts that inject it) | `4317` |
| `SENTINEL_NO_SANDBOX` | Run Chromium without its setuid sandbox (needed as root in a container) | `true` (image) |
| `SENTINEL_DASHBOARD_URL` | Public dashboard URL for PR-comment links | localhost |
| `SENTINEL_POLL_MS` | Mention poll interval | `30000` |
| `SENTINEL_VIDEO_PUBLISH` | `releases` (upload recordings) or `off` | `releases` |

## Troubleshooting

- **"I need a baseline crawl first"** → run a baseline crawl for the project (or your
  volume isn't persistent and the graph was wiped on redeploy).
- **"No ready preview deployment found"** → the PR's preview isn't built/successful yet,
  or the preview-env hint doesn't match. Check the project's `previewEnvIncludes`.
- **GitHub auth fails** → `GH_TOKEN` missing/expired or lacks scope; the bot account
  must have write access to the repo.
- **Chromium won't launch** → make sure `SENTINEL_NO_SANDBOX=true` (set automatically in
  the image). Running the bare Node app as root without it will fail.
- **Nothing happens on a tag** → check `docker compose logs -f` for `Poller started`;
  confirm the repo is registered and the mention handle matches what you typed.
- **`docker build` fails downloading fonts** → the Next.js build fetches its web fonts
  at build time, so the build machine needs outbound network (the norm on Docker Desktop
  and Railway). Air-gapped builders would need the fonts vendored locally.
