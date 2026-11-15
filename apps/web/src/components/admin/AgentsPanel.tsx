/**
 * The admin members screen's agent surfaces — specs/screens/admin-members.md
 * → "Recent agent purges banner", "Agents panel", "Purge log".
 *
 * Staff read the agents, their grants, what they staged and purged, withdraw
 * an agent's staged votes, and unblock a purged GitHub account. Minting,
 * revoking and creating agents are administrators' only; a minted token is
 * shown once and dropped from the page when its dialog closes.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, type AgentScope, type AgentView, type SpamPurgeView } from '@/lib/api';
import { formatAbsoluteDate, formatRelativeTime } from '@/lib/time';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RESTORE_DOC =
  'https://github.com/CodeForPhilly/codeforphilly-ng/blob/develop/docs/operations/runbook.md#restore-a-purged-member';

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Who purged, as the log says it: `{agent} (AI)`, a staff member, or the daily sweep. */
function purgerLabel(p: SpamPurgeView): string {
  if (p.byRef.kind === 'scheduled') return 'daily sweep';
  return p.byRef.kind === 'agent' ? `${p.byRef.fullName} (AI)` : p.byRef.fullName;
}

/**
 * "{n} members purged by {agent} (AI) in the last 7 days" — not dismissable;
 * it goes when the purges age out.
 */
export function RecentAgentPurgesBanner({ onOpenLog }: { onOpenLog: (by: string) => void }) {
  const [since] = useState(() => new Date(Date.now() - WEEK_MS).toISOString());
  const q = useQuery({
    queryKey: ['spam-purges', 'recent-agent', since],
    queryFn: () => api.admin.spamPurges({ by: 'agent', since, perPage: 200 }),
  });
  const purges = q.data?.data ?? [];
  if (purges.length === 0) return null;
  const byAgent = new Map<string, { name: string; count: number }>();
  for (const p of purges) {
    const entry = byAgent.get(p.by) ?? { name: p.byRef.fullName, count: 0 };
    entry.count += 1;
    byAgent.set(p.by, entry);
  }
  return (
    <div role="status" className="mt-4 space-y-1 rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm text-violet-950">
      {[...byAgent.entries()].map(([by, { name, count }]) => (
        <p key={by}>
          {count} member{count === 1 ? '' : 's'} purged by {name} (AI) in the last 7 days.{' '}
          <button type="button" className="font-medium underline" onClick={() => onOpenLog(by)}>
            Open the purge log
          </button>
        </p>
      ))}
    </div>
  );
}

/** The purge log: one line per spam purge, newest first. */
export function PurgeLog({ by, onByChange }: { by: string; onByChange: (by: string) => void }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['spam-purges', 'log', by],
    queryFn: () => api.admin.spamPurges({ ...(by ? { by } : {}), perPage: 100 }),
  });
  const [unblocking, setUnblocking] = useState<SpamPurgeView | null>(null);
  const [reason, setReason] = useState('');
  const unblock = useMutation({
    mutationFn: ({ id, why }: { id: string; why: string }) => api.admin.unblock(id, why.trim() || undefined),
    onSuccess: async () => {
      toast.success('Unblocked: that GitHub account can sign up again');
      setUnblocking(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['spam-purges'] });
    },
    onError: (err) => toast.error(errorText(err, 'Unblock failed')),
  });
  const purges = q.data?.data ?? [];

  return (
    <section aria-labelledby="purge-log-heading" className="mt-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 id="purge-log-heading" className="font-semibold">
          Purge log
        </h3>
        <div className="flex flex-col gap-1">
          <Label htmlFor="purge-log-by" className="text-xs">
            Purged by
          </Label>
          <select
            id="purge-log-by"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={['', 'agent', 'human', 'scheduled'].includes(by) ? by : 'one'}
            onChange={(e) => onByChange(e.target.value === 'one' ? by : e.target.value)}
          >
            <option value="">All</option>
            <option value="agent">An agent</option>
            <option value="human">Staff</option>
            <option value="scheduled">The daily sweep</option>
            {!['', 'agent', 'human', 'scheduled'].includes(by) && <option value="one">{by}</option>}
          </select>
        </div>
      </div>
      {q.isLoading && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
      {q.isError && <p className="mt-2 text-sm text-destructive">Could not load the purge log.</p>}
      {q.data && purges.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No spam purges.</p>}
      <ul className="mt-3 space-y-3">
        {purges.map((p) => (
          <li key={p.id} className="rounded-md border p-3 text-sm" data-testid="purge-log-item">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono font-semibold">{p.personSlug}</span>
              <span className="text-muted-foreground" title={new Date(p.purgedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}>
                purged {formatRelativeTime(p.purgedAt)} by {purgerLabel(p)}
              </span>
            </div>
            {p.reason && <p className="mt-1 whitespace-pre-wrap">{p.reason}</p>}
            {p.flags.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {p.flags.map((f) => (
                  <span key={f} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {f}
                  </span>
                ))}
              </div>
            )}
            {p.evidence.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {p.evidence.map((e) => (
                  <li key={`${e.path}#${e.field ?? ''}`}>
                    <a href={e.url} target="_blank" rel="noreferrer" className="break-all underline">
                      {e.path}
                      {e.field ? `#${e.field}` : ''}
                    </a>{' '}
                    <span className="text-muted-foreground">(as it stood before the purge)</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <a href={p.commitUrl} target="_blank" rel="noreferrer" className="underline">
                Commit
              </a>
              <a href={RESTORE_DOC} target="_blank" rel="noreferrer" className="underline">
                How to restore
              </a>
              {p.blocking ? (
                <>
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">Blocks sign-up</span>
                  <Button size="sm" variant="outline" onClick={() => setUnblocking(p)}>
                    Unblock
                  </Button>
                </>
              ) : p.unblockedAt ? (
                <span className="text-muted-foreground">
                  Unblocked by {p.unblockedBy?.fullName ?? 'staff'} · {formatRelativeTime(p.unblockedAt)}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={unblocking !== null} onOpenChange={(open) => !open && setUnblocking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unblock {unblocking?.personSlug}?</DialogTitle>
            <DialogDescription>
              The GitHub account purged under this slug will be able to sign up again. The purge stays in the log, marked
              unblocked. To bring the member back too, follow the restore runbook.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (unblocking) unblock.mutate({ id: unblocking.id, why: reason });
            }}
            className="space-y-3"
          >
            <div className="space-y-1">
              <Label htmlFor="unblock-reason">Reason (optional, public)</Label>
              <Textarea id="unblock-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setUnblocking(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={unblock.isPending}>
                Unblock
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

const SCOPE_LABEL: Record<AgentScope, string> = {
  'moderation:read': 'read roster',
  'moderation:vote': 'staged votes',
  'moderation:purge': 'purge',
};

/** Mint form + the purge second confirm + the token-once dialog. */
function MintGrantDialog({
  agentSlug,
  open,
  onOpenChange,
  onMinted,
}: {
  agentSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMinted: (token: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('90');
  const [scopes, setScopes] = useState<Record<AgentScope, boolean>>({
    'moderation:read': true,
    'moderation:vote': true,
    'moderation:purge': false,
  });
  const [confirmPurge, setConfirmPurge] = useState(false);
  const mint = useMutation({
    mutationFn: () =>
      api.admin.mintGrant(agentSlug, {
        label: label.trim(),
        scopes: (Object.keys(scopes) as AgentScope[]).filter((s) => scopes[s]),
        expiresInDays: Number(days),
      }),
    onSuccess: (res) => {
      setConfirmPurge(false);
      onOpenChange(false);
      setLabel('');
      onMinted(res.data.token);
    },
    onError: (err) => toast.error(errorText(err, 'Could not mint the grant')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (scopes['moderation:purge'] && !confirmPurge) {
      setConfirmPurge(true);
      return;
    }
    mint.mutate();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setConfirmPurge(false);
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirmPurge ? 'Allow this agent to purge?' : `Mint a grant for ${agentSlug}`}</DialogTitle>
          <DialogDescription>
            {confirmPurge
              ? 'A grant with the purge scope lets the agent immediately and permanently purge members under 7 days old who posted spam, up to 5 a day, citing the records it removes. Each purge is in the purge log and the public commit history.'
              : 'Scopes are fixed for the grant’s life. To change them, mint a new grant and revoke the old one.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {!confirmPurge && (
            <>
              <div className="space-y-1">
                <Label htmlFor="grant-label">Label (what and where)</Label>
                <Input id="grant-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} required placeholder="ops bot, host vm-1" />
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Scopes</legend>
                {(Object.keys(SCOPE_LABEL) as AgentScope[]).map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={scopes[s]}
                      onCheckedChange={(v) => setScopes((cur) => ({ ...cur, [s]: v === true }))}
                    />
                    <span className={s === 'moderation:purge' ? 'text-destructive' : undefined}>
                      <code>{s}</code> — {SCOPE_LABEL[s]}
                    </span>
                  </label>
                ))}
                {scopes['moderation:purge'] && !scopes['moderation:read'] && (
                  <p className="text-xs text-destructive">The purge scope needs moderation:read too.</p>
                )}
              </fieldset>
              <div className="space-y-1">
                <Label htmlFor="grant-days">Expires in (days, 1–180)</Label>
                <Input id="grant-days" type="number" min={1} max={180} value={days} onChange={(e) => setDays(e.target.value)} className="w-28" />
              </div>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => (confirmPurge ? setConfirmPurge(false) : onOpenChange(false))}>
              {confirmPurge ? 'Back' : 'Cancel'}
            </Button>
            <Button type="submit" variant={confirmPurge ? 'destructive' : 'default'} disabled={mint.isPending}>
              {confirmPurge ? 'Yes, mint with purge' : 'Mint grant'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The token, once. Closing the dialog drops it from the page. */
function TokenDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>The agent’s token</DialogTitle>
          <DialogDescription>
            This is the only time it is shown. Put it straight into the agent’s credential file on its host; never paste
            it into chat, an issue or a repo.
          </DialogDescription>
        </DialogHeader>
        <code className="block break-all rounded bg-muted p-3 text-xs" data-testid="agent-token">
          {token}
        </code>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (token) void navigator.clipboard?.writeText(token).then(() => toast.success('Copied'));
            }}
          >
            Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewAgentDialog({ open, onOpenChange, onMinted }: { open: boolean; onOpenChange: (o: boolean) => void; onMinted: (token: string) => void }) {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState('');
  const [fullName, setFullName] = useState('');
  const [bio, setBio] = useState('');
  const [label, setLabel] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.admin.createAgent({
        slug: slug.trim(),
        fullName: fullName.trim(),
        bio: bio.trim(),
        grant: { label: label.trim(), scopes: ['moderation:read', 'moderation:vote'], expiresInDays: 90 },
      }),
    onSuccess: async (res) => {
      onOpenChange(false);
      setSlug('');
      setFullName('');
      setBio('');
      setLabel('');
      await queryClient.invalidateQueries({ queryKey: ['admin-agents'] });
      onMinted(res.data.token);
    },
    onError: (err) => toast.error(errorText(err, 'Could not create the agent')),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent account</DialogTitle>
          <DialogDescription>
            An agent has no sign-in: only grants reach the API as it. Its bio is public and must say it is an AI and who
            runs it. It is created with its first grant, which carries read and staged votes only.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="agent-slug">Slug</Label>
            <Input id="agent-slug" value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-name">Name</Label>
            <Input id="agent-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-bio">Bio</Label>
            <Textarea id="agent-bio" value={bio} onChange={(e) => setBio(e.target.value)} required rows={3} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-grant-label">First grant label (what and where)</Label>
            <Input
              id="agent-grant-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              required
              placeholder="ops bot, host vm-1"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentLine({
  agent,
  isAdmin,
  onShowStaged,
  onOpenLog,
  onToken,
  onRosterChanged,
}: {
  agent: AgentView;
  isAdmin: boolean;
  onShowStaged: () => void;
  onOpenLog: () => void;
  onToken: (token: string) => void;
  onRosterChanged: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [minting, setMinting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [alsoWithdraw, setAlsoWithdraw] = useState(false);
  const refreshAgents = () => queryClient.invalidateQueries({ queryKey: ['admin-agents'] });
  const withdraw = useMutation({
    mutationFn: () => api.admin.withdrawVotes(agent.person.slug),
    onSuccess: async (res) => {
      setWithdrawing(false);
      toast.success(`Withdrew ${res.data.withdrawn} vote${res.data.withdrawn === 1 ? '' : 's'}; un-hid ${res.data.reactivated}`);
      await refreshAgents();
      await onRosterChanged();
    },
    onError: (err) => toast.error(errorText(err, 'Withdraw failed')),
  });
  const revoke = useMutation({
    mutationFn: ({ id, withdrawVotes }: { id: string; withdrawVotes: boolean }) =>
      api.admin.revokeGrant(agent.person.slug, id, { withdrawVotes }),
    onSuccess: async (res) => {
      setRevoking(null);
      setAlsoWithdraw(false);
      const w = res.data.withdrawn;
      toast.success(w === undefined ? 'Grant revoked' : `Grant revoked; withdrew ${w} staged vote${w === 1 ? '' : 's'}`);
      await refreshAgents();
      await onRosterChanged();
    },
    onError: (err) => toast.error(errorText(err, 'Revoke failed')),
  });
  const staged = agent.stagedVotes.spam + agent.stagedVotes.legit;

  return (
    <li className="rounded-md border p-3 text-sm" data-testid="agent-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a href={`/members/${agent.person.slug}`} target="_blank" rel="noreferrer" className="font-semibold hover:underline">
          {agent.person.fullName}
        </a>
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-900">AI agent</span>
        <span className="text-muted-foreground">
          {staged} staged ({agent.stagedVotes.spam} spam, {agent.stagedVotes.legit} not spam) · purged {agent.purges.last24h} in 24h,{' '}
          {agent.purges.last30d} in 30d
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {agent.grants.map((g) => (
          <li key={g.id} className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${g.active ? '' : 'text-muted-foreground'}`}>
            <span className="font-medium">{g.label}</span>
            {g.scopes.map((s) => (
              <code key={s} className={`rounded px-1 ${s === 'moderation:purge' ? 'bg-destructive/10 text-destructive' : 'bg-muted'}`}>
                {s}
              </code>
            ))}
            <span>
              by {g.createdBy.fullName} · expires {formatAbsoluteDate(g.expiresAt, { dateStyle: 'medium' })} · last used{' '}
              {g.lastUsedAt ? formatRelativeTime(g.lastUsedAt) : 'never'}
            </span>
            <span className={g.active ? 'text-emerald-700' : ''}>{g.active ? 'active' : g.revokedAt ? 'revoked' : 'expired'}</span>
            {isAdmin && g.active && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={revoke.isPending} onClick={() => setRevoking(g.id)}>
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onShowStaged}>
          Show staged
        </Button>
        <Button size="sm" variant="outline" onClick={onOpenLog}>
          Purge log
        </Button>
        <Button size="sm" variant="outline" onClick={() => setWithdrawing(true)} disabled={staged === 0}>
          Withdraw staged votes
        </Button>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={() => setMinting(true)}>
            Mint grant
          </Button>
        )}
      </div>
      <MintGrantDialog
        agentSlug={agent.person.slug}
        open={minting}
        onOpenChange={setMinting}
        onMinted={(token) => {
          void refreshAgents();
          onToken(token);
        }}
      />
      <Dialog
        open={revoking !== null}
        onOpenChange={(o) => {
          if (!o) {
            setRevoking(null);
            setAlsoWithdraw(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this grant?</DialogTitle>
            <DialogDescription>
              The next request with its token is refused. {agent.person.fullName}’s staged votes stop counting toward a purge
              while it holds no active grant, and count again if a new grant is minted, unless you withdraw them now.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={alsoWithdraw} onCheckedChange={(v) => setAlsoWithdraw(v === true)} className="mt-0.5" />
            <span>
              This token may be compromised: also withdraw this agent’s staged votes
              {staged > 0 ? ` (${staged} now, un-hiding the members its spam votes hid)` : ''}.
            </span>
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRevoking(null);
                setAlsoWithdraw(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoking && revoke.mutate({ id: revoking, withdrawVotes: alsoWithdraw })}
            >
              {alsoWithdraw ? 'Revoke and withdraw' : 'Revoke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={withdrawing} onOpenChange={setWithdrawing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw {agent.person.fullName}’s staged votes?</DialogTitle>
            <DialogDescription>
              This removes {staged} vote{staged === 1 ? '' : 's'} on members no person has voted on and un-hides the
              members its spam votes hid ({agent.stagedVotes.spam} spam vote{agent.stagedVotes.spam === 1 ? '' : 's'}), in
              one commit. It does not undo purges, and it does not revoke the grant.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawing(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>
              Withdraw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** The collapsed Agents section at the foot of the roster. */
export function AgentsPanel({
  isAdmin,
  open,
  onOpenChange,
  logBy,
  onLogByChange,
  logOpen,
  onShowStaged,
  onRosterChanged,
}: {
  isAdmin: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  logBy: string;
  onLogByChange: (by: string) => void;
  logOpen: boolean;
  onShowStaged: () => void;
  onRosterChanged: () => Promise<void>;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['admin-agents'], queryFn: () => api.admin.agents(), enabled: open });
  const agents = q.data?.data ?? [];

  return (
    <section id="agents" aria-labelledby="agents-heading" className="mt-10 border-t pt-6">
      <button
        type="button"
        id="agents-heading"
        className="text-lg font-semibold hover:underline"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {open ? '▾' : '▸'} Agents
      </button>
      {open && (
        <div className="mt-3">
          <p className="text-sm text-muted-foreground">
            AI agents staff granted access. Their votes are staged (any staff vote overrules them); an agent with the purge
            scope may purge a member under 7 days old who posted spam, and every purge is in the log below.
          </p>
          {q.isLoading && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
          {q.data && agents.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No agents.</p>}
          <ul className="mt-3 space-y-3">
            {agents.map((a) => (
              <AgentLine
                key={a.person.slug}
                agent={a}
                isAdmin={isAdmin}
                onShowStaged={onShowStaged}
                onOpenLog={() => onLogByChange(`agent-${a.person.slug}`)}
                onToken={setToken}
                onRosterChanged={onRosterChanged}
              />
            ))}
          </ul>
          {isAdmin && (
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setCreating(true)}>
              New agent
            </Button>
          )}
          {logOpen && <PurgeLog by={logBy} onByChange={onLogByChange} />}
          {!logOpen && (
            <Button size="sm" variant="link" className="mt-2 px-0" onClick={() => onLogByChange('')}>
              Open the purge log
            </Button>
          )}
          <NewAgentDialog open={creating} onOpenChange={setCreating} onMinted={setToken} />
          <TokenDialog token={token} onClose={() => setToken(null)} />
        </div>
      )}
    </section>
  );
}
