"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  type ArchestraToolShortName,
  extractMcpExecutedAs,
  parseFullToolName,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_REQUEST_BATTERY_CREDENTIALS_SHORT_NAME,
} from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { BotIcon, CheckCircleIcon, ClockIcon, WebhookIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Tool,
  ToolContent,
  ToolErrorDetails,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { ExecutedAsBadge } from "@/components/executed-as-badge";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useSession } from "@/lib/auth/auth.query";
import {
  type CompactToolState,
  getCompactToolState,
  getHumanRulingDisplay,
  getToolErrorText,
  getToolHeaderState,
  withParsedArguments,
} from "@/lib/chat/chat-tools-display.utils";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { cn } from "@/lib/utils/tailwind";
import { useApps } from "./apps-context";
import {
  BatteryCredentialsTool,
  parseBatteryCredentialRequest,
} from "./battery-credentials-tool";
import {
  type AppEntryRender,
  getApprovalToolDisplay,
  getToolCardTitle,
  resolveAppEntryRender,
  resolveRunToolTargetName,
} from "./chat-messages.utils";
import { HookRunChip, type HookRunChipData } from "./hook-run-chip";
import { McpAppEntryContent, McpAppEntryPill } from "./mcp-app-container";
import { useMcpTaskFor } from "./mcp-task-context";
import {
  formatElapsed,
  McpTaskStatusRow,
  useElapsedSince,
} from "./mcp-task-status";
import {
  getOpenAppaSaveResult,
  isOpenAppaPolicyChange,
  isOpenAppaPreview,
  OpenAppaPolicyArguments,
  OpenAppaPolicyChange,
  OpenAppaPolicyCompletion,
  OpenAppaValidationCompletion,
} from "./openappa-policy-change";
import { isPolicyChangeTool } from "./openappa-policy-change.utils";
import {
  RemedyChainCard,
  RemedyGuardrailsSteps,
} from "./openappa-remedy-chain-card";
import {
  getRemedyChainStatus,
  type RemedyChain,
} from "./openappa-remedy-chains";
import {
  PreviewedChangeReview,
  proposalApprovalText,
  usePreviewedChange,
} from "./previewed-policy-change";
import { withoutProxyTransportArguments } from "./proxy-transport-arguments";
import { RuntimeCredentialSetupTool } from "./runtime-credential-setup-tool";
import { getSkillPillDisplay, SkillPill } from "./skill-pill";
import { ToolErrorLogsButton } from "./tool-error-logs-button";
import type { ToolIconMap } from "./tool-icon-map";
import { ToolStatusRow } from "./tool-status-row";

type CompactToolEntry = {
  kind: "tool";
  key: string;
  toolName: string;
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
  /** A delegation call's surfaced subagent tool calls, rendered between its
   * Request and Result once the circle is expanded. */
  nestedToolCalls?: React.ReactNode;
  /** The whole guarded call this circle stands for. */
  remedyChain?: RemedyChain;
};

type CompactAppEntry = {
  /** An MCP-App-rendering call: app pill in the row, app content below it. */
  kind: "app";
  key: string;
  toolName: string;
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
  /** Never set for app entries; present so ExpandedToolCard can take either. */
  nestedToolCalls?: React.ReactNode;
  /** Set when the app call is the released attempt of a guarded call. */
  remedyChain?: RemedyChain;
};

type CompactHookEntry = {
  kind: "hook";
  key: string;
  data: HookRunChipData;
};

type CompactEntry = CompactToolEntry | CompactAppEntry | CompactHookEntry;

/**
 * Conversation-level context an app entry needs to mount its runtime. Absent
 * (e.g. in subagent rows), app entries degrade to plain tool circles.
 */
type CompactAppContext = {
  agentId?: string;
  earlyToolUiStarts?: Record<
    string,
    {
      uiResourceUri: string;
      html?: string;
      csp?: { connectDomains?: string[]; resourceDomains?: string[] };
      permissions?: {
        camera?: boolean;
        microphone?: boolean;
        geolocation?: boolean;
        clipboardWrite?: boolean;
      };
      toolName?: string;
    }
  >;
  onSendMessage?: (text: string) => void;
};

function CompactCircle({
  toolName,
  toolCallId,
  state,
  stateLabel,
  isExpanded,
  isExpandable = true,
  onClick,
  icon,
  catalogId,
  title,
}: {
  toolName: string;
  /** Replaces the tool's own name in the label. */
  title?: string;
  toolCallId?: string;
  state: CompactToolState;
  /** Displays specific status text, such as a user review decision. */
  stateLabel?: string;
  isExpanded: boolean;
  isExpandable?: boolean;
  onClick: () => void;
  icon?: string | null;
  catalogId?: string;
}) {
  // A call that detached into a background task reads as running, but is worth
  // distinguishing: it is no longer bounded by the usual wait, and it can be
  // cancelled from the expanded card.
  const { task } = useMcpTaskFor(toolCallId);
  const isBackground = task?.status === "working" && state === "running";
  // A cancelled task still reports a tool result, so the underlying state
  // reads as completed. It wasn't — the user stopped it.
  const isCancelled = task?.status === "cancelled";
  const elapsed = useElapsedSince(task?.startedAt ?? 0, Boolean(isBackground));
  const stateSuffix = isBackground
    ? " (running in the background)"
    : stateLabel
      ? ` (${stateLabel.toLowerCase()})`
      : state === "approval-requested"
        ? " (approval required)"
        : state === "running"
          ? " (running)"
          : state === "error"
            ? " (error)"
            : state === "denied"
              ? " (denied)"
              : "";
  const label =
    title ??
    getToolCardTitle(toolName) ??
    parseFullToolName(toolName).toolName.replace(/_/g, " ");
  const accessibleName = `${label}${stateSuffix}`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            type="button"
            onClick={onClick}
            disabled={!isExpandable}
            aria-label={accessibleName}
            aria-expanded={isExpandable ? isExpanded : undefined}
            className={cn(
              "relative inline-flex items-center justify-center size-8 rounded-full border transition-all",
              isExpandable &&
                "hover:bg-accent hover:border-accent-foreground/20",
              !isExpandable && "cursor-default",
              isExpanded
                ? "bg-accent border-accent-foreground/20 ring-2 ring-primary/20"
                : "bg-background",
            )}
          >
            {icon || catalogId ? (
              <McpCatalogIcon icon={icon} catalogId={catalogId} size={16} />
            ) : (
              <BotIcon className="size-3.5 text-muted-foreground" />
            )}
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                isCancelled && "bg-muted-foreground",
                !isCancelled && state === "completed" && "bg-green-500",
                !isCancelled &&
                  state === "approval-requested" &&
                  "bg-amber-500 animate-pulse",
                !isCancelled &&
                  state === "running" &&
                  (isBackground
                    ? "bg-amber-500 animate-pulse"
                    : "bg-blue-500 animate-pulse"),
                state === "error" && "bg-destructive",
                state === "denied" && "bg-orange-500",
              )}
            />
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <span>{label}</span>
          {isCancelled ? (
            <span>{" (cancelled)"}</span>
          ) : isBackground ? (
            <span>{` (running in the background · ${formatElapsed(elapsed)})`}</span>
          ) : stateLabel ? (
            <span>{` (${stateLabel.toLowerCase()})`}</span>
          ) : state === "approval-requested" ? (
            <span>{" (approval required)"}</span>
          ) : state === "running" ? (
            <span>{" (running)"}</span>
          ) : state === "error" ? (
            <span>{" (error)"}</span>
          ) : state === "denied" ? (
            <span>{" (denied)"}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Quiet inline marker for `archestra__load_skill` activation calls (no path).
 * External MCP qualifiers are collapsed to a human Skill name; the source is
 * retained in the tooltip. File reads remain normal tool circles (#6184).
 */
function ToolCallSkillPill({
  toolName,
  skillName,
  state,
}: {
  toolName: string;
  skillName: string | null;
  state: CompactToolState;
}) {
  const display = getSkillPillDisplay(skillName);
  const tooltipLabel = (() => {
    if (!display.name) return "Loading skill";
    const target = display.source
      ? `${display.name} from ${display.source}`
      : display.name;
    if (state === "approval-requested")
      return `Approval required for ${target}`;
    if (state === "running") return `Loading ${target}`;
    if (state === "error") return `Failed to load ${target}`;
    if (state === "denied") return `Access denied for ${target}`;
    return target;
  })();

  const pill = (
    <SkillPill
      skillName={skillName}
      data-tool-name={toolName}
      role="status"
      aria-label={tooltipLabel}
      tabIndex={display.source ? 0 : undefined}
      showNativeTitle={false}
    >
      {state === "running" ||
      state === "approval-requested" ||
      state === "error" ? (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
            state === "running" && "bg-blue-500 animate-pulse",
            state === "approval-requested" && "bg-amber-500 animate-pulse",
            state === "error" && "bg-destructive",
          )}
        />
      ) : null}
    </SkillPill>
  );
  // The pill already shows the name; a tooltip only helps when it says more.
  if (tooltipLabel === display.name) return pill;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {tooltipLabel}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Compact circle for a hook run, visually matching CompactCircle: webhook icon
 * in a bordered circle with an outcome dot (green proceeded, orange blocked,
 * red error / timeout). Clicking expands the full HookRunChip card below the
 * row, exactly like a tool circle expands its tool card.
 */
function HookCircle({
  data,
  isExpanded,
  isExpandable = true,
  onClick,
}: {
  data: HookRunChipData;
  isExpanded: boolean;
  isExpandable?: boolean;
  onClick: () => void;
}) {
  const outcome = data.outcome ?? "";
  const tooltip = [
    data.hookEventName,
    data.fileName,
    outcome ? `(${outcome})` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            type="button"
            onClick={onClick}
            disabled={!isExpandable}
            className={cn(
              "relative inline-flex items-center justify-center size-8 rounded-full border transition-all",
              isExpandable &&
                "hover:bg-accent hover:border-accent-foreground/20",
              !isExpandable && "cursor-default",
              isExpanded
                ? "bg-accent border-accent-foreground/20 ring-2 ring-primary/20"
                : "bg-background",
            )}
            aria-label="Show hook run details"
            aria-expanded={isExpandable ? isExpanded : undefined}
          >
            <WebhookIcon className="size-3.5 text-muted-foreground" />
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                outcome === "proceeded" && "bg-green-500",
                outcome === "blocked" && "bg-orange-500",
                (outcome === "error" || outcome === "timeout") &&
                  "bg-destructive",
              )}
            />
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Finds the key of the latest Guardrails policy preview or save entry across a
 * sequence of compact entries, so only the newest one in a message auto-opens.
 */
export function findLatestPolicyChangeKey(params: {
  entries: ReadonlyArray<CompactEntry>;
  getToolShortName: (toolName: string) => ArchestraToolShortName | null;
}): string | undefined {
  const { entries, getToolShortName } = params;
  return entries.findLast((entry) => {
    if (entry.kind === "hook") return false;
    const call = releasedCall(entry);
    if (!call) return false;
    const shortName = getToolShortName(
      resolveRunToolTargetName(call.part, call.toolName, {
        getToolShortName,
      }),
    );
    const output = call.toolResultPart?.output ?? call.part.output;
    return (
      !call.errorText &&
      (getOpenAppaSaveResult({ shortName, output }) !== null ||
        isOpenAppaPreview({ shortName, output, input: call.part.input }))
    );
  })?.key;
}

export function CompactToolGroup({
  tools,
  toolIconMap,
  canExpandToolCalls = true,
  onToolApprovalResponse,
  appContext,
  turnActive = false,
  autoOpenPolicyKey,
  renderAuthCard,
}: {
  tools: CompactEntry[];
  /** The row's turn is still running, so guarded calls read as running. */
  turnActive?: boolean;
  toolIconMap?: ToolIconMap;
  canExpandToolCalls?: boolean;
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
  appContext?: CompactAppContext;
  /**
   * Message-wide key of the latest policy preview/save entry that should
   * auto-open. When omitted, defaults to the latest policy change in this row.
   */
  autoOpenPolicyKey?: string | null;
  /**
   * Renders an inline authentication or no-device setup card directly under
   * the circle row when a tool call requires user action.
   */
  renderAuthCard?: (params: {
    toolName: string;
    part: ToolUIPart | DynamicToolUIPart;
    toolResultPart: ToolUIPart | DynamicToolUIPart | null;
    errorText: string | undefined;
  }) => React.ReactNode;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dismissedApprovalKeys, setDismissedApprovalKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { isToolName, getToolShortName } = useArchestraMcpIdentity();
  const { isAppOpen, toggleAppOpen, portalTarget } = useApps();
  // The latest proposed or saved Guardrails change opens its circle once, so
  // the diff or the save result shows without a click; a circle the user
  // picked is left alone. It opens for every reader, also one who cannot
  // open tool calls: a change the person is asked to approve is theirs to
  // see, not a detail of how the agent worked.
  const userToggledRef = useRef(false);
  const autoOpenedRef = useRef(new Set<string>());
  const policyChangeKey =
    autoOpenPolicyKey !== undefined
      ? autoOpenPolicyKey &&
        tools.some((entry) => entry.key === autoOpenPolicyKey)
        ? autoOpenPolicyKey
        : undefined
      : findLatestPolicyChangeKey({ entries: tools, getToolShortName });
  useEffect(() => {
    if (!policyChangeKey) {
      if (autoOpenPolicyKey !== undefined && !userToggledRef.current) {
        setExpandedKey((prev) =>
          prev && autoOpenedRef.current.has(prev) ? null : prev,
        );
      }
      return;
    }
    if (autoOpenedRef.current.has(policyChangeKey)) return;
    autoOpenedRef.current.add(policyChangeKey);
    if (!userToggledRef.current) setExpandedKey(policyChangeKey);
  }, [policyChangeKey, autoOpenPolicyKey]);

  // Tool calls waiting on user approval stay open directly under their circles,
  // even alongside an auto-opened policy diff preview in the same row and even
  // for viewers who cannot expand ordinary tool calls.
  const approvalPendingKeys = new Set(
    tools.filter(isApprovalPendingEntry).map((entry) => entry.key),
  );

  const isEntryExpanded = (key: string) =>
    approvalPendingKeys.has(key)
      ? !dismissedApprovalKeys.has(key)
      : expandedKey === key;

  const handleToggle = (key: string) => {
    if (approvalPendingKeys.has(key)) {
      setDismissedApprovalKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      return;
    }
    if (!canExpandToolCalls) return;
    userToggledRef.current = true;
    // Expanding a tool card collapses any inline app open in this row — the
    // mirror of an app pill collapsing an expanded tool card, so only one
    // thing unfolds under the row at a time. Panel-hosted apps are untouched
    // (nothing is expanded inline while the panel hosts).
    if (expandedKey !== key && !portalTarget) {
      for (const entry of tools) {
        if (
          entry.kind === "app" &&
          entry.part.toolCallId &&
          isAppOpen(entry.part.toolCallId)
        ) {
          toggleAppOpen(entry.part.toolCallId);
        }
      }
    }
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  const openEntries = tools.filter((entry) => isEntryExpanded(entry.key));

  const authCards = renderAuthCard
    ? tools.flatMap((entry) => {
        if (entry.kind === "hook") return [];
        const call = releasedCall(entry);
        if (!call) return [];
        const card = renderAuthCard(call);
        return card ? [{ key: entry.key, card }] : [];
      })
    : [];

  // Resolve each app entry's render once: the pill needs the app identity, the
  // content below the row needs the full mount props. A `null` render (e.g. a
  // still-streaming scaffold/edit call) degrades to a plain tool circle.
  const appRenders = new Map<string, AppEntryRender>();
  if (appContext?.agentId) {
    for (const entry of tools) {
      if (entry.kind !== "app") continue;
      const render = resolveAppEntryRender({
        part: entry.part,
        toolResultPart: entry.toolResultPart,
        early: entry.part.toolCallId
          ? appContext.earlyToolUiStarts?.[entry.part.toolCallId]
          : undefined,
        getToolShortName,
      });
      if (render) appRenders.set(entry.key, render);
    }
  }

  const circleIconProps = (displayToolName: string) => {
    const iconInfo = toolIconMap?.get(displayToolName);
    return {
      icon: iconInfo?.icon,
      catalogId:
        iconInfo?.catalogId ??
        (isToolName(displayToolName) ? ARCHESTRA_MCP_CATALOG_ID : undefined),
    };
  };

  return (
    <div className="mb-4">
      <div className="flex flex-wrap gap-1.5 items-center">
        {tools.map((entry) => {
          const entryExpanded = isEntryExpanded(entry.key);
          const entryExpandable =
            canExpandToolCalls || approvalPendingKeys.has(entry.key);

          if (entry.kind === "hook") {
            return (
              <HookCircle
                key={entry.key}
                data={entry.data}
                isExpanded={entryExpanded}
                isExpandable={canExpandToolCalls}
                onClick={() => handleToggle(entry.key)}
              />
            );
          }
          // A guarded call reads as one call of its target tool; the
          // Guardrails negotiation shows only once it is expanded.
          if (
            entry.remedyChain &&
            !(entry.kind === "app" && appRenders.has(entry.key))
          ) {
            const status = getRemedyChainStatus(entry.remedyChain, {
              turnActive,
            });
            return (
              <CompactCircle
                key={entry.key}
                toolName={entry.remedyChain.targetToolName}
                toolCallId={entry.remedyChain.finalAttempt?.part.toolCallId}
                state={status.state}
                stateLabel={status.label}
                isExpanded={entryExpanded}
                isExpandable={entryExpandable}
                onClick={() => handleToggle(entry.key)}
                {...circleIconProps(entry.remedyChain.targetToolName)}
              />
            );
          }
          const state = getCompactToolState({
            part: entry.part,
            toolResultPart: entry.toolResultPart,
          });
          if (entry.kind === "app") {
            const render = appRenders.get(entry.key);
            if (!render) {
              // No render to mount (still streaming, or no agent context):
              // a regular circle that expands the tool details.
              const displayToolName = resolveRunToolTargetName(
                entry.part,
                entry.toolName,
                { getToolShortName },
              );
              const iconProps = circleIconProps(displayToolName);
              return (
                <CompactCircle
                  key={entry.key}
                  toolName={displayToolName}
                  toolCallId={entry.part.toolCallId}
                  state={state}
                  isExpanded={entryExpanded}
                  isExpandable={entryExpandable}
                  onClick={() => handleToggle(entry.key)}
                  {...iconProps}
                />
              );
            }
            // The pill resolves its own icon from the app it names — this row
            // deliberately passes none, because the app pill identifies the
            // APP, not the serving MCP catalog.
            return (
              <McpAppEntryPill
                key={entry.key}
                appId={render.appId}
                appName={render.appName}
                toolName={render.mcpAppToolName}
                toolCallId={entry.part.toolCallId}
                state={state}
                // Opening an app collapses an expanded tool-call card so only
                // one thing unfolds under the row at a time.
                onClick={() => setExpandedKey(null)}
              />
            );
          }
          if (
            getToolShortName(entry.toolName) === TOOL_LOAD_SKILL_SHORT_NAME &&
            state !== "approval-requested"
          ) {
            const input = (entry.part.input ?? {}) as {
              name?: unknown;
              path?: unknown;
            };
            // A `load_skill` call with a `path` reads a bundled file from an
            // already-loaded skill — a sub-action, not a new skill trigger.
            // Only activation calls (no path) get the "Skill:" pill; file reads
            // fall through to the normal tool circle below (#6184).
            const skillPath =
              typeof input.path === "string" && input.path.length > 0
                ? input.path
                : null;
            if (!skillPath) {
              const skillName =
                typeof input.name === "string" && input.name.length > 0
                  ? input.name
                  : null;
              return (
                <ToolCallSkillPill
                  key={entry.key}
                  toolName={entry.toolName}
                  skillName={skillName}
                  state={state}
                />
              );
            }
          }
          // A run_tool dispatch belongs visually to its *target* tool: unwrap
          // so the circle shows the underlying MCP server's icon (and tooltip
          // name) instead of the generic Archestra built-in icon. Approval
          // prompts also fall back to the raw short name so branded prefixes
          // unwrap before identity data resolves.
          const displayToolName =
            state === "approval-requested"
              ? getApprovalToolDisplay({
                  toolName: entry.toolName,
                  input: entry.part.input,
                  isApprovalRequested: true,
                  getToolShortName,
                }).toolName
              : resolveRunToolTargetName(entry.part, entry.toolName, {
                  getToolShortName,
                });
          const iconInfo = toolIconMap?.get(displayToolName);
          const fallbackCatalogId =
            iconInfo?.catalogId ??
            (isToolName(displayToolName)
              ? ARCHESTRA_MCP_CATALOG_ID
              : undefined);
          return (
            <CompactCircle
              key={entry.key}
              toolName={displayToolName}
              title={getToolCardTitle(
                displayToolName,
                getToolShortName(displayToolName),
              )}
              toolCallId={entry.part.toolCallId}
              state={state}
              stateLabel={
                getHumanRulingDisplay({
                  part: entry.part,
                  toolResultPart: entry.toolResultPart,
                })?.label
              }
              isExpanded={entryExpanded}
              isExpandable={entryExpandable}
              onClick={() => handleToggle(entry.key)}
              icon={iconInfo?.icon}
              catalogId={fallbackCatalogId}
            />
          );
        })}
      </div>
      {tools.map((entry) => {
        if (entry.kind === "hook") return null;
        const call = releasedCall(entry);
        if (!call || call.errorText) return null;
        const name = resolveRunToolTargetName(call.part, call.toolName, {
          getToolShortName,
        });
        if (
          getToolShortName(name) !== "request_runtime_credential_setup" ||
          (call.part.state !== "output-available" && !call.toolResultPart)
        )
          return null;
        return (
          <RuntimeCredentialSetupTool
            key={entry.key}
            ready
            toolCallId={call.part.toolCallId}
            onSendMessage={appContext?.onSendMessage}
          />
        );
      })}
      {tools.map((entry) => {
        if (entry.kind === "hook") return null;
        const call = releasedCall(entry);
        if (!call || call.errorText) return null;
        const name = resolveRunToolTargetName(call.part, call.toolName, {
          getToolShortName,
        });
        const request =
          getToolShortName(name) === TOOL_REQUEST_BATTERY_CREDENTIALS_SHORT_NAME
            ? parseBatteryCredentialRequest(
                call.toolResultPart?.output ?? call.part.output,
              )
            : null;
        if (!request) return null;
        return (
          <BatteryCredentialsTool
            key={entry.key}
            request={request}
            toolCallId={call.part.toolCallId}
            onSendMessage={appContext?.onSendMessage}
          />
        );
      })}
      {authCards.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {authCards.map(({ key, card }) => (
            <div key={key}>{card}</div>
          ))}
        </div>
      )}
      {openEntries.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {openEntries.map((entry) =>
            entry.kind === "hook" ? (
              <HookRunChip
                key={entry.key}
                data={entry.data}
                defaultOpen
                className="mb-0"
              />
            ) : (
              <EntryToolCard
                key={entry.key}
                entry={entry}
                turnActive={turnActive}
                onToolApprovalResponse={onToolApprovalResponse}
              />
            ),
          )}
        </div>
      )}
      {appContext?.agentId
        ? tools.map((entry) => {
            if (entry.kind !== "app") return null;
            const render = appRenders.get(entry.key);
            if (!render) return null;
            const early = entry.part.toolCallId
              ? appContext.earlyToolUiStarts?.[entry.part.toolCallId]
              : undefined;
            return (
              <McpAppEntryContent
                key={entry.key}
                uiResourceUri={render.uiResourceUri}
                appId={render.appId}
                mcpServerId={render.mcpServerId}
                appName={render.appName}
                appVersion={render.appVersion}
                agentId={appContext.agentId as string}
                toolName={render.mcpAppToolName}
                toolCallId={entry.part.toolCallId}
                toolInput={render.toolInput}
                rawOutput={render.rawOutput}
                preloadedResource={
                  early?.html
                    ? {
                        html: early.html,
                        csp: early.csp,
                        permissions: early.permissions,
                      }
                    : undefined
                }
                // Surfaced only when the app renders nothing to display, so the
                // call stays inspectable instead of the section going blank.
                toolDetails={
                  <EntryToolCard
                    entry={entry}
                    turnActive={turnActive}
                    onToolApprovalResponse={onToolApprovalResponse}
                  />
                }
                onSendMessage={appContext.onSendMessage}
              />
            );
          })
        : null}
    </div>
  );
}

/**
 * Whether an entry is waiting on a user approval decision (either directly or
 * in any step / final attempt of a guarded remedy chain).
 */
function isApprovalPendingEntry(entry: CompactEntry): boolean {
  if (entry.kind === "hook") return false;
  if (entry.remedyChain) {
    if (
      entry.remedyChain.finalAttempt &&
      !entry.remedyChain.finalAttempt.toolResultPart &&
      entry.remedyChain.finalAttempt.part.state === "approval-requested"
    ) {
      return true;
    }
    return entry.remedyChain.steps.some(
      (step) =>
        !step.toolResultPart && step.part.state === "approval-requested",
    );
  }
  return !entry.toolResultPart && entry.part.state === "approval-requested";
}

/**
 * The call a tool entry stands for: the entry itself, or for a guarded call
 * its released attempt (null until the model released it).
 */
function releasedCall(
  entry: CompactToolEntry | CompactAppEntry,
): Pick<
  CompactToolEntry,
  "toolName" | "part" | "toolResultPart" | "errorText"
> | null {
  if (!entry.remedyChain) return entry;
  const { finalAttempt } = entry.remedyChain;
  if (!finalAttempt) return null;
  return {
    toolName: finalAttempt.toolName,
    part: finalAttempt.part,
    toolResultPart: finalAttempt.toolResultPart,
    errorText: getToolErrorText(finalAttempt),
  };
}

/**
 * The expanded card for a tool entry. A released guarded call is its
 * attempt's own card, with the Guardrails negotiation (and the attempt's
 * subagent calls) between Request and Result; an unreleased one is the
 * chain card.
 */
function EntryToolCard({
  entry,
  turnActive,
  onToolApprovalResponse,
}: {
  entry: CompactToolEntry | CompactAppEntry;
  turnActive: boolean;
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
}) {
  const chain = entry.remedyChain;
  const call = releasedCall(entry);
  if (!chain) {
    return (
      <ExpandedToolCard
        tool={entry}
        onToolApprovalResponse={onToolApprovalResponse}
      />
    );
  }
  if (!call) {
    return (
      <RemedyChainCard
        chain={chain}
        turnActive={turnActive}
        onToolApprovalResponse={onToolApprovalResponse}
        className="mb-0"
      />
    );
  }
  return (
    <ExpandedToolCard
      tool={{
        kind: "tool",
        key: entry.key,
        ...call,
        nestedToolCalls: (
          <>
            <RemedyGuardrailsSteps
              steps={chain.steps}
              onToolApprovalResponse={onToolApprovalResponse}
            />
            {entry.nestedToolCalls}
          </>
        ),
      }}
      onToolApprovalResponse={onToolApprovalResponse}
    />
  );
}

function ExpandedToolCard({
  tool,
  onToolApprovalResponse,
}: {
  tool: CompactToolEntry | CompactAppEntry;
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
}) {
  const { part, toolResultPart, toolName, errorText, nestedToolCalls } = tool;
  const { data: session } = useSession();
  const { getToolShortName } = useArchestraMcpIdentity();
  const {
    task,
    cancel: cancelTask,
    isCancelling: isCancellingTask,
  } = useMcpTaskFor(part.toolCallId);
  const isApprovalRequested = part.state === "approval-requested";
  const approvalDisplay = getApprovalToolDisplay({
    toolName,
    input: part.input,
    isApprovalRequested,
    getToolShortName,
  });
  const displayToolName = approvalDisplay.toolName;
  const displayShortName = getToolShortName(displayToolName);
  const toolShortName = getToolShortName(toolName);
  const policyOutput = toolResultPart?.output ?? part.output;
  const resolvedPolicyToolName = resolveRunToolTargetName(part, toolName, {
    getToolShortName,
  });
  const policyToolName = parseFullToolName(resolvedPolicyToolName).toolName;
  const validationChange = [
    "preview_guardrails_validation_change",
    "update_guardrails_validation",
  ].includes(getToolShortName(resolvedPolicyToolName) ?? "");
  // A save reports its result in one line, not the diff it saved.
  const saveResult = errorText
    ? null
    : getOpenAppaSaveResult({
        shortName: getToolShortName(resolvedPolicyToolName),
        output: policyOutput,
      });
  const policyChange =
    !saveResult &&
    (validationChange || isPolicyChangeTool(policyToolName)) &&
    !errorText &&
    isOpenAppaPolicyChange(policyOutput, validationChange, part.input);
  // A proposal of a file this conversation previewed: the person approving
  // it reads that preview's diff, not the raw file a second time.
  const previewed = usePreviewedChange(part.toolCallId);
  const previewedChange =
    previewed && !saveResult && !policyChange && !errorText ? previewed : null;
  const input = withoutProxyTransportArguments({
    toolName: displayToolName,
    shortName: displayShortName,
    input:
      toolShortName === TOOL_GET_REMEDY_PLANS_SHORT_NAME
        ? withParsedArguments(part.input)
        : isApprovalRequested
          ? approvalDisplay.input
          : part.input,
  });
  const hasInput = input && Object.keys(input).length > 0;
  // Whose credential the gateway used against the upstream server.
  const executedAs = extractMcpExecutedAs(
    toolResultPart ? toolResultPart.output : part.output,
  );

  const logsButton = errorText ? (
    <ToolErrorLogsButton toolName={displayToolName} />
  ) : null;
  const humanRuling = getHumanRulingDisplay({ part, toolResultPart });
  const headerState =
    task?.status === "cancelled"
      ? ("output-cancelled" as const)
      : humanRuling?.ruling === "deny"
        ? ("output-denied" as const)
        : getToolHeaderState({
            state: part.state || "input-available",
            toolResultPart,
            errorText,
          });

  return (
    <Tool open className="mb-0">
      <ToolHeader
        type={`tool-${displayToolName}`}
        title={getToolCardTitle(displayToolName, displayShortName)}
        state={headerState}
        statusLabel={humanRuling?.label}
        isCollapsible={false}
        actionButton={logsButton}
        identityBadge={
          executedAs ? (
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              Called as
              <ExecutedAsBadge
                executedAs={executedAs}
                meUserId={session?.user?.id}
              />
            </span>
          ) : undefined
        }
      />
      <ToolContent>
        {task ? (
          <McpTaskStatusRow
            task={task}
            onCancel={cancelTask}
            isCancelling={isCancellingTask}
          />
        ) : null}
        {hasInput && !policyChange && !saveResult && !previewedChange ? (
          <ToolInput input={input} defaultOpen />
        ) : null}
        {previewedChange ? (
          <PreviewedChangeReview previewed={previewedChange} input={input} />
        ) : null}
        {nestedToolCalls}
        {isApprovalRequested &&
          onToolApprovalResponse &&
          "approval" in part &&
          part.approval?.id && (
            <ToolStatusRow
              icon={
                <ClockIcon className="mt-0.5 size-4 flex-none text-amber-600" />
              }
              title="Approval required"
              description={
                previewedChange
                  ? proposalApprovalText(previewedChange)
                  : "Review this tool call before it can continue."
              }
              actions={[
                {
                  label: "Approve",
                  variant: "secondary",
                  icon: <CheckCircleIcon className="size-4" />,
                  onClick: () =>
                    onToolApprovalResponse({
                      id: (part as { approval: { id: string } }).approval.id,
                      approved: true,
                    }),
                },
                {
                  label: "Decline",
                  variant: "outline",
                  onClick: () =>
                    onToolApprovalResponse({
                      id: (part as { approval: { id: string } }).approval.id,
                      approved: false,
                      reason: "User denied",
                    }),
                },
              ]}
            />
          )}
        {errorText ? <ToolErrorDetails errorText={errorText} /> : null}
        {policyChange && (
          <OpenAppaPolicyChange
            output={policyOutput}
            validationChange={validationChange}
            input={part.input}
          />
        )}
        {saveResult === "validation" ? (
          <OpenAppaValidationCompletion output={policyOutput} />
        ) : saveResult === "policy" ? (
          <OpenAppaPolicyCompletion output={policyOutput} />
        ) : null}
        {toolResultPart && !policyChange && !saveResult && (
          <ToolOutput
            label={errorText ? "Error" : "Result"}
            output={toolResultPart.output}
            errorText={errorText}
          />
        )}
        {!toolResultPart &&
          !policyChange &&
          !saveResult &&
          Boolean(part.output) && (
            <ToolOutput
              label={errorText ? "Error" : "Result"}
              output={part.output}
              errorText={errorText}
            />
          )}
        {hasInput && (policyChange || saveResult) ? (
          <OpenAppaPolicyArguments input={input} />
        ) : null}
      </ToolContent>
    </Tool>
  );
}
