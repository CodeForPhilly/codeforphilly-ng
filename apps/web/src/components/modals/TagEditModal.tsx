import { useState } from 'react';
import { useNavigate } from 'react-router';
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
import { api, ApiError, type TagResponse } from '@/lib/api';

interface TagEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tag: TagResponse;
  mode: 'edit' | 'merge';
}

export function TagEditModal({ open, onOpenChange, tag, mode }: TagEditModalProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState(tag.title);
  const [mergeInto, setMergeInto] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    try {
      if (mode === 'edit') {
        await api.tags.update(tag.handle, { title });
        await queryClient.invalidateQueries({ queryKey: ['tag', tag.handle] });
        toast.success('Tag updated');
      } else {
        const target = mergeInto.trim();
        await api.tags.update(tag.handle, { mergeInto: target });
        toast.success(`Merged ${tag.handle} → ${target}`);
        await queryClient.invalidateQueries({ queryKey: ['tags'] });
        void navigate(`/tags/${target.replace('.', '/')}`);
      }
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields);
        toast.error(err.message);
      } else {
        toast.error('Update failed');
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
            <DialogTitle>
              {mode === 'edit' ? `Edit ${tag.handle}` : `Merge ${tag.handle} into…`}
            </DialogTitle>
            <DialogDescription>
              {mode === 'edit'
                ? 'Change the display title for this tag. The slug stays the same.'
                : 'Move every project and member tagged here onto the target tag. This is irreversible.'}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-3">
            {mode === 'edit' ? (
              <div className="space-y-1.5">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={80}
                  required
                />
                {fieldErrors['title'] && (
                  <p className="text-xs text-destructive">{fieldErrors['title']}</p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="mergeInto">Merge into (handle)</Label>
                <Input
                  id="mergeInto"
                  value={mergeInto}
                  onChange={(e) => setMergeInto(e.target.value)}
                  placeholder="e.g. tech.flutter"
                  required
                />
                {fieldErrors['mergeInto'] && (
                  <p className="text-xs text-destructive">{fieldErrors['mergeInto']}</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || (mode === 'edit' ? !title.trim() : !mergeInto.trim())}
              variant={mode === 'merge' ? 'destructive' : 'default'}
            >
              {submitting ? 'Saving…' : mode === 'edit' ? 'Save' : 'Merge'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
