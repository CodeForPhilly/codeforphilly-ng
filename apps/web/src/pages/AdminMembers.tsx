/**
 * /admin/members — staff roster with footprint, signals, and human spam votes.
 * Per specs/screens/admin-members.md.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { AgentsPanel, RecentAgentPurgesBanner } from '@/components/admin/AgentsPanel';
import {
  api,
  ApiError,
  type MemberListParams,
  type MemberRow,
  type StagedVoteView,
  type VoteVerdict,
  type VoteView,
} from '@/lib/api';
import { formatAbsoluteDate, formatRelativeTime } from '@/lib/time';

const PER_PAGE = 50;

function isStaff(level: string | undefined): boolean {
  return level === 'staff' || level === 'administrator';
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  good: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-destructive/10 text-destructive',
};

function Chip({ tone = 'neutral', title, children, href }: { tone?: Tone; title?: string; children: React.ReactNode; href?: string }) {
  const cls = `inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={`${cls} hover:underline`} title={title}>
        {children}
      </a>
    );
  }
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

function accountAge(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** The badges for a row, from origin/github/slack/bounce and the row-local signals. */
function Badges({ row }: { row: MemberRow }) {
  const has = (s: string) => row.signals.includes(s);
  const links = row.signals.find((s) => s.startsWith('bio-links:'))?.split(':')[1];
  const bounce = row.emailBounce;
  const gh = row.github;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.origin === 'signed-up' ? <Chip tone="good">Signed up here</Chip> : <Chip>Imported</Chip>}
      {gh && gh.status === 'gone' && (
        <Chip tone="bad" title="GitHub returns 404 for this account — deleted or suspended">
          GitHub account gone
        </Chip>
      )}
      {gh && gh.status !== 'gone' && (
        <Chip
          tone={has('github-new-account') || has('github-no-activity') ? 'warn' : 'neutral'}
          href={gh.login ? `https://github.com/${gh.login}` : undefined}
          title={gh.checkedAt ? `checked ${formatRelativeTime(gh.checkedAt)}` : 'not yet checked'}
        >
          GitHub{gh.login ? ` · @${gh.login}` : ''}
          {gh.accountCreatedAt ? ` · ${accountAge(gh.accountCreatedAt)} old` : ''}
          {gh.publicRepos !== null ? ` · ${gh.publicRepos} repos` : ''}
          {gh.followers !== null ? ` · ${gh.followers} followers` : ''}
        </Chip>
      )}
      {row.lastSlackSsoAt && <Chip tone="good">Slack · {formatRelativeTime(row.lastSlackSsoAt)}</Chip>}
      {bounce && (
        <Chip tone="bad" title={formatAbsoluteDate(bounce.bouncedAt)}>
          Email bounced · {bounce.type}
        </Chip>
      )}
      {has('email-name-mismatch') && <Chip tone="warn">email ≠ name</Chip>}
      {links && <Chip tone="warn">{links} link{links === '1' ? '' : 's'} in bio</Chip>}
      {has('no-bio') && <Chip>no bio</Chip>}
      {has('no-avatar') && <Chip>no avatar</Chip>}
      {has('slug-purged-before') && (
        <Chip tone="bad" title="An earlier account under this slug was purged as spam; details show when, by whom and why.">
          Slug purged before
        </Chip>
      )}
      {row.isAgent && <Chip tone="neutral">AI agent account</Chip>}
    </div>
  );
}

/**
 * The email with its domain as a button that searches `@domain` across the
 * whole roster — the quickest way to find every account from a throwaway
 * domain once one turns up.
 */
function EmailWithDomainSearch({ email, onSearchDomain }: { email: string; onSearchDomain: (domain: string) => void }) {
  const at = email.lastIndexOf('@');
  if (at === -1) return <span>{email}</span>;
  const local = email.slice(0, at + 1);
  const domain = email.slice(at + 1);
  return (
    <span>
      {local}
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        title={`Search for every member with an @${domain} address`}
        onClick={() => onSearchDomain(domain)}
      >
        {domain}
      </button>
    </span>
  );
}

function rowTint(row: MemberRow): string {
  const critical = row.signals.some((s) => s === 'github-gone' || s.startsWith('email-bounced'));
  if (critical || row.attention >= 5) return 'border-l-4 border-l-destructive';
  if (row.attention >= 3) return 'border-l-4 border-l-amber-500';
  return 'border-l-4 border-l-transparent';
}

/** The scheduled spam purge chip (specs/screens/admin-members.md). */
function purgeLabel(purgeAfter: string, now: Date = new Date()): string {
  return Date.parse(purgeAfter) <= now.getTime()
    ? 'Purging at the next daily sweep'
    : `Purges ${formatAbsoluteDate(purgeAfter, { dateStyle: 'medium' })}`;
}

function VoteBadge({ vote, hiddenByVote, note }: { vote: VoteView; hiddenByVote: boolean; note?: string }) {
  const spam = vote.verdict === 'spam';
  const agent = vote.kind === 'agent';
  const tone = agent
    ? 'bg-violet-100 text-violet-900'
    : spam
      ? 'bg-destructive/10 text-destructive'
      : 'bg-emerald-100 text-emerald-800';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`} title={vote.reasoning ?? undefined}>
      {spam ? 'Spam' : 'Not spam'} · {vote.voter.fullName}
      {agent ? ' (AI)' : ''} · {formatRelativeTime(vote.evaluatedAt)}
      {hiddenByVote ? ' · hidden' : ''}
      {note ? ` · ${note}` : ''}
    </span>
  );
}

/**
 * An agent's staged vote (specs/screens/admin-members.md): violet while it
 * counts, grey once the agent's access is revoked; the first line of its
 * reasoning beside it and its flags as chips.
 */
function StagedVoteBadge({ vote, purgeAfter }: { vote: StagedVoteView; purgeAfter: string | null }) {
  const spam = vote.verdict === 'spam';
  const firstLine = (vote.reasoning ?? '').split('\n')[0] ?? '';
  const title = vote.counts
    ? `${vote.reasoning ?? ''}\n\nStaged by an AI agent. Not spam overrules it; Spam confirms it.${
        spam && purgeAfter ? ` Purges ${formatAbsoluteDate(purgeAfter, { dateStyle: 'medium' })} unless a person votes.` : ''
      }`
    : `${vote.reasoning ?? ''}\n\nThe agent's access was revoked: this vote is a record only and will not purge anyone.`;
  return (
    <div className="flex max-w-xs flex-col items-end gap-1 text-right" data-testid="staged-vote">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
          vote.counts ? 'bg-violet-100 text-violet-900' : 'bg-muted text-muted-foreground'
        }`}
        title={title}
      >
        Staged {spam ? 'spam' : 'not spam'} · {vote.agent.fullName} (AI) · {formatRelativeTime(vote.evaluatedAt)}
        {vote.counts ? '' : ' · access revoked'}
      </span>
      {firstLine && (
        <span className="line-clamp-2 text-xs text-muted-foreground" title={vote.reasoning ?? undefined}>
          {firstLine}
        </span>
      )}
      {vote.flags.length > 0 && (
        <span className="flex flex-wrap justify-end gap-1">
          {vote.flags.map((f) => (
            <span key={f} className="rounded bg-violet-50 px-1 text-[10px] text-violet-900">
              {f}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function VoteButtons({
  slug,
  disabled,
  pending,
  onPendingHandled,
  onDone,
}: {
  slug: string;
  disabled: boolean;
  /** A verdict requested from the keyboard; the component opens the confirm (spam) or fires (legit). */
  pending: VoteVerdict | null;
  onPendingHandled: () => void;
  onDone: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<VoteVerdict | null>(null);
  const [reasoning, setReasoning] = useState('');
  const mutation = useMutation({
    mutationFn: ({ verdict, why }: { verdict: VoteVerdict; why: string }) =>
      api.admin.vote(slug, verdict, why.trim() || undefined),
    onSuccess: async (_res, vars) => {
      toast.success(vars.verdict === 'spam' ? 'Marked as spam and hidden' : 'Marked as not spam');
      setConfirming(null);
      setReasoning('');
      await onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Vote failed'),
  });

  // Keyboard `n` fires immediately; keyboard `s` is rendered as the open
  // confirm below (derived, not stored) until the staffer confirms or cancels.
  useEffect(() => {
    if (pending === 'legit' && !disabled) {
      mutation.mutate({ verdict: 'legit', why: '' });
      onPendingHandled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const active = confirming ?? (pending === 'spam' && !disabled ? 'spam' : null);

  if (active) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      mutation.mutate({ verdict: active, why: reasoning });
      onPendingHandled();
    };
    const cancel = () => {
      setConfirming(null);
      onPendingHandled();
    };
    return (
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Label htmlFor={`why-${slug}`} className="text-xs">
          {active === 'spam' ? 'Why spam? (optional, saved with your vote)' : 'Note (optional)'}
        </Label>
        <Textarea
          id={`why-${slug}`}
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          maxLength={1000}
          rows={2}
          className="text-sm"
          autoFocus
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant={active === 'spam' ? 'destructive' : 'default'} disabled={mutation.isPending}>
            Confirm {active === 'spam' ? 'spam' : 'not spam'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={mutation.isPending}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="destructive" disabled={disabled} onClick={() => setConfirming('spam')}>
        Spam
      </Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setConfirming('legit')}>
        Not spam
      </Button>
    </div>
  );
}

function MemberRowView({
  row,
  selfSlug,
  expanded,
  selected,
  pendingVote,
  onPendingHandled,
  onToggle,
  onChanged,
  onSearchDomain,
}: {
  row: MemberRow;
  selfSlug: string | undefined;
  expanded: boolean;
  selected: boolean;
  pendingVote: VoteVerdict | null;
  onPendingHandled: () => void;
  onToggle: () => void;
  onChanged: () => Promise<void>;
  onSearchDomain: (domain: string) => void;
}) {
  const [changing, setChanging] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const staged = row.stagedVote ?? null;
  const hiddenByVote =
    row.deletedAt !== null && (row.latestVote ? row.latestVote.verdict === 'spam' : staged?.verdict === 'spam');
  const hiddenBy = row.latestVote ? row.latestVote.voter.fullName : staged ? `${staged.agent.fullName} (AI)` : 'vote';
  const isSelf = row.slug === selfSlug;
  const noVoting = isSelf || row.isAgent === true;
  const fp = row.footprint;
  const counts = [
    `${fp.memberships} project${fp.memberships === 1 ? '' : 's'}`,
    fp.updates ? `${fp.updates} update${fp.updates === 1 ? '' : 's'}` : null,
    fp.buzz ? `${fp.buzz} buzz` : null,
    fp.blogPosts ? `${fp.blogPosts} post${fp.blogPosts === 1 ? '' : 's'}` : null,
    fp.helpWantedInterest ? `${fp.helpWantedInterest} help-wanted` : null,
    `${fp.tags} tag${fp.tags === 1 ? '' : 's'}`,
  ].filter(Boolean);
  const signIns =
    row.signInCount === 0
      ? 'never signed in'
      : `signed in ${row.signInCount}×${row.lastLoginAt ? ` · last ${formatRelativeTime(row.lastLoginAt)}` : ''}`;

  return (
    <li
      ref={ref}
      className={`rounded-lg border p-4 ${rowTint(row)} ${row.deletedAt ? 'opacity-60' : ''} ${
        selected ? 'ring-2 ring-primary' : ''
      }`}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-start gap-4">
        {row.avatarUrl ? (
          <img src={row.avatarUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
        ) : (
          <div className="h-12 w-12 rounded-full bg-muted" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to={`/members/${row.slug}`} target="_blank" rel="noreferrer" className="font-semibold hover:underline">
              {row.fullName}
            </Link>
            <span className="text-sm text-muted-foreground">@{row.slug}</span>
            {row.deletedAt && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {hiddenByVote ? `Hidden by ${hiddenBy}` : 'Deactivated'}
              </span>
            )}
            {row.purgeAfter && (
              <span
                className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive"
                title={
                  row.latestVote
                    ? 'Scheduled spam purge: every staff vote is spam. A Not spam vote or reactivating them stops it.'
                    : 'Scheduled spam purge on an AI agent’s staged vote. A Not spam vote or reactivating them stops it.'
                }
              >
                {purgeLabel(row.purgeAfter)}
              </span>
            )}
          </div>
          <div className="mt-1">
            <Badges row={row} />
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            joined {formatRelativeTime(row.createdAt)} · {signIns}
            {row.email && (
              <>
                {' · '}
                <EmailWithDomainSearch email={row.email} onSearchDomain={onSearchDomain} />
              </>
            )}
          </div>
          {row.bioExcerpt && <p className="mt-1 text-sm">{row.bioExcerpt}</p>}
          <div className="mt-1 text-xs text-muted-foreground">{counts.join(' · ')}</div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {row.latestVote && !changing ? (
            <>
              <VoteBadge vote={row.latestVote} hiddenByVote={hiddenByVote} />
              <Button size="sm" variant="ghost" onClick={() => setChanging(true)} disabled={noVoting}>
                Change
              </Button>
            </>
          ) : (
            <>
            {staged && <StagedVoteBadge vote={staged} purgeAfter={row.purgeAfter} />}
            <VoteButtons
              slug={row.slug}
              disabled={noVoting}
              pending={pendingVote}
              onPendingHandled={onPendingHandled}
              onDone={async () => {
                setChanging(false);
                await onChanged();
              }}
            />
            </>
          )}
          <Button size="sm" variant="link" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? 'Hide details' : 'Details'}
          </Button>
        </div>
      </div>
      {expanded && <MemberDetailView slug={row.slug} />}
    </li>
  );
}

function MemberDetailView({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ['admin-member', slug], queryFn: () => api.admin.member(slug) });
  if (q.isLoading) return <p className="mt-3 text-sm text-muted-foreground">Loading…</p>;
  if (q.isError || !q.data) return <p className="mt-3 text-sm text-destructive">Could not load details.</p>;
  const { person, footprint, votes } = q.data.data;
  const earlierVotes = q.data.data.earlierVotes ?? [];
  const earlierPurges = q.data.data.earlierPurges ?? [];
  const humanVoted = votes.some((v) => v.kind !== 'agent');
  const latestHuman = votes.find((v) => v.kind !== 'agent');
  const section = (title: string, items: React.ReactNode[]) =>
    items.length > 0 ? (
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <ul className="ml-4 list-disc text-sm">{items}</ul>
      </div>
    ) : null;
  return (
    <div className="mt-4 grid gap-4 border-t pt-4 md:grid-cols-2">
      <div className="space-y-3">
        {person.bioHtml ? (
          <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: person.bioHtml }} />
        ) : (
          <p className="text-sm text-muted-foreground">No bio.</p>
        )}
        {section(
          'Projects',
          footprint.memberships.map((m) => (
            <li key={`${m.project.slug}-${m.joinedAt}`}>
              <Link to={`/projects/${m.project.slug}`} className="hover:underline">{m.project.title}</Link> — {m.role}, joined {formatAbsoluteDate(m.joinedAt)}
            </li>
          )),
        )}
        {section(
          'Updates',
          footprint.updates.map((u) => (
            <li key={`${u.project.slug}-${u.number}`}>
              <Link to={`/projects/${u.project.slug}/updates/${u.number}`} className="hover:underline">{u.title || `Update #${u.number}`}</Link> on {u.project.title}, {formatAbsoluteDate(u.postedAt)}
            </li>
          )),
        )}
        {section(
          'Buzz',
          footprint.buzz.map((b) => (
            <li key={b.slug}>{b.title} on {b.project.title}, {formatAbsoluteDate(b.postedAt)}</li>
          )),
        )}
        {section(
          'Blog posts',
          footprint.blogPosts.map((bp) => (
            <li key={bp.slug}><Link to={`/blog/${bp.slug}`} className="hover:underline">{bp.title}</Link>, {formatAbsoluteDate(bp.postedAt)}</li>
          )),
        )}
        {section(
          'Help-wanted interest',
          footprint.helpWantedInterest.map((i, idx) => (
            <li key={idx}>{i.role.title} on {i.project.title}, {formatAbsoluteDate(i.createdAt)}</li>
          )),
        )}
        {footprint.tags.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Tags</h3>
            <p className="text-sm">{footprint.tags.map((t) => t.handle).join(', ')}</p>
          </div>
        )}
      </div>
      <div>
        <h3 className="text-sm font-semibold">Votes</h3>
        {votes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No votes yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {votes.map((v) => {
              // Once a person has voted, an agent's vote is history: overruled or confirmed.
              const note =
                v.kind === 'agent' && humanVoted && latestHuman
                  ? latestHuman.verdict === v.verdict
                    ? 'confirmed'
                    : 'overruled'
                  : undefined;
              return (
                <li key={`${v.voter.slug}-${v.evaluatedAt}`}>
                  <VoteBadge vote={v} hiddenByVote={false} note={note} />
                  {v.kind === 'agent' && <span className="ml-1 text-xs text-violet-900">AI agent</span>}
                  {v.flags && v.flags.length > 0 && (
                    <span className="ml-1 text-xs text-muted-foreground">[{v.flags.join(', ')}]</span>
                  )}
                  {v.reasoning && <p className="mt-1 text-muted-foreground">{v.reasoning}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {(earlierVotes.length > 0 || earlierPurges.length > 0) && (
          <div className="mt-4 rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="earlier-account">
            <h3 className="font-semibold">Earlier account</h3>
            <p className="text-xs">An earlier account under this slug. None of this counts for this member.</p>
            <ul className="mt-2 space-y-1">
              {earlierPurges.map((p) => (
                <li key={p.id}>
                  Purged as spam {formatAbsoluteDate(p.purgedAt, { dateStyle: 'medium' })} by{' '}
                  {p.by === 'scheduled' ? 'the daily sweep' : p.by}
                  {p.reason ? ` — ${p.reason}` : ''}
                </li>
              ))}
              {earlierVotes.map((v) => (
                <li key={`earlier-${v.voter.slug}-${v.evaluatedAt}`} className="opacity-70">
                  <VoteBadge vote={v} hiddenByVote={false} />
                  {v.reasoning && <span className="ml-1">{v.reasoning}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          An administrator’s purge lives on the <Link to={`/members/${slug}`} className="underline">person page</Link>.
        </p>
      </div>
    </div>
  );
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function AdminMembers() {
  const { person, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ slug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(params.slug ?? null);
  const [selected, setSelected] = useState<string | null>(params.slug ?? null);
  const [pendingVote, setPendingVote] = useState<{ slug: string; verdict: VoteVerdict } | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(searchParams.has('agents'));
  // The purge log's "by" filter; null while the log is closed.
  const [logBy, setLogBy] = useState<string | null>(searchParams.has('purges') ? (searchParams.get('purges') ?? '') : null);

  const allowed = !!person && isStaff(person.accountLevel);
  useEffect(() => {
    if (loading) return;
    if (!person) {
      void navigate('/login?return=/admin/members', { replace: true });
      return;
    }
    if (!isStaff(person.accountLevel)) {
      void navigate('/404', { replace: true });
    }
  }, [loading, person, navigate]);

  // "No vote yet" is the default: the page exists for triage.
  const voteParam = searchParams.has('vote') ? searchParams.get('vote') : 'none';
  const listParams: MemberListParams = {
    q: searchParams.get('q') || undefined,
    vote: (voteParam as MemberListParams['vote']) || undefined,
    origin: (searchParams.get('origin') as MemberListParams['origin']) || undefined,
    includeDeactivated: searchParams.get('hidden') !== '0',
    sort: searchParams.get('sort') || undefined,
    page: Number(searchParams.get('page') || '1'),
    perPage: PER_PAGE,
  };
  const listQ = useQuery({
    queryKey: ['admin-members', listParams],
    queryFn: () => api.admin.members(listParams),
    enabled: allowed,
  });

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  };

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-members'] });
    await queryClient.invalidateQueries({ queryKey: ['admin-member'] });
  }, [queryClient]);

  const rows = useMemo(() => listQ.data?.data ?? [], [listQ.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (rows.length === 0) return;
      const idx = selected ? rows.findIndex((r) => r.slug === selected) : -1;
      if (e.key === 'j') {
        e.preventDefault();
        setSelected(rows[Math.min(rows.length - 1, idx + 1)]!.slug);
      } else if (e.key === 'k') {
        e.preventDefault();
        setSelected(rows[Math.max(0, idx - 1)]!.slug);
      } else if (e.key === 'Enter' && selected) {
        e.preventDefault();
        setExpanded((cur) => (cur === selected ? null : selected));
      } else if ((e.key === 's' || e.key === 'n') && selected) {
        e.preventDefault();
        setPendingVote({ slug: selected, verdict: e.key === 's' ? 'spam' : 'legit' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selected]);

  if (!allowed) return null;

  const meta = listQ.data?.metadata;

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">Members roster</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Newest signups first. Votes are recorded under your name; a spam vote hides the member immediately, and three
        days later they're purged unless someone votes Not spam. Keys: <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>s</kbd> spam, <kbd>n</kbd> not spam,{' '}
        <kbd>Enter</kbd> details.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        An AI agent staff granted access may vote too. Its votes are <span className="text-violet-900">staged</span>: they
        hide the member at once and purge on the date shown unless a person votes; <strong>Not spam</strong> overrules,{' '}
        <strong>Spam</strong> confirms. An agent with the purge scope may purge a member under 7 days old who posted spam;
        those purges are in the Agents panel’s purge log at the foot of the page.
      </p>
      <RecentAgentPurgesBanner
        onOpenLog={(by) => {
          setAgentsOpen(true);
          setLogBy(by);
          requestAnimationFrame(() => document.getElementById('agents')?.scrollIntoView({ behavior: 'smooth' }));
        }}
      />

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setParam('q', String(data.get('q') ?? '') || null);
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="q" className="text-xs">Search</Label>
          <Input
            id="q"
            name="q"
            key={listParams.q ?? ''}
            defaultValue={listParams.q ?? ''}
            placeholder="name, @slug, bio, email, @domain"
            className="w-64"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="vote" className="text-xs">Vote</Label>
          <select
            id="vote"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={voteParam ?? ''}
            onChange={(e) => setParam('vote', e.target.value)}
          >
            <option value="">Any</option>
            <option value="none">No human vote yet</option>
            <option value="staged">Staged by an agent</option>
            <option value="spam">Voted spam</option>
            <option value="legit">Voted not spam</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="origin" className="text-xs">Origin</Label>
          <select
            id="origin"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={listParams.origin ?? ''}
            onChange={(e) => setParam('origin', e.target.value || null)}
          >
            <option value="">Any</option>
            <option value="signed-up">Signed up here</option>
            <option value="imported">Imported</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="sort" className="text-xs">Sort</Label>
          <select
            id="sort"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={listParams.sort ?? '-createdAt'}
            onChange={(e) => setParam('sort', e.target.value)}
          >
            <option value="-createdAt">Newest first</option>
            <option value="createdAt">Oldest first</option>
            <option value="-lastLoginAt">Last sign-in</option>
            <option value="fullName">Name</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={listParams.includeDeactivated !== false}
            onChange={(e) => setParam('hidden', e.target.checked ? null : '0')}
          />
          Show deactivated
        </label>
        <Button type="submit" size="sm">Apply</Button>
      </form>

      {listQ.isLoading && <p className="mt-6 text-sm text-muted-foreground">Loading…</p>}
      {listQ.isError && <p className="mt-6 text-sm text-destructive">Could not load the roster.</p>}
      {listQ.data && (
        <>
          <p className="mt-6 text-sm text-muted-foreground" role="status">
            {meta?.totalItems ?? 0} member{meta?.totalItems === 1 ? '' : 's'}
            {meta && meta.totalPages > 1 ? ` · page ${meta.page} of ${meta.totalPages}` : ''}
          </p>
          <ul className="mt-2 space-y-3">
            {rows.map((row) => (
              <MemberRowView
                key={row.id}
                row={row}
                selfSlug={person?.slug}
                expanded={expanded === row.slug}
                selected={selected === row.slug}
                pendingVote={pendingVote?.slug === row.slug ? pendingVote.verdict : null}
                onPendingHandled={() => setPendingVote(null)}
                onToggle={() => {
                  setSelected(row.slug);
                  setExpanded(expanded === row.slug ? null : row.slug);
                }}
                onChanged={refresh}
                onSearchDomain={(domain) => setParam('q', `@${domain}`)}
              />
            ))}
          </ul>
          {meta && meta.totalPages > 1 && (
            <nav className="mt-4 flex items-center gap-2" aria-label="Pagination">
              <Button size="sm" variant="outline" disabled={meta.page <= 1} onClick={() => setParam('page', String(meta.page - 1))}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={meta.page >= meta.totalPages} onClick={() => setParam('page', String(meta.page + 1))}>
                Next
              </Button>
            </nav>
          )}
        </>
      )}
      <AgentsPanel
        isAdmin={person?.accountLevel === 'administrator'}
        open={agentsOpen}
        onOpenChange={setAgentsOpen}
        logBy={logBy ?? ''}
        logOpen={logBy !== null}
        onLogByChange={setLogBy}
        onShowStaged={() => {
          setParam('vote', 'staged');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onRosterChanged={refresh}
      />
    </div>
  );
}
