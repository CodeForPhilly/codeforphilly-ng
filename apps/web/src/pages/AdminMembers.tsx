/**
 * /admin/members — staff roster with footprint and human spam votes.
 * Per specs/screens/admin-members.md.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError, type MemberListParams, type MemberRow, type VoteVerdict, type VoteView } from '@/lib/api';
import { formatAbsoluteDate, formatRelativeTime } from '@/lib/time';

const PER_PAGE = 50;

function isStaff(level: string | undefined): boolean {
  return level === 'staff' || level === 'administrator';
}

function VoteBadge({ vote, hiddenByVote }: { vote: VoteView; hiddenByVote: boolean }) {
  const spam = vote.verdict === 'spam';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        spam ? 'bg-destructive/10 text-destructive' : 'bg-emerald-100 text-emerald-800'
      }`}
      title={vote.reasoning ?? undefined}
    >
      {spam ? 'Spam' : 'Not spam'} · {vote.voter.fullName} · {formatRelativeTime(vote.evaluatedAt)}
      {hiddenByVote ? ' · hidden' : ''}
    </span>
  );
}

function VoteButtons({
  slug,
  disabled,
  onDone,
}: {
  slug: string;
  disabled: boolean;
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

  if (confirming) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      mutation.mutate({ verdict: confirming, why: reasoning });
    };
    return (
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Label htmlFor={`why-${slug}`} className="text-xs">
          {confirming === 'spam' ? 'Why spam? (optional, saved with your vote)' : 'Note (optional)'}
        </Label>
        <Textarea
          id={`why-${slug}`}
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          maxLength={1000}
          rows={2}
          className="text-sm"
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant={confirming === 'spam' ? 'destructive' : 'default'} disabled={mutation.isPending}>
            Confirm {confirming === 'spam' ? 'spam' : 'not spam'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)} disabled={mutation.isPending}>
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
  onToggle,
  onChanged,
}: {
  row: MemberRow;
  selfSlug: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
}) {
  const [changing, setChanging] = useState(false);
  const hiddenByVote = row.deletedAt !== null && row.latestVote?.verdict === 'spam';
  const isSelf = row.slug === selfSlug;
  const fp = row.footprint;
  const counts = [
    `${fp.memberships} project${fp.memberships === 1 ? '' : 's'}`,
    fp.updates ? `${fp.updates} update${fp.updates === 1 ? '' : 's'}` : null,
    fp.buzz ? `${fp.buzz} buzz` : null,
    fp.blogPosts ? `${fp.blogPosts} post${fp.blogPosts === 1 ? '' : 's'}` : null,
    fp.helpWantedInterest ? `${fp.helpWantedInterest} help-wanted` : null,
    `${fp.tags} tag${fp.tags === 1 ? '' : 's'}`,
  ].filter(Boolean);

  return (
    <li className={`rounded-lg border p-4 ${row.deletedAt ? 'opacity-60' : ''}`}>
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
            {row.hasGitHubLink && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">GitHub</span>
            )}
            {row.deletedAt && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {hiddenByVote ? `Hidden by ${row.latestVote?.voter.fullName ?? 'vote'}` : 'Deactivated'}
              </span>
            )}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            joined {formatRelativeTime(row.createdAt)}
            {row.lastLoginAt ? ` · last sign-in ${formatRelativeTime(row.lastLoginAt)}` : ' · never signed in'}
            {row.email ? ` · ${row.email}` : ''}
          </div>
          {row.bioExcerpt && <p className="mt-1 text-sm">{row.bioExcerpt}</p>}
          <div className="mt-1 text-xs text-muted-foreground">{counts.join(' · ')}</div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {row.latestVote && !changing ? (
            <>
              <VoteBadge vote={row.latestVote} hiddenByVote={hiddenByVote} />
              <Button size="sm" variant="ghost" onClick={() => setChanging(true)} disabled={isSelf}>
                Change
              </Button>
            </>
          ) : (
            <VoteButtons
              slug={row.slug}
              disabled={isSelf}
              onDone={async () => {
                setChanging(false);
                await onChanged();
              }}
            />
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
          <p className="text-sm text-muted-foreground">No human votes yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {votes.map((v) => (
              <li key={`${v.voter.slug}-${v.evaluatedAt}`}>
                <VoteBadge vote={v} hiddenByVote={false} />
                {v.reasoning && <p className="mt-1 text-muted-foreground">{v.reasoning}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          Purge lives on the <Link to={`/members/${slug}`} className="underline">person page</Link> (admins).
        </p>
      </div>
    </div>
  );
}

export function AdminMembers() {
  const { person, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ slug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(params.slug ?? null);

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

  const listParams: MemberListParams = {
    q: searchParams.get('q') || undefined,
    vote: (searchParams.get('vote') as MemberListParams['vote']) || undefined,
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
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  };

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-members'] });
    await queryClient.invalidateQueries({ queryKey: ['admin-member'] });
  };

  if (!allowed) return null;

  const meta = listQ.data?.metadata;

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">Members roster</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Newest signups first. Votes are recorded under your name; a spam vote hides the member immediately and the next
        pipeline run removes them.
      </p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setParam('q', String(data.get('q') ?? ''));
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="q" className="text-xs">Search</Label>
          <Input id="q" name="q" defaultValue={listParams.q ?? ''} placeholder="name, @slug, bio, email" className="w-64" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="vote" className="text-xs">Vote</Label>
          <select
            id="vote"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={listParams.vote ?? ''}
            onChange={(e) => setParam('vote', e.target.value)}
          >
            <option value="">Any</option>
            <option value="none">No vote yet</option>
            <option value="spam">Voted spam</option>
            <option value="legit">Voted not spam</option>
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
            {listQ.data.data.map((row) => (
              <MemberRowView
                key={row.id}
                row={row}
                selfSlug={person?.slug}
                expanded={expanded === row.slug}
                onToggle={() => setExpanded(expanded === row.slug ? null : row.slug)}
                onChanged={refresh}
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
    </div>
  );
}
