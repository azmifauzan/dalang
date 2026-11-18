import * as React from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@/lib/utils';

export const fieldClasses =
  'min-h-11 w-full min-w-0 rounded-[4px] border border-input bg-card px-3 py-2 text-[0.9375rem] text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(fieldClasses, className)}
      {...props}
    />
  );
}

export { Input };
