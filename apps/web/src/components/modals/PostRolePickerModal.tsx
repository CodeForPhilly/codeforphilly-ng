import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';

interface PostRolePickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PostRolePickerModal({ open, onOpenChange }: PostRolePickerModalProps) {
  const { person } = useAuth();
  const navigate = useNavigate();

  // Staff/admin can post on any project; everyone else only on the ones they
  // maintain. Fetch the most relevant slice for the picker.
  const isStaff =
    person?.accountLevel === 'staff' || person?.accountLevel === 'administrator';

  const projectsQ = useQuery({
    queryKey: ['post-role-picker', person?.slug, isStaff],
    queryFn: () => {
      if (isStaff) return api.projects.list({ perPage: 50, sort: '-updatedAt' });
      return api.projects.list({ maintainer: person!.slug, perPage: 50 });
    },
    enabled: open && !!person,
  });

  const projects = projectsQ.data?.data ?? [];

  const handlePick = (slug: string) => {
    onOpenChange(false);
    void navigate(`/projects/${slug}?openModal=help-wanted`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post a help-wanted role</DialogTitle>
          <DialogDescription>
            Pick a project to post the role under. You'll see the post-role form on
            that project's page.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4 max-h-96 overflow-auto">
          {projectsQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading projects…</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You don't maintain any projects yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {projects.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    className="w-full text-left py-2 px-3 hover:bg-accent rounded"
                    onClick={() => handlePick(p.slug)}
                  >
                    <div className="font-medium">{p.title}</div>
                    {p.summary && (
                      <div className="text-xs text-muted-foreground truncate">
                        {p.summary}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
