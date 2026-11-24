import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The setup instructions (markdown) of a catalog item: what a person installs
 * or turns on before the server works, with links. Shown atop the catalog
 * form and in the dialog that connects a desktop MCP server.
 */
export function CatalogInstructions({ markdown }: { markdown: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={INSTRUCTIONS_MARKDOWN_COMPONENTS}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

// ===

const INSTRUCTIONS_MARKDOWN_COMPONENTS: Components = {
  p: ({ node, ...props }) => (
    <p className="mb-2 text-muted-foreground" {...props} />
  ),
  strong: ({ node, ...props }) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol
      className="mb-2 list-decimal space-y-1 pl-5 text-muted-foreground"
      {...props}
    />
  ),
  ul: ({ node, ...props }) => (
    <ul
      className="mb-2 list-disc space-y-1 pl-5 text-muted-foreground"
      {...props}
    />
  ),
  a: ({ node, children, ...props }) => (
    <a
      className="text-primary underline"
      target="_blank"
      rel="noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  pre: ({ node, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs"
      {...props}
    />
  ),
  code: ({ node, ...props }) => (
    <code
      className="rounded bg-muted px-1 py-0.5 font-mono text-xs"
      {...props}
    />
  ),
};
