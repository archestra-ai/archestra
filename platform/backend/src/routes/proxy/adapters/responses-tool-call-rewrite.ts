/**
 * Responses-API wire helpers for re-emitting a turn's tool calls after the
 * proxy repaired a dispatch-mode direct call into `run_tool` (see
 * `planDispatchModeToolCallRewrites`). Shared by the native OpenAI/Azure
 * Responses adapters and the Responses-from-chat translator so the three
 * surfaces emit byte-identical frame shapes.
 *
 * Two facts about the Responses stream drive the shape:
 *
 * - A function call is four frames: `response.output_item.added` (the item,
 *   with `arguments` still empty), `response.function_call_arguments.delta`
 *   (the client concatenates these), `response.function_call_arguments.done`,
 *   and `response.output_item.done` (the completed item). One delta carrying
 *   the whole argument string is the valid degenerate case.
 * - The client keeps the LAST `response.completed` it sees — the SDK
 *   accumulator overwrites its snapshot on each one — and reconstructs the
 *   turn from that envelope's `output`. So a repair is not complete until a
 *   completed envelope naming the rewritten calls has been written after any
 *   envelope the upstream already produced (which named the originals).
 */

import type { HostedToolCall } from "@/types";

type RewrittenToolCall = {
  id: string;
  name: string;
  arguments: string;
  /** The namespace the client declared the tool in (Codex MCP servers). */
  namespace?: string;
  /** Written to the client as `call_id` in place of `id` (OpenAPPA's trajectory stamp). */
  wireId?: string;
};

type ResponsesFunctionCallItem = {
  id?: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  namespace?: string;
  status?: "completed" | "in_progress";
};

type ResponsesCustomCallItem = {
  id?: string;
  type: "custom_tool_call";
  call_id: string;
  name: string;
  input: string;
  status?: "completed" | "in_progress";
};

/**
 * Renders a Responses `function_call` output item, preserving the upstream
 * item ID and namespace when available. Codex routes a call to a namespaced
 * tool (its MCP servers') by the namespace the item names, so a call
 * re-emitted without it reaches no tool.
 */
export function responsesFunctionCallItem(
  toolCall: RewrittenToolCall,
  itemId?: string,
  namespace?: string,
): ResponsesFunctionCallItem {
  return {
    id: itemId ?? `fc_${toolCall.id}`,
    call_id: toolCall.wireId ?? toolCall.id,
    type: "function_call" as const,
    name: toolCall.name,
    arguments: toolCall.arguments,
    ...((toolCall.namespace ?? namespace)
      ? { namespace: toolCall.namespace ?? namespace }
      : {}),
    status: "completed" as const,
  };
}

/**
 * The four streaming frames per call, as SSE strings, output indices
 * continuing from `firstOutputIndex` so they do not collide with items the
 * turn already streamed (text, reasoning).
 */
export function formatResponsesFunctionCallFrames(params: {
  toolCalls: RewrittenToolCall[];
  firstOutputIndex: number;
  nextSequenceNumber: () => number;
  /** The item id upstream streamed for a call, by `call_id`. */
  itemIdByCallId?: ReadonlyMap<string, string>;
  /** The namespace upstream's item for a call named, by `call_id`. */
  namespaceByCallId?: ReadonlyMap<string, string>;
  /**
   * Calls upstream streamed as custom tool calls and this rewrite left alone.
   * They are re-emitted in their own shape: a client that registered a custom
   * tool cannot execute it as a function call.
   */
  customCallIds?: ReadonlySet<string>;
}): string[] {
  const { toolCalls, firstOutputIndex, nextSequenceNumber } = params;
  return toolCalls.flatMap((toolCall, offset) => {
    const outputIndex = firstOutputIndex + offset;
    const itemId = params.itemIdByCallId?.get(toolCall.id);
    if (params.customCallIds?.has(toolCall.id)) {
      return formatCustomToolCallFrames({
        toolCall,
        itemId,
        outputIndex,
        nextSequenceNumber,
      });
    }
    const item = responsesFunctionCallItem(
      toolCall,
      itemId,
      // An explicit namespace, including "", is the rewrite's own. Falling
      // back to the denied call's namespace would re-emit a local native
      // question as a namespaced MCP call.
      toolCall.namespace !== undefined
        ? undefined
        : params.namespaceByCallId?.get(toolCall.id),
    );
    return [
      toSse({
        type: "response.output_item.added",
        output_index: outputIndex,
        sequence_number: nextSequenceNumber(),
        item: { ...item, arguments: "", status: "in_progress" },
      }),
      toSse({
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: outputIndex,
        sequence_number: nextSequenceNumber(),
        delta: toolCall.arguments,
      }),
      toSse({
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        sequence_number: nextSequenceNumber(),
        name: toolCall.name,
        arguments: toolCall.arguments,
      }),
      toSse({
        type: "response.output_item.done",
        output_index: outputIndex,
        sequence_number: nextSequenceNumber(),
        item,
      }),
    ];
  });
}

/**
 * A response `output` with its function-call items replaced by the rewritten
 * calls, matched by the provider's `call_id`. That id — what the client
 * correlates tool results by — is kept unless the call carries the one the
 * client is given instead. Non-call items (text, reasoning) pass through in
 * place; a rewritten call with no upstream item to replace is appended.
 */
export function rewriteResponsesOutput<TItem extends { type?: string }>(
  output: readonly TItem[],
  toolCalls: RewrittenToolCall[],
): Array<TItem | ReturnType<typeof responsesFunctionCallItem>> {
  const byCallId = new Map(toolCalls.map((call) => [call.id, call]));
  const replaced = new Set<string>();
  const next: Array<TItem | ReturnType<typeof responsesFunctionCallItem>> = [];
  for (const item of output) {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const callId = (item as { call_id?: unknown }).call_id;
      const rewritten =
        typeof callId === "string" ? byCallId.get(callId) : undefined;
      if (rewritten) {
        replaced.add(rewritten.id);
        // Notice tools are function calls; rewrite denied custom tools to function calls.
        const isNotice = (item as { name?: unknown }).name !== rewritten.name;
        next.push(
          item.type === "custom_tool_call" && isNotice
            ? (responsesFunctionCallItem(
                rewritten,
                (item as { id?: string }).id,
              ) as unknown as TItem)
            : item.type === "custom_tool_call"
              ? ({
                  ...item,
                  call_id: rewritten.wireId ?? callId,
                } as TItem)
              : (withNamespace(
                  {
                    ...item,
                    call_id: rewritten.wireId ?? callId,
                    name: rewritten.name,
                    arguments: rewritten.arguments,
                  },
                  // A notice lives in its own tool's namespace, not the
                  // denied call's.
                  isNotice
                    ? rewritten.namespace
                    : (rewritten.namespace ?? namespaceOf(item).namespace),
                ) as TItem),
        );
        continue;
      }
    }
    next.push(item);
  }
  for (const call of toolCalls) {
    if (!replaced.has(call.id)) {
      next.push(responsesFunctionCallItem(call));
    }
  }
  return next;
}

/** Where the provider-run part of a turn starts, or -1 when the turn has none. */
export function firstHostedOutputIndex(
  output: readonly { type?: string }[],
): number {
  return output.findIndex((item) => hostedToolName(item) !== undefined);
}

/**
 * The calls the provider ran, in order. The model wrote everything after them
 * with their results in view, and the wire carries those results nowhere else,
 * so the last call's output is that tail; an earlier call has only its own
 * record to show.
 */
export function responsesHostedToolCalls(
  output: readonly { type?: string }[],
): HostedToolCall[] {
  const hosted = output.flatMap((item, index) => {
    const name = hostedToolName(item);
    const { id, action } = item as { id?: unknown; action?: unknown };
    return name !== undefined && typeof id === "string"
      ? [{ id, name, action, index }]
      : [];
  });
  return hosted.map(({ id, name, action, index }, position) => ({
    id,
    name,
    arguments:
      typeof action === "object" && action !== null && !Array.isArray(action)
        ? (action as Record<string, unknown>)
        : {},
    output: JSON.stringify(
      position === hosted.length - 1 ? output.slice(index) : output[index],
    ),
  }));
}

/**
 * The turn with its provider-run part withheld: everything from the first
 * hosted call on is dropped, and the notices stand where it began.
 */
export function holdResponsesHostedOutput<TItem extends { type?: string }>(
  output: readonly TItem[],
  notices: RewrittenToolCall[],
): Array<TItem | ResponsesFunctionCallItem> {
  const first = firstHostedOutputIndex(output);
  return [
    ...output.slice(0, first === -1 ? output.length : first),
    ...notices.map((notice) => responsesFunctionCallItem(notice)),
  ];
}

/**
 * The four streaming frames of a custom tool call, whose input is free-form
 * text: the item, its input deltas, the done marker, and the completed item.
 */
function formatCustomToolCallFrames(params: {
  toolCall: RewrittenToolCall;
  itemId: string | undefined;
  outputIndex: number;
  nextSequenceNumber: () => number;
}): string[] {
  const { toolCall, outputIndex, nextSequenceNumber } = params;
  const id = params.itemId ?? `ctc_${toolCall.id}`;
  // The proxy carries a custom call's one argument as `input`; the wire wants
  // the text itself back.
  const input = customToolInput(toolCall.arguments) ?? toolCall.arguments;
  const item: ResponsesCustomCallItem = {
    id,
    call_id: toolCall.wireId ?? toolCall.id,
    type: "custom_tool_call" as const,
    name: toolCall.name,
    input,
    status: "completed" as const,
  };
  return [
    toSse({
      type: "response.output_item.added",
      output_index: outputIndex,
      sequence_number: nextSequenceNumber(),
      item: { ...item, input: "", status: "in_progress" },
    }),
    toSse({
      type: "response.custom_tool_call_input.delta",
      item_id: id,
      output_index: outputIndex,
      sequence_number: nextSequenceNumber(),
      delta: input,
    }),
    toSse({
      type: "response.custom_tool_call_input.done",
      item_id: id,
      output_index: outputIndex,
      sequence_number: nextSequenceNumber(),
      input,
    }),
    toSse({
      type: "response.output_item.done",
      output_index: outputIndex,
      sequence_number: nextSequenceNumber(),
      item,
    }),
  ];
}

export function toSse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * The namespace a Responses call item names, as a field to spread into the
 * proxy's own view of the call. Codex declares some tools in namespaces, and
 * the provider expects a call to such a tool to name its namespace.
 */
export function namespaceOf(item: unknown): { namespace?: string } {
  const namespace = (item as { namespace?: unknown } | null)?.namespace;
  return typeof namespace === "string" && namespace !== "" ? { namespace } : {};
}

/**
 * The namespace each call named, by call id: from the completed envelope's
 * items, then from what was streamed for calls the envelope did not carry.
 */
export function namespacesByCallId(params: {
  items: readonly unknown[];
  streamed: Iterable<{ id: string; namespace?: string }>;
}): Map<string, string> {
  const byCallId = new Map<string, string>();
  for (const item of params.items) {
    const callId = (item as { call_id?: unknown } | null)?.call_id;
    const { namespace } = namespaceOf(item);
    if (typeof callId === "string" && namespace) {
      byCallId.set(callId, namespace);
    }
  }
  for (const call of params.streamed) {
    if (call.namespace && !byCallId.has(call.id)) {
      byCallId.set(call.id, call.namespace);
    }
  }
  return byCallId;
}

/** Parses the proxy's canonical custom-call wrapper at its wire boundary. */
export function customToolInput(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    const input = (parsed as { input?: unknown }).input;
    return typeof input === "string" ? input : undefined;
  } catch {
    return undefined;
  }
}

/** The policy name of the hosted tool an output item records a run of. */
function hostedToolName(item: { type?: string }): string | undefined {
  return item.type === undefined
    ? undefined
    : HOSTED_TOOL_NAME_BY_ITEM_TYPE[item.type];
}

const HOSTED_TOOL_NAME_BY_ITEM_TYPE: Partial<Record<string, string>> = {
  web_search_call: "web_search",
};

function withNamespace<T extends object>(
  item: T,
  namespace: string | undefined,
): T {
  if (namespace) return { ...item, namespace };
  const { namespace: _dropped, ...rest } = item as T & { namespace?: unknown };
  return rest as T;
}
