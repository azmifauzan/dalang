import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_HREF = /^(https?:|mailto:)/i;

// Agent output is untrusted: raw HTML is never rendered, and only web and mail links are clickable.
// Other links (for example file:// paths) show as inline code, because the browser will not open them.
const components: Components = {
  a: ({ href, children }) =>
    href && SAFE_HREF.test(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-2"
        style={{ color: 'var(--accent)' }}
      >
        {children}
      </a>
    ) : (
      <code className="rounded bg-[var(--bg-well)] px-1 py-0.5 font-mono-token text-[0.85em]">
        {children}
      </code>
    ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote
      className="my-2 border-l-2 pl-3"
      style={{ borderColor: 'var(--border-control)', color: 'var(--text-secondary)' }}
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3" style={{ borderColor: 'var(--border-subtle)' }} />,
  pre: ({ children }) => (
    <pre
      className="my-2 overflow-x-auto rounded-[6px] border p-3 font-mono-token text-xs [&_code]:bg-transparent [&_code]:p-0"
      style={{ backgroundColor: 'var(--bg-well)', borderColor: 'var(--border-subtle)' }}
    >
      {children}
    </pre>
  ),
  code: ({ className, children }) => (
    <code
      className={
        className ?? 'rounded bg-[var(--bg-well)] px-1 py-0.5 font-mono-token text-[0.85em]'
      }
    >
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th
      className="border px-2 py-1 text-left font-semibold"
      style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-well)' }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border px-2 py-1 align-top" style={{ borderColor: 'var(--border-subtle)' }}>
      {children}
    </td>
  ),
};

/** Renders an agent reply as formatted text: headings, lists, code, tables, and links. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 text-sm leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
