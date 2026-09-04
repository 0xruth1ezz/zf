import { Button as AriaButton } from 'react-aria-components';
import { cn } from '../../lib/utils';
import { buttonVariants } from './button-variants';

export function Button({ className, variant, size, ...props }) {
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
