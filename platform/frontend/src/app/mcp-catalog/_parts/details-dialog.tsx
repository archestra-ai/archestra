"use client";

import "highlight.js/styles/github-dark.css";
import {
  Calendar,
  ExternalLink,
  FileText,
  GitBranch,
  Github,
  Info,
  Loader2,
  Package as PackageIcon,
  Radio,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { ServerResponse } from "@/lib/clients/mcp-registry";
import { useMcpServerVersions } from "@/lib/mcp-registry-external.query";

interface DetailsDialogProps {
  server: ServerResponse | null;
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

export function DetailsDialog({ server, onClose }: DetailsDialogProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch all versions for this server
  const { data: versionsData } = useMcpServerVersions(
    server?.server.name || null,
  );
  const allVersions = versionsData?.servers || [];

  // Fetch README when server changes
  useEffect(() => {
    if (!server) {
      setContent("");
      setError(null);
      setLoading(false);
      return;
    }

    const fetchReadme = async () => {
      if (!server.server.repository?.url) {
        setError("No repository URL available");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        // Convert GitHub URL to raw README URL
        // https://github.com/222wcnm/BiliStalkerMCP -> https://raw.githubusercontent.com/222wcnm/BiliStalkerMCP/main/README.md
        const githubMatch = server.server.repository.url.match(
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

  const metadata = server?._meta["io.modelcontextprotocol.registry/official"];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{server?.server.name || "Server"}</DialogTitle>
          <DialogDescription>
            {server?.server.title && (
              <span className="block mb-1">{server.server.title}</span>
            )}
            {server?.server.repository?.url && (
              <a
                href={server.server.repository.url}
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
        <ScrollArea className="h-[60vh] w-full pr-4 py-4">
          <div className="space-y-6">
            {/* Overview Section */}
            <section>
              <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                <Info className="h-5 w-5" />
                Overview
              </h3>
              <div className="space-y-2 text-sm">
                {server?.server.description && (
                  <p className="text-muted-foreground">
                    {server.server.description}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {server?.server.version && (
                    <Badge variant="secondary">v{server.server.version}</Badge>
                  )}
                  {metadata?.status && (
                    <Badge
                      variant={
                        metadata.status === "active"
                          ? "default"
                          : metadata.status === "deprecated"
                            ? "outline"
                            : "destructive"
                      }
                    >
                      {metadata.status}
                    </Badge>
                  )}
                  {metadata?.isLatest && (
                    <Badge variant="default" className="bg-green-600">
                      Latest
                    </Badge>
                  )}
                </div>
                {server?.server.websiteUrl && (
                  <a
                    href={server.server.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {server.server.websiteUrl}
                  </a>
                )}
              </div>
            </section>

            {/* Versions Section */}
            {allVersions.length > 1 && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <GitBranch className="h-5 w-5" />
                    Available Versions
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {allVersions.map((versionServer) => {
                      const versionMeta =
                        versionServer._meta[
                          "io.modelcontextprotocol.registry/official"
                        ];
                      const isCurrentVersion =
                        versionServer.server.version === server?.server.version;
                      return (
                        <Badge
                          key={versionServer.server.version}
                          variant={isCurrentVersion ? "default" : "outline"}
                          className={
                            versionMeta?.isLatest
                              ? "bg-green-600 hover:bg-green-700"
                              : ""
                          }
                        >
                          v{versionServer.server.version}
                          {versionMeta?.isLatest && " (Latest)"}
                          {versionMeta?.status === "deprecated" &&
                            " (Deprecated)"}
                        </Badge>
                      );
                    })}
                  </div>
                </section>
              </>
            )}

            {/* Packages Section */}
            {server?.server.packages && server.server.packages.length > 0 && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <PackageIcon className="h-5 w-5" />
                    Packages
                  </h3>
                  <div className="space-y-3">
                    {server.server.packages.map((pkg) => (
                      <div
                        key={pkg.identifier}
                        className="border rounded-lg p-3 space-y-2 text-sm"
                      >
                        <div className="font-mono text-xs">
                          {pkg.identifier}
                          {pkg.version && ` @ ${pkg.version}`}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline">{pkg.registryType}</Badge>
                          {pkg.transport.type && (
                            <Badge variant="outline">
                              {pkg.transport.type}
                            </Badge>
                          )}
                          {pkg.runtimeHint && (
                            <Badge variant="outline">{pkg.runtimeHint}</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {/* Remotes Section */}
            {server?.server.remotes && server.server.remotes.length > 0 && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Radio className="h-5 w-5" />
                    Remote Transports
                  </h3>
                  <div className="space-y-2">
                    {server.server.remotes.map((remote) => (
                      <div
                        key={remote.url}
                        className="border rounded-lg p-3 space-y-1 text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{remote.type}</Badge>
                          {remote.url && (
                            <span className="font-mono text-xs text-muted-foreground truncate">
                              {remote.url}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {/* Metadata Section */}
            {metadata && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Calendar className="h-5 w-5" />
                    Metadata
                  </h3>
                  <div className="space-y-1 text-sm">
                    {metadata.publishedAt && (
                      <div>
                        <span className="text-muted-foreground">
                          Published:{" "}
                        </span>
                        {new Date(metadata.publishedAt).toLocaleDateString()}
                      </div>
                    )}
                    {metadata.updatedAt && (
                      <div>
                        <span className="text-muted-foreground">Updated: </span>
                        {new Date(metadata.updatedAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}

            {/* README Section */}
            <Separator />
            <section>
              <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                <FileText className="h-5 w-5" />
                README
              </h3>
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
                <div className="card border px-4">
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
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
