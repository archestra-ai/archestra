"use client";

import { parseFullToolName } from "@shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Info, Search, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InstallationProgress } from "@/app/mcp/registry/_parts/installation-progress";
import {
  LocalServerInstallDialog,
  type LocalServerInstallResult,
} from "@/app/mcp/registry/_parts/local-server-install-dialog";
import {
  NoAuthInstallDialog,
  type NoAuthInstallResult,
} from "@/app/mcp/registry/_parts/no-auth-install-dialog";
import {
  RemoteServerInstallDialog,
  type RemoteServerInstallResult,
} from "@/app/mcp/registry/_parts/remote-server-install-dialog";
import { DebouncedInput } from "@/components/debounced-input";
import { OAuthConfirmationDialog } from "@/components/oauth-confirmation-dialog";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";

type AgentTemplate = {
  id: string;
  name: string;
  description: string;
  type: string;
  categories: string[];
  systemPrompt: string;
  llmModel: string | null;
  tools: string[];
  labels: Array<{ key: string; value: string }>;
  icon?: string | null;
};

type AgentTemplateInstallRequirements = {
  templateId: string;
  missingCatalogIds: string[];
  missingCatalogs: Array<{
    catalogId: string;
    catalogName: string;
    serverType: string;
    requiresOauth: boolean;
    userConfigFields: unknown[];
    environmentFields: unknown[];
  }>;
};

function TemplateDetailsDialog({
  template,
  open,
  onOpenChange,
}: {
  template: AgentTemplate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: catalogItems = [] } = useInternalMcpCatalog({});

  const requiredCatalogIds = useMemo(() => {
    const serverNameSet = new Set<string>();
    for (const fullName of template?.tools ?? []) {
      const parsed = parseFullToolName(fullName);
      if (parsed.serverName) serverNameSet.add(parsed.serverName);
    }

    const ids: string[] = [];
    for (const serverName of serverNameSet) {
      const catalogId = catalogItems.find((c) => c.name === serverName)?.id;
      if (catalogId) ids.push(catalogId);
    }
    return ids;
  }, [template?.tools, catalogItems]);

  const toolQueries = useQueries({
    queries: requiredCatalogIds.map((catalogId) => ({
      queryKey: ["mcp-catalog", catalogId, "tools"] as const,
      queryFn: () => fetchCatalogTools(catalogId),
      enabled: open && !!template && requiredCatalogIds.length > 0,
    })),
  });

  const toolDescriptionByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of toolQueries) {
      for (const t of (q.data ?? []) as Array<{
        name: string;
        description: string;
      }>) {
        if (t?.name && t?.description) map.set(t.name, t.description);
      }
    }
    return map;
  }, [toolQueries]);

  if (!template) return null;

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Template details"
      description="Review what this template will configure for the agent."
      size="large"
      bodyClassName="space-y-4"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <div className="text-sm font-medium">About</div>
        <div className="text-sm text-muted-foreground">
          {template.description}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge variant="outline">{template.type}</Badge>
          {(template.categories ?? []).map((c) => (
            <Badge key={c} variant="outline">
              {c}
            </Badge>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2 md:col-span-2">
          <div className="text-sm font-medium">Agent name</div>
          <div className="text-sm text-muted-foreground">{template.name}</div>
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">Model</div>
          <div className="text-sm text-muted-foreground">
            {template.llmModel ? template.llmModel : "Org default"}
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">Tools</div>
          <div className="text-sm text-muted-foreground">
            {(template.tools ?? []).length} selected
          </div>
        </div>
        <div className="space-y-2 md:col-span-2">
          <div className="text-sm font-medium">Labels</div>
          <div className="flex flex-wrap gap-2">
            {(template.labels ?? []).length === 0 ? (
              <span className="text-sm text-muted-foreground">None</span>
            ) : (
              template.labels.map((l) => (
                <Badge key={`${l.key}:${l.value}`} variant="outline">
                  {l.key}:{l.value}
                </Badge>
              ))
            )}
          </div>
        </div>
      </div>

      {(template.tools ?? []).length > 0 ? (
        <div className="space-y-2">
          <div className="text-sm font-medium">Selected tools</div>
          <div className="space-y-2">
            {(template.tools ?? []).map((fullName) => (
              <div key={fullName} className="rounded-md border p-3">
                <div className="font-mono text-xs">{fullName}</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  {toolDescriptionByName.get(fullName) ??
                    "Description not available (tool not discovered yet)."}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="text-sm font-medium">System prompt</div>
        <pre className="whitespace-pre-wrap rounded-md border bg-muted p-3 text-xs leading-relaxed">
          {template.systemPrompt}
        </pre>
      </div>
    </StandardDialog>
  );
}

export function AgentTemplateCatalogPanel({
  enabled,
  onSelectTemplate,
  onRequestClose,
}: {
  enabled: boolean;
  onSelectTemplate?: (template: AgentTemplate) => void;
  onRequestClose?: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [detailsTemplateId, setDetailsTemplateId] = useState<string | null>(
    null,
  );
  const [mcpServersDialogTemplateId, setMcpServersDialogTemplateId] = useState<
    string | null
  >(null);
  const orchestrator = useMcpInstallOrchestrator();
  const { data: catalogItems } = useInternalMcpCatalog({});
  const { data: installedServers = [] } = useMcpServers({});
  const hasInstallingServers = useMemo(
    () =>
      installedServers.some(
        (s) =>
          s.localInstallationStatus === "pending" ||
          s.localInstallationStatus === "discovering-tools",
      ),
    [installedServers],
  );
  const { data: installedServersPolled = [] } = useMcpServers({
    enabled,
    hasInstallingServers,
  });

  const { data: templates = [], isPending } = useQuery({
    queryKey: ["agent-templates"],
    queryFn: async (): Promise<AgentTemplate[]> => {
      const res = await fetch("/api/agent_templates", {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load templates");
      return (await res.json()) as AgentTemplate[];
    },
    enabled,
  });

  const mcpServersDialogRequirementsQuery = useQuery({
    queryKey: [
      "agent-template-requirements-dialog",
      mcpServersDialogTemplateId,
    ],
    queryFn: async (): Promise<AgentTemplateInstallRequirements> => {
      if (!mcpServersDialogTemplateId) throw new Error("No template selected");
      const res = await fetch(
        `/api/agent_templates/${encodeURIComponent(mcpServersDialogTemplateId)}/requirements`,
        { method: "GET", credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load template requirements");
      return (await res.json()) as AgentTemplateInstallRequirements;
    },
    enabled: enabled && !!mcpServersDialogTemplateId,
  });

  const availableTypes = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates) {
      if (t.type) set.add(t.type);
    }
    return ["all", ...Array.from(set).sort()];
  }, [templates]);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates) {
      for (const c of t.categories ?? []) set.add(c);
    }
    return ["all", ...Array.from(set).sort()];
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return templates.filter((t) => {
      const matchesQuery = !q || t.name.toLowerCase().includes(q);
      const matchesType = selectedType === "all" || t.type === selectedType;
      const matchesCategory =
        selectedCategory === "all" ||
        (t.categories ?? []).includes(selectedCategory);
      return matchesQuery && matchesType && matchesCategory;
    });
  }, [templates, searchQuery, selectedType, selectedCategory]);

  const effectiveInstalledServers = hasInstallingServers
    ? installedServersPolled
    : installedServers;

  const installedCatalogIdSet = useMemo(
    () =>
      new Set(
        effectiveInstalledServers.map((s) => s.catalogId).filter(Boolean),
      ),
    [effectiveInstalledServers],
  );

  const requiredMcpServersByTemplateId = useMemo(() => {
    const byId = new Map<
      string,
      Array<{
        serverName: string;
        catalogId: string | null;
        status:
          | "installed"
          | "installing"
          | "failed"
          | "not-installed"
          | "unknown";
        installationStatus: "pending" | "discovering-tools" | null;
      }>
    >();

    const catalogIdByName = new Map<string, string>();
    for (const item of catalogItems ?? []) {
      catalogIdByName.set(item.name, item.id);
    }

    type InstalledServer = (typeof effectiveInstalledServers)[number];
    const installedByCatalogId = new Map<string, InstalledServer>();
    for (const s of effectiveInstalledServers) {
      const catalogId = s.catalogId;
      if (catalogId && !installedByCatalogId.has(catalogId)) {
        installedByCatalogId.set(catalogId, s);
      }
    }

    for (const t of templates) {
      const serverNameSet = new Set<string>();
      for (const fullName of t.tools ?? []) {
        const parsed = parseFullToolName(fullName);
        if (parsed.serverName) serverNameSet.add(parsed.serverName);
      }

      const rows = Array.from(serverNameSet).map((serverName) => {
        const catalogId = catalogIdByName.get(serverName) ?? null;
        if (!catalogId) {
          return {
            serverName,
            catalogId,
            status: "unknown" as const,
            installationStatus: null,
          };
        }

        const installed = installedByCatalogId.get(catalogId);
        if (!installed) {
          return {
            serverName,
            catalogId,
            status: "not-installed" as const,
            installationStatus: null,
          };
        }

        const localStatus = installed.localInstallationStatus ?? "idle";
        if (localStatus === "pending" || localStatus === "discovering-tools") {
          return {
            serverName,
            catalogId,
            status: "installing" as const,
            installationStatus: localStatus,
          };
        }
        if (localStatus === "error") {
          return {
            serverName,
            catalogId,
            status: "failed" as const,
            installationStatus: null,
          };
        }
        return {
          serverName,
          catalogId,
          status: "installed" as const,
          installationStatus: null,
        };
      });

      byId.set(t.id, rows);
    }

    return byId;
  }, [templates, catalogItems, effectiveInstalledServers]);

  const missingCatalogIdCountByTemplateId = useMemo(() => {
    const byId = new Map<string, number>();
    const catalogIdByName = new Map<string, string>();
    for (const item of catalogItems ?? []) {
      catalogIdByName.set(item.name, item.id);
    }

    for (const t of templates) {
      const requiredServerNames = new Set<string>();
      for (const fullName of t.tools ?? []) {
        const parsed = parseFullToolName(fullName);
        if (parsed.serverName) requiredServerNames.add(parsed.serverName);
      }

      let missing = 0;
      for (const serverName of requiredServerNames) {
        const catalogId = catalogIdByName.get(serverName);
        if (!catalogId) continue;
        if (!installedCatalogIdSet.has(catalogId)) missing++;
      }
      byId.set(t.id, missing);
    }

    return byId;
  }, [templates, catalogItems, installedCatalogIdSet]);
  useEffect(() => {
    if (!enabled) return;
    setSearchQuery("");
    setSelectedType("all");
    setSelectedCategory("all");
    setDetailsTemplateId(null);
    setMcpServersDialogTemplateId(null);
  }, [enabled]);

  return (
    <div className="flex flex-col gap-4">
      <div className="ml-1 grid grid-cols-1 items-end gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.5fr)_minmax(0,0.5fr)]">
        <div className="min-w-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <DebouncedInput
              placeholder="Search templates by name..."
              initialValue={searchQuery}
              onChange={setSearchQuery}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        <div className="min-w-0">
          <Select value={selectedType} onValueChange={setSelectedType}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              {availableTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {t === "all" ? "All types" : t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0">
          <Select value={selectedCategory} onValueChange={setSelectedCategory}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              {availableCategories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c === "all" ? "All categories" : c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => `skeleton-${i}`).map((key) => (
            <Card key={key}>
              <CardHeader>
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2 mt-2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full mt-2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between ml-1">
            <p className="text-sm text-muted-foreground">
              {filteredTemplates.length}{" "}
              {filteredTemplates.length === 1 ? "template" : "templates"} found
            </p>
          </div>

          {filteredTemplates.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                No templates match your search criteria.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 overflow-y-auto">
              {filteredTemplates.map((t) => (
                <Card key={t.id} className="flex flex-col">
                  <CardHeader>
                    <div className="flex items-start">
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        <CardTitle className="text-base">{t.name}</CardTitle>
                      </div>
                      <div className="flex flex-wrap gap-1 items-center flex-shrink-0 mt-1">
                        <Badge variant="outline" className="text-xs">
                          {t.type}
                        </Badge>
                        {(t.categories ?? []).slice(0, 1).map((c) => (
                          <Badge key={c} variant="outline" className="text-xs">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono">
                      {t.id}
                    </p>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col space-y-3">
                    {(missingCatalogIdCountByTemplateId.get(t.id) ?? 0) > 0 ? (
                      <Badge variant="destructive" className="text-xs w-fit">
                        Install required MCP servers to enable all tools
                      </Badge>
                    ) : null}

                    {t.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {t.description}
                      </p>
                    )}

                    <div className="flex flex-col gap-2 mt-auto pt-3 justify-end">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setDetailsTemplateId(t.id)}
                          className="flex-1"
                        >
                          <Info className="h-4 w-4 mr-1" />
                          Details
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setMcpServersDialogTemplateId(t.id)}
                          className="flex-1"
                        >
                          <Server className="h-4 w-4 mr-1" />
                          MCP Servers
                        </Button>
                      </div>
                      <Button
                        type="button"
                        onClick={() => {
                          onSelectTemplate?.(t);
                          onRequestClose?.();
                        }}
                        size="sm"
                        className="w-full"
                      >
                        Use as Template
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <TemplateDetailsDialog
        template={templates.find((t) => t.id === detailsTemplateId) ?? null}
        open={!!detailsTemplateId}
        onOpenChange={(open) => {
          if (!open) setDetailsTemplateId(null);
        }}
      />

      <StandardDialog
        open={!!mcpServersDialogTemplateId}
        onOpenChange={(open) => {
          if (!open) setMcpServersDialogTemplateId(null);
        }}
        title="Required MCP servers"
        description="Install the MCP servers required by this template."
        bodyClassName="space-y-3"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setMcpServersDialogTemplateId(null)}
            >
              Close
            </Button>
          </div>
        }
      >
        {mcpServersDialogRequirementsQuery.isPending ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
            requiredMcpServersByTemplateId.get(
              mcpServersDialogTemplateId ?? "",
            ) ?? []
          ).length > 0 ? (
          <div className="space-y-2">
            {(
              requiredMcpServersByTemplateId.get(
                mcpServersDialogTemplateId ?? "",
              ) ?? []
            ).map((req) => {
              const label =
                req.status === "installed"
                  ? "Installed"
                  : req.status === "installing"
                    ? "Installing…"
                    : req.status === "failed"
                      ? "Failed"
                      : req.status === "not-installed"
                        ? "Not installed"
                        : "Unknown";
              const variant =
                req.status === "failed"
                  ? "destructive"
                  : req.status === "installing"
                    ? "secondary"
                    : req.status === "installed"
                      ? "outline"
                      : "outline";

              const catalogItem =
                req.catalogId != null
                  ? catalogItems?.find((i) => i.id === req.catalogId)
                  : undefined;

              return (
                <div key={req.serverName} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {req.serverName}
                      </div>
                      {catalogItem ? (
                        <div className="text-xs text-muted-foreground">
                          {catalogItem.serverType}
                        </div>
                      ) : null}
                    </div>
                    <Badge variant={variant} className="shrink-0">
                      {label}
                    </Badge>
                  </div>

                  {req.status === "installing" ? (
                    <div className="mt-3">
                      <InstallationProgress status={req.installationStatus} />
                    </div>
                  ) : req.catalogId && req.status !== "installed" ? (
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        onClick={() => {
                          if (!req.catalogId) return;
                          orchestrator.triggerInstallByCatalogId(req.catalogId);
                        }}
                        disabled={!catalogItem}
                      >
                        Install…
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            No MCP servers are required for this template.
          </div>
        )}
      </StandardDialog>

      <RemoteServerInstallDialog
        isOpen={orchestrator.isDialogOpened("remote-install")}
        onClose={orchestrator.closeRemoteInstall}
        onConfirm={async (catalogItem, result: RemoteServerInstallResult) => {
          await orchestrator.handleRemoteServerInstallConfirm(
            catalogItem,
            result,
          );
        }}
        catalogItem={orchestrator.selectedCatalogItem}
        isInstalling={orchestrator.isInstalling}
        isReauth={orchestrator.isReauth}
      />
      <LocalServerInstallDialog
        isOpen={orchestrator.isDialogOpened("local-install")}
        onClose={orchestrator.closeLocalInstall}
        onConfirm={async (result: LocalServerInstallResult) => {
          await orchestrator.handleLocalServerInstallConfirm(result);
        }}
        catalogItem={orchestrator.localServerCatalogItem}
        isInstalling={orchestrator.isInstalling}
        isReauth={orchestrator.isReauth}
      />
      <NoAuthInstallDialog
        isOpen={orchestrator.isDialogOpened("no-auth")}
        onClose={orchestrator.closeNoAuth}
        onInstall={async (result: NoAuthInstallResult) => {
          await orchestrator.handleNoAuthConfirm(result);
        }}
        catalogItem={orchestrator.noAuthCatalogItem}
        isInstalling={orchestrator.isInstalling}
      />
      <OAuthConfirmationDialog
        open={orchestrator.isDialogOpened("oauth")}
        onOpenChange={(next) => {
          if (!next) orchestrator.closeOAuth();
        }}
        serverName={orchestrator.selectedCatalogItem?.name ?? "MCP Server"}
        catalogId={orchestrator.selectedCatalogItem?.id}
        onConfirm={orchestrator.handleOAuthConfirm}
        onCancel={orchestrator.closeOAuth}
      />
    </div>
  );
}
