#!/bin/sh
# CodeForPhilly API entrypoint.
#
# Minimal boot prep. The data-repo reconciliation state machine
# (in-sync / behind / ahead / diverged-clean-rebase / diverged-conflict-escape)
# lives in the Node API process now — see apps/api/src/store/reconcile.ts
# and apps/api/src/plugins/reconcile.ts. This script only ensures:
#
#   1. The PVC mount at CFP_DATA_REPO_PATH is trusted by git regardless of
#      file-ownership (PVCs survive pod restarts and may carry files owned
#      by a different uid than the current runAsUser).
#   2. A reasonable git user identity is configured for any rebase committer
#      writes (rebase preserves authors of replayed commits; the committer
#      line is the only thing that can pick up runtime identity).
#   3. There IS a valid `.git` working tree at CFP_DATA_REPO_PATH. On first
#      pod boot (empty PVC), we do an initial full-history clone. On
#      subsequent boots, the reconciler inside the API decides what to do.
#
# Required env:
#   CFP_DATA_REPO_PATH — local working-tree path (mounted PVC in k8s)
# Optional env:
#   CFP_DATA_REMOTE    — git URL to clone/fetch/push. If unset, the entrypoint
#                        assumes an offline-style dev setup and uses whatever
#                        working tree is already at CFP_DATA_REPO_PATH.
#   CFP_DATA_BRANCH    — branch to clone initially (default: main).
#   GIT_SSH_COMMAND    — set when an SSH deploy key is mounted.

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

# Pseudonymous identity for any direct git operations that pick up the
# runtime committer line. API mutations supply their own GIT_AUTHOR_* via
# gitsheets transaction options; the reconciler re-applies these to the
# repo-local config too, so this is belt-and-suspenders for any other tool
# that touches the tree.
: "${GIT_AUTHOR_NAME:=CodeForPhilly API}"
: "${GIT_AUTHOR_EMAIL:=api@users.noreply.codeforphilly.org}"
: "${GIT_COMMITTER_NAME:=$GIT_AUTHOR_NAME}"
: "${GIT_COMMITTER_EMAIL:=$GIT_AUTHOR_EMAIL}"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

if [ ! -d "$CFP_DATA_REPO_PATH/.git" ]; then
  if [ -z "${CFP_DATA_REMOTE:-}" ]; then
    log "ERROR: $CFP_DATA_REPO_PATH is not a git repo and CFP_DATA_REMOTE is unset"
    exit 1
  fi

  mkdir -p "$CFP_DATA_REPO_PATH"

  # PVC may carry residue from a previous pod that bailed mid-clone.
  # `git clone` refuses to clone into a non-empty directory, so wipe it
  # first. Safe because the data repo is always re-cloneable.
  if [ -n "$(ls -A "$CFP_DATA_REPO_PATH" 2>/dev/null)" ]; then
    log "$CFP_DATA_REPO_PATH non-empty but lacks .git — wiping before clone"
    find "$CFP_DATA_REPO_PATH" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  fi

  log "cloning $CFP_DATA_REMOTE into $CFP_DATA_REPO_PATH (branch=$DATA_BRANCH)"
  # Full history (no --depth) so the API-side reconciler can rebase against
  # any realistic divergence on subsequent boots.
  git clone --branch "$DATA_BRANCH" "$CFP_DATA_REMOTE" "$CFP_DATA_REPO_PATH"
fi

cd "$CFP_DATA_REPO_PATH"
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
# Ensure the origin URL matches the current env (in case CFP_DATA_REMOTE
# was rotated). Idempotent.
if [ -n "${CFP_DATA_REMOTE:-}" ] && git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$CFP_DATA_REMOTE"
fi
cd - >/dev/null

log "data repo ready; starting API (reconciliation runs inside the API process)"
exec "$@"
