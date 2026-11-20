import type { ReactNode, RefObject } from 'react';
import type {
  AskMessageContent,
  ChatImageMessage,
  DiscussMessageDTO,
  SessionMode,
  SessionSummaryDTO,
} from '@dalang/shared';
import { useI18n } from '../../i18n/index.js';
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
}: {
  messages: DiscussMessageDTO[];
  session: SessionSummaryDTO | null;
  /** Attach to the newest message so a new reply can be scrolled to its first line. */
  lastReplyRef: RefObject<HTMLElement | null>;
  onPromote?: (mode: SessionMode) => void;
  renderCard?: (msg: DiscussMessageDTO) => ReactNode | null;
  renderBody?: (msg: DiscussMessageDTO) => ReactNode | null;
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
        const custom = renderBody?.(msg) ?? null;
        const attached = msg.type === 'images' && msg.content && typeof msg.content === 'object'
          ? msg.content as ChatImageMessage : null;

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
              <span className="font-semibold uppercase tracking-wide">
                {msg.role === 'user'
                  ? t('discuss.roleUser')
                  : msg.role === 'lead'
                    ? t('discuss.roleLead')
                    : t('discuss.roleSystem')}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>{formatTime(msg.createdAt)}</span>
            </div>

            <div className="mt-2">
              {custom ? (
                custom
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
              ) : typeof msg.content === 'string' && msg.role === 'lead' ? (
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
