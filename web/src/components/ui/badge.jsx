import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex min-h-5.5 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold leading-none ring-1 ring-inset',
  {
    variants: {
      variant: {
        neutral: 'bg-muted text-muted-foreground ring-border',
        success: 'bg-success/10 text-success ring-success/20',
        info: 'bg-info/10 text-info ring-info/20',
        danger: 'bg-destructive/10 text-destructive ring-destructive/20',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
