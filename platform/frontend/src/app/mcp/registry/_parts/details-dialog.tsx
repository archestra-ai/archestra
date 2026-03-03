"use client";

import "highlight.js/styles/github-dark.css";
import type { archestraCatalogTypes } from "@shared";
import {
  BookOpen,
  Calendar,
  Code2,
  ExternalLink,
  FileText,
  Github,
  Globe,
  Info,
  Link,
  Settings,
  Star,
  Terminal,
  Users,
} from "lucide-react";
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

interface DetailsDialogProps {
  server: archestraCatalogTypes.ArchestraMcpServerManifest | null;
  onClose: () => void;
}

// Custom markdown components for GitHub-like styling
const commonClasses = "max-w-[800px]";
const markdownComponents: Components = {
  h1: ({ node, ...props }) => (
    <h1
      className={`text-2xl font-semibold text-foreground mt-6 mb-4 pb-2 border-b border-border ${commonClasses}`}
      {...props}
    />
  ),
  h2: ({ node, ...props }) => (
    <h2
      className={`text-xl font-semibold text-foreground mt-6 mb-4 pb-2 border-b border-border ${commonClasses}`}
      {...props}
    />
  ),
  h3: ({ node, ...props }) => (
    <h3
      className={`text-lg font-semibold text-foreground mt-6 mb-3 ${commonClasses}`}
      {...props}
    />
  ),
  h4: ({ node, ...props }) => (
    <h4
      className={`text-base font-semibold text-foreground mt-4 mb-2 ${commonClasses}`}
      {...props}
    />
  ),
  p: ({ node, ...props }) => (
    <p
      className={`text-muted-foreground leading-relaxed mb-2 text-left break-words ${commonClasses}`}
      {...props}
    />
  ),
  a: ({ node, ...props }) => (
    <a
      className={`inline-block text-primary hover:underline break-all ${commonClasses}`}
      {...props}
    />
  ),
  code: ({ node, ...props }) => (
    <code
      className={`bg-muted text-destructive px-1.5 py-0.5 rounded text-sm font-mono break-words ${commonClasses}`}
      {...props}
    />
  ),
  pre: ({ node, ...props }) => (
    <pre
      className={`bg-muted/50 border rounded-lg p-4 overflow-x-auto text-sm mb-4 text-foreground ${commonClasses}`}
      {...props}
    />
  ),
  blockquote: ({ node, ...props }) => (
    <blockquote
      className={`border-l-4 border-border pl-4 text-muted-foreground italic my-4 ${commonClasses}`}
      {...props}
    />
  ),
  table: ({ node, ...props }) => (
    <div className={`overflow-x-auto my-6 ${commonClasses}`}>
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
      className={`bg-muted font-semibold text-left px-3 py-2 border border-border ${commonClasses}`}
      {...props}
    />
  ),
  td: ({ node, ...props }) => (
    <td
      className={`px-3 py-2 border border-border align-top ${commonClasses}`}
      {...props}
    />
  ),
  ul: ({ node, ...props }) => (
    <ul
      className={`list-disc pl-6 mb-4 space-y-1 ${commonClasses}`}
      {...props}
    />
  ),
  ol: ({ node, ...props }) => (
    <ol
      className={`list-decimal pl-6 mb-4 space-y-1 ${commonClasses}`}
      {...props}
    />
  ),
  li: ({ node, ...props }) => (
    <li className={`text-muted-foreground ${commonClasses}`} {...props} />
  ),
  img: ({ node, ...props }) => (
    <img
      className={`inline-block align-middle mr-1 h-auto max-w-full ${commonClasses}`}
      alt=""
      {...props}
    />
  ),
  hr: ({ node, ...props }) => (
    <hr className={`border-border my-8 ${commonClasses}`} {...props} />
  ),
  strong: ({ node, ...props }) => (
    <strong
      className={`font-semibold text-foreground ${commonClasses}`}
      {...props}
    />
  ),
};

export function DetailsDialog({ server, onClose }: DetailsDialogProps) {
  const isOpen = !!server;
  const content = server?.readme || "";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {server?.display_name || server?.name || "Server"}
          </DialogTitle>
          <DialogDescription>
            {server?.description && (
              <span className="block mb-1">{server.description}</span>
            )}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-[60vh] w-full py-4">
          <div className="space-y-6 pr-4">
            <section>
              <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                <Info className="h-5 w-5" />
                Overview
              </h3>
              <div className="space-y-2 text-sm">
                {server?.long_description && (
                  <p className="text-muted-foreground">
                    {server.long_description}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {server?.quality_score !== null &&
                    server?.quality_score !== undefined && (
                      <Badge variant="secondary">
                        Quality Score: {Math.round(server.quality_score)}
                      </Badge>
                    )}
                  {server?.category && (
                    <Badge variant="outline">{server.category}</Badge>
                  )}
                  {server?.programming_language && (
                    <Badge variant="outline">
                      {server.programming_language}
                    </Badge>
                  )}
                  {server?.license && (
                    <Badge variant="outline">{server.license}</Badge>
                  )}
                </div>
                {server?.keywords && server.keywords.length > 0 && (
                  <div>
                    <span className="text-muted-foreground font-medium">
                      Keywords:{" "}
                    </span>
                    <span className="text-muted-foreground">
                      {server.keywords.join(", ")}
                    </span>
                  </div>
                )}
              </div>
            </section>

            {server?.author && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Users className="h-5 w-5" />
                    Author
                  </h3>
                  <div className="space-y-1 text-sm">
                    <div>
                      <span className="text-muted-foreground font-medium">
                        Name:{" "}
                      </span>
                      <span className="text-foreground">
                        {server.author.name}
                      </span>
                    </div>
                    {server.author.email && (
                      <div>
                        <span className="text-muted-foreground font-medium">
                          Email:{" "}
                        </span>
                        <a
                          href={`mailto:${server.author.email}`}
                          className="text-primary hover:underline"
                        >
                          {server.author.email}
                        </a>
                      </div>
                    )}
                    {server.author.url && (
                      <div>
                        <span className="text-muted-foreground font-medium">
                          URL:{" "}
                        </span>
                        <a
                          href={server.author.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1"
                        >
                          {server.author.url}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}

            {(server?.homepage ||
              server?.documentation ||
              server?.support ||
              server?.github_info?.url) && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Link className="h-5 w-5" />
                    Links
                  </h3>
                  <div className="space-y-2 text-sm">
                    {server.homepage && (
                      <a
                        href={server.homepage}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1 block"
                      >
                        <Globe className="h-4 w-4" />
                        Homepage: {server.homepage}
                      </a>
                    )}
                    {server.documentation && (
                      <a
                        href={server.documentation}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1 block"
                      >
                        <BookOpen className="h-4 w-4" />
                        Documentation: {server.documentation}
                      </a>
                    )}
                    {server.support && (
                      <a
                        href={server.support}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1 block"
                      >
                        <Info className="h-4 w-4" />
                        Support: {server.support}
                      </a>
                    )}
                    {server.github_info?.url && (
                      <a
                        href={server.github_info.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1 block"
                      >
                        <Github className="h-4 w-4" />
                        GitHub: {server.github_info.url}
                      </a>
                    )}
                  </div>
                </section>
              </>
            )}

            {server?.server && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Terminal className="h-5 w-5" />
                    Server Configuration
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-muted-foreground font-medium">
                        Type:{" "}
                      </span>
                      <Badge variant="outline">{server.server.type}</Badge>
                    </div>
                    {server.server.type === "local" && (
                      <>
                        <div>
                          <span className="text-muted-foreground font-medium">
                            Command:{" "}
                          </span>
                          <code className="bg-muted px-2 py-1 rounded text-xs">
                            {server.server.command}
                          </code>
                        </div>
                        {server.server.args &&
                          server.server.args.length > 0 && (
                            <div>
                              <span className="text-muted-foreground font-medium">
                                Arguments:{" "}
                              </span>
                              <code className="bg-muted px-2 py-1 rounded text-xs">
                                {server.server.args.join(" ")}
                              </code>
                            </div>
                          )}
                        {server.server.env &&
                          Object.keys(server.server.env).length > 0 && (
                            <div>
                              <span className="text-muted-foreground font-medium block mb-1">
                                Environment Variables:
                              </span>
                              <div className="bg-muted rounded p-2 space-y-1">
                                {Object.entries(server.server.env).map(
                                  ([key, value]) => (
                                    <div
                                      key={key}
                                      className="font-mono text-xs"
                                    >
                                      <span className="text-foreground">
                                        {key}
                                      </span>
                                      ={value}
                                    </div>
                                  ),
                                )}
                              </div>
                            </div>
                          )}
                      </>
                    )}
                    {server.server.type === "remote" && (
                      <>
                        <div>
                          <span className="text-muted-foreground font-medium">
                            URL:{" "}
                          </span>
                          <a
                            href={server.server.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            {server.server.url}
                          </a>
                        </div>
                        {server.server.docs_url && (
                          <div>
                            <span className="text-muted-foreground font-medium">
                              Docs URL:{" "}
                            </span>
                            <a
                              href={server.server.docs_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {server.server.docs_url}
                            </a>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </section>
              </>
            )}

            {server?.tools && server.tools.length > 0 && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Code2 className="h-5 w-5" />
                    Tools ({server.tools.length})
                  </h3>
                  <div className="space-y-2">
                    {server.tools.map((tool, index) => (
                      <div
                        key={`${tool.name}-${index}`}
                        className="border rounded-lg p-3 text-sm"
                      >
                        <div className="font-semibold font-mono">
                          {tool.name}
                        </div>
                        {tool.description && (
                          <div className="text-muted-foreground mt-1">
                            {tool.description}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {server?.prompts && server.prompts.length > 0 && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    Prompts ({server.prompts.length})
                  </h3>
                  <div className="space-y-2">
                    {server.prompts.map((prompt, index) => (
                      <div
                        key={`${prompt.name}-${index}`}
                        className="border rounded-lg p-3 text-sm"
                      >
                        <div className="font-semibold font-mono">
                          {prompt.name}
                        </div>
                        {prompt.description && (
                          <div className="text-muted-foreground mt-1">
                            {prompt.description}
                          </div>
                        )}
                        {prompt.arguments && prompt.arguments.length > 0 && (
                          <div className="text-muted-foreground mt-1 text-xs">
                            Arguments: {prompt.arguments.join(", ")}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {server?.user_config &&
              Object.keys(server.user_config).length > 0 && (
                <>
                  <Separator />
                  <section>
                    <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                      <Settings className="h-5 w-5" />
                      Configuration Options
                    </h3>
                    <div className="space-y-2">
                      {Object.entries(server.user_config).map(
                        ([key, config]) => (
                          <div
                            key={key}
                            className="border rounded-lg p-3 text-sm"
                          >
                            <div className="flex items-start justify-between">
                              <div className="font-semibold font-mono">
                                {key}
                              </div>
                              <div className="flex gap-1">
                                <Badge variant="outline" className="text-xs">
                                  {config.type}
                                </Badge>
                                {config.required && (
                                  <Badge
                                    variant="destructive"
                                    className="text-xs"
                                  >
                                    Required
                                  </Badge>
                                )}
                                {config.sensitive && (
                                  <Badge
                                    variant="secondary"
                                    className="text-xs"
                                  >
                                    Sensitive
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <div className="text-muted-foreground mt-1">
                              {config.description}
                            </div>
                            {config.default !== undefined && (
                              <div className="text-muted-foreground mt-1 text-xs">
                                Default: {String(config.default)}
                              </div>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  </section>
                </>
              )}

            {server?.compatibility && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Info className="h-5 w-5" />
                    Compatibility
                  </h3>
                  <div className="space-y-2 text-sm">
                    {server.compatibility.platforms &&
                      server.compatibility.platforms.length > 0 && (
                        <div>
                          <span className="text-muted-foreground font-medium">
                            Platforms:{" "}
                          </span>
                          <div className="flex gap-1 mt-1">
                            {server.compatibility.platforms.map((platform) => (
                              <Badge key={platform} variant="outline">
                                {platform}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    {server.compatibility.runtimes && (
                      <div>
                        <span className="text-muted-foreground font-medium block mb-1">
                          Runtimes:
                        </span>
                        <div className="space-y-1">
                          {server.compatibility.runtimes.python && (
                            <div className="text-muted-foreground text-xs">
                              Python: {server.compatibility.runtimes.python}
                            </div>
                          )}
                          {server.compatibility.runtimes.node && (
                            <div className="text-muted-foreground text-xs">
                              Node: {server.compatibility.runtimes.node}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {server.compatibility.claude_desktop && (
                      <div>
                        <span className="text-muted-foreground font-medium">
                          Claude Desktop:{" "}
                        </span>
                        <span className="text-muted-foreground">
                          {server.compatibility.claude_desktop}
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}

            {server?.github_info && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Github className="h-5 w-5" />
                    GitHub Statistics
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      <Star className="h-4 w-4 text-yellow-500" />
                      <span className="text-muted-foreground">Stars:</span>
                      <span className="font-semibold">
                        {server.github_info.stars}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-blue-500" />
                      <span className="text-muted-foreground">
                        Contributors:
                      </span>
                      <span className="font-semibold">
                        {server.github_info.contributors}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Issues:</span>
                      <span className="font-semibold">
                        {server.github_info.issues}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Releases:</span>
                      <span className="font-semibold">
                        {server.github_info.releases ? "Yes" : "No"}
                      </span>
                    </div>
                  </div>
                </section>
              </>
            )}

            {server?.last_scraped_at && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <Calendar className="h-5 w-5" />
                    Metadata
                  </h3>
                  <div className="space-y-1 text-sm">
                    <div>
                      <span className="text-muted-foreground">
                        Last Updated:{" "}
                      </span>
                      {new Date(server.last_scraped_at).toLocaleDateString()}
                    </div>
                    {server.programming_language && (
                      <div>
                        <span className="text-muted-foreground">
                          Language:{" "}
                        </span>
                        {server.programming_language}
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}

            {content && (
              <>
                <Separator />
                <section>
                  <h3 className="text-xl font-semibold mb-3 flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    README
                  </h3>
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
                </section>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
