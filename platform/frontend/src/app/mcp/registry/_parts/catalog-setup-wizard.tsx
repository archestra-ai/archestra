"use client";

import {
  MCP_CATALOG_INSTALL_QUERY_PARAM,
  parseFullToolName,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Loader2,
  PlugZap,
  RefreshCw,
  Wand2,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ToolDetailsDialog } from "@/app/mcp/tool-guardrails/_parts/tool-details-dialog";
import { CallPolicyToggle } from "@/components/call-policy-toggle";
import { LoadingSpinner } from "@/components/loading";
import {
  OAuthConfirmationDialog,
  type OAuthInstallResult,
} from "@/components/oauth-confirmation-dialog";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAutoConfigurePolicies } from "@/lib/agent-tools.query";
import { useSession } from "@/lib/auth/auth.query";
import { useInitiateOAuth } from "@/lib/auth/oauth.query";
import {
  setOAuthCatalogId,
  setOAuthReturnUrl,
  setOAuthScope,
  setOAuthServerType,
  setOAuthState,
  setOAuthTeamId,
} from "@/lib/auth/oauth-session";
import {
  useInstallMcpServer,
  useMcpDeploymentStatuses,
  useMcpInstallationStatusCacheSync,
  useMcpServers,
  useReloadMcpServerTools,
} from "@/lib/mcp/mcp-server.query";
import { buildRemoteInstallCredentialPayload } from "@/lib/mcp/remote-install-payload";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
  useCallPolicyMutation,
  useResultPolicyMutation,
  useToolInvocationPolicies,
  useToolResultPolicies,
} from "@/lib/policy.query";
import {
  type CallPolicyAction,
  getCallPolicyActionFromPolicies,
  getResultPolicyActionFromPolicies,
  RESULT_POLICY_ACTION_OPTIONS,
  type ResultPolicyAction,
} from "@/lib/policy.utils";
import {
  type ToolWithAssignmentsData,
  useToolsWithAssignments,
} from "@/lib/tools/tool.query";
import { cn } from "@/lib/utils";
import { InstallationProgress } from "./installation-progress";
import {
  LocalServerInstallDialog,
  type LocalServerInstallResult,
} from "./local-server-install-dialog";
import type { CatalogItem } from "./mcp-server-card";
import {
  RemoteServerInstallDialog,
  type RemoteServerInstallResult,
} from "./remote-server-install-dialog";

export type SetupStepId = "configuration" | "test" | "tools";

export const SETUP_STEPS: Array<{ id: SetupStepId; title: string }> = [
  { id: "configuration", title: "Configuration" },
  { id: "test", title: "Test Connection" },
  { id: "tools", title: "Tools & Guardrails" },
];

export function SetupStepper({
  activeStep,
  onStepClick,
}: {
  activeStep: SetupStepId;
  onStepClick?: (step: SetupStepId) => void;
}) {
  const activeIndex = SETUP_STEPS.findIndex((s) => s.id === activeStep);
  return (
    <ol className="flex flex-wrap items-center gap-3">
      {SETUP_STEPS.map((step, index) => {
        const isActive = index === activeIndex;
        const isComplete = index < activeIndex;
        return (
          <li key={step.id} className="flex items-center gap-3">
            <button
              type="button"
              className={cn(
                "flex items-center gap-2",
                onStepClick ? "cursor-pointer" : "cursor-default",
              )}
              onClick={() => onStepClick?.(step.id)}
            >
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium",
                  isActive &&
                    "border-primary bg-primary text-primary-foreground",
                  isComplete && "border-primary bg-primary/10 text-primary",
                  !isActive && !isComplete && "text-muted-foreground",
                )}
              >
                {isComplete ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-sm",
                  isActive ? "font-medium" : "text-muted-foreground",
                )}
              >
                {step.title}
              </span>
            </button>
            {index < SETUP_STEPS.length - 1 && (
              <span className="h-px w-8 bg-border" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Resolves the install the Test Connection step reports on — the current
 * user's personal connection when present, else the newest install. Shared
 * with the wizard host so it can gate the step's Next button on a connection
 * actually existing.
 */
export function useTestConnectionTarget(item: CatalogItem) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: allMcpServers } = useMcpServers();

  const servers = (allMcpServers ?? []).filter((s) => s.catalogId === item.id);
  const target =
    servers.find((s) => s.ownerId === currentUserId && !s.teamId) ??
    servers
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];
  return { target, status: target?.localInstallationStatus ?? null };
}

/**
 * Installs a personal connection (collecting credentials when the catalog
 * item prompts for them) and reports the connection status live.
 */
export function TestConnectionStep({ item }: { item: CatalogItem }) {
  const deploymentStatuses = useMcpDeploymentStatuses();
  useMcpInstallationStatusCacheSync();
  const installMutation = useInstallMcpServer();
  const initiateOAuthMutation = useInitiateOAuth();
  const queryClient = useQueryClient();

  const { target, status } = useTestConnectionTarget(item);

  // Refresh tool lists once the connection succeeds so the next steps show
  // freshly discovered tools.
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current !== "success" && status === "success") {
      queryClient.invalidateQueries({
        queryKey: ["mcp-catalog", item.id, "tools"],
      });
      queryClient.invalidateQueries({ queryKey: ["tools-with-assignments"] });
    }
    prevStatusRef.current = status;
  }, [status, item.id, queryClient]);

  const [openDialog, setOpenDialog] = useState<
    "local" | "remote" | "oauth" | null
  >(null);

  const promptedEnvVars =
    item.localConfig?.environment?.filter(
      (env) => env.promptOnInstallation === true,
    ) ?? [];
  const promptableUserConfig = Object.values(item.userConfig ?? {}).filter(
    (field) => field.promptOnInstallation !== false,
  );
  const hasPromptedFields =
    promptedEnvVars.length > 0 || promptableUserConfig.length > 0;
  // OAuth chained after env collection is a registry-page flow; the wizard
  // hands off via the install deep link for that combination.
  const needsRegistryHandoff = !!item.oauthConfig && hasPromptedFields;

  const directInstall = () =>
    installMutation.mutateAsync({
      name: item.name,
      catalogId: item.id,
      scope: "personal",
      dontShowToast: true,
    });

  const startInstall = () => {
    if (item.oauthConfig) {
      setOpenDialog("oauth");
      return;
    }
    if (item.serverType === "local") {
      if (hasPromptedFields) {
        setOpenDialog("local");
        return;
      }
      void directInstall();
      return;
    }
    const hasUserConfig =
      item.userConfig && Object.keys(item.userConfig).length > 0;
    if (hasUserConfig) {
      setOpenDialog("remote");
      return;
    }
    void directInstall();
  };

  const handleLocalConfirm = async (result: LocalServerInstallResult) => {
    setOpenDialog(null);
    await installMutation.mutateAsync({
      name: item.name,
      catalogId: result.catalogId,
      environmentValues: result.environmentValues,
      userConfigValues: result.userConfigValues,
      isByosVault: result.isByosVault,
      scope: result.scope,
      teamId:
        result.scope === "team" ? (result.teamId ?? undefined) : undefined,
      serviceAccount: result.serviceAccount,
      dontShowToast: true,
    });
  };

  const handleRemoteConfirm = async (
    catalogItem: CatalogItem,
    result: RemoteServerInstallResult,
  ) => {
    setOpenDialog(null);
    await installMutation.mutateAsync({
      name: catalogItem.name,
      catalogId: result.catalogId,
      ...buildRemoteInstallCredentialPayload(result),
      scope: result.scope,
      teamId:
        result.scope === "team" ? (result.teamId ?? undefined) : undefined,
      dontShowToast: true,
    });
  };

  const handleOAuthConfirm = async (result: OAuthInstallResult) => {
    try {
      const { authorizationUrl, state } =
        await initiateOAuthMutation.mutateAsync({ catalogId: item.id });
      setOAuthState(state);
      setOAuthCatalogId(item.id);
      setOAuthTeamId(result.scope === "team" ? (result.teamId ?? null) : null);
      setOAuthScope(result.scope);
      if (item.serverType === "local") {
        setOAuthServerType("local");
      }
      // Remember where the install started so the callback returns here
      setOAuthReturnUrl(window.location.href);
      window.location.href = authorizationUrl;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to initiate OAuth flow",
      );
    }
  };

  const isInstalling =
    installMutation.isPending ||
    status === "pending" ||
    status === "discovering-tools";

  return (
    <div className="space-y-4">
      {!target && !isInstalling ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugZap />
            </EmptyMedia>
            <EmptyDescription>
              Create a connection to verify the server is reachable and discover
              its tools.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            {needsRegistryHandoff ? (
              <Button asChild>
                <Link
                  href={`/mcp/registry?${MCP_CATALOG_INSTALL_QUERY_PARAM}=${item.id}`}
                >
                  Install
                </Link>
              </Button>
            ) : (
              <Button onClick={startInstall} disabled={isInstalling}>
                Install
              </Button>
            )}
          </EmptyContent>
        </Empty>
      ) : status === "success" ? (
        <div className="flex items-start gap-3 rounded-lg border border-green-600/30 bg-green-500/5 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
          <div className="text-sm">
            <p className="font-medium">Connected</p>
            <p className="text-muted-foreground">
              The server responded and its tools were discovered. Continue to
              review them.
            </p>
          </div>
        </div>
      ) : status === "error" ? (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="min-w-0 text-sm">
              <p className="font-medium">Connection failed</p>
              <p className="break-words">
                {target?.localInstallationError ?? "Installation failed"}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={startInstall}>
              Retry
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/mcp/registry/${item.id}?tab=logs`}>View logs</Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border p-4">
          <InstallationProgress
            status={isInstalling && !status ? "pending" : (status ?? null)}
            serverId={target?.id}
            deploymentStatuses={deploymentStatuses}
          />
        </div>
      )}

      {openDialog === "local" && (
        <LocalServerInstallDialog
          isOpen
          onClose={() => setOpenDialog(null)}
          onConfirm={handleLocalConfirm}
          catalogItem={item}
          isInstalling={installMutation.isPending}
        />
      )}

      <RemoteServerInstallDialog
        isOpen={openDialog === "remote"}
        onClose={() => setOpenDialog(null)}
        onConfirm={handleRemoteConfirm}
        catalogItem={openDialog === "remote" ? item : null}
        isInstalling={installMutation.isPending}
      />

      <OAuthConfirmationDialog
        open={openDialog === "oauth"}
        onOpenChange={(open) => {
          if (!open) setOpenDialog(null);
        }}
        serverName={item.name}
        onConfirm={handleOAuthConfirm}
        onCancel={() => setOpenDialog(null)}
        catalogId={item.id}
      />
    </div>
  );
}

/**
 * Combined review step: every discovered tool with its description, schema,
 * annotations, raw definition, and inline guardrail controls.
 */
export function ToolsAndGuardrailsStep({ item }: { item: CatalogItem }) {
  const queryClient = useQueryClient();
  const [selectedTool, setSelectedTool] =
    useState<ToolWithAssignmentsData | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    prefetchOperators(queryClient);
    prefetchToolInvocationPolicies(queryClient);
    prefetchToolResultPolicies(queryClient);
  }, [queryClient]);

  const { data: toolsData, isPending } = useToolsWithAssignments({
    pagination: { limit: TOOLS_REVIEW_LIMIT, offset: 0 },
    sorting: { sortBy: "name", sortDirection: "asc" },
    filters: { origin: item.id, excludeArchestraTools: true },
  });
  const { data: invocationPolicies } = useToolInvocationPolicies();
  const { data: resultPolicies } = useToolResultPolicies();
  const callPolicyMutation = useCallPolicyMutation();
  const resultPolicyMutation = useResultPolicyMutation();
  const autoConfigureMutation = useAutoConfigurePolicies();
  // Same install the Test Connection step reports on — the reload endpoint
  // needs a concrete server install, not the catalog item.
  const { target: reloadTarget } = useTestConnectionTarget(item);
  const reloadTools = useReloadMcpServerTools();
  // `${toolId}:${field}` entries for in-flight policy updates.
  const [updating, setUpdating] = useState<ReadonlySet<string>>(new Set());

  // Let a subagent pick sensible default policies for every tool on this
  // server in one shot (custom policies are preserved). Replaces the bulk
  // "Configure with Subagent" action from the full guardrails table.
  const configureWithSubagent = async (toolIds: string[]) => {
    if (toolIds.length === 0) return;
    try {
      const result = await autoConfigureMutation.mutateAsync(toolIds);
      if (!result) return;
      const successCount = result.results.filter(
        (r: { success: boolean }) => r.success,
      ).length;
      const failureCount = result.results.length - successCount;
      if (failureCount === 0) {
        toast.success(
          `Default policies configured for ${successCount} tool(s). Custom policies are preserved.`,
        );
      } else {
        toast.warning(
          `Configured ${successCount} tool(s), failed ${failureCount}. Custom policies are preserved.`,
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to auto-configure policies",
      );
    }
  };

  const updatePolicy = async (
    toolId: string,
    field: "callPolicy" | "resultPolicyAction",
    value: CallPolicyAction | ResultPolicyAction,
  ) => {
    const key = `${toolId}:${field}`;
    setUpdating((prev) => new Set(prev).add(key));
    try {
      if (field === "callPolicy") {
        await callPolicyMutation.mutateAsync({
          toolId,
          action: value as CallPolicyAction,
        });
      } else {
        await resultPolicyMutation.mutateAsync({
          toolId,
          action: value as ResultPolicyAction,
        });
      }
    } finally {
      setUpdating((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  if (isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const tools = toolsData?.data ?? [];
  const total = toolsData?.pagination.total ?? tools.length;

  const refreshToolsButton = (
    <PermissionButton
      permissions={{ mcpServerInstallation: ["create"] }}
      variant="outline"
      size="sm"
      disabled={reloadTools.isPending || !reloadTarget}
      onClick={() =>
        reloadTarget &&
        reloadTools.mutate({
          id: reloadTarget.id,
          name: item.name,
          catalogId: item.id,
        })
      }
      tooltip={
        reloadTarget
          ? "Re-sync the registry's tool catalog from the live server so this list shows its current tools"
          : "Connect this server first — refreshing tools needs a live connection"
      }
    >
      {reloadTools.isPending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RefreshCw className="h-4 w-4" />
      )}
      Refresh Tools
    </PermissionButton>
  );

  if (tools.length === 0) {
    return (
      <Empty className="border py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Wrench />
          </EmptyMedia>
          <EmptyDescription>
            No tools discovered yet. Complete the connection test first — tools
            appear once the server is reachable.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>{refreshToolsButton}</EmptyContent>
      </Empty>
    );
  }

  const normalizedSearch = search.trim().toLowerCase();
  const visibleTools = normalizedSearch
    ? tools.filter((tool) => tool.name.toLowerCase().includes(normalizedSearch))
    : tools;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {tools.length} {tools.length === 1 ? "tool" : "tools"} discovered. Set
          guardrails per tool, or let a subagent configure sensible defaults.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {refreshToolsButton}
          <PermissionButton
            permissions={{ agent: ["update"], toolPolicy: ["update"] }}
            variant="outline"
            size="sm"
            onClick={() => configureWithSubagent(tools.map((tool) => tool.id))}
            disabled={autoConfigureMutation.isPending}
          >
            {autoConfigureMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Configuring...
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" />
                Configure with Subagent
              </>
            )}
          </PermissionButton>
        </div>
      </div>
      {tools.length > 5 && (
        <Input
          placeholder="Filter tools by name"
          aria-label="Filter tools"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
      )}
      {total > tools.length && (
        <p className="text-sm text-muted-foreground">
          Showing the first {tools.length} of {total} tools.{" "}
          <Link
            href={`/mcp/tool-guardrails?origin=${item.id}`}
            className="underline underline-offset-4"
          >
            Open the full guardrails table
          </Link>{" "}
          for the rest.
        </p>
      )}

      {visibleTools.map((tool) => (
        <ToolReviewCard
          key={tool.id}
          tool={tool}
          callAction={getCallPolicyActionFromPolicies(
            tool.id,
            invocationPolicies ?? { byProfileToolId: {} },
          )}
          resultAction={getResultPolicyActionFromPolicies(
            tool.id,
            resultPolicies ?? { byProfileToolId: {} },
          )}
          hasCustomCallPolicy={(
            invocationPolicies?.byProfileToolId[tool.id] ?? []
          ).some((policy) => policy.conditions.length > 0)}
          hasCustomResultPolicy={(
            resultPolicies?.byProfileToolId[tool.id] ?? []
          ).some((policy) => policy.conditions.length > 0)}
          callUpdating={updating.has(`${tool.id}:callPolicy`)}
          resultUpdating={updating.has(`${tool.id}:resultPolicyAction`)}
          onUpdate={updatePolicy}
          onOpenDetails={() => setSelectedTool(tool)}
        />
      ))}

      <ToolDetailsDialog
        tool={selectedTool}
        open={!!selectedTool}
        onOpenChange={(open: boolean) => !open && setSelectedTool(null)}
      />
    </div>
  );
}

// =============================================================================
// Internal helpers for the Tools & Guardrails review step
// =============================================================================

const TOOLS_REVIEW_LIMIT = 100;

/** MCP ToolAnnotations boolean hints surfaced as badges when true. */
const ANNOTATION_BADGES: Array<{
  key: string;
  label: string;
  destructive?: boolean;
}> = [
  { key: "readOnlyHint", label: "Read-only" },
  { key: "destructiveHint", label: "Destructive", destructive: true },
  { key: "idempotentHint", label: "Idempotent" },
  { key: "openWorldHint", label: "Open world" },
];

function ToolReviewCard({
  tool,
  callAction,
  resultAction,
  hasCustomCallPolicy,
  hasCustomResultPolicy,
  callUpdating,
  resultUpdating,
  onUpdate,
  onOpenDetails,
}: {
  tool: ToolWithAssignmentsData;
  callAction: CallPolicyAction;
  resultAction: ResultPolicyAction;
  hasCustomCallPolicy: boolean;
  hasCustomResultPolicy: boolean;
  callUpdating: boolean;
  resultUpdating: boolean;
  onUpdate: (
    toolId: string,
    field: "callPolicy" | "resultPolicyAction",
    value: CallPolicyAction | ResultPolicyAction,
  ) => void;
  onOpenDetails: () => void;
}) {
  // MCP tool names are slugified with the server name; show the short name.
  const displayName = tool.catalogId
    ? parseFullToolName(tool.name).toolName || tool.name
    : tool.name;

  const schema = (tool.parameters ?? {}) as {
    properties?: Record<string, { type?: unknown; description?: unknown }>;
    required?: unknown;
  };
  const paramEntries = Object.entries(schema.properties ?? {});
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];

  const annotations = tool.annotations ?? null;
  const annotationBadges = ANNOTATION_BADGES.filter(
    (badge) => annotations?.[badge.key] === true,
  );

  const resultLabel =
    RESULT_POLICY_ACTION_OPTIONS.find((opt) => opt.value === resultAction)
      ?.label ?? resultAction;

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-sm font-semibold">{displayName}</code>
            {annotationBadges.map(({ key, label, destructive }) => (
              <Badge
                key={key}
                variant={destructive ? "destructive" : "outline"}
                className="font-normal"
              >
                {label}
              </Badge>
            ))}
            {tool.assignmentCount > 0 && (
              <Badge variant="secondary" className="font-normal">
                {tool.assignmentCount}{" "}
                {tool.assignmentCount === 1 ? "assignment" : "assignments"}
              </Badge>
            )}
          </div>
          {tool.description && (
            <p className="text-sm text-muted-foreground">{tool.description}</p>
          )}
        </div>

        <WithPermissions
          permissions={{ toolPolicy: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <div className="flex shrink-0 flex-wrap items-end gap-x-4 gap-y-2">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Call policy</div>
                {hasCustomCallPolicy ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={onOpenDetails}
                  >
                    Custom
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <CallPolicyToggle
                      value={callAction}
                      onChange={(action) =>
                        onUpdate(tool.id, "callPolicy", action)
                      }
                      disabled={callUpdating || !hasPermission}
                      size="sm"
                    />
                    {callUpdating && (
                      <LoadingSpinner className="h-3 w-3 text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Results are</div>
                {hasCustomResultPolicy ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={onOpenDetails}
                  >
                    Custom
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <Select
                      value={resultAction}
                      disabled={resultUpdating || !hasPermission}
                      onValueChange={(value) => {
                        if (value === resultAction) return;
                        onUpdate(
                          tool.id,
                          "resultPolicyAction",
                          value as ResultPolicyAction,
                        );
                      }}
                    >
                      <SelectTrigger
                        className="h-8 w-[150px] text-xs"
                        size="sm"
                      >
                        <SelectValue>{resultLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {RESULT_POLICY_ACTION_OPTIONS.map(
                          ({ value, label }) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    {resultUpdating && (
                      <LoadingSpinner className="h-3 w-3 text-muted-foreground" />
                    )}
                  </div>
                )}
              </div>

              <Button variant="ghost" size="sm" onClick={onOpenDetails}>
                Edit policies
              </Button>
            </div>
          )}
        </WithPermissions>
      </div>

      <div className="divide-y border-t">
        <ToolReviewSection title={`Parameters (${paramEntries.length})`}>
          {paramEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This tool takes no parameters.
            </p>
          ) : (
            <div className="space-y-2">
              {paramEntries.map(([name, def]) => (
                <div
                  key={name}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
                >
                  <code className="font-medium">{name}</code>
                  {typeof def?.type === "string" && (
                    <span className="text-xs text-muted-foreground">
                      {def.type}
                    </span>
                  )}
                  {required.includes(name) && (
                    <span className="text-xs font-medium text-primary">
                      required
                    </span>
                  )}
                  {typeof def?.description === "string" && (
                    <span className="w-full text-xs text-muted-foreground">
                      {def.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </ToolReviewSection>

        <ToolReviewSection title="Raw JSON">
          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(
              {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.parameters,
                annotations,
              },
              null,
              2,
            )}
          </pre>
        </ToolReviewSection>
      </div>
    </div>
  );
}

function ToolReviewSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-4 py-2.5 text-sm font-medium hover:bg-muted/40">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}
