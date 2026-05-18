#!/bin/sh
# CodeForPhilly API entrypoint.
#
# On pod start:
#   1. Ensures a workable clone of CFP_DATA_REMOTE exists at CFP_DATA_REPO_PATH.
#   2. Reconciles local commits (made by the previous pod's runtime that the
#      push daemon hadn't yet pushed) with origin:
#        - in sync        → no-op
#        - behind         → fast-forward
#        - ahead          → push pending commits to origin
#        - diverged + clean rebase → rebase + push
#        - diverged + conflicts    → push a `conflicts/<UTC-timestamp>` branch
#          to origin for operator review, then hard-reset local to origin so
#          the pod boots from a known-good state. Never silently drops work.
#   3. exec the API.
#
# Required env:
#   CFP_DATA_REPO_PATH — local working-tree path (mounted PVC in k8s)
# Optional env:
#   CFP_DATA_REMOTE    — git URL to clone/fetch/push. If unset, the entrypoint
#                        assumes an offline-style dev setup and uses whatever
#                        working tree is already at CFP_DATA_REPO_PATH.
#   CFP_DATA_BRANCH    — branch to track (default: main).
#   GIT_SSH_COMMAND    — set when an SSH deploy key is mounted.
#
# Failure modes:
# - Fetch failures are non-fatal — log + continue with local state. The
#   push-daemon retries on its schedule.
# - Push failures during reconciliation are non-fatal — the push-daemon
#   retries once the API starts.
# - Rebase conflicts trigger the escape hatch (conflict branch + hard reset).
#   The API still boots; the operator investigates the named branch.
# - Anything else (clone failure, etc.) crashes the container; k8s restarts.

set -eu

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

: "${CFP_DATA_REPO_PATH:?CFP_DATA_REPO_PATH must be set}"

DATA_BRANCH="${CFP_DATA_BRANCH:-main}"

# Trust the data-repo working tree regardless of file ownership. PVCs survive
# pod restarts and may carry files owned by a different uid than this pod's
# runAsUser (e.g., an earlier iteration ran as root).
git config --global --add safe.directory "$CFP_DATA_REPO_PATH"

# Identity for any direct git operations made by the entrypoint (rebase
# preserves authors of existing commits; this just covers the committer when
# rebase actually rewrites a commit). API mutations supply their own GIT_AUTHOR_*
# via gitsheets transaction options.
: "${GIT_AUTHOR_NAME:=CodeForPhilly API}"
: "${GIT_AUTHOR_EMAIL:=api@users.noreply.codeforphilly.org}"
: "${GIT_COMMITTER_NAME:=$GIT_AUTHOR_NAME}"
: "${GIT_COMMITTER_EMAIL:=$GIT_AUTHOR_EMAIL}"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

# ---------------------------------------------------------------------------
# Reconcile against origin. Returns 0 on success or a soft failure; only
# unrecoverable filesystem/clone errors propagate via `set -e`.
# ---------------------------------------------------------------------------
reconcile() {
  cd "$CFP_DATA_REPO_PATH"

  git config user.name  "$GIT_AUTHOR_NAME"
  git config user.email "$GIT_AUTHOR_EMAIL"
  git remote set-url origin "$CFP_DATA_REMOTE"

  # Unshallow if a previous clone used --depth=1; the reconciliation logic
  # below needs the merge-base to be reachable.
  if [ -f .git/shallow ]; then
    log "unshallowing existing clone (needed for rebase)"
    git fetch --unshallow origin "$DATA_BRANCH" 2>&1 | sed 's/^/  /' || \
      log "WARN: --unshallow failed; continuing with shallow history"
  fi

  if ! git fetch --prune origin "$DATA_BRANCH" 2>&1 | sed 's/^/  /'; then
    log "WARN: fetch failed; skipping reconciliation, using local state"
    return 0
  fi

  # Ensure we're on the branch.
  if git rev-parse --verify "refs/heads/$DATA_BRANCH" >/dev/null 2>&1; then
    git checkout "$DATA_BRANCH" 2>&1 | sed 's/^/  /'
  else
    git checkout -b "$DATA_BRANCH" "origin/$DATA_BRANCH" 2>&1 | sed 's/^/  /'
  fi

  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$DATA_BRANCH")
  if ! BASE=$(git merge-base HEAD "origin/$DATA_BRANCH" 2>/dev/null); then
    log "WARN: no merge-base with origin/$DATA_BRANCH; resetting to origin"
    git reset --hard "origin/$DATA_BRANCH" 2>&1 | sed 's/^/  /'
    return 0
  fi

  if [ "$LOCAL" = "$REMOTE" ]; then
    log "in sync with origin/$DATA_BRANCH"
    return 0
  fi

  if [ "$LOCAL" = "$BASE" ]; then
    log "behind origin/$DATA_BRANCH — fast-forwarding"
    git merge --ff-only "origin/$DATA_BRANCH" 2>&1 | sed 's/^/  /'
    return 0
  fi

  if [ "$REMOTE" = "$BASE" ]; then
    AHEAD=$(git rev-list --count "origin/$DATA_BRANCH..HEAD")
    log "ahead of origin/$DATA_BRANCH by ${AHEAD} commit(s) — pushing"
    if git push origin "$DATA_BRANCH" 2>&1 | sed 's/^/  /'; then
      log "push succeeded"
    else
      log "WARN: push failed; push-daemon will retry once API starts"
    fi
    return 0
  fi

  # Diverged: local has commits that origin doesn't AND origin has commits
  # that local doesn't. Attempt a rebase; if it conflicts, escape-hatch.
  AHEAD=$(git rev-list --count "origin/$DATA_BRANCH..HEAD")
  BEHIND=$(git rev-list --count "HEAD..origin/$DATA_BRANCH")
  log "diverged from origin/$DATA_BRANCH (ahead=${AHEAD}, behind=${BEHIND}) — rebasing"

  if git rebase "origin/$DATA_BRANCH" 2>&1 | sed 's/^/  /'; then
    log "rebase clean — pushing"
    if git push origin "$DATA_BRANCH" 2>&1 | sed 's/^/  /'; then
      log "push succeeded"
    else
      log "WARN: push failed; push-daemon will retry once API starts"
    fi
    return 0
  fi

  # Conflict — escape hatch.
  CONFLICT_BRANCH="conflicts/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  log "ERROR: rebase conflict on $DATA_BRANCH — invoking escape hatch"
  git rebase --abort 2>&1 | sed 's/^/  /' || true
  log "preserving pre-rebase HEAD ($LOCAL) at $CONFLICT_BRANCH"
  git branch "$CONFLICT_BRANCH" "$LOCAL"
  if git push origin "$CONFLICT_BRANCH" 2>&1 | sed 's/^/  /'; then
    log "pushed $CONFLICT_BRANCH to origin — operator must investigate"
  else
    log "WARN: failed to push $CONFLICT_BRANCH; diverged commits preserved only in this PVC's reflog"
  fi
  log "resetting $DATA_BRANCH to origin/$DATA_BRANCH"
  git reset --hard "origin/$DATA_BRANCH" 2>&1 | sed 's/^/  /'
  return 0
}

if [ -z "${CFP_DATA_REMOTE:-}" ]; then
  if [ -d "$CFP_DATA_REPO_PATH/.git" ]; then
    log "CFP_DATA_REMOTE unset; using existing working tree at $CFP_DATA_REPO_PATH"
    cd "$CFP_DATA_REPO_PATH"
    git config user.name  "$GIT_AUTHOR_NAME"
    git config user.email "$GIT_AUTHOR_EMAIL"
    cd - >/dev/null
  else
    log "ERROR: CFP_DATA_REMOTE is unset and $CFP_DATA_REPO_PATH is not a git repo"
    exit 1
  fi
else
  mkdir -p "$CFP_DATA_REPO_PATH"

  if [ -d "$CFP_DATA_REPO_PATH/.git" ]; then
    log "reconciling existing data repo at $CFP_DATA_REPO_PATH (branch=$DATA_BRANCH)"
    reconcile
    cd - >/dev/null || true
  else
    # PVC may carry residue from a previous pod that bailed mid-clone.
    # `git clone` refuses to clone into a non-empty directory, so wipe it
    # first. Safe because the data repo is always re-cloneable.
    if [ -n "$(ls -A "$CFP_DATA_REPO_PATH" 2>/dev/null)" ]; then
      log "$CFP_DATA_REPO_PATH non-empty but lacks .git — wiping before clone"
      find "$CFP_DATA_REPO_PATH" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    fi
    log "cloning $CFP_DATA_REMOTE into $CFP_DATA_REPO_PATH (branch=$DATA_BRANCH)"
    # Full history (no --depth) so subsequent reconciliations can rebase.
    git clone --branch "$DATA_BRANCH" "$CFP_DATA_REMOTE" "$CFP_DATA_REPO_PATH"
    cd "$CFP_DATA_REPO_PATH"
    git config user.name  "$GIT_AUTHOR_NAME"
    git config user.email "$GIT_AUTHOR_EMAIL"
    cd - >/dev/null
  fi
fi

log "data repo ready; starting API"
exec "$@"
