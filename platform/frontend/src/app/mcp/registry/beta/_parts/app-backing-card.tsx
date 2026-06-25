"use client";

import { AppWindow, ExternalLink, MessageSquare, Pencil } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { fetchInternalAgents, useCreateProfile } from "@/lib/agent.query";
import { useBulkAssignTools } from "@/lib/agent-tools.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import { fetchCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { resolveCatalogEnvironmentLabel } from "../../_parts/catalog-environment-label";
import { AppSettingsDialog } from "./app-settings-dialog";
import type { CatalogItem } from "./mcp-server-card";

/**
 * Registry card for an owned app's `serverType:"app"` backing. Unlike the
 * install-oriented `McpServerCard`, it carries no install/uninstall/deploy
 * chrome: the body is read-only and all edits (visibility, environment, enabled
 * tools, delete) live behind the top-right pencil, mirroring the regular card.
 */
export function AppBackingCard({ item }: { item: CatalogItem }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isChatCreating, setIsChatCreating] = useState(false);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const createAgent = useCreateProfile();
  const bulkAssignTools = useBulkAssignTools();

  const { data: canUpdate } = useHasPermissions({ app: ["update"] });
  const { data: canAdmin } = useHasPermissions({ app: ["admin"] });
  const { data: canTeamAdmin } = useHasPermissions({ app: ["team-admin"] });
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  const canManage =
    !!item.appId && (canUpdate || canAdmin || canTeamAdmin || canDelete);

  const { data: environmentList } = useEnvironments();
  const defaultEnvironment = useDefaultEnvironment();
  const environmentLabel = resolveCatalogEnvironmentLabel({
    environmentId: item.environmentId,
    environments: environmentList?.environments ?? [],
    defaultEnvironmentName: defaultEnvironment.name,
  });

  // Mirror McpServerCard's "Chat": get-or-create a personal agent named after
  // the app, assign the app's MCP tools, and open a fresh chat with it.
  const handleChatWithApp = async () => {
    setIsChatCreating(true);
    try {
      const existingAgents = await fetchInternalAgents();
      const existing = existingAgents?.find(
        (a) => a.name === item.name && a.authorId === currentUserId,
      );

      const agent =
        existing ??
        (await createAgent.mutateAsync({
          name: item.name,
          agentType: "agent",
          scope: "personal",
          teams: [],
          icon: item.icon ?? undefined,
        }));

      const tools = await fetchCatalogTools(item.id);

      if (agent && tools.length > 0) {
        await bulkAssignTools.mutateAsync({
          assignments: tools.map((tool) => ({
            agentId: agent.id,
            toolId: tool.id,
            resolveAtCallTime: true,
            ...(item.enterpriseManagedConfig
              ? { credentialResolutionMode: "enterprise_managed" as const }
              : {}),
          })),
        });
      }

      if (agent) {
        window.location.href = `/chat/new?agent_id=${agent.id}`;
      }
    } catch {
      toast.error("Failed to create chat agent");
    } finally {
      setIsChatCreating(false);
    }
  };

  const toolsCount = item.toolCount ?? 0;

  return (
    <Card
      className="flex flex-col relative pt-4 gap-4 h-full"
      data-testid={`app-backing-card-${item.name}`}
    >
      <CardHeader className="gap-0">
        <div className="flex items-start justify-between gap-4 overflow-hidden">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 overflow-hidden w-full">
              <McpCatalogIcon icon={item.icon} catalogId={item.id} size={20} />
              <TruncatedTooltip content={item.name}>
                <span className="text-lg font-semibold whitespace-nowrap text-ellipsis overflow-hidden">
                  {item.name}
                </span>
              </TruncatedTooltip>
              <Badge variant="secondary" className="shrink-0 gap-1">
                <AppWindow className="h-3 w-3" />
                App
              </Badge>
              {environmentLabel && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-muted-foreground"
                >
                  <span className="max-w-32 truncate">{environmentLabel}</span>
                </Badge>
              )}
            </div>
            {item.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              data-testid={`app-backing-card-settings-${item.name}`}
              aria-label={`Edit ${item.name}`}
              onClick={() => setSettingsOpen(true)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 flex-grow">
        <div className="mt-auto flex flex-col gap-4">
          <div className="flex items-center gap-3 text-sm text-muted-foreground border-t pt-3">
            <ResourceVisibilityBadge
              scope={item.scope}
              teams={item.teams}
              authorId={item.authorId}
              authorName={item.authorName ?? undefined}
              currentUserId={currentUserId}
            />
          </div>
          {item.appId && (
            <div className="flex items-center gap-2">
              {toolsCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={isChatCreating}
                  onClick={handleChatWithApp}
                >
                  <MessageSquare className="h-4 w-4" />
                  {isChatCreating ? "Creating..." : "Chat"}
                </Button>
              )}
              <Button asChild variant="outline" size="sm" className="flex-1">
                <Link href={`/apps/${item.appId}`}>
                  <ExternalLink className="h-4 w-4" />
                  Open standalone
                </Link>
              </Button>
            </div>
          )}
        </div>
      </CardContent>
      {canManage && item.appId && (
        <AppSettingsDialog
          appId={item.appId}
          item={item}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </Card>
  );
}
