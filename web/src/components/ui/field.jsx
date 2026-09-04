import {
  FieldError,
  Input as AriaInput,
  Label,
  TextField,
} from 'react-aria-components';
import { cn } from '../../lib/utils';

export function Field({ label, description, className, inputClassName, ...props }) {
  return (
    <TextField {...props} className={cn('group grid min-w-0 gap-1.5', className)}>
      <Label className="text-xs font-semibold text-muted-foreground">{label}</Label>
      <AriaInput
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
