import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';

export function LoadingPanel({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border p-6"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
        {label}
      </p>
    </div>
  );
}

export function ErrorPanel({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border p-6"
      style={{
        backgroundColor: 'var(--error-tint)',
        borderColor: 'var(--error)',
      }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--error)' }}>
        {title}
      </p>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-primary)' }}>
        {detail}
      </p>
      {onRetry && (
        <Button type="button" onClick={onRetry} className="mt-4" variant="outline">
          Retry request
        </Button>
      )}
    </div>
  );
}

export function EmptyPanel({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="rounded-md border p-6"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h2>
      <p className="mt-1 max-w-xl text-sm" style={{ color: 'var(--text-secondary)' }}>
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Modal built on the shadcn Dialog: Esc closes, focus is trapped and returned to the trigger. */
export function ModalDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <div
          className="flex items-center justify-between gap-4 border-b px-5 py-4"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <DialogTitle>{title}</DialogTitle>
          <DialogClose render={<Button variant="outline" aria-label={`Close ${title}`} />}>
            Close
          </DialogClose>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
