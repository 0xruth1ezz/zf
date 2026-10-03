import type { ReactNode } from 'react';
import {
  FieldError,
  Input as AriaInput,
  Label,
  TextField,
  type TextFieldProps,
} from 'react-aria-components';
import { cn } from '../../lib/utils';

interface FieldProps extends Omit<TextFieldProps, 'className' | 'children'> {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
}

export function Field({ label, description, className, inputClassName, placeholder, ...props }: FieldProps) {
  return (
    <TextField {...props} className={cn('group grid min-w-0 gap-1.5', className)}>
      <Label className="text-xs font-semibold text-muted-foreground">{label}</Label>
      <AriaInput
        placeholder={placeholder}
        className={cn(
          'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 hover:border-ring/50 focus:border-ring focus:ring-2 focus:ring-ring/15 invalid:border-destructive',
          inputClassName,
        )}
      />
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <FieldError className="text-xs font-medium text-destructive" />
    </TextField>
  );
}
