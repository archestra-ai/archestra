"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  isBuiltInCatalogId,
  isPlaywrightCatalogItem,
} from "@archestra/shared";
import { useQueries } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Database,
  ExternalLink,
  Pencil,
  Plus,
  Trash2,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { excludedSubagentsSummary } from "@/components/agent-form.utils";
import { AgentIcon } from "@/components/agent-icon";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { agentConfigureHref } from "@/components/agent-pages/agent-page-config";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { SystemPromptEditor } from "@/components/system-prompt-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useInternalAgents,
  useSwitchAgentAccess,
  useUpdateProfile,
} from "@/lib/agent.query";
import { useAgentKnowledgeSourceExclusions } from "@/lib/agent-knowledge-source-exclusions.query";
import { useAgentSubagentExclusions } from "@/lib/agent-subagent-exclusions.query";
import { useAgentToolExclusions } from "@/lib/agent-tool-exclusions.query";
import {
  useAgentDelegations,
  useAllProfileTools,
  useRemoveAgentDelegation,
  useUpdateAgentServerTools,
} from "@/lib/agent-tools.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import {
  fetchCatalogTools,
  useAllCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { cn } from "@/lib/utils/tailwind";
import { summarizeAllToolAccess } from "./all-access.utils";
import { connectorLabel as connectorTypeLabel } from "./connector-label";
import { QuickEditFooter } from "./view-header";

type Agent = archestraApiTypes.GetAgentResponses["200"];
type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
type KnowledgeBase =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];
type Connector =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

/** A refused change, shown as a banner at the top of the settings view. */
export type QuickEditNotice = {
  title: string;
  message: string;
  onRetry?: () => void;
};

export function AgentSettingsView({
  agent,
  instructions,
  onInstructionsChange,
  instructionsDirty,
  onSaveInstructions,
  onDiscardInstructions,
  isSavingInstructions,
  instructionsJustSaved,
  notice,
  onDismissNotice,
  highlightCatalogId,
  allKnowledgeBases,
  allConnectors,
  onAddTools,
  onChooseTools,
  onEditSubagents,
  onEditKnowledge,
}: {
  agent: Agent;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  instructionsDirty: boolean;
  onSaveInstructions: () => void;
  onDiscardInstructions: () => void;
  isSavingInstructions: boolean;
  instructionsJustSaved: boolean;
  notice: QuickEditNotice | null;
  onDismissNotice: () => void;
  highlightCatalogId: string | null;
  allKnowledgeBases: KnowledgeBase[];
  allConnectors: Connector[];
  onAddTools: () => void;
  onChooseTools: (catalog: CatalogItem) => void;
  onEditSubagents: () => void;
  onEditKnowledge: () => void;
}) {
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  const { switchAccess } = useSwitchAgentAccess();
  const toolsSwitch = (
    <AccessSwitch
      label="Tool access"
      all={agent.accessAllTools ?? false}
      onChange={(all) => switchAccess({ agent, target: "tools", all })}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SettingsHeader agent={agent} />

      {/* ⌘/Ctrl+Enter anywhere in the body saves the instructions. Captured
          on the way down: the code editor consumes the key before it bubbles. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4"
        onKeyDownCapture={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            instructionsDirty
          ) {
            event.preventDefault();
            event.stopPropagation();
            onSaveInstructions();
          }
        }}
      >
        {notice && (
          <InlineNotice variant="error" role="alert">
            <AlertTriangle />
            <InlineNoticeBody>
              <span className="font-medium">{notice.title}</span>
              <InlineNoticeText>{notice.message}</InlineNoticeText>
            </InlineNoticeBody>
            <div className="ml-auto flex items-center gap-1">
              {notice.onRetry && (
                <Button variant="outline" size="xs" onClick={notice.onRetry}>
                  Try again
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss"
                onClick={onDismissNotice}
              >
                <XIcon />
              </Button>
            </div>
          </InlineNotice>
        )}

        <section className="space-y-2">
          <SystemPromptEditor
            title="Instructions"
            value={instructions}
            onChange={onInstructionsChange}
            minHeight={110}
            maxHeight={260}
          />
          {instructionsDirty ? (
            <InlineNotice role="status">
              <AlertTriangle />
              <span className="font-medium">
                Unsaved changes to instructions
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={onDiscardInstructions}
                  disabled={isSavingInstructions}
                >
                  Discard
                </Button>
                <Button
                  size="xs"
                  onClick={onSaveInstructions}
                  disabled={isSavingInstructions}
                >
                  <span>{isSavingInstructions ? "Saving…" : "Save"}</span>
                </Button>
              </div>
            </InlineNotice>
          ) : instructionsJustSaved ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3 text-emerald-600" />
              <span>Saved</span>
            </p>
          ) : null}
        </section>

        {agent.accessAllTools ? (
          <AllToolsSection
            agent={agent}
            allConnectors={allConnectors}
            accessSwitch={toolsSwitch}
            editExclusionsHref={
              canReadAgents
                ? agentConfigureHref("agent", agent.id, "tools")
                : null
            }
          />
        ) : (
          <ToolsSection
            agentId={agent.id}
            highlightCatalogId={highlightCatalogId}
            accessSwitch={toolsSwitch}
            onAddTools={onAddTools}
            onChooseTools={onChooseTools}
          />
        )}

        <SubagentsSection
          agent={agent}
          accessSwitch={
            <AccessSwitch
              label="Subagent access"
              all={agent.accessAllSubagents ?? false}
              onChange={(all) =>
                switchAccess({ agent, target: "subagents", all })
              }
            />
          }
          onEdit={onEditSubagents}
        />

        {!agent.accessAllTools && (
          <KnowledgeSection
            agent={agent}
            allKnowledgeBases={allKnowledgeBases}
            allConnectors={allConnectors}
            onEdit={onEditKnowledge}
          />
        )}
      </div>

      <QuickEditFooter>
        {canReadAgents ? (
          <Link
            href={agentConfigureHref("agent", agent.id)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Full configuration <ExternalLink className="size-3" />
          </Link>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {instructionsDirty ? (
            <>
              <Kbd>⌘</Kbd>
              <Kbd>Enter</Kbd>
              <span>saves instructions</span>
            </>
          ) : (
            <span>Changes to lists save as you make them</span>
          )}
        </span>
      </QuickEditFooter>
    </div>
  );
}

/** Shown while the agent's full record loads; mirrors the settings layout. */
export function AgentSettingsSkeleton({
  name,
  icon,
}: {
  name?: string;
  icon?: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy="true">
      <div className="flex shrink-0 items-center gap-3 border-b py-3 pr-3 pl-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border">
          <AgentIcon icon={icon} size={22} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {name ? (
            <span className="text-sm font-semibold">{name}</span>
          ) : (
            <Skeleton className="h-4 w-32" />
          )}
          <Skeleton className="h-3 w-56" />
        </div>
        <DialogClose asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Close">
            <XIcon />
          </Button>
        </DialogClose>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-5 py-4">
        <div className="space-y-2">
          <SectionHeading title="Instructions" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
        {["Tools", "Subagents", "Knowledge"].map((title) => (
          <div key={title} className="space-y-2">
            <SectionHeading title={title} />
            <SkeletonRow />
          </div>
        ))}
      </div>
      <QuickEditFooter>
        <Skeleton className="h-3 w-32" />
        <span />
      </QuickEditFooter>
    </div>
  );
}

// ============================================================================
// Internal: header and sections
// ============================================================================

function SettingsHeader({ agent }: { agent: Agent }) {
  const updateProfile = useUpdateProfile();
  const appName = useAppName();
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(agent.name);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: agent.id resets the draft when switching agents
  useEffect(() => {
    setDraftName(agent.name);
    setIsRenaming(false);
  }, [agent.id, agent.name]);

  useEffect(() => {
    if (isRenaming) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [isRenaming]);

  const commitName = () => {
    const trimmed = draftName.trim();
    setIsRenaming(false);
    if (!trimmed || trimmed === agent.name) {
      setDraftName(agent.name);
      return;
    }
    updateProfile.mutate({ id: agent.id, data: { name: trimmed } });
  };

  const authorName = agent.authorName ?? appName;

  return (
    <div className="flex shrink-0 items-center gap-3 border-b py-3 pr-3 pl-4">
      <AgentIconPicker
        value={(agent.icon as string | null) ?? null}
        onChange={(icon) =>
          updateProfile.mutate({ id: agent.id, data: { icon } })
        }
        className="size-10"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {isRenaming ? (
          <Input
            ref={nameInputRef}
            aria-label="Agent name"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitName();
              if (event.key === "Escape") {
                event.stopPropagation();
                setDraftName(agent.name);
                setIsRenaming(false);
              }
            }}
            className="h-7 max-w-80 px-1.5 text-sm font-semibold"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <h2 className="truncate text-sm font-semibold">{agent.name}</h2>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Rename"
              onClick={() => setIsRenaming(true)}
              className="text-muted-foreground"
            >
              <Pencil />
            </Button>
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="shrink-0">
            {scopeLabel(agent.scope)}
          </Badge>
          {agent.createdAt && (
            <span className="truncate">
              Created by {authorName} ·{" "}
              {new Date(agent.createdAt).toLocaleDateString(undefined, {
                dateStyle: "medium",
              })}
            </span>
          )}
        </div>
      </div>
      <DialogClose asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Close">
          <XIcon />
        </Button>
      </DialogClose>
    </div>
  );
}

function ToolsSection({
  agentId,
  highlightCatalogId,
  accessSwitch,
  onAddTools,
  onChooseTools,
}: {
  agentId: string;
  highlightCatalogId: string | null;
  accessSwitch: ReactNode;
  onAddTools: () => void;
  onChooseTools: (catalog: CatalogItem) => void;
}) {
  const { data: catalogItems = [] } = useInternalMcpCatalog();
  const { data: assignedToolsData, isPending } = useAllProfileTools({
    filters: { agentId },
    skipPagination: true,
    enabled: !!agentId,
  });
  const { catalogName: builtInCatalogName } = useArchestraMcpIdentity();
  const serverTools = useUpdateAgentServerTools();
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});

  const assignedByCatalog = useMemo(() => {
    const map = new Map<
      string,
      { toolIds: string[]; hasStaticCredential: boolean }
    >();
    for (const assignment of assignedToolsData?.data ?? []) {
      const catalogId = assignment.tool.catalogId;
      if (!catalogId) continue;
      const entry = map.get(catalogId) ?? {
        toolIds: [],
        hasStaticCredential: false,
      };
      entry.toolIds.push(assignment.tool.id);
      if (assignment.credentialResolutionMode === "static") {
        entry.hasStaticCredential = true;
      }
      map.set(catalogId, entry);
    }
    return map;
  }, [assignedToolsData]);

  // The newest addition first, so the row the user just added is in view.
  const assignedCatalogs = useMemo(
    () =>
      catalogItems
        .filter((catalog) => assignedByCatalog.has(catalog.id))
        .sort(
          (a, b) =>
            Number(b.id === highlightCatalogId) -
            Number(a.id === highlightCatalogId),
        ),
    [catalogItems, assignedByCatalog, highlightCatalogId],
  );

  const totalToolQueries = useQueries({
    queries: assignedCatalogs.map((catalog) => ({
      queryKey: ["mcp-catalog", catalog.id, "tools"],
      queryFn: () => fetchCatalogTools(catalog.id),
      staleTime: 60_000,
    })),
  });

  const removeServer = (catalogId: string) => {
    const entry = assignedByCatalog.get(catalogId);
    if (!entry) return;
    setRemoveErrors(({ [catalogId]: _cleared, ...rest }) => rest);
    serverTools.mutate(
      {
        agentId,
        add: [],
        remove: entry.toolIds,
        builtIn: isBuiltInCatalogId(catalogId),
      },
      {
        onError: (error) =>
          setRemoveErrors((current) => ({
            ...current,
            [catalogId]: `Couldn't remove. ${error.message}`,
          })),
      },
    );
  };

  const assignedToolCount = assignedToolsData?.data?.length ?? 0;

  return (
    <section className="space-y-2">
      <SectionHeading
        title="Tools"
        count={
          assignedToolCount > 0
            ? `${assignedToolCount} ${assignedToolCount === 1 ? "tool" : "tools"} assigned`
            : undefined
        }
        action={
          <div className="flex items-center gap-2">
            {assignedCatalogs.length > 0 && (
              <Button variant="outline" size="sm" onClick={onAddTools}>
                <Plus />
                Add tools
              </Button>
            )}
            {accessSwitch}
          </div>
        }
      />
      {isPending ? (
        <SkeletonRow />
      ) : assignedCatalogs.length === 0 ? (
        <EmptyRow
          text="No tools. On Manual, the agent uses only the tools added here."
          actionLabel="Add tools"
          onAction={onAddTools}
        />
      ) : (
        <ul className="space-y-1.5">
          {assignedCatalogs.map((catalog, index) => {
            const entry = assignedByCatalog.get(catalog.id);
            const assignedCount = entry?.toolIds.length ?? 0;
            const total = totalToolQueries[index]?.data?.length;
            const builtIn = isBuiltInCatalogId(catalog.id);
            const displayName =
              catalog.id === ARCHESTRA_MCP_CATALOG_ID
                ? builtInCatalogName
                : catalog.name;
            const countText =
              total !== undefined && total > assignedCount
                ? `${assignedCount} of ${total} tools`
                : `${assignedCount} ${assignedCount === 1 ? "tool" : "tools"}`;
            const credentialText = builtIn
              ? "Built in"
              : entry?.hasStaticCredential
                ? "One shared connection"
                : "Each person's own connection";
            const error = removeErrors[catalog.id];
            const isNew = catalog.id === highlightCatalogId;
            return (
              <QuickEditRow
                key={catalog.id}
                highlight={isNew}
                error={!!error}
                icon={
                  <McpCatalogIcon
                    icon={catalog.icon}
                    catalogId={catalog.id}
                    size={20}
                  />
                }
                title={
                  <>
                    <span className="truncate">{displayName}</span>
                    {isNew && <Badge className="shrink-0">New</Badge>}
                  </>
                }
                meta={error ?? `${countText} · ${credentialText}`}
                actions={
                  error ? (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => removeServer(catalog.id)}
                    >
                      Retry
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => onChooseTools(catalog)}
                      >
                        Choose tools
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${displayName}`}
                        onClick={() => removeServer(catalog.id)}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )
                }
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * All mode: the agent finds tools as it needs them, so instead of rows there
 * is a short account of what it can reach — a few names and a count, with the
 * full list one click away — and of what is excluded from it.
 */
function AllToolsSection({
  agent,
  allConnectors,
  accessSwitch,
  editExclusionsHref,
}: {
  agent: Agent;
  allConnectors: Connector[];
  accessSwitch: ReactNode;
  editExclusionsHref: string | null;
}) {
  const { data: catalogItems = [] } = useInternalMcpCatalog();
  const { data: catalogTools, isPending: toolsPending } = useAllCatalogTools();
  const { data: toolExclusions } = useAgentToolExclusions(agent.id);
  const { data: canReadKnowledgeBase } = useHasPermissions({
    knowledgeSource: ["read"],
  });
  const { data: sourceExclusions } = useAgentKnowledgeSourceExclusions(
    canReadKnowledgeBase ? agent.id : undefined,
  );
  const { catalogName: builtInCatalogName } = useArchestraMcpIdentity();

  const summary = useMemo(
    () =>
      summarizeAllToolAccess({
        catalogs: catalogItems.map((catalog) =>
          catalog.id === ARCHESTRA_MCP_CATALOG_ID
            ? { ...catalog, name: builtInCatalogName }
            : isPlaywrightCatalogItem(catalog.id)
              ? { ...catalog, name: "Playwright" }
              : catalog,
        ),
        tools: catalogTools ?? [],
        excludedToolIds: toolExclusions?.excludedToolIds ?? [],
        builtInCatalogIds: BUILT_IN_PREFILL_CATALOG_IDS,
      }),
    [catalogItems, catalogTools, toolExclusions, builtInCatalogName],
  );

  const excludedSources = new Set(sourceExclusions?.excludedConnectorIds ?? []);
  const sources = allConnectors.filter(
    (connector) => !excludedSources.has(connector.id),
  );
  const excludedText = [
    summary.excluded,
    excludedSources.size > 0
      ? `${excludedSources.size} knowledge ${excludedSources.size === 1 ? "source" : "sources"} excluded`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="space-y-2">
      <SectionHeading title="Tools and knowledge" action={accessSwitch} />
      <div className="space-y-3 rounded-lg border bg-background px-4 py-3.5">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">
            Every tool you can reach is available
          </p>
          <p className="text-xs text-muted-foreground">
            The agent looks a tool up when it needs one, so they don't fill its
            context.
          </p>
        </div>
        <div className="space-y-2">
          <ReachLine
            label="Tools"
            loading={toolsPending}
            items={summary.servers.map(({ catalog, toolCount }) => ({
              id: catalog.id,
              name: catalog.name,
              meta: `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`,
              icon: (
                <McpCatalogIcon
                  icon={catalog.icon}
                  catalogId={catalog.id}
                  size={12}
                />
              ),
            }))}
          />
          {canReadKnowledgeBase && sources.length > 0 && (
            <ReachLine
              label="Knowledge"
              items={sources.map((connector) => ({
                id: connector.id,
                name: connector.name,
                meta: connectorTypeLabel(connector.connectorType),
                icon: (
                  <ConnectorTypeIcon
                    type={connector.connectorType}
                    className="size-3"
                  />
                ),
              }))}
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t pt-2.5 text-xs text-muted-foreground">
          <span className="truncate">{excludedText || "Nothing excluded"}</span>
          {editExclusionsHref && (
            <Link
              href={editExclusionsHref}
              className="flex shrink-0 items-center gap-1 transition-colors hover:text-foreground"
            >
              Edit exclusions <ExternalLink className="size-3" />
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

/** The full configuration's All / Manual control, at the same size. */
function AccessSwitch({
  label,
  all,
  onChange,
}: {
  label: string;
  all: boolean;
  onChange: (all: boolean) => void;
}) {
  // Shows the choice at once, before the saved agent comes back: the tab
  // fires on press and again on focus, and the second must not save twice.
  const [shown, setShown] = useState(all);
  useEffect(() => setShown(all), [all]);
  return (
    <Tabs
      value={shown ? "all" : "manual"}
      onValueChange={(value) => {
        const next = value === "all";
        if (next === shown) return;
        setShown(next);
        onChange(next);
      }}
    >
      <TabsList size="sm" aria-label={label}>
        <TabsTrigger value="all">All</TabsTrigger>
        <TabsTrigger value="manual">Manual</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

const REACH_LINE_SHOWN = 4;

/** Switching to All pre-fills exclusions for this server's tools only. */
const BUILT_IN_PREFILL_CATALOG_IDS: ReadonlySet<string> = new Set([
  ARCHESTRA_MCP_CATALOG_ID,
]);

/**
 * One line of what an All-mode agent reaches: a stack of icons and a count of
 * the rest, with every item named in a popover.
 */
function ReachLine({
  label,
  items,
  loading = false,
}: {
  label: string;
  items: Array<{ id: string; name: string; meta?: string; icon: ReactNode }>;
  loading?: boolean;
}) {
  const shown = items.slice(0, REACH_LINE_SHOWN);
  const rest = items.length - shown.length;
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-sm">
      <span className="w-[4.5rem] shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      {loading ? (
        <Skeleton className="h-4 w-48" />
      ) : items.length === 0 ? (
        <span className="text-muted-foreground">None yet</span>
      ) : (
        <>
          {/* Hover names each icon; the sr-only list below is the same for
              screen readers, and See all for everyone else. */}
          <span className="flex shrink-0 items-center" aria-hidden="true">
            {shown.map((item) => (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <span className="-ml-1.5 flex size-5 items-center justify-center overflow-hidden rounded-md bg-muted ring-2 ring-background first:ml-0">
                    {item.icon}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{reachItemLabel(item)}</TooltipContent>
              </Tooltip>
            ))}
          </span>
          {rest > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="text-xs text-muted-foreground"
                  aria-hidden="true"
                >
                  +{rest}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {items
                  .slice(REACH_LINE_SHOWN)
                  .map((item) => item.name)
                  .join(", ")}
              </TooltipContent>
            </Tooltip>
          )}
          <span className="sr-only">
            {items.map((item) => item.name).join(", ")}
          </span>
          <span className="flex-1" />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="link" size="xs" className="h-auto shrink-0 px-0">
                See all
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-1">
              <ul className="max-h-72 overflow-y-auto">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted">
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.meta && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.meta}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  );
}

function reachItemLabel(item: { name: string; meta?: string }) {
  return item.meta ? `${item.name} · ${item.meta}` : item.name;
}

function SubagentsSection({
  agent,
  accessSwitch,
  onEdit,
}: {
  agent: Agent;
  accessSwitch: ReactNode;
  onEdit: () => void;
}) {
  const agentId = agent.id;
  const accessAll = agent.accessAllSubagents ?? false;
  const { data: delegations = [], isPending } = useAgentDelegations(agentId);
  const { data: allAgents = [] } = useInternalAgents();
  const { data: subagentExclusions } = useAgentSubagentExclusions(
    accessAll ? agentId : undefined,
  );
  const removeDelegation = useRemoveAgentDelegation();

  const subagents = useMemo(() => {
    const byId = new Map(allAgents.map((agent) => [agent.id, agent]));
    return delegations.map((delegation) => ({
      ...delegation,
      ...byId.get(delegation.id),
    }));
  }, [allAgents, delegations]);

  if (accessAll) {
    const excluded = new Set(subagentExclusions?.excludedSubagentIds ?? []);
    const reachable = allAgents.filter(
      (candidate) =>
        candidate.id !== agentId &&
        !candidate.builtIn &&
        !excluded.has(candidate.id),
    );
    return (
      <section className="space-y-2">
        <SectionHeading title="Subagents" action={accessSwitch} />
        <div className="space-y-2.5 rounded-lg border bg-background px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {excludedSubagentsSummary(excluded.size)}
          </p>
          <ReachLine
            label="Agents"
            items={reachable.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              icon: <AgentIcon icon={candidate.icon} size={12} />,
            }))}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <SectionHeading
        title="Subagents"
        count={
          subagents.length > 0
            ? `${subagents.length} ${subagents.length === 1 ? "subagent" : "subagents"} assigned`
            : undefined
        }
        action={
          <div className="flex items-center gap-2">
            {subagents.length > 0 && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Plus />
                Add subagents
              </Button>
            )}
            {accessSwitch}
          </div>
        }
      />
      {isPending ? (
        <SkeletonRow />
      ) : subagents.length === 0 ? (
        <EmptyRow
          text="No subagents. Add agents this one can hand work to."
          actionLabel="Add subagents"
          onAction={onEdit}
        />
      ) : (
        <ul className="space-y-1.5">
          {subagents.map((subagent) => (
            <QuickEditRow
              key={subagent.id}
              icon={<AgentIcon icon={subagent.icon} size={18} />}
              title={<span className="truncate">{subagent.name}</span>}
              meta={subagent.description || "No description"}
              actions={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${subagent.name}`}
                  disabled={removeDelegation.isPending}
                  onClick={() =>
                    removeDelegation.mutate({
                      agentId,
                      targetAgentId: subagent.id,
                    })
                  }
                >
                  <Trash2 />
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function KnowledgeSection({
  agent,
  allKnowledgeBases,
  allConnectors,
  onEdit,
}: {
  agent: Agent;
  allKnowledgeBases: KnowledgeBase[];
  allConnectors: Connector[];
  onEdit: () => void;
}) {
  const updateProfile = useUpdateProfile();
  const knowledgeBaseIds = agent.knowledgeBaseIds ?? [];
  const connectorIds = agent.connectorIds ?? [];
  const knowledgeBases = allKnowledgeBases.filter((kb) =>
    knowledgeBaseIds.includes(kb.id),
  );
  const connectors = allConnectors.filter((connector) =>
    connectorIds.includes(connector.id),
  );
  const count = knowledgeBases.length + connectors.length;

  return (
    <section className="space-y-2">
      <SectionHeading
        title="Knowledge"
        count={String(count)}
        action={
          count > 0 ? (
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Plus />
              Add knowledge
            </Button>
          ) : undefined
        }
      />
      {count === 0 ? (
        <EmptyRow
          text="No knowledge sources. Add documents this agent can search."
          actionLabel="Add knowledge"
          onAction={onEdit}
        />
      ) : (
        <ul className="space-y-1.5">
          {knowledgeBases.map((kb) => {
            const types = [
              ...new Set((kb.connectors ?? []).map((c) => c.connectorType)),
            ];
            return (
              <QuickEditRow
                key={kb.id}
                icon={
                  types[0] ? (
                    <ConnectorTypeIcon type={types[0]} className="size-4" />
                  ) : (
                    <Database className="size-4 text-muted-foreground" />
                  )
                }
                title={<span className="truncate">{kb.name}</span>}
                meta={
                  types.length > 0
                    ? `Knowledge base · ${types.map(connectorTypeLabel).join(", ")}`
                    : "Knowledge base"
                }
                actions={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${kb.name}`}
                    onClick={() =>
                      updateProfile.mutate({
                        id: agent.id,
                        data: {
                          knowledgeBaseIds: knowledgeBaseIds.filter(
                            (id) => id !== kb.id,
                          ),
                        },
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                }
              />
            );
          })}
          {connectors.map((connector) => (
            <QuickEditRow
              key={connector.id}
              icon={
                <ConnectorTypeIcon
                  type={connector.connectorType}
                  className="size-4"
                />
              }
              title={<span className="truncate">{connector.name}</span>}
              meta={`${connectorTypeLabel(connector.connectorType)} connector`}
              actions={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${connector.name}`}
                  onClick={() =>
                    updateProfile.mutate({
                      id: agent.id,
                      data: {
                        connectorIds: connectorIds.filter(
                          (id) => id !== connector.id,
                        ),
                      },
                    })
                  }
                >
                  <Trash2 />
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ============================================================================
// Internal: shared row primitives
// ============================================================================

function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">
        {title}
        {count !== undefined && (
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {count}
          </span>
        )}
      </h3>
      {action}
    </div>
  );
}

function QuickEditRow({
  icon,
  title,
  meta,
  actions,
  highlight = false,
  error = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  meta: string;
  actions: ReactNode;
  highlight?: boolean;
  error?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-background py-2 pr-2 pl-3",
        highlight &&
          "border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/30",
        error && "border-destructive/40",
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {title}
        </div>
        <div
          className={cn(
            "truncate text-xs",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {meta}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
    </li>
  );
}

function EmptyRow({
  text,
  actionLabel,
  onAction,
}: {
  text: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2.5">
      <span className="text-sm text-muted-foreground">{text}</span>
      <Button variant="outline" size="sm" onClick={onAction}>
        <Plus />
        {actionLabel}
      </Button>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <Skeleton className="size-8 rounded-md" />
      <div className="flex flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-3 w-52" />
      </div>
    </div>
  );
}

function scopeLabel(scope: string | undefined) {
  if (scope === "org") return "Shared with organization";
  if (scope === "team") return "Shared with team";
  return "Only you";
}
