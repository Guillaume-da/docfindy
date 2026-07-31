import Markdown from "react-markdown";

// Styled markdown rendering for .md previews, mapped onto the theme tokens.
// react-markdown passes an extra `node` prop to custom components; it is
// destructured away so it never reaches the DOM.
type MdProps<T extends keyof React.JSX.IntrinsicElements> =
  React.ComponentProps<T> & { node?: unknown };

const components = {
  h1: ({ node: _n, ...p }: MdProps<"h1">) => (
    <h1 className="mb-2 mt-5 text-xl font-bold tracking-tight text-txt-strong first:mt-0" {...p} />
  ),
  h2: ({ node: _n, ...p }: MdProps<"h2">) => (
    <h2 className="mb-1.5 mt-4 text-base font-bold tracking-tight text-txt-strong first:mt-0" {...p} />
  ),
  h3: ({ node: _n, ...p }: MdProps<"h3">) => (
    <h3 className="mb-1 mt-3 text-sm font-semibold text-txt-strong" {...p} />
  ),
  h4: ({ node: _n, ...p }: MdProps<"h4">) => (
    <h4 className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted" {...p} />
  ),
  p: ({ node: _n, ...p }: MdProps<"p">) => (
    <p className="mb-2.5 text-[13.5px] leading-[1.75] text-txt-mid" {...p} />
  ),
  a: ({ node: _n, ...p }: MdProps<"a">) => (
    <a className="text-accent underline decoration-accent/40 underline-offset-2" target="_blank" rel="noreferrer" {...p} />
  ),
  ul: ({ node: _n, ...p }: MdProps<"ul">) => (
    <ul className="mb-2.5 list-disc space-y-1 pl-5 text-[13.5px] leading-relaxed text-txt-mid marker:text-accent" {...p} />
  ),
  ol: ({ node: _n, ...p }: MdProps<"ol">) => (
    <ol className="mb-2.5 list-decimal space-y-1 pl-5 text-[13.5px] leading-relaxed text-txt-mid marker:text-muted" {...p} />
  ),
  blockquote: ({ node: _n, ...p }: MdProps<"blockquote">) => (
    <blockquote className="mb-2.5 border-l-2 border-accent/50 pl-3 text-[13.5px] italic text-muted" {...p} />
  ),
  code: ({ node: _n, ...p }: MdProps<"code">) => (
    <code className="rounded bg-fill px-1.5 py-0.5 font-mono text-[12px] text-txt" {...p} />
  ),
  pre: ({ node: _n, ...p }: MdProps<"pre">) => (
    <pre className="mb-3 overflow-x-auto rounded-[11px] border border-edge-soft bg-panel p-3.5 font-mono text-[12px] leading-relaxed text-txt-mid [&>code]:bg-transparent [&>code]:p-0" {...p} />
  ),
  hr: () => <hr className="my-4 border-edge-soft" />,
  img: ({ node: _n, ...p }: MdProps<"img">) => (
    <img className="my-2 max-w-full rounded-lg" {...p} />
  ),
};

export default function MarkdownView({ text }: { text: string }) {
  return <Markdown components={components}>{text}</Markdown>;
}
