import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { TaskRunDTO } from '@dalang/shared';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function TaskSteering({ run }: { run: TaskRunDTO }) {
  const { t } = useI18n();
  const inputId = useId();
  const [message, setMessage] = useState('');
  const steering = useMutation({
    mutationFn: (text: string) => api.steerTask(run.projectId, run.taskId, run.id, text),
    onSuccess: () => setMessage(''),
  });

  return (
    <form className="mt-3 space-y-2" onSubmit={(event) => {
      event.preventDefault();
      if (message.trim() && !steering.isPending) steering.mutate(message.trim());
    }}>
      <Label htmlFor={inputId}>{t('work.steerLabel')}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={inputId} className="min-w-0 flex-1" maxLength={8000} value={message}
          disabled={steering.isPending} onChange={(event) => setMessage(event.target.value)} />
        <Button type="submit" variant="outline" disabled={!message.trim() || steering.isPending}>
          {t('work.steerSend')}
        </Button>
      </div>
      {steering.isError && <p className="text-sm text-destructive" role="alert">{steering.error.message}</p>}
      {steering.isSuccess && !message && <p className="text-sm text-muted-foreground" role="status">{t('work.steerSent')}</p>}
    </form>
  );
}
