import {
  Cell,
  Column,
  Row,
  Table as AriaTable,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { cn } from '../../lib/utils';

export function Table({ className, ...props }) {
  return <AriaTable className={cn('w-full border-separate border-spacing-0 text-sm outline-none', className)} {...props} />;
}

export function TableHeaderRow({ children }) {
  return (
    <TableHeader className="text-left text-xs font-semibold text-muted-foreground">
      {children}
    </TableHeader>
  );
}

export function TableColumn({ className, ...props }) {
  return (
    <Column
      className={cn(
        'h-10 border-b border-border bg-muted/65 px-3 outline-none first:rounded-tl-lg last:rounded-tr-lg',
        'data-[allows-sorting]:cursor-pointer data-[allows-sorting]:select-none data-[hovered]:bg-accent/60 data-[pressed]:bg-accent',
        'data-[focus-visible]:relative data-[focus-visible]:z-10 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-ring',
        'data-[sort-direction]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function TableRows({ className, ...props }) {
  return <TableBody className={className} {...props} />;
}

export function TableRow({ className, ...props }) {
  return (
    <Row
      className={cn('outline-none transition-colors hover:bg-muted/45 focus-visible:bg-accent/60', className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }) {
  return (
    <Cell
      className={cn('whitespace-nowrap border-b border-border px-3 py-3 align-middle text-foreground last:text-right', className)}
      {...props}
    />
  );
}
