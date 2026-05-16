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

interface AddMemberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
}

export function AddMemberModal({ open, onOpenChange, projectSlug }: AddMemberModalProps) {
  const queryClient = useQueryClient();
  const [personSlug, setPersonSlug] = useState('');
  const [role, setRole] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const reset = () => {
    setPersonSlug('');
    setRole('');
    setFieldErrors({});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!personSlug.trim()) return;
    setSubmitting(true);
    setFieldErrors({});
    try {
      await api.projects.addMember(projectSlug, {
        personSlug: personSlug.trim(),
        role: role.trim() || null,
      });
      await queryClient.invalidateQueries({ queryKey: ['project', projectSlug] });
      toast.success(`Added ${personSlug.trim()}`);
      reset();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields);
        if (err.code === 'already_member') {
          setFieldErrors({ personSlug: 'Already a member' });
        }
        toast.error(err.message);
      } else {
        toast.error("Couldn't add member.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
            <DialogDescription>
              The person must already have an account on Code for Philly.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="member-slug">
                Member slug <span className="text-destructive">*</span>
              </Label>
              <Input
                id="member-slug"
                value={personSlug}
                onChange={(e) => setPersonSlug(e.target.value)}
                placeholder="e.g. chris"
                required
                aria-invalid={fieldErrors['personSlug'] ? 'true' : 'false'}
              />
              {fieldErrors['personSlug'] && (
                <p className="text-xs text-destructive">{fieldErrors['personSlug']}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="member-role">Role (optional)</Label>
              <Input
                id="member-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Backend Engineer"
                maxLength={80}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!personSlug.trim() || submitting}>
              {submitting ? 'Adding…' : 'Add member'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
