import type { ReactNode, RefObject } from 'react';
import type {
  AskMessageContent,
  ChatImageMessage,
  DiscussMessageDTO,
  RoomReportContent,
  SessionMode,
  SessionSummaryDTO,
} from '@dalang/shared';
import { useI18n, type TranslationKey } from '../../i18n/index.js';
import { Markdown } from '../Markdown.js';
import { Button } from '@/components/ui/button';

/**
 * The conversation, the same in every mode: your messages on the right, the Lead's on the left, replies as
 * formatted text. A mode adds its own pieces through `renderCard` (a whole card in place of a bubble) and
 * `renderBody` (the inside of a bubble), and returns null to use the default.
 */
export function ChatTranscript({
  messages,
  session,
  lastReplyRef,
  onPromote,
  renderCard,
  renderBody,
  planApproval,
  scopeRequest,
}: {
  messages: DiscussMessageDTO[];
  session: SessionSummaryDTO | null;
  /** Attach to the newest message so a new reply can be scrolled to its first line. */
  lastReplyRef: RefObject<HTMLElement | null>;
  onPromote?: (mode: SessionMode) => void;
  renderCard?: (msg: DiscussMessageDTO) => ReactNode | null;
  renderBody?: (msg: DiscussMessageDTO) => ReactNode | null;
  /** A draft plan that waits for approval: its version gets an Approve button under its message. */
  planApproval?: { version: number; pending: boolean; error: string | null; onApprove: () => void };
  /** A failed task that asked for more files: its latest scope request gets an Allow button. */
  scopeRequest?: { messageId: string; pending: boolean; error: string | null; onAllow: () => void };
}) {
  const { t, formatTime } = useI18n();

  const refFor = (isLast: boolean) => (el: HTMLElement | null) => {
    if (isLast) lastReplyRef.current = el;
  };

  return (
    <div className="flex flex-col gap-3">
      {messages.map((msg, index) => {
        const isLast = index === messages.length - 1;
        const card = renderCard?.(msg) ?? null;
        if (card) {
          return (
            <div key={msg.id} ref={refFor(isLast)} className="scroll-mt-20">
              {card}
            </div>
          );
        }

        const isUser = msg.role === 'user';
        const isError = msg.type === 'error';
        const ask =
          msg.type === 'ask' && msg.content && typeof msg.content === 'object'
            ? (msg.content as AskMessageContent)
            : null;
        // A yes/no question that holds back Auto work until the user answers.
        const isQuestion = Boolean(ask && 'pendingAutoWork' in ask);
        const report =
          msg.type === 'report' && msg.content && typeof msg.content === 'object'
            ? (msg.content as RoomReportContent)
            : null;
        const planMsg =
          msg.type === 'plan' && msg.content && typeof msg.content === 'object'
            ? (msg.content as {
                version?: number;
                milestoneCount?: number;
                taskCount?: number;
                awaitingApproval?: boolean;
                tasks?: Array<{
                  id: string;
                  title: string;
                  role: string;
                  complexity: string;
                  dependsOn?: string[];
                  executor?: string | null;
                }>;
              })
            : null;
        const custom = renderBody?.(msg) ?? null;
        const attached = msg.type === 'images' && msg.content && typeof msg.content === 'object'
          ? msg.content as ChatImageMessage : null;
        const speakerLabel =
          msg.role === 'user'
            ? t('discuss.roleUser')
            : msg.authorProfileName
              ? `@${msg.authorProfileName}`
              : msg.role === 'lead'
                ? t('discuss.roleLead')
                : msg.role === 'agent'
                  ? t('discuss.roleAgent')
                  : t('discuss.roleSystem');
        const reportBadgeKey = report
          ? (`room.report.${report.event}` as TranslationKey)
          : isQuestion
            ? ('room.badge.question' as TranslationKey)
            : null;

        const formatReportSummary = (rep: RoomReportContent): string => {
          const task = rep.externalId ?? rep.taskId ?? '';
          const title = rep.taskTitle ?? '';
          switch (rep.event) {
            case 'task_started':
              return t('room.msg.task_started', { task, title });
            case 'task_finished':
              return t('room.msg.task_finished', { task, title });
            case 'task_failed':
              return t('room.msg.task_failed', { task });
            case 'verify_result':
              if (rep.verifySkipped || rep.verifyExitCode == null) {
                return t('room.msg.verify_skipped', { task });
              }
              return rep.verifyExitCode === 0
                ? t('room.msg.verify_pass', { task, cmd: rep.verifyCommand ?? '' })
                : t('room.msg.verify_fail', {
                    task,
                    code: rep.verifyExitCode,
                    cmd: rep.verifyCommand ?? '',
                  });
            case 'review_verdict':
              return rep.reviewStatus === 'pass'
                ? t('room.msg.review_pass', {
                    round: rep.reviewRound ?? 1,
                    task,
                    count: rep.findingsCount ?? 0,
                  })
                : t('room.msg.review_fail', {
                    round: rep.reviewRound ?? 1,
                    task,
                    count: rep.findingsCount ?? 0,
                  });
            case 'task_merged':
              return t('room.msg.task_merged', {
                task,
                title,
                sha: rep.mergeCommitSha ? rep.mergeCommitSha.slice(0, 7) : '',
              });
            case 'task_accepted':
              return t('room.msg.task_accepted', {
                task,
                title,
                path: rep.answerPath ?? (rep.taskId ? `.dalang/answers/${rep.taskId}.md` : '.dalang/answers/'),
              });
            case 'task_rejected':
              return t('room.msg.task_rejected', { task, title });
            case 'task_steered':
              return t('room.msg.task_steered', { task });
            case 'run_finished':
            case 'run_stopped': {
              const o = rep.outcome;
              if (!o) return rep.summary;
              if (rep.event === 'run_finished') return t('room.msg.run_finished', { total: o.total });
              const lines = [t('room.msg.run_stopped', { done: o.done, total: o.total })];
              if (o.reviewFailed.length > 0) lines.push(t('room.msg.run_reviewFailed', { tasks: o.reviewFailed.join(', ') }));
              if (o.failed.length > 0) lines.push(t('room.msg.run_failed', { tasks: o.failed.join(', ') }));
              if (o.waiting.length > 0) lines.push(t('room.msg.run_waiting', { tasks: o.waiting.join(', ') }));
              return lines.join('\n');
            }
            default:
              return rep.summary;
          }
        };

        return (
          <article
            key={msg.id}
            ref={refFor(isLast)}
            className={`scroll-mt-20 rounded-[10px] border p-4 ${
              isUser ? 'ml-auto w-full max-w-[85%]' : 'mr-auto w-full max-w-[95%]'
            }`}
            style={{
              backgroundColor: isError
                ? 'var(--error-tint)'
                : isUser
                  ? 'var(--bg-well)'
                  : 'var(--bg-surface)',
              borderColor: isError ? 'var(--error)' : 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold uppercase tracking-wide">{speakerLabel}</span>
                {reportBadgeKey && (
                  <span
                    className="rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] uppercase"
                    style={{
                      borderColor:
                        report?.reviewStatus === 'fail' || report?.event === 'task_failed' || report?.event === 'run_stopped'
                          ? 'var(--error)'
                          : report?.reviewStatus === 'pass' ||
                              report?.event === 'task_merged' ||
                              report?.event === 'task_accepted' ||
                              report?.event === 'run_finished'
                            ? 'var(--pass)'
                            : isQuestion
                              ? 'var(--accent)'
                              : 'var(--border-subtle)',
                      color:
                        report?.reviewStatus === 'fail' || report?.event === 'task_failed' || report?.event === 'run_stopped'
                          ? 'var(--error)'
                          : report?.reviewStatus === 'pass' ||
                              report?.event === 'task_merged' ||
                              report?.event === 'task_accepted' ||
                              report?.event === 'run_finished'
                            ? 'var(--pass)'
                            : isQuestion
                              ? 'var(--accent)'
                              : 'var(--text-secondary)',
                    }}
                  >
                    {t(reportBadgeKey)}
                  </span>
                )}
              </div>
              <span style={{ color: 'var(--text-secondary)' }}>{formatTime(msg.createdAt)}</span>
            </div>

            <div className="mt-2">
              {custom ? (
                custom
              ) : report ? (
                <div className="space-y-1.5 text-sm">
                  <p className="whitespace-pre-wrap">{formatReportSummary(report)}</p>
                  {scopeRequest && report.event === 'scope_request' && msg.id === scopeRequest.messageId && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="button" onClick={scopeRequest.onAllow} disabled={scopeRequest.pending}>
                        {t('room.scopeAllow')}
                      </Button>
                      {scopeRequest.error && (
                        <span className="text-xs" style={{ color: 'var(--error)' }}>{scopeRequest.error}</span>
                      )}
                    </div>
                  )}
                  {report.diffStats && (
                    <p className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {t('room.report.diffStats', {
                        files: report.diffStats.filesChanged,
                        insertions: report.diffStats.insertions,
                        deletions: report.diffStats.deletions,
                      })}
                    </p>
                  )}
                  {report.answer && (
                    <div
                      className="mt-2 rounded-[6px] border p-3"
                      style={{
                        backgroundColor: 'var(--bg-well)',
                        borderColor: 'var(--border-subtle)',
                      }}
                    >
                      <Markdown>{report.answer}</Markdown>
                    </div>
                  )}
                  {report.findings && report.findings.length > 0 && (
                    <ul className="space-y-1 pt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {report.findings.map((f, fIdx) => (
                        <li key={fIdx} className="font-mono">
                          [{f.severity}] {f.file ? `${f.file}: ` : ''}
                          {f.note}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : planMsg ? (
                <div className="space-y-1.5 text-sm">
                  <p>
                    {t('room.planSummary', {
                      version: planMsg.version ?? 1,
                      tasks: planMsg.taskCount ?? planMsg.tasks?.length ?? 0,
                      milestones: planMsg.milestoneCount ?? 1,
                    })}
                  </p>
                  {planMsg.tasks && planMsg.tasks.length > 0 && (
                    <ul className="space-y-0.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {planMsg.tasks.map((task) => (
                        <li key={task.id}>
                          [{task.id}] {task.title}
                          {task.executor && (
                            <div className="pl-4">{t('room.planExecutor', { executor: task.executor })}</div>
                          )}
                          {task.dependsOn && task.dependsOn.length > 0 && (
                            <div className="pl-4">{t('room.planAfter', { tasks: task.dependsOn.join(', ') })}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {planApproval && planMsg.awaitingApproval && planMsg.version === planApproval.version && (
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border px-3 py-2.5"
                      style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent)' }}
                    >
                      <p className="min-w-0 flex-1 text-xs">{t('room.planAwaiting')}</p>
                      <Button type="button" onClick={planApproval.onApprove} disabled={planApproval.pending}>
                        {planApproval.pending ? t('plan.approving') : t('room.planApproveStart')}
                      </Button>
                      {planApproval.error && (
                        <p className="w-full text-xs" style={{ color: 'var(--error)' }}>{planApproval.error}</p>
                      )}
                    </div>
                  )}
                </div>
              ) : ask ? (
                <div className="space-y-3">
                  <Markdown>{ask.text}</Markdown>
                  {ask.suggestion && onPromote && (
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border px-3 py-2.5"
                      style={{ backgroundColor: 'var(--accent-tint)', borderColor: 'var(--accent)' }}
                    >
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="font-semibold" style={{ color: 'var(--accent)' }}>
                          {t('sessions.suggestionHeading', {
                            mode: t(`sessions.mode.${ask.suggestion.targetMode}`),
                          })}
                        </div>
                        <p className="mt-0.5" style={{ color: 'var(--text-primary)' }}>
                          {ask.suggestion.reason}
                        </p>
                      </div>
                      <Button type="button" onClick={() => onPromote(ask.suggestion!.targetMode)}>
                        {t('sessions.modePromoteConfirm', {
                          mode: t(`sessions.mode.${ask.suggestion.targetMode}`),
                        })}
                      </Button>
                    </div>
                  )}
                </div>
              ) : attached ? (
                <div className="space-y-2">
                  {attached.text && <p className="whitespace-pre-wrap text-sm">{attached.text}</p>}
                  <div className="flex flex-wrap gap-2">
                    {attached.images.map((image) => (
                      <a key={image.id} href={`/api/chat-images/${encodeURIComponent(image.id)}`} target="_blank" rel="noreferrer" className="max-w-full rounded-md focus-visible:outline-2 focus-visible:outline-ring">
                        <img src={`/api/chat-images/${encodeURIComponent(image.id)}`} alt={image.name} loading="lazy" width={144} height={108} className="aspect-[4/3] max-w-full rounded-md border border-input object-cover" />
                      </a>
                    ))}
                  </div>
                </div>
              ) : typeof msg.content === 'string' && (msg.role === 'lead' || msg.role === 'agent') ? (
                <Markdown>{msg.content}</Markdown>
              ) : (
                <p className="whitespace-pre-wrap text-sm">
                  {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
                </p>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
