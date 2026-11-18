import * as React from 'react';
import { cn } from '@/lib/utils';
import { fieldClasses } from '@/components/ui/input';

// The platform <select> keeps its own keyboard and mobile pickers; only the box is styled.
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return <select data-slot="native-select" className={cn(fieldClasses, className)} {...props} />;
}

export { NativeSelect };
