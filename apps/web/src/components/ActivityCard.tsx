import { Link } from 'react-router';
import { MarkdownView } from '@/components/MarkdownView';
import { PersonAvatar } from '@/components/PersonAvatar';
import { formatRelativeTime, formatAbsoluteDate } from '@/lib/time';
import type { ProjectUpdateResponse, ProjectBuzzResponse } from '@/lib/api';

export type ActivityItem =
  | { kind: 'update'; data: ProjectUpdateResponse }
  | { kind: 'buzz'; data: ProjectBuzzResponse };

interface ActivityCardProps {
  item: ActivityItem;
}

export function ActivityCard({ item }: ActivityCardProps) {
  if (item.kind === 'update') return <UpdateCard update={item.data} />;
  return <BuzzCard buzz={item.data} />;
}

function UpdateCard({ update }: { update: ProjectUpdateResponse }) {
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2 text-sm">
        <div className="text-muted-foreground">
          <Link to={`/projects/${update.project.slug}`} className="hover:text-primary font-medium">
            {update.project.title}
          </Link>
          <span> · </span>
          <Link
            to={`/projects/${update.project.slug}/updates/${update.number}`}
            className="hover:text-primary"
          >
            Update #{update.number}
          </Link>
        </div>
        <span title={formatAbsoluteDate(update.createdAt)} className="text-xs text-muted-foreground">
          {formatRelativeTime(update.createdAt)}
        </span>
      </div>

      {update.author && (
        <div className="flex items-center gap-2 mb-2 text-xs">
          <PersonAvatar person={update.author} size={20} />
          <Link to={`/members/${update.author.slug}`} className="text-muted-foreground hover:text-primary">
            {update.author.fullName}
          </Link>
        </div>
      )}

      <div className="line-clamp-5">
        <MarkdownView html={update.bodyHtml} />
      </div>
    </article>
  );
}

function BuzzCard({ buzz }: { buzz: ProjectBuzzResponse }) {
  let hostname: string;
  try {
    hostname = new URL(buzz.url).hostname;
  } catch {
    hostname = buzz.url;
  }
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2 text-sm text-muted-foreground">
        <span>
          <Link to={`/projects/${buzz.project.slug}`} className="hover:text-primary font-medium">
            {buzz.project.title}
          </Link>
          <span> · Buzz · </span>
          <span title={formatAbsoluteDate(buzz.publishedAt)}>
            {formatAbsoluteDate(buzz.publishedAt, { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </span>
      </div>

      <div className="flex gap-3">
        {buzz.imageUrl && (
          <img
            src={buzz.imageUrl}
            alt=""
            width={96}
            height={96}
            className="rounded object-cover shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold mb-0.5">
            <a href={buzz.url} target="_blank" rel="noopener noreferrer" className="hover:text-primary">
              {buzz.headline}
            </a>
          </h3>
          <p className="text-xs text-muted-foreground mb-2">{hostname}</p>
          {buzz.summaryHtml && (
            <div className="line-clamp-3 text-sm">
              <MarkdownView html={buzz.summaryHtml} />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 pt-2 border-t border-border text-xs text-muted-foreground">
        {buzz.postedBy && (
          <span>
            Logged by{' '}
            <Link to={`/members/${buzz.postedBy.slug}`} className="hover:text-primary">
              {buzz.postedBy.fullName}
            </Link>
          </span>
        )}
        <Link to={`/projects/${buzz.project.slug}/buzz/${buzz.slug}`} className="hover:text-primary">
          View on site
        </Link>
      </div>
    </article>
  );
}

/** Merge update + buzz arrays into a single reverse-chronological feed. */
export function mergeActivity(
  updates: ProjectUpdateResponse[],
  buzz: ProjectBuzzResponse[],
  limit?: number,
): ActivityItem[] {
  const items: Array<{ item: ActivityItem; sortKey: string }> = [
    ...updates.map((u) => ({
      item: { kind: 'update' as const, data: u },
      sortKey: u.createdAt,
    })),
    ...buzz.map((b) => ({
      item: { kind: 'buzz' as const, data: b },
      sortKey: b.publishedAt,
    })),
  ];
  items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  const merged = items.map((x) => x.item);
  return limit ? merged.slice(0, limit) : merged;
}
