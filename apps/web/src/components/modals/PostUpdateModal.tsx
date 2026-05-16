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
import { MarkdownEditor } from '@/components/MarkdownEditor';
import { api, ApiError } from '@/lib/api';

interface PostUpdateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
}

export function PostUpdateModal({ open, onOpenChange, projectSlug }: PostUpdateModalProps) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const reset = () => {
    setBody('');
    setFieldErrors({});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSubmitting(true);
    setFieldErrors({});
    try {
      await api.projects.postUpdate(projectSlug, { body });
      await queryClient.invalidateQueries({ queryKey: ['project-updates', projectSlug] });
      await queryClient.invalidateQueries({ queryKey: ['project', projectSlug] });
      toast.success('Update posted');
      reset();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields);
        toast.error(err.message);
      } else {
        toast.error("Couldn't post update.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-3xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Post Update</DialogTitle>
            <DialogDescription>
              Share progress, results, or news with everyone watching this project.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <MarkdownEditor
              value={body}
              onChange={setBody}
              placeholder="What's new with the project?"
              maxLength={20_000}
              error={fieldErrors['body']}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!body.trim() || submitting}>
              {submitting ? 'Posting…' : 'Post update'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
