import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';

interface ExpressInterestModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
  roleId: string;
  roleTitle: string;
}

export function ExpressInterestModal({
  open,
  onOpenChange,
  projectSlug,
  roleId,
  roleTitle,
}: ExpressInterestModalProps) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.helpWantedRole.expressInterest(projectSlug, roleId, {
        message: message.trim() || null,
      });
      await queryClient.invalidateQueries({ queryKey: ['project', projectSlug] });
      await queryClient.invalidateQueries({
        queryKey: ['project-help-wanted', projectSlug],
      });
      await queryClient.invalidateQueries({ queryKey: ['help-wanted-index'] });
      toast.success('Interest sent — the project maintainer will be notified');
      setMessage('');
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'already_expressed') {
          toast.error(
            'You expressed interest in this role recently. Try again in 30 days.',
          );
        } else if (err.code === 'role_not_open') {
          toast.error('This role is no longer accepting interest.');
        } else {
          toast.error(err.message);
        }
      } else {
        toast.error("Couldn't send interest.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Express Interest</DialogTitle>
            <DialogDescription>
              Send a note to the maintainer of <strong>{roleTitle}</strong>. Your name
              and contact info are included automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2">
            <Label htmlFor="interest-message">Optional message</Label>
            <Textarea
              id="interest-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tell them a bit about your interest, availability, or background…"
              rows={5}
              maxLength={2000}
            />
            <p className="text-xs text-muted-foreground text-right">
              {message.length} / 2000
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send interest'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
