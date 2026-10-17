"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  isBuiltInCatalogId,
} from "@archestra/shared";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ToolChecklist } from "@/components/agent-tools-editor";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ServerToolsUpdateError,
  useAllProfileTools,
  useUpdateAgentServerTools,
} from "@/lib/agent-tools.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { useCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServersGroupedByCatalog } from "@/lib/mcp/mcp-server.query";
import { cn } from "@/lib/utils/tailwind";
import { QuickEditFooter, QuickEditViewHeader } from "./view-header";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export function ChooseToolsView({
  agentId,
  agentName,
  catalog,
  backLabel,
  onBack,
  onDone,
}: {
  agentId: string;
  agentName: string;
  catalog: CatalogItem;
  backLabel: string;
  onBack: () => void;
  onDone: (catalogId: string) => void;
}) {
  const { data: allTools = [], isLoading } = useCatalogTools(catalog.id);
  const allCredentials = useMcpServersGroupedByCatalog({
    catalogId: catalog.id,
  });
  const { data: assignedToolsData } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    includeToolDetails: false,
    enabled: !!agentId,
  });
  const { catalogName: builtInCatalogName } = useArchestraMcpIdentity();
  const serverTools = useUpdateAgentServerTools();
  const builtIn = isBuiltInCatalogId(catalog.id);
  const name =
    catalog.id === ARCHESTRA_MCP_CATALOG_ID ? builtInCatalogName : catalog.name;

  // Only org and team connections can be pinned; a personal one belongs to
  // whoever made it, so the backend refuses to share it.
  const shareableServers = useMemo(
    () =>
      (allCredentials?.[catalog.id] ?? []).filter(
        (server) => server.scope === "org" || server.scope === "team",
      ),
    [allCredentials, catalog.id],
  );

  const existing = useMemo(() => {
    const toolIds = new Set<string>();
    let pinnedServerId: string | null = null;
    for (const assignment of assignedToolsData?.data ?? []) {
      if (assignment.tool.catalogId !== catalog.id) continue;
      toolIds.add(assignment.tool.id);
      if (
        assignment.credentialResolutionMode === "static" &&
        assignment.mcpServerId
      ) {
        pinnedServerId = assignment.mcpServerId;
      }
    }
    return { toolIds, pinnedServerId };
  }, [assignedToolsData, catalog.id]);

  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    new Set(),
  );
  const [mode, setMode] = useState<"dynamic" | "static">("dynamic");
  const [pinnedServerId, setPinnedServerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // Start from what is assigned, or everything for a server not yet added.
  useEffect(() => {
    if (initializedRef.current || allTools.length === 0 || !assignedToolsData)
      return;
    initializedRef.current = true;
    setSelectedToolIds(
      existing.toolIds.size > 0
        ? new Set(existing.toolIds)
        : new Set(allTools.map((tool) => tool.id)),
    );
    if (existing.pinnedServerId) {
      setMode("static");
      setPinnedServerId(existing.pinnedServerId);
    }
  }, [allTools, assignedToolsData, existing]);

  const isEditing = existing.toolIds.size > 0;
  const credentialChanged =
    !builtIn &&
    isEditing &&
    (mode === "static" ? pinnedServerId : null) !== existing.pinnedServerId;
  const toAdd = credentialChanged
    ? [...selectedToolIds]
    : [...selectedToolIds].filter((id) => !existing.toolIds.has(id));
  const toRemove = [...existing.toolIds].filter(
    (id) => !selectedToolIds.has(id),
  );
  const hasChanges = toAdd.length > 0 || toRemove.length > 0;
  const staticIncomplete = mode === "static" && !pinnedServerId;

  const save = () => {
    setError(null);
    serverTools.mutate(
      {
        agentId,
        add: toAdd,
        remove: toRemove,
        builtIn,
        credential:
          mode === "static" && pinnedServerId
            ? { mode: "static", mcpServerId: pinnedServerId }
            : { mode: "dynamic" },
      },
      {
        onSuccess: () => onDone(catalog.id),
        onError: (refusal) =>
          setError(
            refusal instanceof ServerToolsUpdateError && refusal.addedCount > 0
              ? `${refusal.addedCount} of ${refusal.requestedAddCount} tools were added. ${refusal.message}`
              : refusal.message,
          ),
      },
    );
  };

  const saveLabel = isEditing
    ? `Save (${selectedToolIds.size} ${selectedToolIds.size === 1 ? "tool" : "tools"})`
    : `Add ${toAdd.length} ${toAdd.length === 1 ? "tool" : "tools"}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <QuickEditViewHeader
        backLabel={backLabel}
        onBack={onBack}
        title={name}
        icon={
          <McpCatalogIcon
            icon={catalog.icon}
            catalogId={catalog.id}
            size={18}
          />
        }
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {!builtIn && (
          <div className="shrink-0 space-y-2 px-5 pt-4 pb-3">
            <h3 id="credential-mode-label" className="text-sm font-semibold">
              Whose connection do the tools use?
            </h3>
            <RadioGroup
              aria-labelledby="credential-mode-label"
              value={mode}
              onValueChange={(value) => setMode(value as "dynamic" | "static")}
              className="gap-2"
            >
              <Label
                className={cn(
                  radioCardClass({ checked: mode === "dynamic" }),
                  "flex cursor-pointer items-start gap-3 rounded-lg p-3 font-normal",
                )}
              >
                <RadioGroupItem value="dynamic" className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    Each person's own connection
                    <Badge variant="secondary">Recommended</Badge>
                  </span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">
                    Whoever is chatting uses their own {name} connection, unless
                    the server is set to always use one account. People who
                    haven't connected are asked to.
                  </span>
                </span>
              </Label>
              <Label
                className={cn(
                  radioCardClass({
                    checked: mode === "static",
                    disabled: shareableServers.length === 0,
                  }),
                  "flex items-start gap-3 rounded-lg p-3 font-normal",
                  shareableServers.length > 0
                    ? "cursor-pointer"
                    : "cursor-not-allowed",
                )}
              >
                <RadioGroupItem
                  value="static"
                  className="mt-0.5"
                  disabled={shareableServers.length === 0}
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-sm font-medium">
                    One shared connection
                  </span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">
                    Everyone uses the same connection. Only team or organization
                    connections can be shared.
                  </span>
                  <Select
                    value={pinnedServerId ?? undefined}
                    onValueChange={(value) => {
                      setPinnedServerId(value);
                      setMode("static");
                    }}
                    disabled={shareableServers.length === 0}
                  >
                    <SelectTrigger
                      size="sm"
                      className="mt-2 w-72"
                      aria-label="Shared connection"
                    >
                      <SelectValue
                        placeholder={
                          shareableServers.length === 0
                            ? "No shared connections available"
                            : "Choose a connection"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {shareableServers.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.scope === "org"
                            ? "Organization connection"
                            : `Team: ${server.teamDetails?.name ?? "Unknown team"}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>
              </Label>
            </RadioGroup>
          </div>
        )}

        {error && (
          <div className="shrink-0 px-5 pb-3">
            <InlineNotice variant="error" role="alert">
              <AlertTriangle />
              <InlineNoticeBody>
                <span className="font-medium">Couldn't update {name}</span>
                <InlineNoticeText>{error}</InlineNoticeText>
              </InlineNoticeBody>
            </InlineNotice>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col px-5 pb-1">
          <h3 className="mb-2 shrink-0 text-sm font-semibold">Tools</h3>
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>Loading tools…</span>
            </div>
          ) : allTools.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {name} reports no tools.
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
              <ToolChecklist
                tools={allTools}
                catalogId={catalog.id}
                selectedToolIds={selectedToolIds}
                onSelectionChange={setSelectedToolIds}
              />
            </div>
          )}
        </div>
      </div>

      <QuickEditFooter>
        <span className="text-xs text-muted-foreground">
          {isEditing
            ? `Changes apply to ${agentName}`
            : `Added to ${agentName}`}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={
              !hasChanges ||
              staticIncomplete ||
              (selectedToolIds.size === 0 && !isEditing) ||
              serverTools.isPending
            }
          >
            {serverTools.isPending && <Loader2 className="animate-spin" />}
            <span>{saveLabel}</span>
          </Button>
        </div>
      </QuickEditFooter>
    </div>
  );
}
