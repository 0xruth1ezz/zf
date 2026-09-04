import { ChevronDown, Check } from 'lucide-react';
import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
} from 'react-aria-components';
import { cn } from '../../lib/utils';

export function Select({ label, className, children, ...props }) {
  return (
    <AriaSelect {...props} className={cn('group grid min-w-0 gap-1.5', className)}>
      <Label className="text-xs font-semibold text-muted-foreground">{label}</Label>
      <Button className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] hover:border-ring/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15">
        <SelectValue className="min-w-0 flex-1 truncate" />
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Button>
      <Popover className="z-popover min-w-(--trigger-width) overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md entering:animate-in entering:fade-in entering:zoom-in-95 exiting:animate-out exiting:fade-out">
        <ListBox className="max-h-72 outline-none">{children}</ListBox>
      </Popover>
    </AriaSelect>
  );
}

export function SelectItem({ children, className, ...props }) {
  return (
    <ListBoxItem
      {...props}
      className={cn(
        'group/item relative flex min-h-8 cursor-default select-none items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground selected:bg-accent selected:text-accent-foreground disabled:opacity-50',
        className,
      )}
    >
      {({ isSelected }) => (
        <>
          <span className="truncate">{children}</span>
          {isSelected ? <Check aria-hidden="true" className="absolute right-2 size-4" /> : null}
        </>
      )}
    </ListBoxItem>
  );
}
