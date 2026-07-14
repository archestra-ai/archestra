import type { UIMessage } from "@ai-sdk/react";
import {
  type ArchestraToolShortName,
  getArchestraAppResourceUri,
  HOOK_RUN_PART_TYPE,
  isAppRenderingArchestraToolShortName,
  isBrowserMcpTool,
  parseArchestraAppResourceUri,
  parseFullToolName,
  SUBAGENT_TOOL_CALL_PART_TYPE,
  type SubagentToolCallPartData,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  getToolErrorText,
  isCompactEligible,
} from "@/lib/chat/chat-tools-display.utils";
import type { PanelApp } from "./apps-context";
import type { FileAttachment } from "./editable-user-message";
import type { HookRunChipData } from "./hook-run-chip";
import type { McpToolOutput } from "./mcp-app-container";

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
      /**
       * An MCP-App-rendering tool call (UI-resource result, early UI start, or
       * owned-app management tool). Renders as an app pill in the circle row
       * with its app content below the row.
       */
      kind: "app";
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

/**
 * Assistant turns routinely contain throwaway whitespace-only `text` parts that
 * the model streams right before a tool call (e.g. `" "`, `"   "`, `"\n\n"`).
 * They carry no content and must not render as empty message bubbles. The check
 * trims before testing for emptiness, matching the `text.trim().length > 0`
 * guards used elsewhere in the message stream; a bare `!part.text` only catches
 * the strictly-empty string and lets whitespace through.
 */
export function isBlankAssistantTextPart(
  part: UIMessage["parts"][number],
  role: UIMessage["role"],
): boolean {
  return role === "assistant" && part.type === "text" && !part.text.trim();
}

/**
 * Anthropic `redacted_thinking` blocks (encrypted, no visible text) and
 * signature-only `thinking` blocks arrive as `reasoning` parts with empty text.
 * They are load-bearing — the thinking signature must be replayed to the
 * provider on the next turn — so they are persisted and reload verbatim, but
 * rendered they show as empty "Thinking…" accordions. Suppress those; a
 * reasoning part only renders when it carries readable text. Structurally typed
 * so both the live-chat (`UIMessage`) and read-only (`PartialUIMessage`) part
 * shapes qualify.
 */
export function isBlankReasoningPart(part: {
  type: string;
  text?: string;
}): boolean {
  return part.type === "reasoning" && !part.text?.trim();
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
 * Every render is its own entry (keyed by its unique toolCallId), so each inline
 * pill — including older renders of the same owned app — stays independently
 * openable and expands its app under itself. Owned apps always resolve to the
 * latest version at render time (their runtime endpoint is keyed by `appId`), so
 * a stale render still shows current content. Display surfaces that must not
 * repeat an app fold the registry into per-app groups (see `buildAppGroups`)
 * instead of the registry deduping here.
 */

/**
 * Address-bar label for an external MCP tool: the raw server and tool name from
 * its full name, e.g. "Archestra PM__show_board" -> "Archestra PM / show_board".
 */
export function mcpToolLabel(fullToolName: string): string {
  const { serverName, toolName } = parseFullToolName(fullToolName);
  return serverName ? `${serverName} / ${toolName}` : toolName;
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

  for (const message of messages) {
    const createdAt = getMessageCreatedAt(message);

    for (const part of message.parts ?? []) {
      if (!isToolPart(part) || !part.toolCallId || seen.has(part.toolCallId)) {
        continue;
      }

      const { outputUri, mcpServerId, fullToolName } = parseToolAppRender(
        part,
        earlyToolUiStarts[part.toolCallId],
      );

      // An owned app rendered by its own render (e.g. its `__open` launch tool)
      // carries a `ui://archestra-app/<appId>` URI. Route it by `appId` to the
      // app-bound endpoint so its SDK storage and app-scoped tool calls reach
      // `/api/mcp/app/:appId`, not the generic agent gateway. Its head version
      // is served from that endpoint, so the inline result isn't seeded.
      const uriAppId = outputUri
        ? parseArchestraAppResourceUri(outputUri)
        : null;
      if (uriAppId) {
        seen.add(part.toolCallId);
        apps.push({
          toolCallId: part.toolCallId,
          label: mcpToolLabel(fullToolName),
          uiResourceUri: outputUri as string,
          appId: uriAppId,
          toolName: resolveRunToolTargetName(part, fullToolName, {
            getToolShortName,
          }),
          version: null,
          createdAt: createdAt ?? 0,
        });

        continue;
      }

      // An external MCP-UI render carries its own URI in the result. It never
      // dedups: the same URI can represent entirely different content across
      // calls (e.g. Excalidraw drawing different pictures), so each tool call is
      // its own entry keyed by its unique toolCallId.
      if (outputUri) {
        seen.add(part.toolCallId);
        apps.push({
          toolCallId: part.toolCallId,
          label: mcpToolLabel(fullToolName),
          uiResourceUri: outputUri,
          appId: null,
          mcpServerId,
          // Unwrap run_tool so the server prefix matches the inline render.
          toolName: resolveRunToolTargetName(part, fullToolName, {
            getToolShortName,
          }),
          // Seed the panel-hosted iframe with the tool result exactly like the
          // inline render, so it doesn't re-call its source tool on mount.
          rawOutput: part.output as McpToolOutput,
          // Unwrap run_tool's tool_args so the seeded input matches inline.
          toolInput:
            getToolShortName(fullToolName) === TOOL_RUN_TOOL_SHORT_NAME
              ? ((
                  part.input as
                    | { tool_args?: Record<string, unknown> }
                    | undefined
                )?.tool_args ?? null)
              : ((part.input as Record<string, unknown> | undefined) ?? null),
          version: null,
          createdAt: createdAt ?? 0,
        });

        continue;
      }

      // Otherwise it may be an owned-app management result. Each render is its
      // own entry so its pill stays independently openable; owned apps resolve
      // to the latest version at render time via the `appId` runtime endpoint.
      const ownedApp = extractOwnedAppRender({
        toolName: resolveRunToolTargetName(part, fullToolName, {
          getToolShortName,
        }),
        output: part.output,
        getToolShortName,
      });

      if (!ownedApp) {
        continue;
      }

      seen.add(part.toolCallId);

      apps.push({
        toolCallId: part.toolCallId,
        label: ownedApp.appName ?? mcpToolLabel(fullToolName),
        uiResourceUri: getArchestraAppResourceUri(ownedApp.appId),
        appId: ownedApp.appId,
        toolName: fullToolName,
        version: ownedApp.latestVersion,
        createdAt: createdAt ?? 0,
      });
    }
  }

  return apps;
}

/**
 * Everything an app group entry needs to mount its runtime, resolved from the
 * tool part the same way the full-card path resolves it: an external MCP-UI
 * result (or early UI start) yields the URI-bound render; an owned-app
 * management result yields the app-bound render. `null` means the call is an
 * app-rendering tool with nothing to mount yet (e.g. a still-streaming
 * scaffold/edit call) — render it as a plain tool circle until the result lands.
 */
export type AppEntryRender = {
  uiResourceUri: string;
  appId?: string;
  mcpServerId?: string | null;
  appName?: string | null;
  appVersion?: number | null;
  /** Full tool name with any run_tool wrapper already unwrapped. */
  mcpAppToolName: string;
  toolInput?: Record<string, unknown>;
  rawOutput?: McpToolOutput;
};

export function resolveAppEntryRender(params: {
  part: DynamicToolUIPart | ToolUIPart;
  toolResultPart: DynamicToolUIPart | ToolUIPart | null;
  early?: { uiResourceUri?: string; toolName?: string };
  getToolShortName: (toolName: string) => ArchestraToolShortName | null;
}): AppEntryRender | null {
  const { part, toolResultPart, early, getToolShortName } = params;
  const output = (toolResultPart?.output ?? part.output) as
    | McpToolOutput
    | undefined;
  const fullToolName = getToolName(part) ?? early?.toolName ?? "";
  const mcpAppToolName = resolveRunToolTargetName(part, fullToolName, {
    getToolShortName,
  });

  const ui = output?._meta?.ui as
    | { resourceUri?: string; mcpServerId?: string }
    | undefined;
  const outputUri = ui?.resourceUri ?? early?.uiResourceUri ?? null;
  if (outputUri) {
    // An owned app's own render (e.g. its `__open` launch tool) carries a
    // `ui://archestra-app/<appId>` URI; bind it so the app runs against the
    // app-bound endpoint (/api/mcp/app/:appId), not the agent gateway.
    const uriAppId = parseArchestraAppResourceUri(outputUri);
    // When the model dispatched through run_tool, the app belongs to the
    // *target* tool: forward its real arguments, not the run_tool wrapper's.
    const runToolInput =
      getToolShortName(fullToolName) === TOOL_RUN_TOOL_SHORT_NAME
        ? (part.input as { tool_args?: Record<string, unknown> } | null)
            ?.tool_args
        : undefined;
    return {
      uiResourceUri: outputUri,
      appId: uriAppId ?? undefined,
      mcpServerId: ui?.mcpServerId ?? null,
      mcpAppToolName,
      toolInput: runToolInput ?? (part.input as Record<string, unknown>),
      rawOutput: output,
    };
  }

  // Owned-app management result (scaffold/edit/render_app): mount the
  // app-bound runtime from structuredContent.id. The management tool's
  // input/result are not forwarded into the iframe (they are not app data).
  const ownedApp = extractOwnedAppRender({
    toolName: mcpAppToolName,
    output,
    getToolShortName,
  });
  if (ownedApp) {
    return {
      uiResourceUri: getArchestraAppResourceUri(ownedApp.appId),
      appId: ownedApp.appId,
      appName: ownedApp.appName,
      appVersion: ownedApp.latestVersion,
      mcpAppToolName,
    };
  }

  return null;
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

/** One tool call a delegated child agent made, ready to render as a tool card. */
export type SubagentChildEntry = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  state: string | undefined;
  errorText: string | undefined;
};

/**
 * Collect every subagent tool call in the conversation into a map keyed by the
 * delegation call that spawned it (`parentToolCallId`). A child whose own
 * `toolCallId` is itself a key has descendants (a nested delegation), so the
 * renderer recurses to build an arbitrary-depth tree. Collected across all
 * messages — not per-message — so where the backend stored a part never affects
 * how it nests. Deduped by `toolCallId` so a part present both live (streamed)
 * and persisted (after reload) renders once.
 */
export function collectSubagentToolCalls(
  messages: UIMessage[],
): Map<string, SubagentChildEntry[]> {
  const byParent = new Map<string, SubagentChildEntry[]>();
  const seen = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const candidate = part as { type?: string; data?: unknown };
      if (candidate.type !== SUBAGENT_TOOL_CALL_PART_TYPE) {
        continue;
      }
      const data = candidate.data as SubagentToolCallPartData | undefined;
      if (
        !data ||
        typeof data.parentToolCallId !== "string" ||
        typeof data.toolCallId !== "string" ||
        seen.has(data.toolCallId)
      ) {
        continue;
      }
      seen.add(data.toolCallId);
      const entry: SubagentChildEntry = {
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        input: data.input,
        output: data.output,
        state: data.state,
        errorText: data.errorText,
      };
      const list = byParent.get(data.parentToolCallId);
      if (list) {
        list.push(entry);
      } else {
        byParent.set(data.parentToolCallId, [entry]);
      }
    }
  }
  return byParent;
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
    if (!isToolPart(part)) continue;

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

    // MCP-App-rendering calls join the row as app pills (their app content
    // renders below the row). Errors, approvals, and denials keep the full
    // tool card, exactly like non-compact tools.
    if (
      isAppRenderPart({
        part: rawPart,
        toolResultPart,
        mcpAppCallIds,
        getToolShortName: options?.getToolShortName,
      })
    ) {
      const state = (toolResultPart ?? rawPart).state;
      const appEligible =
        !errorText &&
        state !== "approval-requested" &&
        state !== "output-denied";
      if (appEligible) {
        if (!currentGroup) {
          currentGroup = { startIndex: idx, entries: [] };
        }
        currentGroup.entries.push({
          kind: "app",
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
      continue;
    }

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

/**
 * Detect an MCP-App-rendering tool call: a UI-resource result (on the
 * invocation or its result part), an early `data-tool-ui-start` announcement,
 * or an owned-app management tool (scaffold/edit/render_app — matched by name
 * so a still-pending call renders compact from the moment it streams).
 */
function isAppRenderPart(params: {
  part: DynamicToolUIPart | ToolUIPart;
  toolResultPart: DynamicToolUIPart | ToolUIPart | null;
  mcpAppCallIds: Set<string>;
  getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
}): boolean {
  const { part, toolResultPart, mcpAppCallIds, getToolShortName } = params;
  const output = toolResultPart?.output ?? part.output;
  // biome-ignore lint/suspicious/noExplicitAny: checking nested _meta shape on unknown output
  if ((output as any)?._meta?.ui?.resourceUri) return true;
  if (part.toolCallId && mcpAppCallIds.has(part.toolCallId)) return true;
  if (!getToolShortName) return false;
  // Owned-app management tools, unwrapping run_tool so a dispatch targeting
  // scaffold/edit/render_app is covered too (its raw name is run_tool, which
  // nonCompactToolNames deliberately does not contain).
  const targetName = resolveRunToolTargetName(part, getToolName(part) ?? "", {
    getToolShortName,
  });
  const shortName = getToolShortName(targetName);
  return shortName !== null
    ? isAppRenderingArchestraToolShortName(shortName)
    : isAppRenderingArchestraToolShortName(targetName);
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

/**
 * Read an app render's UI-resource URI and full tool name from a tool part,
 * falling back to the early `data-tool-ui-start` data when the tool result
 * hasn't arrived yet (mid-stream). `outputUri` is the external MCP-UI URI, if any.
 */
function parseToolAppRender(
  part: DynamicToolUIPart | ToolUIPart,
  early: { uiResourceUri?: string; toolName?: string } | undefined,
): {
  outputUri: string | null;
  mcpServerId: string | null;
  fullToolName: string;
} {
  // biome-ignore lint/suspicious/noExplicitAny: checking nested _meta shape on unknown output
  const ui = (part.output as any)?._meta?.ui as
    | { resourceUri?: string; mcpServerId?: string }
    | undefined;
  const outputUri = ui?.resourceUri ?? early?.uiResourceUri ?? null;
  // A server-scoped deep link (apps-page open-in-chat) stamps the concrete
  // install so the chat mounts against it; live tool calls omit it.
  const mcpServerId = ui?.mcpServerId ?? null;
  const fullToolName = getToolName(part) ?? early?.toolName ?? "";
  return { outputUri, mcpServerId, fullToolName };
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
