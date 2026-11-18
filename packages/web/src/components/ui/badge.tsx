import * as React from 'react';
import { cn } from '@/lib/utils';

// Rectangular monospace "stamp" for IDs, versions, and states; no pills, no dots (docs/DESIGN.md).
function Badge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[4px] border border-border bg-muted px-2 py-0.5 font-mono-token text-xs font-semibold whitespace-nowrap text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
