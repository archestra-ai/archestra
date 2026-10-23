"use client";

import type { archestraCatalogTypes } from "@archestra/shared";
import { BookOpen, Github, PackageX } from "lucide-react";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
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
import { ServerDetails } from "./server-details";

export function McpRegistryServerDetailPage({ name }: { name: string }) {
  const { data: server, isPending } = useMcpRegistryServer(name);

  return (
    <PageLayout
      stackHeaderOnMobile
      maxWidth="wide"
      icon={
        server?.icon ? (
          <img src={server.icon} alt="" className="size-7 object-contain" />
        ) : undefined
      }
      title={
        server ? (
          <span className="block min-w-0 truncate">
            {server.display_name || server.name}
          </span>
        ) : (
          <span>MCP Server</span>
        )
      }
      documentTitle={server ? server.display_name || server.name : "MCP Server"}
      description={
        server ? (
          <span className="flex flex-col gap-1">
            {server.display_name && server.display_name !== server.name && (
              <span className="font-mono text-xs">{server.name}</span>
            )}
            {server.description && <span>{server.description}</span>}
          </span>
        ) : undefined
      }
      backLink={
        <PageBackLink href="/mcp/registry">Back to MCP Registry</PageBackLink>
      }
      actionButton={
        server ? <ServerHeaderActions server={server} /> : undefined
      }
    >
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
    </PageLayout>
  );
}

function ServerHeaderActions({
  server,
}: {
  server: archestraCatalogTypes.ArchestraMcpServerManifest;
}) {
  return (
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
