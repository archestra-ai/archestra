"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import {
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  Eye,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  Table2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentDialog } from "@/components/agent-dialog";
import { AgentIcon } from "@/components/agent-icon";
import { CloneAgentDialog } from "@/components/clone-agent-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PostCreateConnectDialog } from "@/components/post-create-connect-dialog";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDeleteProfile,
  useProfile,
  useProfilesPaginated,
  useRestoreProfile,
  useUpdateProfile,
} from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";
import { VirtualKeysCard } from "./virtual-keys-card";

export default function LlmProxyWorkspacePage() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <LlmProxyWorkspace />
      </ErrorBoundary>
    </div>
  );
}

type ProxyRow = archestraApiTypes.GetAgentsResponses["200"]["data"][number];

// The switcher lists every active proxy the user can see; 100 covers real
// deployments — beyond that, "All LLM Proxies" is the management surface.
const SWITCHER_LIMIT = 100;

function LlmProxyWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data: proxiesResponse, isPending: proxiesPending } =
    useProfilesPaginated({
      limit: SWITCHER_LIMIT,
      offset: 0,
      sortBy: "name",
      sortDirection: "asc",
      agentTypes: ["llm_proxy", "profile"],
    });

  const proxies = useMemo(
    () => sortProxies(proxiesResponse?.data ?? []),
    [proxiesResponse],
  );

  // "Opening it selects Default LLM Proxy": the org default (isDefault), not
  // the per-user personal proxy that /api/llm-proxy/default ensures.
  const idParam = searchParams.get("id");
  const selectedId =
    idParam ?? proxies.find((p) => p.isDefault)?.id ?? proxies[0]?.id;
  const { data: selectedProxy, isPending: selectedPending } =
    useProfile(selectedId);

  const selectProxy = useCallback(
    (id: string) => {
      router.replace(`/llm/proxies?id=${encodeURIComponent(id)}`, {
        scroll: false,
      });
    },
    [router],
  );

  // Same modify rules as the management table: org admins, team admins of the
  // proxy's team, and owners of personal proxies.
  const { data: isAdmin } = useHasPermissions({ llmProxy: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({ llmProxy: ["team-admin"] });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: userTeams } = useMyTeams({ enabled: !!canReadTeams });
  const userTeamIdSet = useMemo(
    () => new Set((userTeams ?? []).map((t) => t.id)),
    [userTeams],
  );
  const canModify = useMemo(() => {
    if (!selectedProxy) return false;
    const isOwner = !!currentUserId && selectedProxy.authorId === currentUserId;
    const isMemberOfProxyTeam = selectedProxy.teams?.some((t) =>
      userTeamIdSet.has(t.id),
    );
    return (
      !!isAdmin ||
      (selectedProxy.scope === "team" &&
        !!isTeamAdmin &&
        !!isMemberOfProxyTeam) ||
      (selectedProxy.scope === "personal" && isOwner)
    );
  }, [selectedProxy, isAdmin, isTeamAdmin, currentUserId, userTeamIdSet]);

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [cloningProxy, setCloningProxy] = useState<Pick<
    ProxyRow,
    "id" | "name" | "agentType" | "scope" | "teams"
  > | null>(null);
  const [postCreateProxy, setPostCreateProxy] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const updateProfile = useUpdateProfile();
  const restoreProfile = useRestoreProfile();

  const setAsDefault = useCallback(() => {
    if (!selectedProxy) return;
    updateProfile.mutate(
      { id: selectedProxy.id, data: { isDefault: true } },
      {
        onSuccess: (data) => {
          if (!data) return;
          toast.success(`"${data.name}" is now the default LLM Proxy`);
        },
      },
    );
  }, [selectedProxy, updateProfile]);

  const restoreSelected = useCallback(() => {
    if (!selectedProxy) return;
    restoreProfile.mutate(selectedProxy.id, {
      onSuccess: (data) => {
        if (!data) return;
        toast.success("LLM Proxy restored successfully");
      },
    });
  }, [selectedProxy, restoreProfile]);

  const bootstrapping = proxiesPending;
  const detailLoading = !!selectedId && selectedPending && !selectedProxy;
  if (bootstrapping || detailLoading) {
    return <WorkspaceSkeleton />;
  }

  if (proxies.length === 0 && !selectedProxy) {
    return (
      <>
        <WorkspaceEmptyState onCreate={() => setIsCreateDialogOpen(true)} />
        <AgentDialog
          open={isCreateDialogOpen}
          onOpenChange={setIsCreateDialogOpen}
          agentType="llm_proxy"
          defaultIconType="llm_proxy"
          onCreated={(created) => {
            setIsCreateDialogOpen(false);
            setPostCreateProxy(created);
            selectProxy(created.id);
          }}
        />
        <PostCreateConnectDialog
          created={postCreateProxy}
          agentType="llm_proxy"
          onOpenChange={(open) => {
            if (!open) setPostCreateProxy(null);
          }}
        />
      </>
    );
  }

  if (!selectedProxy) {
    // The id param points at a proxy that doesn't exist or isn't visible.
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
        <Alert>
          <AlertDescription>
            This LLM Proxy doesn't exist or you don't have access to it.{" "}
            <Link href="/llm/proxies" className="underline">
              Open the default proxy
            </Link>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const isDefault = selectedProxy.isDefault;
  const isDeleted = !!selectedProxy.deletedAt;

  return (
    <div
      className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8"
      data-testid={E2eTestId.LlmProxyWorkspace}
    >
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted">
            <AgentIcon
              icon={selectedProxy.icon}
              size={22}
              fallbackType="llm_proxy"
            />
          </div>
          <div className="min-w-0">
            <ProxySwitcher
              proxies={proxies}
              selectedId={selectedProxy.id}
              selectedName={selectedProxy.name}
              onSelect={selectProxy}
              onCreate={() => setIsCreateDialogOpen(true)}
            />
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {isDefault && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 text-amber-600 dark:text-amber-400"
                >
                  Default
                </Badge>
              )}
              <ResourceVisibilityBadge
                scope={selectedProxy.scope}
                teams={selectedProxy.teams}
                authorId={selectedProxy.authorId}
                authorName={selectedProxy.authorName}
                currentUserId={currentUserId}
                showSelfAsMe
              />
              {isDeleted ? (
                <Badge variant="destructive">Deleted</Badge>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  Active
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <PermissionButton
            permissions={{ llmProxy: ["update"] }}
            variant="outline"
            disabled={!canModify}
            onClick={() => setIsEditDialogOpen(true)}
            data-testid={`${E2eTestId.EditAgentButton}-${selectedProxy.name}`}
          >
            <Pencil className="h-4 w-4" />
            Edit
          </PermissionButton>
          <Button asChild data-testid={E2eTestId.LlmProxyConnectClientButton}>
            <Link
              href={`/connection?proxyId=${encodeURIComponent(selectedProxy.id)}&from=table`}
            >
              Connect a client
            </Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <Ellipsis className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <PermissionGatedMenuItem
                permissions={{ llmProxy: ["create"] }}
                onClick={() => setIsCreateDialogOpen(true)}
              >
                <Plus className="h-4 w-4" />
                New proxy
              </PermissionGatedMenuItem>
              <PermissionGatedMenuItem
                permissions={{ llmProxy: ["create"] }}
                onClick={() => setCloningProxy(selectedProxy)}
              >
                <Copy className="h-4 w-4" />
                Clone proxy
              </PermissionGatedMenuItem>
              {!isDefault && !isDeleted && (
                <PermissionGatedMenuItem
                  permissions={{ llmProxy: ["admin"] }}
                  onClick={setAsDefault}
                >
                  <Star className="h-4 w-4" />
                  Set as default
                </PermissionGatedMenuItem>
              )}
              <DropdownMenuItem asChild>
                <Link href="/llm/proxies/manage">
                  <Table2 className="h-4 w-4" />
                  All LLM Proxies
                </Link>
              </DropdownMenuItem>
              {canModify && !isDeleted && (
                <>
                  <DropdownMenuSeparator />
                  <PermissionGatedMenuItem
                    permissions={{ llmProxy: ["delete"] }}
                    onClick={() => setIsDeleteDialogOpen(true)}
                    variant="destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete proxy
                  </PermissionGatedMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* State banners */}
      {isDeleted && (
        <Alert className="mt-4">
          <RotateCcw className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center gap-3">
            This proxy is deleted. Clients can no longer call it.
            <PermissionButton
              permissions={{ llmProxy: ["delete"] }}
              variant="outline"
              size="sm"
              disabled={!canModify || restoreProfile.isPending}
              onClick={restoreSelected}
            >
              Restore
            </PermissionButton>
          </AlertDescription>
        </Alert>
      )}
      {!isDeleted && !canModify && (
        <Alert className="mt-4">
          <Eye className="h-4 w-4" />
          <AlertDescription>
            View only. You can use this proxy and manage your own Virtual API
            Keys; editing the proxy itself requires an admin or owner role.
          </AlertDescription>
        </Alert>
      )}

      {/* Overview */}
      <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(260px,0.7fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <VirtualKeysCard />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ConfigurationCard
            proxy={selectedProxy}
            canModify={canModify}
            currentUserId={currentUserId}
            onEdit={() => setIsEditDialogOpen(true)}
          />
          <RelatedResourcesCard proxyId={selectedProxy.id} />
        </div>
      </div>

      {/* Dialogs */}
      <AgentDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        agentType="llm_proxy"
        defaultIconType="llm_proxy"
        onCreated={(created) => {
          setIsCreateDialogOpen(false);
          setPostCreateProxy(created);
          selectProxy(created.id);
        }}
      />
      <PostCreateConnectDialog
        created={postCreateProxy}
        agentType="llm_proxy"
        onOpenChange={(open) => {
          if (!open) setPostCreateProxy(null);
        }}
      />
      {isEditDialogOpen && (
        <AgentDialog
          open={isEditDialogOpen}
          onOpenChange={setIsEditDialogOpen}
          agent={selectedProxy}
          agentType={selectedProxy.agentType}
          defaultIconType="llm_proxy"
        />
      )}
      <CloneAgentDialog
        agent={cloningProxy}
        onOpenChange={(open) => {
          if (!open) setCloningProxy(null);
        }}
        onCloned={(cloned) => {
          selectProxy(cloned.id);
          setIsEditDialogOpen(true);
        }}
      />
      {isDeleteDialogOpen && (
        <DeleteProxyDialog
          agentId={selectedProxy.id}
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          onDeleted={() => router.replace("/llm/proxies", { scroll: false })}
        />
      )}
    </div>
  );
}

// =========================================================================
// Header switcher
// =========================================================================

function ProxySwitcher({
  proxies,
  selectedId,
  selectedName,
  onSelect,
  onCreate,
}: {
  proxies: ProxyRow[];
  selectedId: string;
  selectedName: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: canCreate } = useHasPermissions({ llmProxy: ["create"] });

  const groups = useMemo(() => {
    const visible = proxies.filter(
      (proxy) =>
        !search || proxy.name.toLowerCase().includes(search.toLowerCase()),
    );
    return {
      org: visible.filter((p) => p.scope === "org"),
      team: visible.filter((p) => p.scope === "team"),
      personal: visible.filter((p) => p.scope === "personal"),
    };
  }, [proxies, search]);

  const handleSelect = (id: string) => {
    onSelect(id);
    setOpen(false);
    setSearch("");
  };

  const renderGroup = (heading: string, items: ProxyRow[]) =>
    items.length > 0 && (
      <CommandGroup heading={heading}>
        {items.map((proxy) => (
          <CommandItem
            key={proxy.id}
            value={proxy.id}
            onSelect={() => handleSelect(proxy.id)}
            className="justify-between"
          >
            <span className="flex min-w-0 items-center gap-2">
              <AgentIcon icon={proxy.icon} fallbackType="llm_proxy" />
              <span className="truncate">{proxy.name}</span>
              {proxy.isDefault && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400"
                >
                  Default
                </Badge>
              )}
            </span>
            <Check
              className={cn(
                "h-4 w-4",
                proxy.id === selectedId ? "opacity-100" : "opacity-0",
              )}
            />
          </CommandItem>
        ))}
      </CommandGroup>
    );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Switch LLM Proxy"
          data-testid={E2eTestId.LlmProxySwitcherTrigger}
          className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-left text-2xl font-semibold tracking-tight hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">{selectedName}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Find a proxy..."
          />
          <CommandList>
            <CommandEmpty>No proxies found.</CommandEmpty>
            {renderGroup("Organization", groups.org)}
            {renderGroup("Team", groups.team)}
            {renderGroup("Personal", groups.personal)}
          </CommandList>
        </Command>
        <div className="flex items-center justify-between border-t px-2 py-1.5">
          {canCreate ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              <Plus className="h-4 w-4" />
              New proxy
            </Button>
          ) : (
            <span />
          )}
          <Button variant="ghost" size="sm" asChild>
            <Link href="/llm/proxies/manage">All LLM Proxies</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// =========================================================================
// Sidebar cards
// =========================================================================

function ConfigurationCard({
  proxy,
  canModify,
  currentUserId,
  onEdit,
}: {
  proxy: NonNullable<ReturnType<typeof useProfile>["data"]>;
  canModify: boolean;
  currentUserId: string | undefined;
  onEdit: () => void;
}) {
  const { data: canReadEnvironments } = useHasPermissions({
    environment: ["read"],
  });
  const { data: environmentList } = useEnvironments(
    !!canReadEnvironments && !!proxy.environmentId,
  );
  const environmentName = proxy.environmentId
    ? (environmentList?.environments.find((e) => e.id === proxy.environmentId)
        ?.name ?? "…")
    : "Default";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">Configuration</CardTitle>
          {canModify && (
            <Button
              variant="ghost"
              size="sm"
              className="-mt-1 text-primary"
              onClick={onEdit}
            >
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ConfigurationRow label="Accessible to">
          <ResourceVisibilityBadge
            scope={proxy.scope}
            teams={proxy.teams}
            authorId={proxy.authorId}
            authorName={proxy.authorName}
            currentUserId={currentUserId}
            showSelfAsMe
          />
        </ConfigurationRow>
        <ConfigurationRow label="Environment">
          {environmentName}
        </ConfigurationRow>
        <ConfigurationRow label="Passthrough headers">
          {proxy.passthroughHeaders?.length
            ? `${proxy.passthroughHeaders.length} configured`
            : "None"}
        </ConfigurationRow>
        {proxy.labels && proxy.labels.length > 0 && (
          <ConfigurationRow label="Labels">
            <span className="flex flex-wrap gap-1">
              {proxy.labels.map((label) => (
                <Badge
                  key={`${label.key}:${label.value}`}
                  variant="outline"
                  className="text-xs font-normal"
                >
                  {label.key}: {label.value}
                </Badge>
              ))}
            </span>
          </ConfigurationRow>
        )}
      </CardContent>
    </Card>
  );
}

function ConfigurationRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}

function RelatedResourcesCard({ proxyId }: { proxyId: string }) {
  const resources = [
    {
      title: "Model Providers",
      description: "Upstream connections shared with Chat",
      href: "/llm/model-providers",
    },
    {
      title: "Client Credentials",
      description: "All Virtual API Keys and OAuth clients",
      href: "/credentials/virtual-keys",
    },
    {
      title: "Connect",
      description: "Client-specific setup for this proxy",
      href: `/connection?proxyId=${encodeURIComponent(proxyId)}&from=table`,
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Related resources</CardTitle>
        <CardDescription>
          Global resources used with this proxy.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-3 pb-3">
        {resources.map((resource) => (
          <Link
            key={resource.href}
            href={resource.href}
            className="flex items-center justify-between gap-2 rounded-md px-3 py-2 hover:bg-muted/60"
          >
            <span>
              <span className="block text-sm font-medium">
                {resource.title}
              </span>
              <span className="block text-xs text-muted-foreground">
                {resource.description}
              </span>
            </span>
            <span className="text-muted-foreground">→</span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

// =========================================================================
// States and dialogs
// =========================================================================

function WorkspaceSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
      <div className="flex items-center gap-3 border-b pb-5">
        <Skeleton className="h-11 w-11 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-36" />
        </div>
      </div>
      <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(260px,0.7fr)]">
        <Skeleton className="h-64" />
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    </div>
  );
}

function WorkspaceEmptyState({ onCreate }: { onCreate: () => void }) {
  const { data: canCreate } = useHasPermissions({ llmProxy: ["create"] });
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16 md:px-8">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Set up your LLM Proxy</EmptyTitle>
          <EmptyDescription>
            One endpoint for every model provider, with policies, cost
            attribution, and full request logs.
            {!canCreate &&
              " Ask an admin for access to a proxy — none are visible to you yet."}
          </EmptyDescription>
        </EmptyHeader>
        {canCreate && (
          <EmptyContent>
            <PermissionButton
              permissions={{ llmProxy: ["create"] }}
              onClick={onCreate}
              data-testid={E2eTestId.CreateAgentButton}
            >
              <Plus className="h-4 w-4" />
              Create LLM Proxy
            </PermissionButton>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}

function PermissionGatedMenuItem({
  permissions,
  onClick,
  variant,
  children,
}: {
  permissions: Parameters<typeof useHasPermissions>[0];
  onClick: () => void;
  variant?: "destructive";
  children: React.ReactNode;
}) {
  const { data: allowed } = useHasPermissions(permissions);
  if (!allowed) return null;
  return (
    <DropdownMenuItem onClick={onClick} variant={variant}>
      {children}
    </DropdownMenuItem>
  );
}

function DeleteProxyDialog({
  agentId,
  open,
  onOpenChange,
  onDeleted,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const deleteProxy = useDeleteProfile();

  const handleDelete = useCallback(async () => {
    const result = await deleteProxy.mutateAsync(agentId);
    if (result) {
      toast.success("LLM Proxy deleted successfully");
      onOpenChange(false);
      onDeleted();
    }
  }, [agentId, deleteProxy, onOpenChange, onDeleted]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete LLM Proxy"
      description="Are you sure you want to delete this LLM Proxy? This action cannot be undone."
      isPending={deleteProxy.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete LLM Proxy"
      pendingLabel="Deleting..."
    />
  );
}

// =========================================================================
// Helpers
// =========================================================================

function sortProxies(proxies: ProxyRow[]) {
  const scopeRank = { org: 0, team: 1, personal: 2 } as const;
  return [...proxies]
    .filter((proxy) => !proxy.deletedAt)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const scopeDiff =
        (scopeRank[a.scope as keyof typeof scopeRank] ?? 3) -
        (scopeRank[b.scope as keyof typeof scopeRank] ?? 3);
      if (scopeDiff !== 0) return scopeDiff;
      return a.name.localeCompare(b.name);
    });
}
