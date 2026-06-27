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
import { api, ApiError, type ProjectDetail } from '@/lib/api';
import { PersonAvatar } from '@/components/PersonAvatar';

interface ManageMembersModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectDetail;
}

export function ManageMembersModal({ open, onOpenChange, project }: ManageMembersModalProps) {
  const queryClient = useQueryClient();
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<Record<string, string>>({});

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['project', project.slug] });

  const handleRemove = async (personSlug: string, rowKey: string) => {
    if (!window.confirm(`Remove ${personSlug} from this project?`)) return;
    setBusySlug(rowKey);
    try {
      await api.projects.removeMember(project.slug, personSlug);
      toast.success(`Removed ${personSlug}`);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cannot_remove_maintainer') {
        toast.error('Transfer maintainer first');
      } else if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error('Remove failed');
      }
    } finally {
      setBusySlug(null);
    }
  };

  const handleChangeMaintainer = async (personSlug: string, rowKey: string) => {
    if (!window.confirm(`Make ${personSlug} the maintainer? You'll become a regular member.`)) return;
    setBusySlug(rowKey);
    try {
      await api.projects.changeMaintainer(project.slug, personSlug);
      toast.success(`Maintainer transferred to ${personSlug}`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Transfer failed');
    } finally {
      setBusySlug(null);
    }
  };

  const handleSaveRole = async (rowKey: string, personSlug: string) => {
    const role = editingRole[rowKey];
    if (role === undefined) return;
    setBusySlug(rowKey);
    try {
      await api.projects.updateMember(project.slug, personSlug, {
        role: role.trim() || null,
      });
      toast.success('Role updated');
      setEditingRole((m) => {
        const next = { ...m };
        delete next[rowKey];
        return next;
      });
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Update failed');
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage Members</DialogTitle>
          <DialogDescription>
            Edit roles, transfer maintainer, or remove members.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <ul className="divide-y divide-border">
            {project.memberships.map((m) => {
              // Use membership ID as the stable row key.
              // person.slug may be null for deactivated members (placeholder shape).
              const rowKey = m.id;
              const personSlug = m.person.slug;
              const isEditingThisRow = editingRole[rowKey] !== undefined;
              return (
                <li key={m.id} className="py-3 flex items-center gap-3">
                  <PersonAvatar person={m.person} size={32} asLink={false} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{m.person.fullName}</div>
                    {isEditingThisRow ? (
                      <Input
                        value={editingRole[rowKey] ?? ''}
                        onChange={(e) =>
                          setEditingRole((r) => ({ ...r, [rowKey]: e.target.value }))
                        }
                        placeholder="Role"
                        className="h-7 mt-1 text-xs"
                      />
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        {m.role ?? <em>No role</em>}
                        {m.isMaintainer && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-primary/15 text-primary px-1.5 py-0.5">
                            Maintainer
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {/* Deactivated members: no edit actions available. */}
                    {m.person.deactivated ? (
                      <span className="text-xs text-muted-foreground italic">Deactivated</span>
                    ) : isEditingThisRow ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => personSlug && handleSaveRole(rowKey, personSlug)}
                          disabled={busySlug === rowKey}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setEditingRole((r) => {
                              const next = { ...r };
                              delete next[rowKey];
                              return next;
                            })
                          }
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setEditingRole((r) => ({ ...r, [rowKey]: m.role ?? '' }))
                          }
                        >
                          Edit role
                        </Button>
                        {!m.isMaintainer && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => personSlug && handleChangeMaintainer(personSlug, rowKey)}
                            disabled={busySlug === rowKey}
                          >
                            Make maintainer
                          </Button>
                        )}
                        {!m.isMaintainer && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => personSlug && handleRemove(personSlug, rowKey)}
                            disabled={busySlug === rowKey}
                            className="text-destructive hover:text-destructive"
                          >
                            Remove
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
