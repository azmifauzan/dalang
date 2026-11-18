import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// 44px minimum target, 6px radius, 140ms colour change only (docs/DESIGN.md).
const buttonVariants = cva(
  'inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[6px] border px-4 text-[0.9375rem] font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border-primary bg-primary font-semibold text-primary-foreground hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)]',
        outline: 'border-input bg-card text-foreground hover:bg-muted',
        destructive: 'border-destructive bg-card text-destructive hover:bg-muted',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Button({
  className,
  variant,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
