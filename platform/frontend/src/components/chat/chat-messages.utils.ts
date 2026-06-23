import type { UIMessage } from "@ai-sdk/react";
import {
  type ArchestraToolShortName,
  getArchestraAppResourceUri,
  getArchestraToolShortName,
  HOOK_RUN_PART_TYPE,
  isAppRenderingArchestraToolShortName,
  isBrowserMcpTool,
  parseFullToolName,
  TOOL_EDIT_APP_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
} from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { startCase } from "lodash-es";
import {
  getToolErrorText,
  isCompactEligible,
} from "@/lib/chat/chat-tools-display.utils";
import type { PanelApp } from "./apps-context";
import type { FileAttachment } from "./editable-user-message";
import type { HookRunChipData } from "./hook-run-chip";

export type OptimisticToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type CompactToolGroupEntry =
  | {
      kind: "tool";
      partIndex: number;
      toolName: string;
      part: DynamicToolUIPart | ToolUIPart;
      toolResultPart: DynamicToolUIPart | ToolUIPart | null;
      errorText: string | undefined;
    }
  | {
      /** An inline `data-hook-run` debug entry rendered as a circle in the row. */
      kind: "hook";
      partIndex: number;
      data: HookRunChipData;
    };

export type CompactToolGroup = {
  startIndex: number;
  entries: CompactToolGroupEntry[];
};

/**
 * Extract file attachments from message parts.
 * Filters for file parts and maps them to FileAttachment format.
 */
export function extractFileAttachments(
  parts: UIMessage["parts"] | undefined,
): FileAttachment[] | undefined {
  return parts
    ?.filter((p) => p.type === "file")
    .map((p) => {
      const filePart = p as {
        type: "file";
        url: string;
        mediaType: string;
        filename?: string;
      };
      return {
        url: filePart.url,
        mediaType: filePart.mediaType,
        filename: filePart.filename,
      };
    });
}

/**
 * Check if a message has any text parts.
 */
export function hasTextPart(parts: UIMessage["parts"] | undefined): boolean {
  return parts?.some((p) => p.type === "text") ?? false;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Detect an owned-app render: a successful `scaffold_app`/`edit_app`/`render_app`
 * result identifies an Archestra-authored MCP App via `structuredContent.id`,
 * and chat mounts the app-bound runtime from that id. Only archestra-branded
 * tool names match — a foreign server exposing a tool with the same short name
 * resolves to `null` and never triggers a mount.
 */
export function extractOwnedAppRender(params: {
  /** Full tool name with any run_tool wrapper already unwrapped */
  toolName: string;
  output: unknown;
  getToolShortName: (toolName: string) => ArchestraToolShortName | null;
}): {
  appId: string;
  appName: string | null;
  latestVersion: number | null;
} | null {
  const shortName = params.getToolShortName(params.toolName);
  // run_tool also accepts bare archestra short names; a bare name can only be
  // a run_tool target — direct chat tool names are always server-prefixed.
  const matchesAppTrio =
    shortName !== null
      ? isAppRenderingArchestraToolShortName(shortName)
      : isAppRenderingArchestraToolShortName(params.toolName);
  if (!matchesAppTrio) {
    return null;
  }
  const structured = (
    params.output as
      | {
          structuredContent?: {
            id?: unknown;
            name?: unknown;
            latestVersion?: unknown;
          };
        }
      | undefined
  )?.structuredContent;
  const id = structured?.id;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    return null;
  }
  return {
    appId: id,
    appName: typeof structured?.name === "string" ? structured.name : null,
    // Keys the render-loop diagnostics: "app X v3 threw" must point at the
    // version this render actually showed.
    latestVersion:
      typeof structured?.latestVersion === "number"
        ? structured.latestVersion
        : null,
  };
}

/**
 * Whether a render has been superseded by a newer render of the same app in the
 * conversation. The app registry (see {@link deriveAppsFromMessages}) dedupes
 * apps by `uiResourceUri` to their latest render, so a render is superseded when
 * the registry holds an entry for its `uiResourceUri` whose `toolCallId` differs.
 * Applies to both owned apps and external MCP-UI tool calls.
 *
 * Returns `false` when the registry has no entry for the app yet (e.g. mid-stream
 * before the result is derived) so a freshly arriving render is never wrongly
 * collapsed. Superseded renders show a static changelog pill instead of a live
 * iframe; only the latest render of each app stays live.
 */
export function isSupersededRender(params: {
  apps: PanelApp[];
  uiResourceUri: string;
  toolCallId: string | undefined;
}): boolean {
  const latest = params.apps.find(
    (a) => a.uiResourceUri === params.uiResourceUri,
  )?.toolCallId;
  return latest !== undefined && latest !== params.toolCallId;
}

/**
 * Past-tense verb describing what an owned-app render did, derived from the tool
 * that produced it — used as the trailing label on a superseded render's
 * changelog pill (e.g. "Dashboard · v2 · Updated"). Returns `null` for unknown
 * tools so the pill simply omits the verb.
 */
export function getAppRenderVerb(toolName: string): string | null {
  switch (getArchestraToolShortName(toolName, { includeDefaultPrefix: true })) {
    case TOOL_SCAFFOLD_APP_SHORT_NAME:
      return "Created";
    case TOOL_EDIT_APP_SHORT_NAME:
      return "Updated";
    case TOOL_RENDER_APP_SHORT_NAME:
      return "Rendered";
    default:
      return null;
  }
}

/**
 * Derive the list of MCP Apps for a conversation directly from its messages
 * (plus any early UI-start data from the active stream).
 *
 * A tool call yields an app when its output carries `_meta.ui.resourceUri`,
 * when the backend announced it via a `data-tool-ui-start` event (tracked in
 * `earlyToolUiStarts`) before the result arrived, or when it is an owned-app
 * management result (see {@link extractOwnedAppRender}). Deriving the registry
 * from the conversation — rather than from `McpAppSection` mount/unmount
 * effects — makes the panel selector deterministic: it matches what a page
 * refresh reconstructs and never empties because a single section briefly
 * unmounts.
 *
 * Apps are deduped by `uiResourceUri`: repeated renders of the same app collapse
 * to a single entry that tracks the latest render (its toolCallId and version),
 * so the panel defaults to the newest version. Owned (Archestra-authored) apps
 * use the synthetic `ui://archestra-app/<appId>` URI (version-independent, so
 * every version collapses together); external MCP-UI tool calls use the URI from
 * their result.
 */

/**
 * Friendly label for an external MCP tool, derived from its full name.
 * "system__get-system-stats" -> "System / Get System Stats"; "render_app" -> "Render App".
 */
export function humanizeToolLabel(fullToolName: string): string {
  const { serverName, toolName } = parseFullToolName(fullToolName);
  return serverName
    ? `${startCase(serverName)} / ${startCase(toolName)}`
    : startCase(toolName);
}

export function deriveAppsFromMessages(
  messages: UIMessage[],
  earlyToolUiStarts: Record<
    string,
    { uiResourceUri?: string; toolName?: string }
  >,
  getToolShortName: (toolName: string) => ArchestraToolShortName | null,
): PanelApp[] {
  const apps: PanelApp[] = [];
  const seen = new Set<string>();
  // Maps an app's `uiResourceUri` to its index in `apps`, so a later render of
  // the same app replaces the earlier entry instead of appending a duplicate.
  const appIndex = new Map<string, number>();

  for (const message of messages) {
    const createdAt = getMessageCreatedAt(message);
    for (const part of message.parts ?? []) {
      if (!isToolPart(part)) continue;
      const toolCallId = part.toolCallId;
      if (!toolCallId || seen.has(toolCallId)) continue;

      const early = earlyToolUiStarts[toolCallId];
      const outputUri =
        // biome-ignore lint/suspicious/noExplicitAny: checking nested _meta shape on unknown output
        ((part.output as any)?._meta?.ui?.resourceUri as string | undefined) ??
        early?.uiResourceUri ??
        null;
      const hasUiResource = Boolean(outputUri);
      const fullToolName = getToolName(part) ?? early?.toolName ?? "";
      const ownedApp = hasUiResource
        ? null
        : extractOwnedAppRender({
            toolName: resolveRunToolTargetName(part, fullToolName, {
              getToolShortName,
            }),
            output: part.output,
            getToolShortName,
          });
      // Owned apps drive the app-bound endpoint via a synthetic, version-stable
      // URI; external MCP-UI calls carry their own URI in the result.
      const uiResourceUri = ownedApp
        ? getArchestraAppResourceUri(ownedApp.appId)
        : outputUri;
      if (!uiResourceUri) continue;

      seen.add(toolCallId);
      const entry: PanelApp = {
        toolCallId,
        label: ownedApp?.appName ?? humanizeToolLabel(fullToolName),
        uiResourceUri,
        appId: ownedApp?.appId ?? null,
        version: ownedApp?.latestVersion ?? null,
        createdAt: createdAt ?? 0,
      };

      const existing = appIndex.get(uiResourceUri);
      if (existing !== undefined) {
        apps[existing] = entry;
        continue;
      }
      appIndex.set(uiResourceUri, apps.length);
      apps.push(entry);
    }
  }

  return apps;
}

/** Unwrap a run_tool dispatch to the target tool name (no-op for other tools). */
export function resolveRunToolTargetName(
  part: DynamicToolUIPart | ToolUIPart,
  fullToolName: string,
  options: {
    getToolShortName: (toolName: string) => ArchestraToolShortName | null;
  },
): string {
  if (options.getToolShortName(fullToolName) !== TOOL_RUN_TOOL_SHORT_NAME) {
    return fullToolName;
  }
  const target = (part.input as { tool_name?: unknown } | undefined)?.tool_name;
  return typeof target === "string" && target.length > 0
    ? target
    : fullToolName;
}

function getMessageCreatedAt(message: UIMessage): number | null {
  const metadata = message.metadata;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "createdAt" in metadata &&
    typeof metadata.createdAt === "string"
  ) {
    const createdAt = Date.parse(metadata.createdAt);
    return Number.isNaN(createdAt) ? null : createdAt;
  }
  return null;
}

export function filterOptimisticToolCalls(
  messages: UIMessage[],
  optimisticToolCalls: OptimisticToolCall[],
): OptimisticToolCall[] {
  const renderedToolCallIds = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        typeof part === "object" &&
        part !== null &&
        "toolCallId" in part &&
        typeof part.toolCallId === "string"
      ) {
        renderedToolCallIds.add(part.toolCallId);
      }
    }
  }

  return optimisticToolCalls.filter(
    (toolCall) => !renderedToolCallIds.has(toolCall.toolCallId),
  );
}

export function collectBrowserToolCallIds(params: {
  messages: UIMessage[];
  optimisticToolCalls?: OptimisticToolCall[];
}): Set<string> {
  const ids = new Set<string>();

  for (const message of params.messages) {
    for (const part of message.parts ?? []) {
      if (!isToolPart(part) || !part.toolCallId) continue;

      const toolName = getToolName(part);
      if (toolName && isBrowserMcpTool(toolName)) {
        ids.add(part.toolCallId);
      }
    }
  }

  for (const toolCall of params.optimisticToolCalls ?? []) {
    if (isBrowserMcpTool(toolCall.toolName)) {
      ids.add(toolCall.toolCallId);
    }
  }

  return ids;
}

export function identifyCompactToolGroups(
  parts: UIMessage["parts"] | undefined,
  options?: {
    nonCompactToolNames?: Set<string>;
    getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
    mcpAppToolCallIds?: Set<string>;
  },
): { groupMap: Map<number, CompactToolGroup>; consumedIndices: Set<number> } {
  const groupMap = new Map<number, CompactToolGroup>();
  const consumedIndices = new Set<number>();

  if (!parts) return { groupMap, consumedIndices };

  // Collect toolCallIds from data-tool-ui-start parts (MCP Apps known before output arrives)
  const mcpAppCallIds = new Set(options?.mcpAppToolCallIds);
  for (const part of parts) {
    // biome-ignore lint/suspicious/noExplicitAny: data-tool-ui-start shape is dynamic
    const earlyPart = part as any;
    if (
      typeof earlyPart?.type === "string" &&
      earlyPart.type.startsWith("data-tool-ui-start") &&
      earlyPart.data?.toolCallId
    ) {
      mcpAppCallIds.add(earlyPart.data.toolCallId as string);
    }
  }

  const seenToolCallIds = new Set<string>();
  const invocationIndices: number[] = [];
  const resultByCallId = new Map<string, number>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Hook-run debug parts join the circle row alongside the tool calls they
    // bracket (SessionStart at turn start, Pre/PostToolUse around their tool).
    if (isHookRunPart(part)) {
      invocationIndices.push(i);
      continue;
    }
    // Skip non-tool parts and MCP App tools (they render their own UI)
    // biome-ignore lint/suspicious/noExplicitAny: checking nested _meta shape on unknown output
    if (!isToolPart(part) || (part.output as any)?._meta?.ui?.resourceUri)
      continue;
    // Also skip tools identified as MCP Apps via early UI start or earlyToolUiStarts
    if (part.toolCallId && mcpAppCallIds.has(part.toolCallId)) continue;
    // Owned-app renders escape compaction by OUTPUT, not name, so a run_tool
    // dispatch targeting create/update/render_app is covered too (its raw name
    // is run_tool, which nonCompactToolNames deliberately does not contain).
    if (
      options?.getToolShortName &&
      extractOwnedAppRender({
        toolName: resolveRunToolTargetName(part, getToolName(part) ?? "", {
          getToolShortName: options.getToolShortName,
        }),
        output: part.output,
        getToolShortName: options.getToolShortName,
      })
    ) {
      continue;
    }

    const callId = part.toolCallId;
    if (callId && seenToolCallIds.has(callId)) {
      resultByCallId.set(callId, i);
      continue;
    }

    if (callId) {
      seenToolCallIds.add(callId);
    }
    invocationIndices.push(i);
  }

  let currentGroup: CompactToolGroup | null = null;

  for (const idx of invocationIndices) {
    const rawPart = parts[idx];
    // Hook runs are always compact-eligible: join (or start) the current row.
    if (isHookRunPart(rawPart)) {
      if (!currentGroup) {
        currentGroup = { startIndex: idx, entries: [] };
      }
      currentGroup.entries.push({
        kind: "hook",
        partIndex: idx,
        data: (rawPart.data ?? {}) as HookRunChipData,
      });
      consumedIndices.add(idx);
      continue;
    }
    if (!isToolPart(rawPart)) {
      finalizeCurrentGroup({ currentGroup, groupMap });
      currentGroup = null;
      continue;
    }

    const toolName = getToolName(rawPart);
    if (!toolName) {
      finalizeCurrentGroup({ currentGroup, groupMap });
      currentGroup = null;
      continue;
    }

    const resultIdx = rawPart.toolCallId
      ? resultByCallId.get(rawPart.toolCallId)
      : undefined;
    const toolResultPart =
      resultIdx !== undefined && isToolPart(parts[resultIdx])
        ? parts[resultIdx]
        : null;
    const errorText = getToolErrorText({
      part: rawPart as never,
      toolResultPart: toolResultPart as never,
    });
    const isEligible =
      !options?.nonCompactToolNames?.has(toolName) &&
      isCompactEligible({
        part: rawPart as never,
        toolResultPart: toolResultPart as never,
        toolName,
        getToolShortName: options?.getToolShortName,
      });

    if (isEligible) {
      if (!currentGroup) {
        currentGroup = { startIndex: idx, entries: [] };
      }
      currentGroup.entries.push({
        kind: "tool",
        partIndex: idx,
        toolName,
        part: rawPart,
        toolResultPart,
        errorText,
      });
      consumedIndices.add(idx);
      if (resultIdx !== undefined) {
        consumedIndices.add(resultIdx);
      }
    } else {
      finalizeCurrentGroup({ currentGroup, groupMap });
      currentGroup = null;
    }
  }

  finalizeCurrentGroup({ currentGroup, groupMap });
  return { groupMap, consumedIndices };
}

function isHookRunPart(
  part: unknown,
): part is { type: string; data?: unknown } {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === HOOK_RUN_PART_TYPE
  );
}

function isToolPart(part: unknown): part is DynamicToolUIPart | ToolUIPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

function getToolName(part: DynamicToolUIPart | ToolUIPart): string | null {
  if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
    return part.toolName;
  }

  if (part.type.startsWith("tool-")) {
    return part.type.replace("tool-", "");
  }

  return null;
}

function finalizeCurrentGroup(params: {
  currentGroup: CompactToolGroup | null;
  groupMap: Map<number, CompactToolGroup>;
}) {
  const { currentGroup, groupMap } = params;
  if (currentGroup && currentGroup.entries.length > 0) {
    groupMap.set(currentGroup.startIndex, currentGroup);
  }
}
