import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';
import { formatAbsoluteDate, formatRelativeTime } from '@/lib/time';

export function StaffAccountClaimQueue() {
  const { person, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (loading) return;
    if (!person) {
      void navigate('/login?return=/staff/account-claim', { replace: true });
      return;
    }
    if (person.accountLevel !== 'staff' && person.accountLevel !== 'administrator') {
      toast.error('Staff only');
      void navigate('/', { replace: true });
    }
  }, [loading, person, navigate]);

  const queueQ = useQuery({
    queryKey: ['staff-account-claim-queue'],
    queryFn: () => api.staffAccountClaim.queue(),
    enabled: !!person && (person.accountLevel === 'staff' || person.accountLevel === 'administrator'),
  });

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const setReason = (id: string, val: string) => {
    setReasons((r) => ({ ...r, [id]: val }));
  };

  const onApprove = async (id: string) => {
    setPendingId(id);
    try {
      await api.staffAccountClaim.approve(id, reasons[id] ?? undefined);
      toast.success('Claim approved');
      await queryClient.invalidateQueries({ queryKey: ['staff-account-claim-queue'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Approve failed');
    } finally {
      setPendingId(null);
    }
  };

  const onDeny = async (id: string) => {
    setPendingId(id);
    try {
      await api.staffAccountClaim.deny(id, reasons[id] ?? undefined);
      toast.success('Claim denied');
      await queryClient.invalidateQueries({ queryKey: ['staff-account-claim-queue'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Deny failed');
    } finally {
      setPendingId(null);
    }
  };

  if (loading || !person) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading…</div>;
  }
  if (person.accountLevel !== 'staff' && person.accountLevel !== 'administrator') {
    return null;
  }

  const items = queueQ.data?.data ?? [];

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">Account-claim queue</h1>

      {queueQ.isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}

      {!queueQ.isLoading && items.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Nothing pending</CardTitle>
            <CardDescription>The queue is empty.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {items.map((item) => (
        <Card key={item.requestId}>
          <CardHeader>
            <CardTitle className="text-lg">
              <span className="font-mono">{item.claimedSlug}</span>
              {' '}
              <span className="text-sm text-muted-foreground font-normal">
                ({item.type === 'pre-onboarding' ? 'pre-onboarding link' : 'post-onboarding merge'})
              </span>
            </CardTitle>
            <CardDescription>
              From{' '}
              <span className="font-mono">{item.requesterGithubLogin}</span>
              {item.requesterPersonId && (
                <>
                  {' '}
                  · currently{' '}
                  <span className="font-mono">{item.requesterPersonId.slice(0, 8)}…</span>
                </>
              )}
              {' · '}
              <span
                title={formatAbsoluteDate(item.submittedAt)}
                className="text-muted-foreground"
              >
                {formatRelativeTime(item.submittedAt)}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!item.claimedPersonId && (
              <div className="rounded-md bg-yellow-100 dark:bg-yellow-900/30 text-yellow-900 dark:text-yellow-100 px-3 py-2 text-xs">
                The claimed slug doesn't resolve to a current Person. Approve
                will return an error — deny with a note instead.
              </div>
            )}
            <div className="rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">
              {item.evidence}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`reason-${item.requestId}`}>Note (optional, included in commit / denial email)</Label>
              <Textarea
                id={`reason-${item.requestId}`}
                value={reasons[item.requestId] ?? ''}
                onChange={(e) => setReason(item.requestId, e.target.value)}
                rows={2}
                maxLength={2000}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => void onApprove(item.requestId)}
                disabled={pendingId !== null || !item.claimedPersonId}
              >
                {pendingId === item.requestId ? 'Working…' : 'Approve'}
              </Button>
              <Button
                variant="outline"
                onClick={() => void onDeny(item.requestId)}
                disabled={pendingId !== null}
              >
                {pendingId === item.requestId ? 'Working…' : 'Deny'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
