# Person lifecycle: deactivate & purge

A person record has two removal paths with very different intent and reversibility.

| State | Set by | Effect | Reversible |
| ----- | ------ | ------ | ---------- |
| **Active** | default | Normal — visible in lists, detail, and as a reference on content. | — |
| **Deactivated** | self, staff/admin, **or a spam vote** (staff, or a staged [agent](../api/agents.md) vote) | Soft hide. `deletedAt` set. Hidden from public lists + detail; references render a placeholder. The person **can still sign in** and reactivate. | Reactivate (clears `deletedAt`). |
| **Purged** | admin; the scheduled spam purge; or an [agent](../api/agents.md) with a purge grant, for a new member who posted spam | Cascading hard delete of the person + their content, in a single commit. | Via git history only — [Restoring a purged member](#restoring-a-purged-member). |

## Deactivate (soft, self-service)

The privacy / self-removal path — members should be able to remove themselves; CfP gets these requests often.

- **Who:** a person may deactivate/reactivate their OWN account; staff and administrators may deactivate/reactivate ANY account.
- **Mechanism:** sets `person.deletedAt = now()` (reactivate clears it). The record and relationships stay intact.
- **Visibility while deactivated:** excluded from public list endpoints; `GET /api/people/:slug` returns 404 for non-staff (staff may still fetch it, with `deletedAt` populated). Anywhere a deactivated person is referenced (project member grids, project-update/project-buzz authors, help-wanted "posted by", blog author) the serialized reference is a **"Deactivated user" placeholder** (no slug link, generic avatar) rather than the person — substitute, do not omit, so counts/history stay coherent.
- **Login is NOT blocked** — a deactivated user can still authenticate and reactivate themselves. No session revocation.
- **Surfaces:** self at `/account` ("Deactivate my account" / "Reactivate"); staff/admin via a person "Danger Zone"; and the **admin members screen**, where a `spam` vote deactivates the person in the same transaction that records the vote ([api/moderation.md](../api/moderation.md)).
- **Deciding votes:** the human votes on a person, when there are any; otherwise the votes of agents that hold an active grant ([api/moderation.md → Agent votes](../api/moderation.md#agent-votes)). An agent vote stops deciding the moment any human votes on the person, and while its agent holds no active grant. Only votes on **this account** count: a vote older than the person's `createdAt` was cast on an earlier account under the same slug and is ignored here and everywhere below ([api/moderation.md → Votes belong to one account](../api/moderation.md#votes-belong-to-one-account)).
- **Vote reversal rule:** a `legit` vote (or an agent withdrawing its vote) clears `deletedAt` only when the person's previous latest vote — human or agent, whether or not it still decides — was `spam`, that is, when moderation set it. A self-deactivation is never undone by a vote.

## Purge (cascading hard delete, admin only)

The garbage-collection path for spam — the runtime sibling of the offline spam-prune (behaviors/spam-exclusion.md).

- **Who:** administrators; the [scheduled spam purge](#scheduled-spam-purge); and, for a new member who posted spam only, an agent holding `moderation:purge` ([Agent purge](#agent-purge)). (The heading keeps its old name so links to it hold.)
- **Mechanism:** one write-mutex transaction that hard-deletes: the `people` record; their `project-membership`; their `help-wanted-interest`; their person `tag-assignment`; AND their authored `project-update`, `project-buzz`, and `blog-post` records (unlike the prune which nulls authorId — purge DELETES the content, it's garbage). Their **private** data goes in the same transaction: private profile, legacy password credential, password-reset tokens, account-claim requests naming them, and their session metadata. A purged person leaves nothing behind in either store.
- **Projects only they touched go too.** In the same transaction, purge hard-deletes every project the person created that nobody else has touched — spam accounts create spam projects, and a project left behind with no members is a soft-deleted husk an admin can't clear. A project qualifies when both hold:
  1. **Created by the person:** `createdById` is the person; for a project with no `createdById` (imported from laddr, or created before the field existed), the person is its `maintainerId`.
  2. **No one else touched it:** every membership is the person's, every update was authored by them, every buzz posted by them, every help-wanted role posted by them with no interest from anyone else, and no RSVP from anyone else names the project.

  A qualifying project is deleted with everything that hangs off it: the project record and its attachments, its memberships, updates, buzz, help-wanted roles and their interest, its tag-assignments, and RSVPs naming it (slug-history entries are left to expire). A project anyone else touched is left exactly as it is (the person's own records on it are removed as above).
  Attachments (avatars, buzz images) go with the records they hang off.
- **Atomic + git-revertable** (one commit).
- **Surface:** person "Danger Zone" (admin only), behind a confirm dialog.
- **Preview:** the confirm dialog lists the projects that will be deleted with the person (`GET /api/people/:slug/purge-preview`), or says none will be.
- **Spam or not.** The dialog asks whether this was spam (checked by default when the person has a spam vote). A spam purge writes a [`spam-purges`](../data-model.md#spampurge) record in the same commit — who, why, and the person's `githubUserId` — which blocks that GitHub account from signing up again until staff unblock it ([api/auth.md](../api/auth.md#get-apiauthgithubcallback)). A purge that is not for spam writes nothing of the kind.
- **What stays.** The person's `person-evaluations` records stay, keyed by the slug, as the record of why; they do not attach to a later account that gets the same slug.

### Agent purge

The operator's policy: "When someone actually posts spam, purge immediately."
An agent holding `moderation:purge` may purge a member who has **posted spam**
— the account itself put spam on the site: a promotional bio or link, a spam
project, update, buzz item or help-wanted role — without the three-day wait
([api/moderation.md → Agent purges](../api/moderation.md#agent-purges)).

- **Narrower than an administrator's purge by precondition, not by a smaller
  cascade.** The API refuses unless the member joined in the last 7 days, is a
  signed-up `user` with no human vote, no standing `legit` vote and no Slack
  sign-in, created no project anyone else touched and maintains no project with
  other members; the agent cites 1–5 records the member authored, which the API
  checks exist, are theirs and go with the purge; at most 5 a day per agent.
  Within those fences the cascade is the one above, so nothing an agent purge
  reaches belongs to anyone else, and the spam it cites is removed with the
  account. A plain membership on someone else's project does not block (a
  self-service join is no one else's judgment); the membership goes and the
  project stays.
- **One commit per purge**, authored by the agent, with the reason in the body
  and `Evidence:` trailers; a `spam-purges` record (`by = "agent-<slug>"`) and
  the agent's `spam` vote record are written in the same commit.
- **After the fact:** a purged member has no roster row, so the purge shows in
  the [admin members screen's](../screens/admin-members.md#agents-panel)
  purge log, with reason, evidence links and the commit; the agent also posts
  each one to its operators' channel.

## Restoring a purged member

A purge deletes from the data repo's working tree, but the repo is git: every
deleted public record is in the purge commit's parent. Private data (email,
newsletter preference, Slack sign-in time, GitHub reputation facts) is **not**
recoverable: the production private store is a filesystem volume with no
versioning and no backup today ([deploy.md](../../docs/operations/deploy.md);
[private-storage.md → Bucket versioning](private-storage.md#bucket-versioning)
describes the S3 backend, which is not the one in use).

The runbook step (`docs/operations/runbook.md` → "Restore a purged member"):

1. **Find the commit.** For an agent or staff spam purge, the purge log links
   it (the history of the `spam-purges` record's path); for a non-spam staff
   purge, `git log --grep='^Action: person.purge$'` and the slug; for the
   sweep, the sweep commit naming the slug.
2. **Lift the block**: `POST /api/admin/spam-purges/:id/unblock` (staff, from
   the purge log), with a reason. The `spam-purges` record stays, now marked
   unblocked: it is the log that the purge happened and was undone.
3. **Restore the records** in a working clone of the data repo and push to
   `published`; the hot-reload webhook rebuilds the in-memory state. An agent
   or staff purge is one person per commit, so revert it but keep the log:
   `git revert --no-commit <sha> && git checkout HEAD -- spam-purges/`, then
   commit with `Action: person.restore` and the slug. A sweep commit purges a
   batch: check out only that person's paths from the parent
   (`git checkout <sha>^ -- people/<slug>.toml people/<slug>/ …`) rather than
   reverting the whole commit.
4. **Vote Not spam** on the restored member on the roster. The restored record
   is as it was before the purge, which may be deactivated by a spam vote that
   is back too (a staff vote the purge left in place, or an agent's staged
   vote the revert brought back); Not spam un-hides them and keeps the sweep
   off them.
5. **If the slug was taken since** (someone signed up again under it), the
   restore conflicts on `people/<slug>.toml`; that is a merge for an
   administrator to decide, not a revert.
6. **Tell the person** to sign in with GitHub: the restored `githubUserId`
   matches, and sign-in rebuilds their private profile from GitHub (email and
   reputation facts). Their newsletter choice and Slack sign-in history are
   gone.

No staff "Restore" button for now: a restore is rare, needs judgment (what
else changed since, whether the slug was re-taken), and a git revert restores
the exact records. If restores become routine (more than about one a month),
a `POST /api/admin/spam-purges/:id/restore` that replays the parent's records
is the follow-up.

## Scheduled spam purge

A `spam` vote on the admin members screen deactivates the person at once; three days later, if nobody has disagreed, the site purges them on its own. Staff shouldn't have to come back and press a second button for every spam account, and three days is long enough for another staff member to look and object.

An agent's `spam` vote **stages** the same way: it hides the person at once and purges them three days later unless a human votes in the meantime. The three days are the review window: the roster shows every staged vote, labeled as the agent's, with its reasoning and purge date, and one **Not spam** click from any staff member overrules it ([screens/admin-members.md](../screens/admin-members.md)). A staged vote never deletes anything sooner. This is the operator's second case — "for signups that are obviously spam but haven't posted anything spammy, log a spam vote to put them in the 3-day purge queue pending doing anything that makes them not look like spam" — and the agent clears its own vote when the member does ([api/moderation.md → DELETE …/vote](../api/moderation.md#delete-apiadminmembersslugvote)). The only way an agent deletes sooner is an [agent purge](#agent-purge), for a member who posted spam.

- **When:** an in-process job runs once a day (and once shortly after boot) — **only on the deployment where `CFP_SCHEDULED_PURGE=true`, which is production alone.** Sandbox and production serve the same `published` branch, so any pod that runs the sweep is deleting production data; exactly one may. With the flag off the pod never sweeps and logs that at boot.
- **Who it takes:** every person who
  1. has at least one deciding `spam` vote, and every deciding vote on them is `spam` — a `legit` or `uncertain` vote holds them back. With any human vote on record, only human votes decide; with none, the votes of agents holding an active grant decide (an agent's vote with no active grant behind it queues nobody);
  2. got their newest deciding vote at least **3 days** ago — a staff member confirming a staged vote with their own `spam` restarts the three days from their vote;
  3. is still deactivated (`deletedAt` set) — reactivating someone takes them out of the queue;
  4. is not `staff` or `administrator`, and is not an agent account.
- **What it does:** exactly what Purge does for each of them, including projects they created that nobody else touched. Within one run, "nobody else" means nobody outside the batch: a project made by one queued spam account and joined only by others in the same queue goes too.
- **One commit per run** for the whole batch, authored by the site (`cfp-api`), its message listing the purged slugs. A slug queued on agent votes alone is listed as `<slug> (staged by agent-<agentSlug>)`, and the commit carries an `Agent-Staged: <n>` trailer counting them, so `git log` separates what a person decided from what only an agent did. A run with nobody queued writes nothing.
- The votes — human and agent — stay in `person-evaluations` as the record of why.
- Each purged person gets a [`spam-purges`](../data-model.md#spampurge) record in the same commit, `by = "scheduled"`, its reason naming the deciding voters, `blocksSignIn = true`: three days with nobody objecting is a spam verdict, and the GitHub account should not sign straight back up.

## Authorization summary

| Action | Self | Staff | Admin |
| ------ | ---- | ----- | ----- |
| Deactivate / Reactivate | ✓ (own) | ✓ (any) | ✓ (any) |
| Spam / not-spam vote (deactivates / may reactivate) | – | ✓ | ✓ |
| Purge | – | – | ✓ |
| Scheduled spam purge | – | – (their spam vote queues it) | – (runs as the site) |
| Unblock a spam-purged GitHub account | – | ✓ | ✓ |

An agent with a `moderation:vote` grant may cast staged spam / not-spam votes within the [agent vote rules](../api/moderation.md#agent-votes); it can deactivate (a spam vote) and reverse its own deactivation. An agent with a `moderation:purge` grant may also purge, within the [agent purge rules](../api/moderation.md#agent-purges). Nothing else in this table.

## Relationship to other specs

- storage.md — all writes go through the in-process mutex; purge is one transaction.
- spam-exclusion.md — offline prune and on-demand purge share cascade semantics; keep aligned.
- API endpoints + response placeholder shape are specified in api/people.md.
