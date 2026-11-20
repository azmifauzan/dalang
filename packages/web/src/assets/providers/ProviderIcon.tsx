import type { ProviderId } from '@dalang/shared';
import antigravityMark from './antigravity.png';
import { CLAUDE_MARK_PATH, CLAUDE_MARK_VIEWBOX, OPENAI_MARK_PATH, OPENAI_MARK_VIEWBOX } from './marks.js';

/** The provider's own mark: Claude in its orange, Codex in the text color, Antigravity as its image. */
export function ProviderIcon({ id, size = 20 }: { id: ProviderId; size?: number }) {
  if (id === 'claude-code') {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox={CLAUDE_MARK_VIEWBOX}
        className="shrink-0"
        fill="#d97757"
      >
        <path d={CLAUDE_MARK_PATH} />
      </svg>
    );
  }
  if (id === 'codex') {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox={OPENAI_MARK_VIEWBOX}
        className="shrink-0"
        fill="currentColor"
      >
        <path fillRule="evenodd" clipRule="evenodd" d={OPENAI_MARK_PATH} />
      </svg>
    );
  }
  return (
    <img
      src={antigravityMark}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="shrink-0"
      decoding="async"
    />
  );
}
