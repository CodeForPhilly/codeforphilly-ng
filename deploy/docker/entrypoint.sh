#!/bin/sh
# CodeForPhilly API entrypoint.
#
# Per specs/architecture.md, on pod start:
#   1. Runs `git clone` / `git fetch && git reset --hard origin/<branch>`
#      against CFP_DATA_REMOTE to populate the data-repo working tree.
#   2. exec node apps/api/dist/index.js
#
# Required env:
#   CFP_DATA_REPO_PATH — local working-tree path (mounted PVC in k8s)
#   CFP_DATA_REMOTE    — git URL to clone/fetch from
# Optional env:
#   CFP_DATA_BRANCH    — branch to track (default: main)
#   GIT_SSH_COMMAND    — set by Helm when an SSH deploy key is mounted; usually
#                        `ssh -i /etc/cfp/git-deploy-key -o StrictHostKeyChecking=accept-new`
#
# Failure modes: any non-zero exit causes the container to crash. K8s restarts
# it. Readiness probe stays 503 until /api/health/ready returns 200.

set -eu

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

: "${CFP_DATA_REPO_PATH:?CFP_DATA_REPO_PATH must be set}"

DATA_BRANCH="${CFP_DATA_BRANCH:-main}"

if [ -z "${CFP_DATA_REMOTE:-}" ]; then
  if [ -d "$CFP_DATA_REPO_PATH/.git" ]; then
    log "CFP_DATA_REMOTE unset; using existing working tree at $CFP_DATA_REPO_PATH"
  else
    log "ERROR: CFP_DATA_REMOTE is unset and $CFP_DATA_REPO_PATH is not a git repo"
    exit 1
  fi
else
  mkdir -p "$CFP_DATA_REPO_PATH"

  if [ -d "$CFP_DATA_REPO_PATH/.git" ]; then
    log "refreshing existing data repo at $CFP_DATA_REPO_PATH (branch=$DATA_BRANCH)"
    cd "$CFP_DATA_REPO_PATH"

    # Re-point origin in case CFP_DATA_REMOTE was rotated.
    git remote set-url origin "$CFP_DATA_REMOTE"
    git fetch --prune --depth=1 origin "$DATA_BRANCH"
    git checkout -B "$DATA_BRANCH" "origin/$DATA_BRANCH"
    git reset --hard "origin/$DATA_BRANCH"
    cd - >/dev/null
  else
    log "cloning $CFP_DATA_REMOTE into $CFP_DATA_REPO_PATH (branch=$DATA_BRANCH)"
    # --depth=1 keeps the PVC footprint small; the push daemon will deepen as
    # needed when it next pushes (or we accept periodic re-clones).
    git clone --depth=1 --branch "$DATA_BRANCH" "$CFP_DATA_REMOTE" "$CFP_DATA_REPO_PATH"
  fi
fi

# Identity for any commits the API makes (the gitsheets writer commits per
# mutation). Override via env in Helm values if you want per-environment
# identities.
: "${GIT_AUTHOR_NAME:=CodeForPhilly API}"
: "${GIT_AUTHOR_EMAIL:=api@codeforphilly.org}"
: "${GIT_COMMITTER_NAME:=$GIT_AUTHOR_NAME}"
: "${GIT_COMMITTER_EMAIL:=$GIT_AUTHOR_EMAIL}"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

cd "$CFP_DATA_REPO_PATH"
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
cd - >/dev/null

log "data repo ready; starting API"
exec "$@"
