import { Link } from 'react-router';
import { TagChip } from '@/components/TagChip';
import { PersonAvatar } from '@/components/PersonAvatar';
import type { PersonListItem } from '@/lib/api';

interface PersonCardProps {
  person: PersonListItem;
}

export function PersonCard({ person }: PersonCardProps) {
  return (
    // The whole card used to be one <a>, so its accessible name was the
    // avatar's title plus the name plus the project count plus every tag
    // chip, read as one run-on string. Follow the ProjectCard idiom instead:
    // an <article> whose heading wraps the only link, named by the person.
    // A stretched pseudo-element keeps the entire card clickable — safe here
    // because the avatar and chips are deliberately non-interactive.
    <article className="relative rounded-lg border border-border bg-card p-4 hover:shadow-md hover:-translate-y-0.5 transition-all">
      <div className="flex flex-col items-center text-center">
        <PersonAvatar person={{ slug: person.slug, fullName: person.fullName, avatarUrl: person.avatarUrl }} size={80} asLink={false} className="rounded-lg" />
        <h3 className="mt-3 font-semibold text-foreground">
          <Link
            to={`/members/${person.slug}`}
            className="after:absolute after:inset-0 after:rounded-lg hover:text-primary transition-colors"
          >
            {person.fullName}
          </Link>
        </h3>
        {person.memberOfCount > 0 && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Member of {person.memberOfCount} project{person.memberOfCount === 1 ? '' : 's'}
          </p>
        )}
        {person.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 justify-center">
            {person.tags.slice(0, 3).map((t) => (
              <TagChip key={`${t.namespace}.${t.slug}`} tag={t} asLink={false} className="pointer-events-none" />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
