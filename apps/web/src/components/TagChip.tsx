import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import type { TagItem } from '@/lib/api';

const NAMESPACE_CLASSES: Record<string, string> = {
  topic: 'bg-purple-100 text-purple-900 border-purple-300 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-200 dark:border-purple-800',
  tech: 'bg-cyan-100 text-cyan-900 border-cyan-300 hover:bg-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-200 dark:border-cyan-800',
  event: 'bg-orange-100 text-orange-900 border-orange-300 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-200 dark:border-orange-800',
};

interface TagChipProps {
  tag: Pick<TagItem, 'namespace' | 'slug' | 'title'>;
  count?: number;
  showNamespace?: boolean;
  active?: boolean;
  asLink?: boolean;
  onClick?: () => void;
  className?: string;
}

export function TagChip({ tag, count, showNamespace = false, active = false, asLink = true, onClick, className }: TagChipProps) {
  const nsClass = NAMESPACE_CLASSES[tag.namespace] ?? NAMESPACE_CLASSES['topic']!;
  const display = showNamespace ? `${tag.namespace} · ${tag.title}` : tag.title;
  const inner = (
    <>
      <span>{display}</span>
      {count !== undefined && (
        <span className="ml-1.5 text-xs opacity-70">{count}</span>
      )}
    </>
  );
  const classes = cn(
    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
    nsClass,
    active && 'ring-2 ring-primary ring-offset-1',
    className,
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {inner}
      </button>
    );
  }

  if (asLink) {
    return (
      <Link to={`/tags/${tag.namespace}/${tag.slug}`} className={classes}>
        {inner}
      </Link>
    );
  }

  return <span className={classes}>{inner}</span>;
}
