import { X } from 'lucide-react';
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import { cn } from '../../lib/utils';
import { Button } from './button';

export { DialogTrigger };

export function Dialog({ title, description, children, className, ...props }) {
  return (
    <ModalOverlay
      {...props}
      className="z-modal-backdrop fixed inset-0 flex min-h-full items-center justify-center overflow-y-auto bg-foreground/22 p-4 backdrop-blur-[2px] entering:animate-in entering:fade-in exiting:animate-out exiting:fade-out"
    >
      <Modal className="z-modal w-full max-w-md rounded-lg bg-background text-foreground shadow-xl outline-none entering:animate-in entering:fade-in entering:zoom-in-95 exiting:animate-out exiting:fade-out exiting:zoom-out-95">
        <AriaDialog className={cn('relative grid gap-5 p-5 outline-none', className)}>
          {({ close }) => (
            <>
              <div className="pr-9">
                <Heading slot="title" className="text-base font-semibold tracking-tight">
                  {title}
                </Heading>
                {description ? <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{description}</p> : null}
              </div>
              <Button
                aria-label="Close dialog"
                className="absolute top-3 right-3"
                onPress={close}
                size="icon"
                variant="ghost"
              >
                <X />
              </Button>
              {typeof children === 'function' ? children({ close }) : children}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
