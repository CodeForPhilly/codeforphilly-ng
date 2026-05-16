import { Link } from 'react-router';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (!items.length) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="container mx-auto px-4 py-2 print:hidden"
    >
      <ol className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={item.label} className="flex items-center gap-1">
              {index > 0 && (
                <span aria-hidden="true" className="text-muted-foreground/50">
                  &rsaquo;
                </span>
              )}
              {isLast || !item.href ? (
                <span aria-current={isLast ? 'page' : undefined} className={isLast ? 'text-foreground' : ''}>
                  {item.label}
                </span>
              ) : (
                <Link to={item.href} className="hover:text-foreground transition-colors">
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
