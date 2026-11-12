# Runbook

On-call playbooks for the codeforphilly-ng production service.

> See also: [monitoring.md](monitoring.md) for the alarm signals we *want*
> (none are wired yet), [cutover.md](cutover.md) for cutover-specific
> procedures, [deploy.md](deploy.md) for the GitOps flow.

## Where to point kubectl

| | Cluster repo | Namespace |
| --- | --- | --- |
| Production | `cfp-live-cluster` | `codeforphilly-ng` |
| Sandbox | `cfp-sandbox-cluster` | `codeforphilly-rewrite-sandbox` |

Commands below use `-n codeforphilly-ng`; substitute the sandbox namespace
as needed. The Deployment is `deploy/codeforphilly` in both.

## "API won't boot"

Symptoms: pod CrashLoopBackOff, `kubectl describe pod` shows the container
restarting, no `/api/health` response.

### 1. Read the logs first

```bash
kubectl -n codeforphilly-ng logs deploy/codeforphilly --previous
kubectl -n codeforphilly-ng logs deploy/codeforphilly --tail=200
```

Look for one of the common boot failures:

| Log line excerpt | Cause | Fix |
| ------------------ | ------- | ----- |
| `[entrypoint] ERROR: CFP_DATA_REMOTE is unset` | The Secret containing `CFP_DATA_REMOTE` isn't reaching the pod. | Check `kubectl -n codeforphilly-ng get secret codeforphilly-secrets -o yaml`; verify the SealedSecret in the GitOps repo decrypted successfully (look at the sealed-secrets controller logs). |
| `fatal: could not read Username for 'https://...'` or `Permission denied (publickey)` | Bad/missing data-repo credentials. | Verify the `codeforphilly-data-deploy-key` Secret holds a valid `id_ed25519` whose public key has push access to the data repo. See [secrets.md](secrets.md#data-repo-deploy-key). |
| `Failed to open public gitsheets store` | Bare clone corrupt or missing `.gitsheets/` configs. | Exec into the pod, inspect `/app/data/refs/`, `/app/data/objects/`, and verify `.gitsheets/` exists in HEAD via `git --git-dir=/app/data show HEAD:.gitsheets`. Recovery: restart the pod — `data` is an `emptyDir`, so a fresh pod re-clones from `CFP_DATA_REMOTE` automatically. |
| `Failed to load private store (filesystem)` | The `codeforphilly-private` PVC didn't mount, is read-only, or the `.jsonl` files are malformed. | `kubectl -n codeforphilly-ng describe pod` for volume events; exec in and `ls -la /app/private-storage`. A malformed line points at a bad manual load — see [legacy-credentials-import.md](legacy-credentials-import.md). |
| `environment variable ... is required` | A required env (`CFP_DATA_REPO_PATH`, `STORAGE_BACKEND`, `CFP_JWT_SIGNING_KEY`) is missing. | Manifest regression. Compare against `deploy/kustomize/base/configmap.yaml` + the GitOps repo's SealedSecret. |
| OOMKilled (no log line; `kubectl describe pod` shows it) | In-memory record set too big for `NODE_OPTIONS`/`resources.limits`. Usually an unpruned `published` push. | Check whether the last `published` push skipped the prune step ([spam-detection.md](spam-detection.md)). Re-prune and push; the hot-reload will pick it up once the pod is up. |

### 2. Drop into the pod (if it stays up long enough)

```bash
kubectl -n codeforphilly-ng debug -it deploy/codeforphilly \
  --image=alpine --target=api -- sh
```

From inside:

```bash
# Is the bare data repo really there? Bare gitdir lives at the path root —
# no .git subdir; expect HEAD, config, objects/, refs/ at the top.
ls -la /app/data
git --git-dir=/app/data show HEAD:.gitsheets

# Is the private store there?
ls -la /app/private-storage
wc -l /app/private-storage/*.jsonl

# Are env vars present?
env | grep -E '^(CFP_|STORAGE_|GITHUB_|SAML_|POSTMARK_)' | sort

# Can we reach the data remote?
git ls-remote "$CFP_DATA_REMOTE" 2>&1 | head
```

### 3. Last-resort recovery

If the cluster state is unrecoverable but the data remote is intact:

```bash
# Revert the most recent GitOps deploy (the cluster repo's deploy PR is a
# normal merge commit on `deploys/k8s-manifests`). Use cfp-sandbox-cluster
# for the sandbox.
gh-axi -R CodeForPhilly/cfp-live-cluster pr list --base deploys/k8s-manifests --state merged
git -C ~/Repositories/cfp-live-cluster revert <merge-sha> --mainline 1
git -C ~/Repositories/cfp-live-cluster push origin deploys/k8s-manifests

# Or pin to a previous release: move BOTH
#   .holo/sources/codeforphilly-ng.toml   (ref = "refs/tags/vX.Y.Z")
#   codeforphilly-ng/app/kustomization.yaml (images[].newTag)
# back to the last known-good tag on a branch, PR into main, merge the
# resulting deploy PR.

# Out-of-band hotfix (bypasses GitOps — fix the repo afterward):
kubectl -n codeforphilly-ng set image \
  deploy/codeforphilly codeforphilly=ghcr.io/codeforphilly/codeforphilly-ng:<known-good-tag>
```

The bare data clone lives in an `emptyDir` — re-cloned from the git remote on
every pod boot. Pod restart is the recovery primitive; there's no data PVC to
delete. The `codeforphilly-private` PVC **is** the private store — never
delete it as part of a recovery.

## "Readiness flapping / 503 spikes"

Readiness probe (`/api/health/ready`) returns 503 only when the store
decorators are missing — that only happens during boot. Mid-life flapping
likely means:

- Liveness probe (`/api/health`) failed and k8s is restarting the pod. Look
  at the previous logs.
- Memory pressure → OOMKilled. Check for an unpruned `published` push first
  (see the boot table above); only then bump `resources.limits.memory` /
  `NODE_OPTIONS=--max-old-space-size`.

## "Mutations succeed in UI but don't appear on GitHub"

Push daemon failure. Check logs for git push errors. Common causes:

- Deploy key removed/expired — see [secrets.md](secrets.md#data-repo-deploy-key).
- Remote branch protection rejecting the push.
- Network egress blocked.

The in-memory state and the pod's bare clone continue to accept writes —
it's only the asynchronous mirror to GitHub that's broken. Once fixed, the
daemon pushes the backlog. **Don't restart the pod to "fix" this** until the
backlog has been pushed or fetched out (below): the clone is an `emptyDir`
and unpushed commits die with the pod.

## Hot-reload webhook

The API exposes `POST /api/_internal/reload-data` so that a push to
`CFP_DATA_BRANCH` (`published`) propagates to the running pod without
rolling it. The `codeforphilly-data` repo's
`.github/workflows/notify-deployments.yml` calls this endpoint on every push
to `published`, once per target: sandbox (`next-v2.codeforphilly.org`) and
prod (`next.codeforphilly.org` before cutover; the apex after — the
workflow's prod URL must be switched at cutover, see
[cutover.md](cutover.md#t-0-cutover)).

See [specs/behaviors/storage.md#hot-reload](../../specs/behaviors/storage.md#hot-reload)
for the authoritative contract. Operationally:

- **Configured by** the `CFP_DATA_RELOAD_SECRET` env variable. When
  unset, the endpoint is still registered but returns 503 — the
  workflow's `curl` will exit non-zero and the operator must
  investigate. The value lives in each cluster repo's
  `codeforphilly-ng.secrets/codeforphilly-secrets.yaml` (sealed) and as the
  `CFP_DATA_RELOAD_SECRET` Actions secret on the data repo — all three must
  agree.
- **Public data only.** The webhook reloads the gitsheets state + FTS. It
  does **not** reload the private store; files placed on the PVC need a
  `rollout restart`.
- **Trigger manually** for debugging:

  ```bash
  SECRET=$(kubectl -n codeforphilly-ng get secret \
    codeforphilly-secrets -o jsonpath='{.data.CFP_DATA_RELOAD_SECRET}' | base64 -d)

  curl -sS -X POST https://next.codeforphilly.org/api/_internal/reload-data \
    -H "Authorization: Bearer $SECRET" \
    -H "Content-Type: application/json" \
    -d '{}' | jq
  ```

- **Response shapes** (all wrapped in the success envelope):
  - **No-op via cheap pre-check** (commit already in local HEAD) —
    `{ noChanges: true, outcome: 'in-sync', head, durationMs }`. No
    fetch, no lock acquired.
  - **No-op after reconcile** (local already matched remote after the
    fetch) — `{ noChanges: true, outcome: 'in-sync', oldCommit,
    newCommit, durationMs }`.
  - **Rebuilt** — `{ noChanges: false, rebuilt: true, outcome, oldCommit,
    newCommit, durationMs, conflictBranch? }`. `outcome` is one of
    `fast-forwarded`, `pushed-ahead`, `rebased`, `conflict-escaped`, or
    `fetch-failed` (see [`store/reconcile.ts`](../../apps/api/src/store/reconcile.ts)).
- **500 response** means the reconcile happened but the in-memory
  rebuild threw partway. The pod's in-memory state and FTS index are
  in an undefined state — restart the pod:

  ```bash
  kubectl -n codeforphilly-ng rollout restart deploy/codeforphilly
  ```

- **Outside-the-pod observability** — every reload logs an info line
  with the outcome + commits; failures log error. Search the pod logs
  for `hot-reload` to audit the most recent firings. The data repo's
  Actions run for `notify-deployments.yml` shows the HTTP status per target.

## Fetch from the pod's data clone

The pod's bare clone lives in an `emptyDir` at `/app/data` and may briefly hold commits the push daemon hasn't shipped to GitHub yet (or that got escape-hatched onto a `conflicts/*` branch — those *are* always pushed, see [`apps/api/src/store/reconcile.ts`](../../apps/api/src/store/reconcile.ts)). When you want to inspect the pod's view of the data repo without exposing any network ports, add it as a git remote via the `ext::` transport.

```bash
cd /path/to/codeforphilly-data

git config protocol.ext.allow always
git remote add pod 'ext::sh /path/to/codeforphilly-ng/scripts/git-pod-uploadpack.sh'

git fetch pod
git log --oneline origin/published..pod/published   # unpushed commits, if any
```

The helper script resolves the current pod by label selector, so it survives restarts. Override via env for the cluster you're targeting:

| Var | Default | Production |
| --- | --- | --- |
| `CFP_POD_KUBECONFIG` | `~/.kube/cfp-sandbox-cluster-kubeconfig.yaml` | the live cluster kubeconfig |
| `CFP_POD_NAMESPACE` | `codeforphilly-rewrite-sandbox` | `codeforphilly-ng` |
| `CFP_POD_SELECTOR` | `app.kubernetes.io/name=codeforphilly` | same |
| `CFP_POD_DATA_PATH` | `/app/data` | same |

**Read-only by design** — `git upload-pack` only serves fetch; pushing back to the pod would bypass gitsheets + in-memory state and fight the push daemon. Pull what you need to your local clone, reason about it there, then push to `origin` if appropriate.

## Private data left behind by purges

Purge deletes a person's private data (profile, legacy password, reset tokens,
claim requests, sessions) in the same transaction since v0.10.3. People purged
or pruned before that still have private data. An administrator clears it from
the running API — never with an out-of-process script, because the API holds
the private store in memory and would write the old files back:

```js
// In the browser console on the site, signed in as an administrator.
const run = (apply) => fetch('/api/admin/private-data/purge-orphans', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apply }),
}).then((r) => r.json()).then((j) => console.log(j.data));
run(false); // counts only — check them
run(true);  // deletes; cannot be undone (the private store is not versioned)
```

It answers counts only, never emails. Spec:
[api/moderation.md](../../specs/api/moderation.md#post-apiadminprivate-datapurge-orphans).

## Scheduled spam purge runs on production only

`CFP_SCHEDULED_PURGE=true` is set in cfp-live-cluster alone
([deploy.md](deploy.md)). Sandbox shares `published`, so a sandbox pod with
the flag on would delete production data. A pod logs
`scheduled spam purge disabled` at boot when the flag is off.

## Agents

An agent is an automated moderator (the first is Code for Philly's ops bot)
with its own site account, reaching the API with a scoped bearer grant
([api/agents.md](../../specs/api/agents.md)). Grants are minted and revoked by
an administrator; every step is a public commit. Calls below run in the
browser console on the site, signed in as an administrator (or staff, where
noted), like the orphan cleanup above.

```js
const api = (method, path, body) => fetch(path, {
  method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
}).then((r) => r.json()).then((j) => (console.log(j), j.data));
```

- **Create the agent** (once), with its first grant: `grant` is required, since
  an account is an agent because it holds one. Its bio says it is an AI and who
  runs it. The first grant is read + vote only; purge comes later
  ([plans/bot-spam-votes.md](../../plans/bot-spam-votes.md) → Rollout).

  ```js
  api('POST', '/api/admin/agents', {
    slug: 'grittybot', fullName: 'GrittyBot',
    bio: 'An AI ops bot run by Code for Philly. Its spam votes on /admin/members are staged and staff overrule them; it purges only accounts that posted spam, and says why.',
    grant: { label: 'ops bot, host <name>', scopes: ['moderation:read', 'moderation:vote'], expiresInDays: 90 },
  });
  ```

- **Hand the token to its host.** The response's `token` (`cfpa_…`) is shown
  once and stored nowhere but its hash. Put it straight into the agent's
  credential file on its host (for the ops bot,
  `~/.config/grittybot/cfp-agent-token`, mode 0600); never in a chat, issue,
  repo or ticket. Lose it and mint a new one.
- **Rotate / renew / change scopes** (nothing is wrong with the token). Scopes
  are fixed for a grant's life, so rotating, renewing (grants last 1–180 days,
  default 90) or adding `moderation:purge` is: mint the new grant first, then
  revoke the old one **without** withdrawing votes. The agent always holds an
  active grant, so its staged votes count throughout. Minting a grant with
  `moderation:purge` requires `moderation:read`.

  ```js
  const { grant, token } = await api('POST', '/api/admin/agents/grittybot/grants',
    { label: 'ops bot, host <name>', scopes: ['moderation:read', 'moderation:vote', 'moderation:purge'], expiresInDays: 90 });
  // replace the token file on the host, then:
  api('POST', '/api/admin/agents/grittybot/grants/<old grant id>/revoke');
  ```

- **Compromise** (the token may be in someone else's hands, or the agent has
  gone wrong): revoke **with** `withdrawVotes: true`. In one commit, the token
  is dead (the next request with it gets `401 grant_invalid`) and every vote
  the agent staged on members no human has voted on is withdrawn, un-hiding
  the members its spam votes hid. Do this before minting a replacement: a plain
  revoke only stops the staged votes counting while the agent holds no active
  grant, and the next grant minted for it brings them all back. The Agents
  panel's Revoke confirm has the checkbox "This token may be compromised: also
  withdraw this agent's staged votes". Neither undoes purges: check the purge
  log for the agent and restore any wrong one (below).

  ```js
  api('POST', '/api/admin/agents/grittybot/grants/<grant id>/revoke', { withdrawVotes: true });
  ```
- **Withdraw** (staff) every vote the agent staged on members no human has
  voted on, un-hiding the members its votes hid, in one commit, without
  revoking anything (for a run of bad votes from a token that is still sound;
  use `since` to take back only the recent ones). Purges are not undone by it
  (restore them one by one, below).

  ```js
  api('POST', '/api/admin/agents/grittybot/withdraw-votes', { since: '2026-11-01T00:00:00Z' });
  ```

The Agents panel at the foot of `/admin/members` does all of this with
buttons, and shows each agent's grants, staged votes and purges.

## Restore a purged member

A purge (an agent's, an administrator's, or the daily sweep's) deletes from
the data repo's tree; every deleted public record is in the purge commit's
parent. **Private data does not come back**: the production private store is
a filesystem volume with no versioning or backup, so the person's email,
newsletter choice, Slack sign-in time and GitHub facts are gone and are
rebuilt only from GitHub on their next sign-in
([person-lifecycle.md → Restoring a purged member](../../specs/behaviors/person-lifecycle.md#restoring-a-purged-member)).

1. **Find the commit.** An agent or staff spam purge: the purge log's
   **Commit** link on `/admin/members` opens the history of the purge record;
   the purge commit is the oldest entry (an unblock adds one above it). From a
   clone: `git log --format=%H --grep='^Purge-Id: <purge id>$'`. A non-spam staff purge:
   `git log --grep='^Action: person.purge$' --grep='Subject-Slug: <slug>' --all-match`.
   The sweep: `git log --grep='scheduled spam purge'` and find the slug in the
   message.
2. **Lift the block** from the purge log (**Unblock**, with a reason), or
   `api('POST', '/api/admin/spam-purges/<id>/unblock', { reason: '…' })`. The
   record stays, marked unblocked.
3. **Restore the records** in a working clone of `codeforphilly-data` on
   `published`, pulled after step 2 so it holds the unblock commit:

   ```bash
   git pull --ff-only
   # An agent or staff purge: one person per commit. Revert it, but keep the log.
   # The unblock edited the purge record, so the revert stops with a
   # modify/delete conflict on it and exits non-zero; the checkout below
   # resolves it by keeping the record as it stands.
   git revert --no-commit <sha>
   git checkout HEAD -- spam-purges/
   git status --short   # expect only the person's records, and the purge's vote record reverted
   git commit -m "people: restore <slug>" --trailer "Action: person.restore" --trailer "Subject-Slug: <slug>"

   # A sweep commit purges a batch: take only this person's paths from the parent.
   git checkout <sha>^ -- people/<slug>.toml people/<slug>/   # plus their memberships, updates, … as needed
   git commit -m "people: restore <slug>" --trailer "Action: person.restore" --trailer "Subject-Slug: <slug>"
   ```

   Commit as yourself with a pseudonymous email
   (`<you>@users.noreply.codeforphilly.org`). Push; the hot-reload webhook
   rebuilds the in-memory state.
4. **Vote Not spam** on the restored member's row, before the next daily
   sweep. Votes are not deleted by a purge, so a member restored from the
   sweep (or from a staff purge that followed a spam vote) comes back
   deactivated with their spam votes still standing, and past the three
   days: the next sweep would purge them again. An agent purge writes the agent's vote in the purge commit, so the
   revert puts back whatever stood before: nothing, or the agent's earlier
   staged spam vote, which hides them again. Not spam un-hides them, keeps
   the sweep off them and puts a human verdict on record. The row keeps the
   `Slug purged before` badge and lists the purge under Earlier account: the
   purge record names the slug, and stays.
5. **If the slug was taken since**, the restore conflicts on
   `people/<slug>.toml`: that is a merge for an administrator to decide, not a
   revert.
6. **Tell the person** to sign in with GitHub: the restored `githubUserId`
   matches and sign-in rebuilds their private profile (email from GitHub;
   sign-in count starts again, newsletter choice and Slack link are gone).

## Helpful commands

```bash
# Watch a deploy
kubectl -n codeforphilly-ng rollout status deploy/codeforphilly

# Last 10 GitOps deploys (merge commits on deploys/k8s-manifests)
gh-axi -R CodeForPhilly/cfp-live-cluster pr list --base deploys/k8s-manifests --state merged --limit 10

# Which release is running?
kubectl -n codeforphilly-ng get deploy codeforphilly -o jsonpath='{.spec.template.spec.containers[0].image}'

# Pod resource use
kubectl -n codeforphilly-ng top pod

# Force a config / secret reload (env is read at pod start)
kubectl -n codeforphilly-ng rollout restart deploy/codeforphilly
```
