#!/bin/sh
# CodeForPhilly API entrypoint.
#
# Minimal boot prep. The data-repo reconciliation state machine
# (in-sync / behind / ahead / diverged-clean-rebase / diverged-conflict-escape)
# lives in the Node API process — see apps/api/src/store/reconcile.ts
# and apps/api/src/plugins/reconcile.ts. This script only ensures:
#
#   1. CFP_DATA_REPO_PATH is trusted by git regardless of file-ownership
#      (volumes may carry files owned by a different uid than the current
#      runAsUser between iterations).
#   2. A reasonable git user identity is configured for any committer line
#      the API's plumbing-based reconcile might mint.
#   3. CFP_DATA_REPO_PATH is a valid **bare** git repo. On first pod boot
#      (empty volume), we do an initial bare clone. On subsequent boots
#      within the same pod's lifetime, the reconciler inside the API
#      handles fetching + ref advancement.
#
# Bare invariant: gitsheets reads/writes via hologit's tree-object
# interface — no working tree needed. See
# specs/behaviors/storage.md → "The data clone is bare".
#
# Required env:
#   CFP_DATA_REPO_PATH — bare gitdir (the path itself is the gitdir; no
#                       .git subdirectory inside it)
# Optional env:
#   CFP_DATA_REMOTE    — git URL to clone/fetch/push. If unset, the
#                        entrypoint assumes an offline-style dev setup
#                        and uses whatever is already at the path.
#   CFP_DATA_BRANCH    — branch to set HEAD to on initial clone (default: main).
#   GIT_SSH_COMMAND    — set when an SSH deploy key is mounted.

set -eu

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

: "${CFP_DATA_REPO_PATH:?CFP_DATA_REPO_PATH must be set}"

DATA_BRANCH="${CFP_DATA_BRANCH:-main}"

# Trust the data-repo path regardless of file ownership.
git config --global --add safe.directory "$CFP_DATA_REPO_PATH"

# Pseudonymous identity for any direct git operations that pick up the
# runtime committer line.
: "${GIT_AUTHOR_NAME:=CodeForPhilly API}"
: "${GIT_AUTHOR_EMAIL:=api@users.noreply.codeforphilly.org}"
: "${GIT_COMMITTER_NAME:=$GIT_AUTHOR_NAME}"
: "${GIT_COMMITTER_EMAIL:=$GIT_AUTHOR_EMAIL}"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

# Bare-repo marker: an `objects/` directory at the path root. (A non-bare
# clone has `.git/objects/` instead, so this check distinguishes the two
# without false positives on either side.)
if [ ! -d "$CFP_DATA_REPO_PATH/objects" ]; then
  if [ -z "${CFP_DATA_REMOTE:-}" ]; then
    log "ERROR: $CFP_DATA_REPO_PATH is not a bare git repo and CFP_DATA_REMOTE is unset"
    exit 1
  fi

  # Refuse a non-bare working-tree clone left over from an earlier build.
  if [ -d "$CFP_DATA_REPO_PATH/.git" ]; then
    log "ERROR: $CFP_DATA_REPO_PATH contains a non-bare clone (.git subdirectory)"
    log "  The app requires a bare clone — wipe the volume and restart, or"
    log "  delete $CFP_DATA_REPO_PATH/.git and re-clone."
    exit 1
  fi

  mkdir -p "$CFP_DATA_REPO_PATH"

  # Volume may carry residue from a previous pod that bailed mid-clone.
  # `git clone` refuses to clone into a non-empty directory, so wipe it
  # first. Safe because the data repo is always re-cloneable.
  if [ -n "$(ls -A "$CFP_DATA_REPO_PATH" 2>/dev/null)" ]; then
    log "$CFP_DATA_REPO_PATH non-empty but not a bare repo — wiping before clone"
    find "$CFP_DATA_REPO_PATH" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  fi

  log "bare-cloning $CFP_DATA_REMOTE into $CFP_DATA_REPO_PATH (HEAD → $DATA_BRANCH)"
  # Full history (no --depth) so the API-side reconciler can rebase against
  # any realistic divergence on subsequent boots.
  git clone --bare --branch "$DATA_BRANCH" "$CFP_DATA_REMOTE" "$CFP_DATA_REPO_PATH"
fi

# Pin the API's committer identity into the bare repo's config.
git --git-dir="$CFP_DATA_REPO_PATH" config user.name  "$GIT_AUTHOR_NAME"
git --git-dir="$CFP_DATA_REPO_PATH" config user.email "$GIT_AUTHOR_EMAIL"

# Refresh the origin URL in case CFP_DATA_REMOTE was rotated. Idempotent.
if [ -n "${CFP_DATA_REMOTE:-}" ] && git --git-dir="$CFP_DATA_REPO_PATH" remote get-url origin >/dev/null 2>&1; then
  git --git-dir="$CFP_DATA_REPO_PATH" remote set-url origin "$CFP_DATA_REMOTE"
fi

log "data repo ready (bare); starting API (reconciliation runs inside the API process)"
exec "$@"
