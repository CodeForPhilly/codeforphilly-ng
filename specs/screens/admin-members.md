# Screen: Admin members

## Route

`/admin/members` — staff and administrators. Anyone else (including signed-out)
gets the site's 404, same as `/staff/account-claim`.

`/admin/members/:slug` — the expanded footprint view for one member (also
reachable in-page by expanding a row).

## Purpose

New members now arrive only through GitHub sign-in, so the volume is low and the
question is simple: *is this a real person?* Everyone listed here has already
passed the offline spam pipeline (or arrived after its last run), so the page
does **not** show machine evaluations. It shows the member's footprint on the
site in one place, and lets staff record a **human judgment** the pipeline treats
as final. A spam vote hides the member at once; the [scheduled spam
purge](../behaviors/person-lifecycle.md#scheduled-spam-purge) deletes them three
days later unless another vote disagrees. The page intro says so.

An [agent](../api/agents.md) — an AI moderator staff have granted access — may
cast votes too. Its votes are **staged**: they hide a member at once like a
staff spam vote, but this page labels them as the agent's, shows its reasoning
on the row, and lets any staff member overrule (**Not spam**) or confirm
(**Spam**) them with one click. The intro says that as well, and names the
date a staged vote purges.

An agent granted the purge scope may also **purge** a new member who posted
spam, at once ([api/moderation.md → Agent purges](../api/moderation.md#agent-purges)).
A purged member has no row left, so this page shows those purges in the
Agents panel's purge log, with the agent's reason, links to the evidence as it
stood and to the commit, and a banner while any is recent. The intro says this
too.

## Data Requirements

- `GET /api/admin/members` on entry and on every filter/sort/page change
- `GET /api/admin/members/:slug` when a row is expanded or the detail route opens
- `POST /api/admin/members/:slug/vote` on either vote button
- `GET /api/admin/agents`, `POST /api/admin/agents/:slug/withdraw-votes` and the
  grant endpoints in the Agents panel ([api/agents.md](../api/agents.md))
- `GET /api/admin/spam-purges` on entry (`by=agent&since=<7 days ago>`, for the
  banner) and when the purge log opens; `POST /api/admin/spam-purges/:id/unblock`
  from the log

See [api/moderation.md](../api/moderation.md).

## Display Rules

### Roster

- Newest signup first by default; sort toggles for name and last sign-in.
- Filter bar: text search; **Vote**: any / **no human vote yet (default)** /
  staged by an agent / voted spam / voted legit — the default includes
  agent-staged rows, so a staged vote is never out of the default view; **Origin**: any / signed up here / imported; joined date
  range; a "show deactivated" toggle (on by default — moderation needs to see
  what it hid).
- Each row: avatar, `fullName` (link to the public profile, opens in a new tab),
  `@slug`, then the **badges**, then "joined {createdAt relative}", sign-ins
  (`signed in 4× · last 2h ago` or `never signed in`), email (staff-visible;
  the domain is a button that searches `@domain` across the whole roster, so
  one throwaway address leads to every account from that domain),
  bio excerpt, compact footprint counts (`2 projects · 1 update · 3 tags`), and
  the vote state:
  - no vote → two buttons **Spam** / **Not spam**
  - voted → a badge `Spam · by {voter} · {when}` or `Not spam · …` with a
    "Change" affordance that re-shows the buttons
  - staged by an agent (`stagedVote`, no human vote) → a violet badge
    `Staged spam · {agent} (AI) · {when}` or `Staged not spam · …`, the first
    line of the agent's reasoning beside it (full text on hover and in the
    detail), its flags as small chips, **and the two buttons still shown**: Not
    spam overrules, Spam confirms. When `counts` is false the badge is grey and
    reads `… · access revoked`, and its tooltip says it will not purge anyone.
- **Badges** (from the row's `origin`, `github`, `lastSlackSsoAt`,
  `emailBounce`, and `signals`):
  - `Signed up here` (green) or `Imported` (neutral).
  - `GitHub · @login · {account age} · {repos} repos · {followers} followers`,
    linking to the GitHub profile; **red `GitHub account gone`** when
    `status = gone`; amber when `github-new-account` or `github-no-activity`.
  - `Slack · {lastSlackSsoAt relative}` when the person has signed into Slack
    through us.
  - `Email bounced · {type}` (red) when `emailBounce` is set.
  - `email ≠ name` (amber), `{n} links in bio` (amber), `no bio`, `no avatar`
    (neutral) from the signals.
  - `Slug purged before` (red) from `slug-purged-before`: an earlier account
    under this slug was purged as spam; the detail shows when, by whom and why.
- **Attention tint**: the row's left border goes amber at `attention ≥ 3` and
  red at `attention ≥ 5` (or whenever `github-gone` / `email-bounced` is
  present), so the eye lands on the spam shape without reading every field.
  Rows with `has-footprint` and `attention = 0` stay plain.
- Deactivated members render dimmed with a "Deactivated" chip; a member hidden by
  a spam vote shows "Hidden by {voter}" ("Hidden by {agent} (AI)" for a
  staged vote). When `purgeAfter` is set, a red chip says when the
  [scheduled spam purge](../behaviors/person-lifecycle.md#scheduled-spam-purge) takes
  them: "Purges {date}", or "Purging at the next daily sweep" once the date has
  passed; its tooltip says a Not spam vote or reactivation stops it.
- **Keyboard triage**: `j` / `k` move the selection, `s` opens the Spam
  confirm for the selected row, `n` votes Not spam, `Enter` toggles details.
  The selected row is outlined and scrolled into view.

### Expanded row / detail

Full bio (rendered markdown, server-side), then the footprint as lists with
links: project memberships (role, joined), authored updates, buzz, blog posts,
help-wanted interest, tags. Then the vote history, newest first, each with
voter, verdict, reasoning, and time; an agent's vote is marked "AI agent" and
shows its flags, and once a human has voted the agent's votes read "overruled"
or "confirmed". When the slug was used before, an **Earlier account** block
follows: the earlier account's purges (`earlierPurges`) and votes
(`earlierVotes`), greyed, saying they do not count for this member. Then the
same two buttons, plus a link to the person's Danger Zone for admins (an
administrator's purge lives there, not here).

### Recent agent purges banner

When any agent purged anyone in the last 7 days, a banner above the roster
says `{n} members purged by {agent} (AI) in the last 7 days` and opens the
purge log. It is not dismissable: it goes when the purges age out, so an agent
purge is seen by whoever opens this page that week.

### Agents panel

A collapsed **Agents** section at the foot of the page, one line per agent
account (`GET /api/admin/agents`): its name (linking to its profile), how many
votes it has staged now, how many members it purged in the last 24 hours and
30 days, and its grants (label, scopes, created by, expires, last used, active
or revoked). A grant carrying `moderation:purge` shows that scope in red.

- **Show staged** sets the Vote filter to "staged by an agent".
- **Purge log** opens the log below, filtered to that agent.
- **Withdraw staged votes** (staff) — a confirm saying how many votes it removes
  and how many members it un-hides, then `POST …/withdraw-votes`. The confirm
  says it does not undo purges.
- **Mint grant** / **Revoke** / **New agent** (administrators only). A minted
  token is shown once, in a dialog with a copy button and the words "This is
  the only time it is shown"; closing the dialog drops it from the page.
  Minting a grant with `moderation:purge` asks for a second confirm naming
  what it allows (immediate purges of members under 7 days old who posted
  spam, up to 5 a day).

#### Purge log

`GET /api/admin/spam-purges`, newest first, filterable by who purged (an agent,
staff, the daily sweep, or all). One line per purge:

- the purged slug as plain text (there is no profile to link to), when, and by
  whom (`{agent} (AI)`, a staff member, or "daily sweep");
- the reason, in full, and the flags as chips;
- for an agent purge, each evidence item as a link to the record as it stood
  before the purge (`people/<slug>.toml#bio`, `project-updates/<project>/<n>.toml`
  on the data repo at `beforeCommit`), so a reviewer reads the spam the agent
  saw without it being shown on this page;
- **Commit**, linking to the purge commit;
- the sign-up block: `Blocks sign-up` with an **Unblock** button (staff; a
  confirm with an optional reason), or `Unblocked by {staff} · {when}`;
- a "How to restore" link to the runbook step
  ([person-lifecycle.md → Restoring a purged member](../behaviors/person-lifecycle.md#restoring-a-purged-member)).

### Voting

- **Spam** opens a small confirm with an optional reasoning field ("Why? —
  optional, saved with your vote"), then calls the vote endpoint. On success the
  row dims immediately ("Hidden by you"), because the API deactivates the person
  in the same transaction.
- **Not spam** calls the endpoint directly (reasoning optional via the same
  disclosure). If the member had been hidden by a spam vote, the row un-dims.
- The buttons are disabled on the caller's own row and on agent accounts'.
- On a staged row, **Not spam** and **Spam** are ordinary staff votes: the
  first un-hides the member and stops the purge; the second confirms it and
  restarts the three days from now. Either way the row then shows the staff
  vote, and the agent's vote moves to the history.
- Errors surface as a toast; the row state is refetched, never guessed.

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Filter / sort / page | `GET /api/admin/members?…` | Re-render roster |
| Expand row | `GET /api/admin/members/:slug` | Show footprint + votes |
| Spam | `POST …/vote { verdict: "spam", reasoning? }` | Row → deactivated + vote badge |
| Not spam | `POST …/vote { verdict: "legit", reasoning? }` | Row → vote badge; un-dim if vote-hidden |
| Withdraw staged votes (Agents panel) | `POST /api/admin/agents/:slug/withdraw-votes` | Refetch roster; toast with the counts |
| Mint / Revoke grant, New agent (Agents panel, admin) | [api/agents.md](../api/agents.md) | Refresh the panel; show a new token once |
| Open purge log (banner or Agents panel) | `GET /api/admin/spam-purges?…` | Show the log |
| Unblock (purge log) | `POST /api/admin/spam-purges/:id/unblock { reason? }` | Line shows "Unblocked by you" |

## Authorization

Staff and administrators. An administrator's purge is not offered here (it is
on the person page). Votes are attributed to the individual caller and can be changed
by that caller at any time. Grants are minted and revoked by administrators
only; any staff member may read the purge log and unblock. Agents never see
this page: they hold no session, only an API grant.

## Out of scope (v1)

- Offline machine verdicts, confidence, or reasoning on this page — the
  pipeline's concern, and its data lives in a private repo. (Agent votes are
  not machine verdicts in this sense: they are cast on the site, public, and
  shown.)
- Bulk actions.
- Running the heuristic in-process at signup (natural follow-up).
