"use client";

import {
  type AgentType,
  archestraApiSdk,
  type archestraApiTypes,
  E2eTestId,
} from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Plus, Upload, LayoutGrid, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import { AgentDialog } from "@/components/agent-dialog";
import { AgentIcon } from "@/components/agent-icon";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  ActiveFilterBadges,
  AgentScopeFilter,
} from "@/components/agent-scope-filter";
import {
  ConnectDialog,
  ConnectDialogSection,
} from "@/components/connect-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ImportAgentDialog } from "@/components/import-agent-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DEFAULT_SORT_BY, DEFAULT_SORT_DIRECTION } from "@/consts";
import {
  useCloneAgent,
  useDeleteProfile,
  useExportAgent,
  useProfile,
  useProfiles,
  useProfilesPaginated,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { AgentActions } from "./agent-actions";

type AgentsInitialData = {
  agents: archestraApiTypes.GetAgentsResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
  templates?: any[]; // [ISSUE #3858] Added templates to initial data
};

export default function AgentsPage({
  initialData,
}: {
  initialData?: AgentsInitialData;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Agents initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

// ... (SortIcon function stays exactly the same)
function SortIcon({
  isSorted,
}: {
  isSorted:
    | NonNullable<archestraApiTypes.GetAgentsData["query"]>["sortDirection"]
    | false;
}) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") return upArrow;
  if (isSorted === "desc") return downArrow;
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

function Agents({ initialData }: { initialData?: AgentsInitialData }) {
  const {
    searchParams,
    pathname,
    pageIndex,
    pageSize,
    offset,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();
  const router = useRouter();

  // URL Params parsing...
  const nameFilter = searchParams.get("name") || "";
  const sortByFromUrl = searchParams.get("sortBy") as any;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as any;
  const scopeFromUrl = searchParams.get("scope") as any;
  const teamIdsFromUrl = searchParams.get("teamIds");
  const authorIdsFromUrl = searchParams.get("authorIds");
  const excludeAuthorIdsFromUrl = searchParams.get("excludeAuthorIds");
  const labelsFromUrl = searchParams.get("labels");

  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;

  const { data: agentsResponse, isPending } = useProfilesPaginated({
    initialData: initialData?.agents ?? undefined,
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
    agentTypes: ["agent"],
    scope: scopeFromUrl || undefined,
    teamIds: teamIdsFromUrl ? teamIdsFromUrl.split(",") : undefined,
    authorIds: authorIdsFromUrl ? authorIdsFromUrl.split(",") : undefined,
    excludeAuthorIds: excludeAuthorIdsFromUrl ? excludeAuthorIdsFromUrl.split(",") : undefined,
    excludeOtherPersonalAgents: scopeFromUrl !== "personal" && !authorIdsFromUrl && !excludeAuthorIdsFromUrl ? true : undefined,
    labels: labelsFromUrl || undefined,
  });

  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: userTeams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams({ query: { limit: 100, offset: 0 } });
      return data?.data || [];
    },
    initialData: initialData?.teams,
    enabled: !!canReadTeams,
  });

  const { data: isAgentAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: isAgentTeamAdmin } = useHasPermissions({ agent: ["team-admin"] });
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const userTeamIdSet = new Set((userTeams ?? []).map((t) => t.id));

  const [sorting, setSorting] = useState<SortingState>([{ id: sortBy, desc: sortDirection === "desc" }]);
  useEffect(() => { setSorting([{ id: sortBy, desc: sortDirection === "desc" }]); }, [sortBy, sortDirection]);

  type AgentData = archestraApiTypes.GetAgentsResponses["200"]["data"][number];

  // --- [ISSUE #3858] Template Catalog State ---
  const [showCatalog, setShowCatalog] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<any>(null);

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingAgent, setConnectingAgent] = useState<any>(null);
  const [editingAgent, setEditingAgent] = useState<AgentData | null>(null);
  const [viewingAgent, setViewingAgent] = useState<AgentData | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);

  const cloneAgent = useCloneAgent();
  const handleClone = useCallback(async (agentId: string) => {
    try {
      const cloned = await cloneAgent.mutateAsync(agentId);
      if (cloned) setEditingAgent(cloned as AgentData);
    } catch (_error) {}
  }, [cloneAgent]);

  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const exportAgent = useExportAgent();

  // Sorting & Pagination Handlers...
  const handleSortingChange = useCallback((updater: any) => {
    const newSorting = typeof updater === "function" ? updater(sorting) : updater;
    setSorting(newSorting);
    updateQueryParams({
      page: "1",
      sortBy: newSorting.length > 0 ? newSorting[0].id : null,
      sortDirection: newSorting.length > 0 ? (newSorting[0].desc ? "desc" : "asc") : null,
    });
  }, [sorting, updateQueryParams]);

  const handlePaginationChange = useCallback((newPagination: any) => setPagination(newPagination), [setPagination]);

  const agents = agentsResponse?.data || [];
  const pagination = agentsResponse?.pagination;
  const showLoading = isPending && !initialData?.agents;
  const hasActiveFilters = !!(nameFilter || scopeFromUrl || labelsFromUrl);

  const clearFilters = useCallback(() => {
    updateQueryParams({ page: "1", name: null, scope: null, teamIds: null, authorIds: null, excludeAuthorIds: null, labels: null });
  }, [updateQueryParams]);

  // Columns definition stays the same...
  const columns: ColumnDef<AgentData>[] = [
    { id: "icon", size: 40, enableSorting: false, header: "", cell: ({ row }) => (<div className="flex items-center justify-center"><AgentIcon icon={row.original.icon} size={20} /></div>) },
    { id: "name", accessorKey: "name", size: 240, header: ({ column }) => (<Button variant="ghost" className="h-auto !p-0 font-medium hover:bg-transparent" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}>Name <SortIcon isSorted={column.getIsSorted()} /></Button>), cell: ({ row }) => (<AgentNameCell name={row.original.name} scope={row.original.scope} builtIn={row.original.builtIn ?? undefined} description={row.original.description} labels={row.original.labels} />) },
    { id: "toolsCount", accessorKey: "toolsCount", header: ({ column }) => (<Button variant="ghost" className="h-auto !p-0 font-medium hover:bg-transparent" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}>Tools <SortIcon isSorted={column.getIsSorted()} /></Button>), cell: ({ row }) => (<div>{row.original.tools.filter((t) => !t.delegateToAgentId).length}</div>) },
    { id: "knowledgeSourcesCount", header: ({ column }) => (<Button variant="ghost" className="h-auto !p-0 font-medium hover:bg-transparent" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}>Knowledge Sources <SortIcon isSorted={column.getIsSorted()} /></Button>), cell: ({ row }) => (<div>{(row.original.knowledgeBaseIds?.length ?? 0) + (row.original.connectorIds?.length ?? 0)}</div>) },
    { id: "subagentsCount", accessorKey: "subagentsCount", header: ({ column }) => (<Button variant="ghost" className="h-auto !p-0 font-medium hover:bg-transparent" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}>Subagents <SortIcon isSorted={column.getIsSorted()} /></Button>), cell: ({ row }) => (<div>{row.original.tools.filter((t) => t.delegateToAgentId).length}</div>) },
    ...(isAgentAdmin ? [{ id: "team", header: "Accessible to", enableSorting: false, cell: ({ row }: any) => (<ResourceVisibilityBadge scope={row.original.scope} teams={row.original.teams} authorId={row.original.authorId} authorName={row.original.authorName} currentUserId={currentUserId} />) }] : []),
    { id: "actions", header: "Actions", enableHiding: false, size: 220, cell: ({ row }) => (<AgentActions agent={row.original} canModify={!!isAgentAdmin || (row.original.scope === "team" && !!isAgentTeamAdmin && row.original.teams?.some((t) => userTeamIdSet.has(t.id))) || (row.original.scope === "personal" && row.original.authorId === currentUserId)} onConnect={setConnectingAgent} onEdit={setEditingAgent} onView={setViewingAgent} onDelete={setDeletingAgentId} onClone={handleClone} onExport={(agentData) => exportAgent.mutate(agentData.id, { onSuccess: (data) => { if (!data) return; const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `${agentData.name.replace(/\s+/g, "-").toLowerCase()}-agent.json`; a.click(); URL.revokeObjectURL(url); } })} />) },
  ];

  return (
    <LoadingWrapper isPending={showLoading} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title="Agents"
        description={<p className="text-sm text-muted-foreground">Agents are AI assistants with system prompts, tools, knowledge sources, and integrations like ChatOps, email, and A2A.</p>}
        actionButton={
          <div className="flex gap-2">
            <PermissionButton variant="outline" permissions={{ agent: ["create"] }} onClick={() => setIsImportDialogOpen(true)}>
              <Upload className="mr-2 h-4 w-4" /> Import Agent
            </PermissionButton>
            <PermissionButton permissions={{ agent: ["create"] }} onClick={() => setShowCatalog(true)} data-testid={E2eTestId.CreateAgentButton}>
              <Sparkles className="mr-2 h-4 w-4" /> Template Catalog
            </PermissionButton>
          </div>
        }
      >
        <div className="space-y-6">
          {/* --- [ISSUE #3858] Template Catalog UI --- */}
          {showCatalog && (
            <div className="bg-muted/30 p-6 rounded-lg border border-dashed border-primary/50 animate-in fade-in duration-500">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2 text-primary">
                  <LayoutGrid className="h-5 w-5" /> Select an Agent Template
                </h3>
                <Button variant="ghost" size="sm" onClick={() => setShowCatalog(false)}>Close Catalog</Button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {initialData?.templates?.map((template) => (
                  <Card 
                    key={template.id} 
                    className="cursor-pointer hover:border-primary transition-all hover:shadow-md"
                    onClick={() => {
                      setSelectedTemplate(template);
                      setIsCreateDialogOpen(true);
                      setShowCatalog(false);
                    }}
                  >
                    <CardHeader className="p-4 pb-2">
                      <CardTitle className="text-md flex items-center justify-between">
                        {template.name}
                        <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full">{template.category}</span>
                      </CardTitle>
                      <CardDescription className="text-xs line-clamp-2">{template.description}</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
                <Card 
                  className="border-dashed flex items-center justify-center cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => {
                    setSelectedTemplate(null);
                    setIsCreateDialogOpen(true);
                    setShowCatalog(false);
                  }}
                >
                  <CardContent className="p-4 text-center">
                    <Plus className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm font-medium">Start from Scratch</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-4">
              <SearchInput objectNamePlural="agents" searchFields={["name"]} paramName="name" />
              <AgentScopeFilter showBuiltIn ownerLabelPlural="agents" />
            </div>
            {!canReadTeams && <PermissionRequirementHint message="Team-based filters and sharing details are unavailable without" permissions={[{ resource: "team", action: "read" }]} />}
            <ActiveFilterBadges />
          </div>

          <div data-testid={E2eTestId.AgentsTable}>
            <DataTable columns={columns} data={agents} sorting={sorting} onSortingChange={handleSortingChange} manualSorting manualPagination pagination={{ pageIndex, pageSize, total: pagination?.total ?? 0 }} onPaginationChange={handlePaginationChange} emptyMessage="No agents found" hasActiveFilters={hasActiveFilters} filteredEmptyMessage="No agents match your filters. Try adjusting your search." onClearFilters={clearFilters} />
          </div>

          <AgentDialog
            open={isCreateDialogOpen}
            onOpenChange={(open) => {
              setIsCreateDialogOpen(open);
              if(!open) setSelectedTemplate(null);
            }}
            agentType="agent"
            // [ISSUE #3858] Passing the selected template to the dialog for auto-fill
            initialValues={selectedTemplate ? {
              name: selectedTemplate.name,
              description: selectedTemplate.description,
              systemPrompt: selectedTemplate.systemPrompt,
              model: selectedTemplate.model
            } : undefined}
            onCreated={() => setIsCreateDialogOpen(false)}
          />

          {/* ... (Existing dialogs stay exactly the same) */}
          {connectingAgent && <ConnectAgentDialog agent={connectingAgent} open={!!connectingAgent} onOpenChange={(open) => !open && setConnectingAgent(null)} />}
          <AgentDialog open={!!editingAgent} onOpenChange={(open) => !open && setEditingAgent(null)} agent={editingAgent} agentType="agent" />
          <AgentDialog open={!!viewingAgent} onOpenChange={(open) => !open && setViewingAgent(null)} agent={viewingAgent} agentType="agent" readOnly />
          {deletingAgentId && <DeleteAgentDialog agentId={deletingAgentId} open={!!deletingAgentId} onOpenChange={(open) => !open && setDeletingAgentId(null)} />}
          <ImportAgentDialog open={isImportDialogOpen} onOpenChange={setIsImportDialogOpen} onSuccess={() => {}} />
        </div>
      </PageLayout>
    </LoadingWrapper>
  );
}

// ... (AgentConnectionColumns, ConnectAgentDialog, DeleteAgentDialog stay exactly the same)
function AgentConnectionColumns({ agentId }: { agentId: string }) {
  const appName = useAppName();
  const { data: profiles, isPending } = useProfiles();
  const agent = profiles?.find((p) => p.id === agentId);
  if (isPending || !agent) return (<div className="flex items-center justify-center py-8"><LoadingSpinner /></div>);
  return (
    <div className="space-y-6">
      <ConnectDialogSection title="A2A Connection" description={`Connect directly to this agent with ${appName}'s A2A endpoint, tokens, deep links, and optional email invocation.`}>
        <A2AConnectionInstructions agent={agent} />
      </ConnectDialogSection>
    </div>
  );
}

function ConnectAgentDialog({ agent, open, onOpenChange }: any) {
  return (<ConnectDialog agent={agent} open={open} onOpenChange={onOpenChange} docsPage="platform-agents"><AgentConnectionColumns agentId={agent.id} /></ConnectDialog>);
}

function DeleteAgentDialog({ agentId, open, onOpenChange }: any) {
  const deleteAgent = useDeleteProfile();
  const handleDelete = useCallback(async () => {
    const result = await deleteAgent.mutateAsync(agentId);
    if (result) { toast.success("Agent deleted successfully"); onOpenChange(false); }
  }, [agentId, deleteAgent, onOpenChange]);
  return (<DeleteConfirmDialog open={open} onOpenChange={onOpenChange} title="Delete Agent" description="Are you sure you want to delete this agent? This action cannot be undone." isPending={deleteAgent.isPending} onConfirm={handleDelete} confirmLabel="Delete Agent" pendingLabel="Deleting..." />);
}
