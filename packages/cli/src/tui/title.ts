import { useEffect } from 'react';
import type { DiscussMessageDTO } from '@dalang/shared';
import { stripControl } from './format.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The most recent conversational reply can still be waiting after later status reports. */
export function waitingForReply(messages: DiscussMessageDTO[]): boolean {
  const last = messages.findLast((message) => message.role === 'user' || message.role === 'lead' ||
    (message.role === 'agent' && (message.type === 'ask' || message.type === 'questions' || message.type === 'text')));
  if (!last || last.role === 'user') return false;
  if (last.type === 'questions') {
    const content = last.content as { questions?: unknown[] } | null;
    return Array.isArray(content?.questions) && content.questions.length > 0;
  }
  if (last.kind === 'question') return true;
  const content = last.content;
  const text = typeof content === 'string' ? content
    : content && typeof content === 'object' && 'text' in content && typeof content.text === 'string'
      ? content.text : '';
  return (last.type === 'ask' || last.type === 'text') && /[?？]/.test(text);
}

export function useTerminalTitle(
  stdout: NodeJS.WriteStream | undefined,
  project: string | undefined,
  state: 'idle' | 'working' | 'waiting',
): void {
  useEffect(() => {
    if (!stdout?.isTTY) return;
    stdout.write('\x1b[22;0t');
    return () => { stdout.write('\x1b[23;0t'); };
  }, [stdout]);

  useEffect(() => {
    if (!stdout?.isTTY) return;
    const name = stripControl(project ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const base = name ? `DALANG · ${name}` : 'DALANG';
    let frame = 0;
    const draw = () => {
      const prefix = state === 'waiting' ? '* ' : state === 'working' ? `${FRAMES[frame++ % FRAMES.length]} ` : '';
      stdout.write(`\x1b]0;${prefix}${base}\x07`);
    };
    draw();
    if (state !== 'working') return;
    // Same pace as the WorkingStatus spinner, so the tab and the room move together.
    const timer = setInterval(draw, 120);
    return () => clearInterval(timer);
  }, [stdout, project, state]);
}
