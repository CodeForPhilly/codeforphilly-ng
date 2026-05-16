import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import type { PersonAvatar as PersonAvatarType } from '@/lib/api';

interface PersonAvatarProps {
  person: PersonAvatarType;
  size?: number;
  asLink?: boolean;
  className?: string;
  title?: string;
}

export function PersonAvatar({ person, size = 32, asLink = true, className, title }: PersonAvatarProps) {
  const letter = person.fullName.charAt(0).toUpperCase();
  const inner = person.avatarUrl ? (
    <img
      src={person.avatarUrl}
      alt={person.fullName}
      width={size}
      height={size}
      className={cn('rounded-full object-cover bg-muted', className)}
      title={title ?? person.fullName}
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      title={title ?? person.fullName}
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground font-medium',
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-label={person.fullName}
    >
      {letter}
    </span>
  );

  if (!asLink) return inner;

  return (
    <Link to={`/members/${person.slug}`} aria-label={person.fullName}>
      {inner}
    </Link>
  );
}
