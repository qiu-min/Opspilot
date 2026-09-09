import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type AssistantMarkdownProps = {
  content: string;
};

export function AssistantMarkdown({ content }: AssistantMarkdownProps) {
  return (
    <div className="min-w-0 text-[14px] leading-7 text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          h1: ({ children }) => <h1 className="mb-3 mt-4 text-lg font-semibold leading-6 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold leading-6 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-semibold leading-5 first:mt-0">{children}</h3>,
          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          code: ({ className, children, node: _node, ...props }) => {
            const isBlockCode = typeof className === "string" && className.includes("language-");

            return isBlockCode ? (
              <code className={className} {...props}>
                {children}
              </code>
            ) : (
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.9em] text-ink" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="mb-3 overflow-x-auto rounded-lg border border-line bg-slate-50 p-3 font-mono text-xs leading-5 [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit last:mb-0">{children}</pre>,
          blockquote: ({ children }) => <blockquote className="mb-3 border-l-2 border-brand/40 pl-3 text-mutedInk last:mb-0">{children}</blockquote>,
          a: ({ children, href, node: _node, ...props }) => (
            <a
              href={href}
              className="text-brand underline decoration-brand/40 underline-offset-2 hover:text-brand-strong"
              target="_blank"
              rel="noreferrer noopener"
              {...props}
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-4 border-line" />,
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto last:mb-0">
              <table className="min-w-full border-collapse text-left text-[13px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-line last:border-b-0">{children}</tr>,
          th: ({ children }) => <th className="border border-line px-2.5 py-2 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-line px-2.5 py-2 align-top">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
