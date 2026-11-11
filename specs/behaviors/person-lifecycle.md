# Person lifecycle: deactivate & purge

A person record has two removal paths with very different intent and reversibility.

| State | Set by | Effect | Reversible |
| ----- | ------ | ------ | ---------- |
| **Active** | default | Normal — visible in lists, detail, and as a reference on content. | — |
| **Deactivated** | self, staff/admin, **or a spam vote** (staff, or a staged [agent](../api/agents.md) vote) | Soft hide. `deletedAt` set. Hidden from public lists + detail; references render a placeholder. The person **can still sign in** and reactivate. | Reactivate (clears `deletedAt`). |
| **Purged** | admin only | Cascading hard delete of the person + their content, in a single commit. | Via git history only (revert the commit). |

## Deactivate (soft, self-service)

The privacy / self-removal path — members should be able to remove themselves; CfP gets these requests often.

- **Who:** a person may deactivate/reactivate their OWN account; staff and administrators may deactivate/reactivate ANY account.
- **Mechanism:** sets `person.deletedAt = now()` (reactivate clears it). The record and relationships stay intact.
- **Visibility while deactivated:** excluded from public list endpoints; `GET /api/people/:slug` returns 404 for non-staff (staff may still fetch it, with `deletedAt` populated). Anywhere a deactivated person is referenced (project member grids, project-update/project-buzz authors, help-wanted "posted by", blog author) the serialized reference is a **"Deactivated user" placeholder** (no slug link, generic avatar) rather than the person — substitute, do not omit, so counts/history stay coherent.
- **Login is NOT blocked** — a deactivated user can still authenticate and reactivate themselves. No session revocation.
- **Surfaces:** self at `/account` ("Deactivate my account" / "Reactivate"); staff/admin via a person "Danger Zone"; and the **admin members screen**, where a `spam` vote deactivates the person in the same transaction that records the vote ([api/moderation.md](../api/moderation.md)).
- **Deciding votes:** the human votes on a person, when there are any; otherwise the votes of agents that hold an active grant ([api/moderation.md → Agent votes](../api/moderation.md#agent-votes)). An agent vote stops deciding the moment any human votes on the person, and while its agent holds no active grant.
- **Vote reversal rule:** a `legit` vote (or an agent withdrawing its vote) clears `deletedAt` only when the person's previous latest vote — human or agent, whether or not it still decides — was `spam`, that is, when moderation set it. A self-deactivation is never undone by a vote.

## Purge (cascading hard delete, admin only)

The garbage-collection path for spam — the runtime sibling of the offline spam-prune (behaviors/spam-exclusion.md).

- **Who:** administrators only.
- **Mechanism:** one write-mutex transaction that hard-deletes: the `people` record; their `project-membership`; their `help-wanted-interest`; their person `tag-assignment`; AND their authored `project-update`, `project-buzz`, and `blog-post` records (unlike the prune which nulls authorId — purge DELETES the content, it's garbage). Their **private** data goes in the same transaction: private profile, legacy password credential, password-reset tokens, account-claim requests naming them, and their session metadata. A purged person leaves nothing behind in either store.
- **Projects only they touched go too.** In the same transaction, purge hard-deletes every project the person created that nobody else has touched — spam accounts create spam projects, and a project left behind with no members is a soft-deleted husk an admin can't clear. A project qualifies when both hold:
  1. **Created by the person:** `createdById` is the person; for a project with no `createdById` (imported from laddr, or created before the field existed), the person is its `maintainerId`.
  2. **No one else touched it:** every membership is the person's, every update was authored by them, every buzz posted by them, every help-wanted role posted by them with no interest from anyone else, and no RSVP from anyone else names the project.

  A qualifying project is deleted with everything that hangs off it: the project record and its attachments, its memberships, updates, buzz, help-wanted roles and their interest, its tag-assignments, and RSVPs naming it (slug-history entries are left to expire). A project anyone else touched is left exactly as it is (the person's own records on it are removed as above).
- **Atomic + git-revertable** (one commit).
- **Surface:** person "Danger Zone" (admin only), behind a confirm dialog.
- **Preview:** the confirm dialog lists the projects that will be deleted with the person (`GET /api/people/:slug/purge-preview`), or says none will be.

## Scheduled spam purge

A `spam` vote on the admin members screen deactivates the person at once; three days later, if nobody has disagreed, the site purges them on its own. Staff shouldn't have to come back and press a second button for every spam account, and three days is long enough for another staff member to look and object.

An agent's `spam` vote **stages** the same way: it hides the person at once and purges them three days later unless a human votes in the meantime. The three days are the review window: the roster shows every staged vote, labeled as the agent's, with its reasoning and purge date, and one **Not spam** click from any staff member overrules it ([screens/admin-members.md](../screens/admin-members.md)). Nothing an agent does deletes anything sooner.

- **When:** an in-process job runs once a day (and once shortly after boot) — **only on the deployment where `CFP_SCHEDULED_PURGE=true`, which is production alone.** Sandbox and production serve the same `published` branch, so any pod that runs the sweep is deleting production data; exactly one may. With the flag off the pod never sweeps and logs that at boot.
- **Who it takes:** every person who
  1. has at least one deciding `spam` vote, and every deciding vote on them is `spam` — a `legit` or `uncertain` vote holds them back. With any human vote on record, only human votes decide; with none, the votes of agents holding an active grant decide (an agent's vote with no active grant behind it queues nobody);
  2. got their newest deciding vote at least **3 days** ago — a staff member confirming a staged vote with their own `spam` restarts the three days from their vote;
  3. is still deactivated (`deletedAt` set) — reactivating someone takes them out of the queue;
  4. is not `staff` or `administrator`, and is not an agent account.
- **What it does:** exactly what Purge does for each of them, including projects they created that nobody else touched. Within one run, "nobody else" means nobody outside the batch: a project made by one queued spam account and joined only by others in the same queue goes too.
- **One commit per run** for the whole batch, authored by the site (`cfp-api`), its message listing the purged slugs. A slug queued on agent votes alone is listed as `<slug> (staged by agent-<agentSlug>)`, and the commit carries an `Agent-Staged: <n>` trailer counting them, so `git log` separates what a person decided from what only an agent did. A run with nobody queued writes nothing.
- The votes — human and agent — stay in `person-evaluations` as the record of why.

## Authorization summary

| Action | Self | Staff | Admin |
| ------ | ---- | ----- | ----- |
| Deactivate / Reactivate | ✓ (own) | ✓ (any) | ✓ (any) |
| Spam / not-spam vote (deactivates / may reactivate) | – | ✓ | ✓ |
| Purge | – | – | ✓ |
| Scheduled spam purge | – | – (their spam vote queues it) | – (runs as the site) |

An agent with a `moderation:vote` grant may cast staged spam / not-spam votes within the [agent vote rules](../api/moderation.md#agent-votes); it can deactivate (a spam vote) and reverse its own deactivation, and nothing else in this table.

## Relationship to other specs

- storage.md — all writes go through the in-process mutex; purge is one transaction.
- spam-exclusion.md — offline prune and on-demand purge share cascade semantics; keep aligned.
- API endpoints + response placeholder shape are specified in api/people.md.
