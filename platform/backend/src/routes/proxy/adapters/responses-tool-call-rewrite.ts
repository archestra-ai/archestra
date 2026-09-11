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

type RewrittenToolCall = {
  id: string;
  name: string;
  arguments: string;
  /** The authoritative upstream item, when this call was rewritten in place. */
  originalItem?: ResponsesToolCallItem;
};

type ResponsesToolCallItem = {
  type?: unknown;
  id?: unknown;
  call_id?: unknown;
  name?: unknown;
  namespace?: unknown;
  arguments?: unknown;
  input?: unknown;
  server_label?: unknown;
  [key: string]: unknown;
};

/** The `function_call` output item as the Responses API renders it. */
export function responsesFunctionCallItem(toolCall: RewrittenToolCall) {
  const original = toolCall.originalItem;
  const name = providerToolName(toolCall, original);
  if (original?.type === "custom_tool_call") {
    const item = {
      ...original,
      call_id: toolCall.id,
      type: "custom_tool_call" as const,
      name,
    };
    if ("input" in original || !("arguments" in original)) {
      const { arguments: _arguments, ...withoutArguments } = item;
      return {
        ...withoutArguments,
        input: customToolInput(toolCall.arguments),
      };
    }
    return { ...item, arguments: toolCall.arguments };
  }
  if (original?.type === "mcp_call") {
    return {
      ...original,
      id: typeof original.id === "string" ? original.id : toolCall.id,
      type: "mcp_call" as const,
      name,
      arguments: toolCall.arguments,
      status: "completed" as const,
    };
  }
  return {
    ...original,
    id: typeof original?.id === "string" ? original.id : `fc_${toolCall.id}`,
    call_id: toolCall.id,
    type: "function_call" as const,
    name,
    arguments: toolCall.arguments,
    status: "completed" as const,
  };
}

/**
 * Function calls use the documented four-frame sequence. Custom calls keep
 * their native item shape and have no invented function-arguments frames.
 */
export function formatResponsesFunctionCallFrames(params: {
  toolCalls: RewrittenToolCall[];
  firstOutputIndex: number;
  nextSequenceNumber: () => number;
}): string[] {
  const { toolCalls, firstOutputIndex, nextSequenceNumber } = params;
  return toolCalls.flatMap((toolCall, offset) => {
    const outputIndex = firstOutputIndex + offset;
    const item = responsesFunctionCallItem(toolCall);
    if (item.type === "custom_tool_call" || item.type === "mcp_call") {
      return [
        toSse({
          type: "response.output_item.added",
          output_index: outputIndex,
          sequence_number: nextSequenceNumber(),
          item: { ...item, status: "in_progress" },
        }),
        toSse({
          type: "response.output_item.done",
          output_index: outputIndex,
          sequence_number: nextSequenceNumber(),
          item,
        }),
      ];
    }
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
 * A response `output` with its native tool-call items replaced by rewritten
 * calls, matched by `call_id`. The original item supplies the wire kind and
 * all opaque provider fields, so a custom call is never flattened to a
 * function call while non-call items pass through untouched.
 */
export function rewriteResponsesOutput<TItem extends { type?: string }>(
  output: readonly TItem[],
  toolCalls: RewrittenToolCall[],
): Array<TItem | ReturnType<typeof responsesFunctionCallItem>> {
  const byCallId = new Map(toolCalls.map((call) => [call.id, call]));
  const replaced = new Set<string>();
  const next: Array<TItem | ReturnType<typeof responsesFunctionCallItem>> = [];
  for (const item of output) {
    if (
      item.type === "function_call" ||
      item.type === "custom_tool_call" ||
      item.type === "mcp_call"
    ) {
      const callId =
        item.type === "mcp_call"
          ? (item as { id?: unknown }).id
          : (item as { call_id?: unknown }).call_id;
      const rewritten =
        typeof callId === "string" ? byCallId.get(callId) : undefined;
      if (rewritten) {
        replaced.add(rewritten.id);
        next.push(
          responsesFunctionCallItem({
            ...rewritten,
            originalItem: item,
          }),
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

function providerToolName(
  toolCall: RewrittenToolCall,
  original: ResponsesToolCallItem | undefined,
): string {
  const serverLabel = original?.server_label;
  if (typeof serverLabel === "string" && serverLabel.length > 0) {
    const prefix = `mcp__${serverLabel}__`;
    return toolCall.name.startsWith(prefix)
      ? toolCall.name.slice(prefix.length)
      : toolCall.name;
  }
  const namespace = original?.namespace;
  if (typeof namespace !== "string" || namespace.length === 0) {
    return toolCall.name;
  }
  const prefix = `${namespace}${namespace.startsWith("mcp__") ? "__" : "."}`;
  return toolCall.name.startsWith(prefix)
    ? toolCall.name.slice(prefix.length)
    : toolCall.name;
}

function customToolInput(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { input?: unknown }).input === "string"
    ) {
      return (parsed as { input: string }).input;
    }
  } catch {
    // The caller receives a protocol error rather than a fabricated custom call.
  }
  throw new Error("Custom Responses tool call has no string input");
}

export function toSse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
