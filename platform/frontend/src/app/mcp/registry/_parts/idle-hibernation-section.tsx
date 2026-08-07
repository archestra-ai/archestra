"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { useUpdateInternalMcpCatalogItem } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useOrganization } from "@/lib/organization.query";
import { useCanModifyCatalogItem } from "./catalog-edit-access";
import type { CatalogItem } from "./mcp-server-card";

type HibernationMode = "inherit" | "enabled" | "disabled";

const HIBERNATION_MODE_LABELS: Record<HibernationMode, string> = {
  inherit: "Inherit organization setting",
  enabled: "Always allow",
  disabled: "Never hibernate this server",
};

const DEFAULT_HIBERNATION_MODE: HibernationMode = "inherit";

/**
 * Per-server override of the organization's idle-hibernation setting, shown on
 * the edit page's configuration step.
 *
 * Only self-hosted servers have a deployment to scale to zero, and the override
 * is meaningless while the organization keeps every server running, so the row
 * stays hidden unless this is a local server in an org that hibernates idle
 * servers on an active enterprise licence. Saves on change through the same
 * catalog-update mutation the rest of the form uses, and is gated by the same
 * authorization as editing the catalog item.
 */
export function IdleHibernationSection({ item }: { item: CatalogItem }) {
  const { data: organization } = useOrganization();
  const enterpriseCoreActive = useEnterpriseFeature("core");
  // Beta feature: with the deployment flag off, the control does not exist.
  const hibernationBeta = useFeature("mcpIdleHibernationBetaEnabled");
  const { canModify } = useCanModifyCatalogItem(item);
  const updateMutation = useUpdateInternalMcpCatalogItem();
  const { data: servers = [] } = useMcpServers();

  // The override lives on the installed server rows, which the catalog update
  // writes across every install of this catalog item — so any one of them
  // reports the current value.
  const mode =
    servers.find((server) => server.catalogId === item.id)?.hibernationMode ??
    DEFAULT_HIBERNATION_MODE;

  const orgHibernationEnabled =
    organization?.mcpIdleHibernationEnabled ?? false;
  if (
    item.serverType !== "local" ||
    !hibernationBeta ||
    !enterpriseCoreActive ||
    !orgHibernationEnabled ||
    !canModify
  ) {
    return null;
  }

  const handleChange = (next: string) => {
    if (next === mode) return;
    updateMutation.mutate({
      id: item.id,
      data: { hibernationMode: next as HibernationMode },
    });
  };

  return (
    <div className="shrink-0 border-b px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="max-w-xl space-y-1">
          <h4 className="text-sm font-medium">Idle hibernation</h4>
          <p className="text-sm text-muted-foreground">
            A server set to never hibernate stays running even when the
            organization hibernates idle servers.
          </p>
        </div>
        <Select
          value={mode}
          disabled={updateMutation.isPending}
          onValueChange={handleChange}
        >
          <SelectTrigger className="w-[320px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(HIBERNATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value} className="cursor-pointer">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
