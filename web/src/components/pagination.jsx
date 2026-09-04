import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';

export function Pagination({ label, page, pageSize, total, onPageChange }) {
  if (total <= pageSize) return null;
  const pageCount = Math.ceil(total / pageSize);
  const current = Math.min(page, pageCount - 1);
  const start = current * pageSize;
  const end = Math.min(start + pageSize, total);

  return (
    <nav aria-label={`${label} pagination`} className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>{start + 1}–{end} of {total}</span>
      <div className="flex items-center gap-2">
        <Button aria-label="Previous page" isDisabled={current === 0} onPress={() => onPageChange(current - 1)} size="icon" variant="outline">
          <ChevronLeft />
        </Button>
        <span className="min-w-20 text-center">Page {current + 1} of {pageCount}</span>
        <Button aria-label="Next page" isDisabled={current >= pageCount - 1} onPress={() => onPageChange(current + 1)} size="icon" variant="outline">
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}
