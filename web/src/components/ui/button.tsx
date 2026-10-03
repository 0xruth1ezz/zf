import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { buttonVariants } from './button-variants';

type ButtonProps = AriaButtonProps & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <AriaButton
      {...props}
      className={(state) => cn(
        buttonVariants({ variant, size }),
        typeof className === 'function' ? className(state) : className,
      )}
    />
  );
}
