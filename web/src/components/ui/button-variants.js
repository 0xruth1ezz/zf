import { cva } from 'class-variance-authority';

export const buttonVariants = cva(
  'inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold outline-none transition-[background-color,color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 pressed:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/75',
        outline: 'border border-border bg-background hover:bg-muted hover:text-foreground',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        destructive: 'border border-destructive/35 bg-background text-destructive hover:bg-destructive/8',
      },
      size: {
        default: 'h-9',
        sm: 'h-8 min-h-8 px-2.5 text-xs',
        icon: 'size-9 min-h-9 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);
