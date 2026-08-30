"use client";

import {
  Download,
  Loader2,
  MoreHorizontal,
  PackageOpen,
  Pencil,
  Puzzle,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  type OverviewFact,
  OverviewSummary,
} from "@/components/overview-summary";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { TableCard, TableCardGrid } from "@/components/table-card-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useBundle, useDeleteBundle } from "@/lib/bundle.query";
import { usePlugins } from "@/lib/plugins/plugin.query";
import { useAllSkills } from "@/lib/skills/skill.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import {
  bundleConnectionHref,
  bundleEditHref,
} from "../_parts/bundle-page-config";

export default function BundleDetailPage({ bundleId }: { bundleId: string }) {
  const router = useRouter();
  const {
    data: bundle,
    isPending,
    isLoadingError,
    refetch,
  } = useBundle(bundleId);
  const { data: skills = [] } = useAllSkills();
  const { data: plugins = [] } = usePlugins();
  const { data: gateways = [] } = useProfiles({
    filters: { agentTypes: ["profile", "mcp_gateway"] },
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteBundle = useDeleteBundle();
  const { data: canDelete } = useHasPermissions({ bundle: ["delete"] });

  if (isPending) {
    return (
      <PageLayout title="Bundle" maxWidth="wizard">
        <div className="flex min-h-64 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </PageLayout>
    );
  }
  if (isLoadingError) {
    return (
      <PageLayout title="Bundle" maxWidth="wizard">
        <QueryLoadError title="Couldn't load this bundle" onRetry={refetch} />
      </PageLayout>
    );
  }
  if (!bundle) {
    return (
      <PageLayout title="Bundle not found" maxWidth="wizard">
        <p className="text-sm text-muted-foreground">
          This bundle no longer exists or is not accessible.
        </p>
      </PageLayout>
    );
  }

  const gateway = gateways.find((item) => item.id === bundle.mcpGatewayId);
  const facts: OverviewFact[] = [
    { label: "Skills", value: bundle.skillIds.length },
    { label: "Plugins", value: bundle.pluginIds.length },
    { label: "Local MCPs", value: bundle.localMcpServers.length },
    { label: "MCP gateway", value: gateway?.name ?? "Keep current gateway" },
    { label: "Updated", value: formatRelativeTimeFromNow(bundle.updatedAt) },
  ];
  const resolvedSkills = bundle.skillIds.map((id) => ({
    id,
    skill: skills.find((skill) => skill.id === id),
  }));
  const resolvedPlugins = bundle.pluginIds.map((id) => ({
    id,
    plugin: plugins.find((plugin) => plugin.id === id),
  }));
  const hasCapabilities =
    resolvedSkills.length > 0 ||
    resolvedPlugins.length > 0 ||
    bundle.localMcpServers.length > 0;

  return (
    <PageLayout
      title={bundle.name}
      documentTitle={bundle.name}
      status={<Badge variant="secondary">Beta</Badge>}
      description={bundle.description || "A reusable connection setup."}
      backLink={
        <Link
          className="text-sm text-muted-foreground hover:text-foreground"
          href="/bundles"
        >
          Back to Bundles
        </Link>
      }
      maxWidth="wizard"
      actionButton={
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <Link href={bundleConnectionHref(bundle.id)}>
              <Download className="size-4" />
              <span>Install</span>
            </Link>
          </Button>
          <PermissionButton
            permissions={{ bundle: ["update"] }}
            variant="outline"
            asChild
          >
            <Link href={bundleEditHref(bundle.id)}>
              <Pencil className="size-4" />
              <span>Edit</span>
            </Link>
          </PermissionButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <MoreHorizontal className="size-4" />
                <span className="sr-only">More actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                aria-disabled={canDelete !== true || undefined}
                className={
                  canDelete === true
                    ? undefined
                    : "cursor-not-allowed opacity-50"
                }
                onSelect={(event) => {
                  if (canDelete !== true) event.preventDefault();
                }}
                onClick={(event) => {
                  if (canDelete !== true) {
                    event.preventDefault();
                    return;
                  }
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="size-4" />
                <span>Delete</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      <div className="space-y-10">
        <OverviewSummary
          headingId="bundle-overview"
          facts={facts}
          configHref={bundleEditHref(bundle.id)}
        />
        <section aria-labelledby="bundle-capabilities" className="space-y-6">
          <div className="space-y-1">
            <h2 id="bundle-capabilities" className="text-base font-semibold">
              Capabilities
            </h2>
            <p className="text-sm text-muted-foreground">
              Skills are delivered together as one generated plugin. Native
              plugins stay independently managed and are filtered for client
              compatibility during installation.
            </p>
          </div>
          {hasCapabilities ? (
            <div className="space-y-10">
              {resolvedSkills.length > 0 ? (
                <BundleMemberSection
                  id="bundle-skills"
                  title="Skills"
                  items={resolvedSkills.map(({ id, skill }) => ({
                    id,
                    name: skill?.name ?? "Skill no longer available",
                    href: skill
                      ? `/skills/${encodeURIComponent(id)}`
                      : undefined,
                    icon: <Sparkles className="size-4" />,
                  }))}
                />
              ) : null}
              {resolvedPlugins.length > 0 ? (
                <BundleMemberSection
                  id="bundle-plugins"
                  title="Plugins"
                  items={resolvedPlugins.map(({ id, plugin }) => ({
                    id,
                    name: plugin?.displayName ?? "Plugin no longer available",
                    description: plugin?.clientType,
                    href: plugin
                      ? `/plugins/${encodeURIComponent(id)}`
                      : undefined,
                    icon: <Puzzle className="size-4" />,
                  }))}
                />
              ) : null}
              {bundle.localMcpServers.length > 0 ? (
                <BundleMemberSection
                  id="bundle-local-mcp-servers"
                  title="Local MCP servers"
                  items={bundle.localMcpServers.map((server) => ({
                    id: server.id,
                    name: server.name,
                    description: `${server.command}${server.args.length > 0 ? ` ${server.args.join(" ")}` : ""} · ${server.optional ? "Optional" : "Required"}`,
                    icon: <Terminal className="size-4" />,
                  }))}
                />
              ) : null}
            </div>
          ) : (
            <Empty className="border p-6 md:p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PackageOpen />
                </EmptyMedia>
                <EmptyTitle>No capabilities in this bundle</EmptyTitle>
                <EmptyDescription>
                  Add skills, plugins, or local MCP servers before using this
                  bundle as a connection starting point.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <PermissionButton permissions={{ bundle: ["update"] }} asChild>
                  <Link href={bundleEditHref(bundle.id)}>
                    <Pencil className="size-4" />
                    <span>Edit bundle</span>
                  </Link>
                </PermissionButton>
              </EmptyContent>
            </Empty>
          )}
        </section>
      </div>
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete bundle?"
        description="Existing marketplace installations will no longer receive updates from this Bundle."
        isPending={deleteBundle.isPending}
        onConfirm={() =>
          deleteBundle.mutate(bundle.id, {
            onSuccess: (deleted) => deleted && router.push("/bundles"),
          })
        }
      />
    </PageLayout>
  );
}

function BundleMemberSection({
  id,
  title,
  items,
}: {
  id: string;
  title: string;
  items: Array<{
    id: string;
    name: string;
    description?: string;
    href?: string;
    icon: React.ReactNode;
  }>;
}) {
  const router = useRouter();

  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        <Badge variant="secondary">{items.length}</Badge>
      </div>
      <TableCardGrid>
        {items.map((item) => {
          const href = item.href;
          return (
            <TableCard
              key={item.id}
              icon={item.icon}
              title={
                href ? (
                  <Link href={href}>{item.name}</Link>
                ) : (
                  <span>{item.name}</span>
                )
              }
              description={item.description}
              className={href ? undefined : "opacity-60"}
              onNavigate={href ? () => router.push(href) : undefined}
            />
          );
        })}
      </TableCardGrid>
    </section>
  );
}
