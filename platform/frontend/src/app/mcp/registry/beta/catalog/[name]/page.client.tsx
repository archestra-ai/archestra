"use client";

import type { archestraCatalogTypes } from "@archestra/shared";
import {
  ArrowLeft,
  BookOpen,
  Code2,
  ExternalLink,
  FileText,
  Github,
  Globe,
  Info,
  PackageX,
  Settings,
  Star,
  Terminal,
  Users,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useMcpRegistryServer } from "@/lib/mcp/external-mcp-catalog.query";
import { ReadmeMarkdown } from "./readme-markdown";

export function McpRegistryServerDetailPage({ name }: { name: string }) {
  const { data: server, isPending } = useMcpRegistryServer(name);

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/mcp/registry/beta">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to MCP Registry
        </Link>
      </Button>

      {isPending ? (
        <DetailPageSkeleton />
      ) : !server ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageX />
            </EmptyMedia>
            <EmptyTitle>Server not found</EmptyTitle>
            <EmptyDescription>
              "{name}" is not in the MCP server catalog. It may have been
              removed or renamed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ServerDetails server={server} />
      )}
    </div>
  );
}

function ServerDetails({
  server,
}: {
  server: archestraCatalogTypes.ArchestraMcpServerManifest;
}) {
  const displayName = server.display_name || server.name;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          {server.icon && (
            <img
              src={server.icon}
              alt={`${displayName} icon`}
              className="h-12 w-12 shrink-0 rounded-lg border bg-background p-1"
            />
          )}
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              {displayName}
            </h1>
            {server.display_name && server.display_name !== server.name && (
              <p className="font-mono text-xs text-muted-foreground">
                {server.name}
              </p>
            )}
            {server.description && (
              <p className="max-w-2xl text-sm text-muted-foreground">
                {server.description}
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              {server.server && (
                <Badge variant="secondary" className="capitalize">
                  {server.server.type}
                </Badge>
              )}
              {server.category && (
                <Badge variant="outline">{server.category}</Badge>
              )}
              {server.programming_language && (
                <Badge variant="outline">{server.programming_language}</Badge>
              )}
              {server.license && (
                <Badge variant="outline">{server.license}</Badge>
              )}
              {server.quality_score !== null &&
                server.quality_score !== undefined && (
                  <Badge variant="outline">
                    Quality {Math.round(server.quality_score)}
                  </Badge>
                )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {server.github_info?.url && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={server.github_info.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="h-4 w-4 mr-1" />
                GitHub
              </a>
            </Button>
          )}
          {(server.documentation || server.homepage) && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={server.documentation || server.homepage}
                target="_blank"
                rel="noopener noreferrer"
              >
                <BookOpen className="h-4 w-4 mr-1" />
                Docs
              </a>
            </Button>
          )}
        </div>
      </div>

      <Separator />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {(server.long_description ||
            (server.keywords && server.keywords.length > 0)) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Info className="h-4 w-4" />
                  Overview
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {server.long_description && (
                  <p className="text-muted-foreground">
                    {server.long_description}
                  </p>
                )}
                {server.keywords && server.keywords.length > 0 && (
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
                )}
              </CardContent>
            </Card>
          )}

          {server.tools && server.tools.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Code2 className="h-4 w-4" />
                  Tools
                  <Badge variant="secondary">{server.tools.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {server.tools.map((tool) => (
                  <div
                    key={tool.name}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <div className="font-mono font-semibold">{tool.name}</div>
                    {tool.description && (
                      <div className="mt-1 text-muted-foreground">
                        {tool.description}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {server.prompts && server.prompts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4" />
                  Prompts
                  <Badge variant="secondary">{server.prompts.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {server.prompts.map((prompt) => (
                  <div
                    key={`${prompt.name}-${prompt.text}`}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <div className="font-mono font-semibold">{prompt.name}</div>
                    {prompt.description && (
                      <div className="mt-1 text-muted-foreground">
                        {prompt.description}
                      </div>
                    )}
                    {prompt.arguments && prompt.arguments.length > 0 && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Arguments: {prompt.arguments.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {server.user_config && Object.keys(server.user_config).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Settings className="h-4 w-4" />
                  Configuration Options
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(server.user_config).map(([key, config]) => (
                  <div key={key} className="rounded-lg border p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-mono font-semibold">{key}</div>
                      <div className="flex gap-1">
                        <Badge variant="outline" className="text-xs">
                          {config.type}
                        </Badge>
                        {config.required && (
                          <Badge variant="destructive" className="text-xs">
                            Required
                          </Badge>
                        )}
                        {config.sensitive && (
                          <Badge variant="secondary" className="text-xs">
                            Sensitive
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {config.description}
                    </div>
                    {config.default !== undefined && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Default: {String(config.default)}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {server.readme && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4" />
                  README
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ReadmeMarkdown content={server.readme} />
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="min-w-0 space-y-6">
          {server.server && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Terminal className="h-4 w-4" />
                  Server
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <SidebarRow label="Type">
                  <Badge variant="outline" className="capitalize">
                    {server.server.type}
                  </Badge>
                </SidebarRow>
                {server.server.type === "local" && (
                  <>
                    <SidebarRow label="Command">
                      <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {server.server.command}
                      </code>
                    </SidebarRow>
                    {server.server.args && server.server.args.length > 0 && (
                      <SidebarRow label="Arguments">
                        <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {server.server.args.join(" ")}
                        </code>
                      </SidebarRow>
                    )}
                    {server.server.env &&
                      Object.keys(server.server.env).length > 0 && (
                        <SidebarRow label="Environment">
                          <div className="space-y-1 rounded bg-muted p-2">
                            {Object.entries(server.server.env).map(
                              ([key, value]) => (
                                <div
                                  key={key}
                                  className="break-all font-mono text-xs"
                                >
                                  <span className="text-foreground">{key}</span>
                                  ={value}
                                </div>
                              ),
                            )}
                          </div>
                        </SidebarRow>
                      )}
                  </>
                )}
                {server.server.type === "remote" && (
                  <>
                    <SidebarRow label="URL">
                      <ExternalLinkText href={server.server.url} />
                    </SidebarRow>
                    {server.server.docs_url && (
                      <SidebarRow label="Docs URL">
                        <ExternalLinkText href={server.server.docs_url} />
                      </SidebarRow>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {server.author && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4" />
                  Author
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <SidebarRow label="Name">{server.author.name}</SidebarRow>
                {server.author.email && (
                  <SidebarRow label="Email">
                    <a
                      href={`mailto:${server.author.email}`}
                      className="break-all text-primary hover:underline"
                    >
                      {server.author.email}
                    </a>
                  </SidebarRow>
                )}
                {server.author.url && (
                  <SidebarRow label="URL">
                    <ExternalLinkText href={server.author.url} />
                  </SidebarRow>
                )}
              </CardContent>
            </Card>
          )}

          {(server.homepage || server.documentation || server.support) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Globe className="h-4 w-4" />
                  Links
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {server.homepage && (
                  <SidebarRow label="Homepage">
                    <ExternalLinkText href={server.homepage} />
                  </SidebarRow>
                )}
                {server.documentation && (
                  <SidebarRow label="Documentation">
                    <ExternalLinkText href={server.documentation} />
                  </SidebarRow>
                )}
                {server.support && (
                  <SidebarRow label="Support">
                    <ExternalLinkText href={server.support} />
                  </SidebarRow>
                )}
              </CardContent>
            </Card>
          )}

          {server.compatibility && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Info className="h-4 w-4" />
                  Compatibility
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {server.compatibility.platforms &&
                  server.compatibility.platforms.length > 0 && (
                    <SidebarRow label="Platforms">
                      <div className="flex flex-wrap gap-1">
                        {server.compatibility.platforms.map((platform) => (
                          <Badge key={platform} variant="outline">
                            {platform}
                          </Badge>
                        ))}
                      </div>
                    </SidebarRow>
                  )}
                {server.compatibility.runtimes?.python && (
                  <SidebarRow label="Python">
                    {server.compatibility.runtimes.python}
                  </SidebarRow>
                )}
                {server.compatibility.runtimes?.node && (
                  <SidebarRow label="Node">
                    {server.compatibility.runtimes.node}
                  </SidebarRow>
                )}
                {server.compatibility.claude_desktop && (
                  <SidebarRow label="Claude Desktop">
                    {server.compatibility.claude_desktop}
                  </SidebarRow>
                )}
              </CardContent>
            </Card>
          )}

          {server.github_info && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Github className="h-4 w-4" />
                  GitHub
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <SidebarRow label="Stars">
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Star className="h-3.5 w-3.5 text-yellow-500" />
                    {server.github_info.stars}
                  </span>
                </SidebarRow>
                <SidebarRow label="Contributors">
                  {server.github_info.contributors}
                </SidebarRow>
                <SidebarRow label="Issues">
                  {server.github_info.issues}
                </SidebarRow>
                <SidebarRow label="Releases">
                  {server.github_info.releases ? "Yes" : "No"}
                </SidebarRow>
                {server.last_scraped_at && (
                  <SidebarRow label="Last updated">
                    {new Date(server.last_scraped_at).toLocaleDateString()}
                  </SidebarRow>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ExternalLinkText({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 break-all text-primary hover:underline"
    >
      {href}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

function DetailPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <Skeleton className="h-12 w-12 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-14" />
          </div>
        </div>
      </div>
      <Separator />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
