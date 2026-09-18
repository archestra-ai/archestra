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

type RewrittenToolCall = { id: string; name: string; arguments: string };

type ResponsesFunctionCallItem = {
  id?: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
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

/** Renders a Responses `function_call` output item, preserving upstream item ID when available. */
export function responsesFunctionCallItem(
  toolCall: RewrittenToolCall,
  itemId?: string,
): ResponsesFunctionCallItem {
  return {
    id: itemId ?? `fc_${toolCall.id}`,
    call_id: toolCall.id,
    type: "function_call" as const,
    name: toolCall.name,
    arguments: toolCall.arguments,
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
    const item = responsesFunctionCallItem(toolCall, itemId);
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
 * calls, matched by `call_id` so ids — what the client correlates tool results
 * by — are untouched. Non-call items (text, reasoning) pass through in place; a
 * rewritten call with no upstream item to replace is appended.
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
              ? item
              : ({
                  ...item,
                  name: rewritten.name,
                  arguments: rewritten.arguments,
                } as TItem),
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
    call_id: toolCall.id,
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
