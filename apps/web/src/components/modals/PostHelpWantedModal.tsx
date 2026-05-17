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
import { MarkdownEditor } from '@/components/MarkdownEditor';
import { TagPicker } from '@/components/TagPicker';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

interface PostHelpWantedModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
}

export function PostHelpWantedModal({
  open,
  onOpenChange,
  projectSlug,
}: PostHelpWantedModalProps) {
  const queryClient = useQueryClient();
  const { person } = useAuth();
  const isStaff =
    person?.accountLevel === 'staff' || person?.accountLevel === 'administrator';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [hours, setHours] = useState<string>('');
  const [tagsTopic, setTagsTopic] = useState<string[]>([]);
  const [tagsTech, setTagsTech] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const reset = () => {
    setTitle('');
    setDescription('');
    setHours('');
    setTagsTopic([]);
    setTagsTech([]);
    setFieldErrors({});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    try {
      await api.projects.postHelpWanted(projectSlug, {
        title: title.trim(),
        description,
        commitmentHoursPerWeek: hours ? Number.parseInt(hours, 10) : null,
        tags: { topic: tagsTopic, tech: tagsTech },
      });
      await queryClient.invalidateQueries({
        queryKey: ['project-help-wanted', projectSlug],
      });
      await queryClient.invalidateQueries({ queryKey: ['help-wanted-index'] });
      toast.success('Help-wanted role posted');
      reset();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(err.fields);
        toast.error(err.message);
      } else {
        toast.error("Couldn't post role.");
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
            <DialogTitle>Post Help-Wanted Role</DialogTitle>
            <DialogDescription>
              Describe a concrete, time-boxed way someone can contribute.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="hw-title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="hw-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                required
                placeholder="e.g. React developer for admin dashboard"
              />
              {fieldErrors['title'] && (
                <p className="text-xs text-destructive">{fieldErrors['title']}</p>
              )}
            </div>
            <MarkdownEditor
              label="Description"
              value={description}
              onChange={setDescription}
              maxLength={4_000}
              error={fieldErrors['description']}
              required
            />
            <div className="space-y-1.5">
              <Label htmlFor="hw-hours">Commitment (hours / week)</Label>
              <Input
                id="hw-hours"
                type="number"
                min={0}
                max={40}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="Leave blank for flexible"
                className="w-40"
              />
            </div>
            <TagPicker
              namespace="topic"
              label="Topic tags"
              value={tagsTopic}
              onChange={setTagsTopic}
              allowCreate={isStaff}
            />
            <TagPicker
              namespace="tech"
              label="Tech tags"
              value={tagsTech}
              onChange={setTagsTech}
              allowCreate={isStaff}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || !description.trim() || submitting}>
              {submitting ? 'Posting…' : 'Post role'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
