# syntax=docker/dockerfile:1.7
#
# CodeForPhilly modernization — single image bundling the API + built SPA.
#
# Multi-stage build:
#   1. deps       — npm ci for the full monorepo
#   2. build      — type-check + build api/web + prune dev deps
#   3. runtime    — minimal alpine + git + ca-certificates; non-root user
#
# Build:
#   docker build -t cfp:dev .
# Run (filesystem private storage; for smoke tests only):
#   docker run --rm -p 3001:3001 \
#     -e CFP_DATA_REMOTE=https://github.com/CodeForPhilly/codeforphilly-data-snapshot.git \
#     -e STORAGE_BACKEND=filesystem \
#     -e CFP_PRIVATE_STORAGE_PATH=/app/private-storage \
#     -e CFP_JWT_SIGNING_KEY=$(openssl rand -base64 48) \
#     cfp:dev
#
# Production env-vars are documented in docs/operations/deploy.md.

# ----------------------------------------------------------------------------
# Stage 1: deps — install full workspace deps (incl. dev) for the build step.
# ----------------------------------------------------------------------------
FROM node:22.22-alpine AS deps

WORKDIR /app

# git is required by some npm postinstall scripts (e.g. transitive deps that
# resolve from git tags during install).
RUN apk add --no-cache git python3 make g++

# Copy lockfiles + manifests first so docker layer-cache survives source edits.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --no-audit --no-fund

# ----------------------------------------------------------------------------
# Stage 2: build — compile api + web, then prune to production deps only.
# ----------------------------------------------------------------------------
FROM node:22.22-alpine AS build

WORKDIR /app

RUN apk add --no-cache git python3 make g++

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY tsconfig.base.json package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages

# Build both workspaces. Web is built first so api/dist references work; the
# workspace `build` script handles order via `--if-present`.
RUN npm run build --workspaces --if-present

# Drop devDependencies from node_modules to shrink the runtime image. We still
# need workspace-local node_modules (better-sqlite3 native binding lives there).
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ----------------------------------------------------------------------------
# Stage 3: runtime — minimal image; node, git, ca-certificates, tini.
# ----------------------------------------------------------------------------
FROM node:22.22-alpine AS runtime

# git: needed at boot for the entrypoint clone + by the gitsheets push daemon.
# ca-certificates: TLS to GitHub / S3-compatible endpoints.
# tini: minimal init so SIGTERM from k8s reaches node cleanly.
# openssh-client: for ssh:// remotes (deploy key auth to the data repo).
RUN apk add --no-cache git ca-certificates tini openssh-client

WORKDIR /app

# Copy built artifacts + pruned node_modules.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules

# Entrypoint script handles data-repo init/refresh before exec'ing node.
COPY deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Defaults pointing at PVC mount points. Override via Helm values / env.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    CFP_DATA_REPO_PATH=/app/data \
    CFP_WEB_DIST_PATH=/app/apps/web/dist \
    STORAGE_BACKEND=s3 \
    NODE_OPTIONS="--max-old-space-size=384"

# Non-root user. The Helm chart's PVC must be writable by uid 1000 (alpine
# `node` user). 1000:1000 is the upstream node:alpine default.
USER node

EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/api/dist/index.js"]
