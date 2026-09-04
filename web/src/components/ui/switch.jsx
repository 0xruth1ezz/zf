import { Switch as AriaSwitch } from 'react-aria-components';
import { cn } from '../../lib/utils';

export function Switch({ children, className, ...props }) {
  return (
    <AriaSwitch
      {...props}
      className={cn(
        'group inline-flex min-h-9 cursor-default items-center gap-2 text-sm font-medium text-foreground outline-none disabled:opacity-50',
        className,
      )}
    >
      <span className="relative h-5 w-9 shrink-0 rounded-full border border-input bg-muted shadow-inner transition-colors group-selected:border-primary group-selected:bg-primary group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background">
        <span className="absolute top-0.5 left-0.5 size-3.5 rounded-full bg-background shadow-xs transition-transform group-selected:translate-x-4" />
      </span>
      <span>{children}</span>
    </AriaSwitch>
  );
}
