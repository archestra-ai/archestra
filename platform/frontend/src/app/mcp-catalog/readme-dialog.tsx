"use client";

import "highlight.js/styles/github-dark.css";
import { Github, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { McpServer } from "@/lib/mcp-registry-external.query";

interface ReadmeDialogProps {
  server: McpServer | null;
  onClose: () => void;
}

// Custom markdown components for GitHub-like styling
const markdownComponents: Components = {
  h1: ({ node, ...props }) => (
    <h1
      className="text-2xl font-semibold text-foreground mt-6 mb-4 pb-2 border-b border-border"
      {...props}
    />
  ),
  h2: ({ node, ...props }) => (
    <h2
      className="text-xl font-semibold text-foreground mt-6 mb-4 pb-2 border-b border-border"
      {...props}
    />
  ),
  h3: ({ node, ...props }) => (
    <h3
      className="text-lg font-semibold text-foreground mt-6 mb-3"
      {...props}
    />
  ),
  h4: ({ node, ...props }) => (
    <h4
      className="text-base font-semibold text-foreground mt-4 mb-2"
      {...props}
    />
  ),
  p: ({ node, ...props }) => (
    <p
      className="text-muted-foreground leading-relaxed mb-2 text-left"
      {...props}
    />
  ),
  a: ({ node, ...props }) => (
    <a className="inline-block text-primary hover:underline" {...props} />
  ),
  code: ({ node, ...props }) => (
    <code
      className="bg-muted text-destructive px-1.5 py-0.5 rounded text-sm font-mono"
      {...props}
    />
  ),
  pre: ({ node, ...props }) => (
    <pre
      className="bg-muted/50 border rounded-lg p-4 overflow-x-auto text-sm mb-4 text-foreground"
      {...props}
    />
  ),
  blockquote: ({ node, ...props }) => (
    <blockquote
      className="border-l-4 border-border pl-4 text-muted-foreground italic my-4"
      {...props}
    />
  ),
  table: ({ node, ...props }) => (
    <div className="overflow-x-auto my-6">
      <table
        className="w-full border-collapse border border-border text-sm"
        {...props}
      />
    </div>
  ),
  tr: ({ node, ...props }) => {
    // Filter out valign prop to avoid React warning
    // biome-ignore lint/suspicious/noExplicitAny: Props from react-markdown can have legacy HTML attributes
    const { valign, vAlign, ...cleanProps } = props as any;
    // Use the filtered props to avoid React warnings about legacy attributes
    void valign;
    void vAlign;
    return <tr {...cleanProps} />;
  },
  th: ({ node, ...props }) => (
    <th
      className="bg-muted font-semibold text-left px-3 py-2 border border-border"
      {...props}
    />
  ),
  td: ({ node, ...props }) => (
    <td className="px-3 py-2 border border-border align-top" {...props} />
  ),
  ul: ({ node, ...props }) => (
    <ul className="list-disc pl-6 mb-4 space-y-1" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol className="list-decimal pl-6 mb-4 space-y-1" {...props} />
  ),
  li: ({ node, ...props }) => (
    <li className="text-muted-foreground" {...props} />
  ),
  img: ({ node, ...props }) => (
    <img className="inline-block align-middle mr-1 h-auto" alt="" {...props} />
  ),
  hr: ({ node, ...props }) => <hr className="border-border my-8" {...props} />,
  strong: ({ node, ...props }) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
};

export function ReadmeDialog({ server, onClose }: ReadmeDialogProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch README when server changes
  useEffect(() => {
    if (!server) {
      setContent("");
      setError(null);
      setLoading(false);
      return;
    }

    const fetchReadme = async () => {
      if (!server.repository) {
        setError("No repository URL available");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        // Convert GitHub URL to raw README URL
        // https://github.com/222wcnm/BiliStalkerMCP -> https://raw.githubusercontent.com/222wcnm/BiliStalkerMCP/main/README.md
        const githubMatch = server.repository.match(
          /github\.com\/([^/]+)\/([^/]+)/,
        );

        if (!githubMatch) {
          throw new Error("Not a GitHub repository");
        }

        const [, owner, repo] = githubMatch;
        const cleanRepo = repo.replace(/\.git$/, ""); // Remove .git suffix if present

        // Try main branch first, then master
        const branches = ["main", "master"];
        let readmeContent = "";

        for (const branch of branches) {
          try {
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${cleanRepo}/${branch}/README.md`;
            const response = await fetch(rawUrl);
            if (response.ok) {
              readmeContent = await response.text();
              break;
            }
          } catch {}
        }

        if (!readmeContent) {
          throw new Error("README.md not found");
        }

        setContent(readmeContent);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch README");
        setLoading(false);
      }
    };

    fetchReadme();
  }, [server]);

  const isOpen = !!server;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{server?.name || "Server"} README</DialogTitle>
          <DialogDescription>
            {server?.repository && (
              <a
                href={server.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline inline-flex items-center gap-1"
              >
                <Github className="h-3 w-3" />
                View on GitHub
              </a>
            )}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-[60vh] w-full pr-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && (
            <div className="text-center py-8">
              <p className="text-destructive mb-2">Failed to load README</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          )}
          {!loading && !error && content && (
            <div className="github-markdown">
              <style>{`
                .github-markdown pre code.hljs {
                  background: transparent !important;
                  color: inherit !important;
                }
              `}</style>
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                rehypePlugins={[rehypeHighlight, rehypeRaw]}
                components={markdownComponents}
              >
                {content}
              </ReactMarkdown>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
