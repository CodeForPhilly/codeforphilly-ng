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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';

interface FillRoleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
  roleId: string;
  roleTitle: string;
}

export function FillRoleModal({
  open,
  onOpenChange,
  projectSlug,
  roleId,
  roleTitle,
}: FillRoleModalProps) {
  const queryClient = useQueryClient();
  const [filledBySlug, setFilledBySlug] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.helpWantedRole.fill(
        projectSlug,
        roleId,
        filledBySlug.trim() || null,
      );
      await queryClient.invalidateQueries({ queryKey: ['project', projectSlug] });
      await queryClient.invalidateQueries({
        queryKey: ['project-help-wanted', projectSlug],
      });
      toast.success(`Marked "${roleTitle}" as filled`);
      setFilledBySlug('');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to mark filled');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Mark role filled</DialogTitle>
            <DialogDescription>
              Mark <strong>{roleTitle}</strong> as filled. Optionally specify the
              person who filled it — they'll be added as a project member if not
              already on the project.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2">
            <Label htmlFor="filled-by">Filled by (optional)</Label>
            <Input
              id="filled-by"
              value={filledBySlug}
              onChange={(e) => setFilledBySlug(e.target.value)}
              placeholder="e.g. chris"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to mark filled without attribution.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Mark filled'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
