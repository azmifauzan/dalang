import { useEffect, useRef } from 'react';
import type { DiscussMessageDTO } from '@dalang/shared';
import type { LiveTurn } from '../../lib/liveTurn.js';

const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });

/**
 * Keeps the conversation in view like any chat. A new reply is read from its first line, so scroll to the
 * top of it; while a turn runs, follow the end. The composer is sticky, so scrolling it into view does
 * nothing: scroll the page itself. Attach the returned ref to the last message.
 */
export function useChatScroll(
  messages: DiscussMessageDTO[],
  turnRunning: boolean,
  liveTurn: LiveTurn | undefined,
) {
  const lastReplyRef = useRef<HTMLElement | null>(null);
  const lastRole = messages.length > 0 ? messages[messages.length - 1].role : null;

  useEffect(() => {
    if (turnRunning) toBottom();
    else if (lastRole === 'lead' && lastReplyRef.current) {
      lastReplyRef.current.scrollIntoView({ block: 'start' });
    } else if (messages.length > 0) toBottom();
  }, [messages.length, lastRole, turnRunning]);

  const liveTextLength = liveTurn?.text.length ?? 0;
  useEffect(() => {
    if (!turnRunning) return;
    const nearBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    if (nearBottom) toBottom();
  }, [liveTextLength, liveTurn?.activity, turnRunning]);

  return lastReplyRef;
}
