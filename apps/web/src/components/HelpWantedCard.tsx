import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { TagChip } from '@/components/TagChip';
import { PersonAvatar } from '@/components/PersonAvatar';
import { MarkdownView } from '@/components/MarkdownView';
import { ExpressInterestModal } from '@/components/modals/ExpressInterestModal';
import { useAuth } from '@/hooks/useAuth';
import { formatRelativeTime } from '@/lib/time';
import type { HelpWantedRoleResponse } from '@/lib/api';

interface HelpWantedCardProps {
  role: HelpWantedRoleResponse;
  showProjectLink?: boolean;
}

function commitmentLabel(hours: number | null): string {
  if (hours === null) return 'Flexible commitment';
  return `~${hours} hrs/week`;
}

export function HelpWantedCard({ role, showProjectLink = true }: HelpWantedCardProps) {
  const { person } = useAuth();
  const isSignedIn = person !== null;
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      {showProjectLink && (
        <div className="flex items-center justify-between mb-2">
          <Link to={`/projects/${role.project.slug}`} className="text-sm text-muted-foreground hover:text-primary">
            {role.project.title}
          </Link>
          <span className="inline-flex items-center rounded-full bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200 px-2 py-0.5 text-xs font-medium">
            Help Wanted
          </span>
        </div>
      )}

      <h3 className="text-lg font-semibold mb-2">{role.title}</h3>

      <div className="line-clamp-4 mb-3 text-sm">
        <MarkdownView html={role.descriptionHtml} />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs">
          {commitmentLabel(role.commitmentHoursPerWeek)}
        </span>
        {role.tags.tech.map((t) => (
          <TagChip key={`tech.${t.slug}`} tag={t} />
        ))}
        {role.tags.topic.map((t) => (
          <TagChip key={`topic.${t.slug}`} tag={t} />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {role.postedBy && (
            <>
              <PersonAvatar person={role.postedBy} size={20} />
              <span>{role.postedBy.fullName}</span>
              <span>·</span>
            </>
          )}
          <span>posted {formatRelativeTime(role.createdAt)}</span>
        </div>

        {isSignedIn ? (
          role.permissions.alreadyExpressedInterest ? (
            <Button size="sm" variant="outline" disabled>
              Interest Sent ✓
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!role.permissions.canExpressInterest}
              onClick={() => setModalOpen(true)}
            >
              Express Interest
            </Button>
          )
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link to={`/login?return=${encodeURIComponent(`/projects/${role.project.slug}`)}`}>
              Sign in to express interest
            </Link>
          </Button>
        )}
      </div>
      <ExpressInterestModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        projectSlug={role.project.slug}
        roleId={role.id}
        roleTitle={role.title}
      />
    </article>
  );
}
