import type { ReactNode } from 'react';

/**
 * Keeps the composer at the bottom of the window while the conversation scrolls above it.
 * Place it as a sibling of the message list so the whole page column bounds the sticky.
 * `bleed` also covers the page gutters, for a composer that spans the full column.
 */
export function ComposerDock({ children, bleed = true }: { children: ReactNode; bleed?: boolean }) {
  return (
    <div
      className={`sticky bottom-0 z-10 pt-2 pb-3 ${
        bleed ? '-mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8' : ''
      }`}
      style={{ backgroundColor: 'var(--bg-canvas)' }}
    >
      <div className="mx-auto w-full max-w-4xl">{children}</div>
    </div>
  );
}
