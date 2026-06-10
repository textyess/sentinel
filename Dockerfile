# syntax=docker/dockerfile:1
#
# Sentinel — self-hosted QA bot. One always-on container runs the whole thing:
# the Next.js dashboard, its API, the @mention poller, and the Playwright engine
# in a single process. It only ever reaches OUT (GitHub + the app under test), so
# it needs no public ingress — just keep it running. See DEPLOY.md.
FROM node:22-bookworm

# System packages:
#  - gh   : Sentinel drives GitHub entirely through the gh CLI (poll mentions,
#           post verdicts, upload recordings). Authenticated via GH_TOKEN at runtime.
#  - git  : some engine paths stamp artifacts with a git sha.
#  - tini : real PID 1, so a redeploy's SIGTERM reaches Node and Chromium cleanly
#           (and zombie browser processes get reaped).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gnupg tini \
    && install -d -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Package managers for the no-preview bring-up path: Sentinel clones a target repo
# and runs the operator's install/run recipe inside this container, and the recipe
# scanner proposes the manager matching the repo's lockfile (pnpm/yarn/bun/npm).
# The base image ships only npm + yarn classic, so a `pnpm install` recipe would die
# with exit 127. Pinned to majors; bun's npm package resolves the platform binary.
RUN npm install -g --no-audit --no-fund pnpm@10 bun@1

WORKDIR /app

# Install deps first for layer caching. The repo intentionally ships no lockfile
# (it's gitignored), so this is `npm install`, not `npm ci`. devDependencies are
# needed for `next build` (Tailwind, TypeScript), so NODE_ENV is left unset here.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Chromium + its OS libraries, matching the Playwright version npm just resolved.
# Installed before the source copy so editing app code doesn't re-download the browser.
RUN npx playwright install --with-deps chromium

# App source.
COPY . .

# Build the Next.js app (UI + API routes + the bundled engine). This also
# type-checks the project, so a type error fails the image build.
RUN npm run build

# Runtime configuration baked into the image:
#  - bind every interface inside the container (the container boundary is the
#    isolation; map the port to 127.0.0.1 on the host to keep the UI private),
#  - run Chromium without its setuid sandbox (required as root in a container),
#  - keep all state under /data so a mounted volume can persist it across redeploys.
ENV NODE_ENV=production \
    SENTINEL_UI_HOST=0.0.0.0 \
    SENTINEL_NO_SANDBOX=true \
    SENTINEL_HEADLESS=true \
    SENTINEL_OUTPUT_DIR=/data

# Mount a persistent volume here (Railway Volume, or the compose `sentinel-data`
# volume) so state survives redeploys. No Dockerfile VOLUME instruction: Railway's
# builder rejects it ("use Railway Volumes"), and it isn't needed for local Docker.
RUN mkdir -p /data

EXPOSE 4317
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start"]
