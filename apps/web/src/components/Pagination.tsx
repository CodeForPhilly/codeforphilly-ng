import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  siblingCount?: number;
  className?: string;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

function buildPages(page: number, totalPages: number, siblingCount: number): Array<number | 'ellipsis'> {
  const total = totalPages;
  const totalShown = siblingCount * 2 + 5;
  if (total <= totalShown) return range(1, total);

  const leftSibling = Math.max(page - siblingCount, 1);
  const rightSibling = Math.min(page + siblingCount, total);

  const showLeftDots = leftSibling > 2;
  const showRightDots = rightSibling < total - 1;

  const result: Array<number | 'ellipsis'> = [1];
  if (showLeftDots) result.push('ellipsis');
  for (const p of range(Math.max(2, leftSibling), Math.min(total - 1, rightSibling))) {
    result.push(p);
  }
  if (showRightDots) result.push('ellipsis');
  result.push(total);
  return result;
}

export function Pagination({ page, totalPages, onPageChange, siblingCount = 1, className }: PaginationProps) {
  if (totalPages <= 1) return null;
  const pages = buildPages(page, totalPages, siblingCount);

  return (
    <nav aria-label="Pagination" className={cn('flex items-center justify-center gap-1 mt-6', className)}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        Previous
      </Button>
      {pages.map((p, idx) =>
        p === 'ellipsis' ? (
          <span key={`e-${idx}`} className="px-2 text-muted-foreground" aria-hidden>
            …
          </span>
        ) : (
          <Button
            key={p}
            variant={p === page ? 'default' : 'outline'}
            size="sm"
            onClick={() => onPageChange(p)}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </Button>
        ),
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label="Next page"
      >
        Next
      </Button>
    </nav>
  );
}
