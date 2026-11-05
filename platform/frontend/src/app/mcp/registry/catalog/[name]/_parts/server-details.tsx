"use client";

import type { archestraCatalogTypes } from "@archestra/shared";
import {
  ArrowUpRight,
  BookOpen,
  CircleDot,
  Code2,
  FileText,
  GitFork,
  Settings2,
  Star,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ReadmeMarkdown } from "./readme-markdown";

export function ServerDetails({
  server,
}: {
  server: archestraCatalogTypes.ArchestraMcpServerManifest;
}) {
  const runtime = server.server;
  const configuration = Object.entries(server.user_config ?? {});
  return (
    <div className="min-w-0 space-y-7">
      <div className="grid min-w-0 items-start gap-7 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-8">
          {server.readme && (
            <section className="overflow-hidden rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <BookOpen className="size-4 text-muted-foreground" />
                  <span>Documentation</span>
                </h2>
                {server.category && (
                  <span className="text-xs text-muted-foreground">
                    {server.category}
                  </span>
                )}
              </div>
              <div className="p-6 text-sm sm:p-8 [&_.github-markdown>*]:max-w-none [&_.github-markdown>h1:first-of-type]:mt-0 [&_.github-markdown_h2]:mt-10 [&_.github-markdown_p]:leading-7">
                <ReadmeMarkdown content={server.readme} />
              </div>
            </section>
          )}
          {server.long_description && (
            <section className="px-1">
              <h2 className="mb-3 text-lg font-semibold">Overview</h2>
              <p className="text-sm leading-7 text-muted-foreground">
                {server.long_description}
              </p>
            </section>
          )}
          {!!server.tools?.length && (
            <section>
              <div className="mb-4 flex items-center gap-2">
                <Code2 className="size-4 text-muted-foreground" />
                <h2 className="text-lg font-semibold">Available tools</h2>
                <Badge variant="secondary">{server.tools.length}</Badge>
              </div>
              <div className="divide-y rounded-lg border">
                {server.tools.map((tool) => (
                  <div key={tool.name} className="space-y-2 px-5 py-4">
                    <h3 className="break-all font-mono text-sm font-medium">
                      {tool.name}
                    </h3>
                    {tool.description && (
                      <p className="text-sm leading-6 text-muted-foreground">
                        {tool.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
          {!!server.prompts?.length && (
            <section>
              <div className="mb-4 flex items-center gap-2">
                <FileText className="size-4 text-muted-foreground" />
                <h2 className="text-lg font-semibold">Prompts</h2>
                <Badge variant="secondary">{server.prompts.length}</Badge>
              </div>
              <div className="divide-y rounded-lg border">
                {server.prompts.map((prompt) => (
                  <div
                    key={`${prompt.name}-${prompt.text}`}
                    className="space-y-2 px-5 py-4"
                  >
                    <h3 className="font-mono text-sm font-medium">
                      {prompt.name}
                    </h3>
                    {prompt.description && (
                      <p className="text-sm leading-6 text-muted-foreground">
                        {prompt.description}
                      </p>
                    )}
                    {!!prompt.arguments?.length && (
                      <p className="text-xs text-muted-foreground">
                        Arguments: {prompt.arguments.join(", ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside aria-label="Server setup" className="min-w-0 space-y-6">
          {configuration.length > 0 && (
            <section className="overflow-hidden rounded-lg border">
              <h2 className="flex items-center gap-2 border-b bg-muted/25 px-4 py-4 text-sm font-semibold">
                <Settings2 className="size-4 text-muted-foreground" />
                <span>Configuration</span>
              </h2>
              <div className="divide-y">
                {configuration.map(([key, config]) => (
                  <div key={key} className="space-y-2 p-4">
                    <h3 className="break-all font-mono text-xs font-medium">
                      {key}
                    </h3>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs text-muted-foreground">
                        {config.type}
                      </span>
                      {config.required && (
                        <Badge variant="outline" className="font-normal">
                          Required
                        </Badge>
                      )}
                      {config.sensitive && (
                        <Badge variant="secondary" className="font-normal">
                          Sensitive
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {config.description}
                    </p>
                    {config.default !== undefined && (
                      <p className="break-all text-xs text-muted-foreground">
                        Default: <code>{String(config.default)}</code>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
          {runtime && (
            <SidebarSection title="Server">
              <Fact label="Type">
                <span className="capitalize">{runtime.type}</span>
              </Fact>
              {server.programming_language && (
                <Fact label="Language">{server.programming_language}</Fact>
              )}
              {runtime.type === "local" ? (
                <>
                  <Fact label="Command">
                    <code className="break-all font-mono">
                      {runtime.command}
                    </code>
                  </Fact>
                  {!!runtime.args?.length && (
                    <Fact label="Arguments">
                      <code className="break-all font-mono">
                        {runtime.args.join(" ")}
                      </code>
                    </Fact>
                  )}
                </>
              ) : (
                <>
                  <Fact label="Endpoint">
                    <ExternalLink href={runtime.url}>
                      {runtime.url}
                    </ExternalLink>
                  </Fact>
                  {runtime.docs_url && (
                    <ExternalLink href={runtime.docs_url}>
                      Connection documentation
                    </ExternalLink>
                  )}
                </>
              )}
            </SidebarSection>
          )}
          {runtime?.type === "local" &&
            runtime.env &&
            Object.keys(runtime.env).length > 0 && (
              <SidebarSection title="Environment">
                <div className="space-y-2 rounded-md bg-muted/50 p-3">
                  {Object.entries(runtime.env).map(([key, value]) => (
                    <p
                      key={key}
                      className="break-all font-mono text-xs leading-5"
                    >
                      {key}={value}
                    </p>
                  ))}
                </div>
              </SidebarSection>
            )}
          {server.author && (
            <SidebarSection title="Publisher">
              <p className="text-sm font-medium">{server.author.name}</p>
              {server.author.url && (
                <ExternalLink href={server.author.url}>
                  Publisher website
                </ExternalLink>
              )}
              {server.author.email && (
                <a
                  className="block break-all text-xs text-muted-foreground hover:text-foreground"
                  href={`mailto:${server.author.email}`}
                >
                  {server.author.email}
                </a>
              )}
            </SidebarSection>
          )}
          {server.github_info && (
            <SidebarSection title="Repository">
              <div className="grid grid-cols-3 divide-x rounded-lg border py-3">
                <Metric
                  icon={<Star className="size-3.5" />}
                  value={server.github_info.stars.toLocaleString()}
                  label="Stars"
                />
                <Metric
                  icon={<GitFork className="size-3.5" />}
                  value={server.github_info.contributors}
                  label="Contributors"
                />
                <Metric
                  icon={<CircleDot className="size-3.5" />}
                  value={server.github_info.issues}
                  label="Issues"
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Releases</span>
                <span>
                  {server.github_info.releases ? "Available" : "None"}
                </span>
              </div>
              {server.license && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>License</span>
                  <span>{server.license}</span>
                </div>
              )}
            </SidebarSection>
          )}
          {(server.homepage || server.documentation || server.support) && (
            <SidebarSection title="Resources">
              {server.homepage && (
                <ExternalLink href={server.homepage}>Website</ExternalLink>
              )}
              {server.documentation && (
                <ExternalLink href={server.documentation}>
                  Documentation
                </ExternalLink>
              )}
              {server.support && (
                <ExternalLink href={server.support}>Support</ExternalLink>
              )}
            </SidebarSection>
          )}
          {server.compatibility && (
            <SidebarSection title="Compatibility">
              <div className="space-y-3">
                {!!server.compatibility.platforms?.length && (
                  <Fact label="Platforms">
                    {server.compatibility.platforms.join(", ")}
                  </Fact>
                )}
                {server.compatibility.runtimes?.node && (
                  <Fact label="Node.js">
                    {server.compatibility.runtimes.node}
                  </Fact>
                )}
                {server.compatibility.runtimes?.python && (
                  <Fact label="Python">
                    {server.compatibility.runtimes.python}
                  </Fact>
                )}
                {server.compatibility.claude_desktop && (
                  <Fact label="Claude Desktop">
                    {server.compatibility.claude_desktop}
                  </Fact>
                )}
              </div>
            </SidebarSection>
          )}
          {!!server.keywords?.length && (
            <SidebarSection title="Topics">
              <div className="flex flex-wrap gap-1.5">
                {server.keywords.map((keyword) => (
                  <Badge
                    key={keyword}
                    variant="secondary"
                    className="font-normal"
                  >
                    {keyword}
                  </Badge>
                ))}
              </div>
            </SidebarSection>
          )}
          {!server.github_info && server.license && (
            <SidebarSection title="License">
              <p className="text-sm text-muted-foreground">{server.license}</p>
            </SidebarSection>
          )}
        </aside>
      </div>
    </div>
  );
}

function Metric({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
}) {
  return (
    <div className="space-y-1.5 text-center">
      <div className="flex justify-center text-muted-foreground">{icon}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function SidebarSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-b pb-5">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center gap-1.5 break-all text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <span>{children}</span>
      <ArrowUpRight className="size-3.5 shrink-0" />
    </a>
  );
}
