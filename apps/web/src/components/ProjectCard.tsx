import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { StageBadge } from '@/components/StageBadge';
import { TagChip } from '@/components/TagChip';
import { PersonAvatar } from '@/components/PersonAvatar';
import type { ProjectListItem } from '@/lib/api';

interface ProjectCardProps {
  project: ProjectListItem;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const summary = project.summary || project.overviewExcerpt;
  const visibleTags = project.tags.slice(0, 5);
  const extraTagCount = project.tags.length - visibleTags.length;

  return (
    <article className="rounded-lg border border-border bg-card p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h2 className="text-lg font-semibold leading-tight">
          <Link to={`/projects/${project.slug}`} className="hover:text-primary transition-colors">
            {project.title}
          </Link>
        </h2>
        <StageBadge stage={project.stage} />
      </div>

      {summary && (
        <p className="text-sm text-muted-foreground mb-3 line-clamp-3">{summary}</p>
      )}

      {project.members.length > 0 && (
        <div className="flex items-center -space-x-2 mb-3">
          {project.members.slice(0, 8).map((m) => {
            const isMaintainer = m.slug === project.maintainer?.slug;
            return (
              <div key={m.slug} className="ring-2 ring-card rounded-full" title={m.fullName}>
                <PersonAvatar person={m} size={isMaintainer ? 36 : 28} />
              </div>
            );
          })}
          {project.memberCount > 8 && (
            <span className="ml-3 text-xs text-muted-foreground">+{project.memberCount - 8} more</span>
          )}
        </div>
      )}

      {visibleTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {visibleTags.map((t) => (
            <TagChip key={`${t.namespace}.${t.slug}`} tag={t} showNamespace />
          ))}
          {extraTagCount > 0 && (
            <span className="text-xs text-muted-foreground self-center">+{extraTagCount} more</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        {project.links.usersUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={project.links.usersUrl} target="_blank" rel="noopener noreferrer">
              Public Site
            </a>
          </Button>
        )}
        {project.links.developersUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={project.links.developersUrl} target="_blank" rel="noopener noreferrer">
              Developers
            </a>
          </Button>
        )}
        {project.links.chatChannel && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/chat?channel=${encodeURIComponent(project.links.chatChannel)}`}>Chat</Link>
          </Button>
        )}
        {project.openHelpWantedCount > 0 && (
          <Link
            to={`/projects/${project.slug}#help-wanted`}
            className="inline-flex items-center rounded-full bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200 px-2.5 py-0.5 text-xs font-medium hover:bg-yellow-200 transition-colors"
          >
            Help wanted ({project.openHelpWantedCount})
          </Link>
        )}
      </div>
    </article>
  );
}
