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

/** The `function_call` output item as the Responses API renders it. */
export function responsesFunctionCallItem(toolCall: RewrittenToolCall) {
  return {
    id: `fc_${toolCall.id}`,
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
}): string[] {
  const { toolCalls, firstOutputIndex, nextSequenceNumber } = params;
  return toolCalls.flatMap((toolCall, offset) => {
    const outputIndex = firstOutputIndex + offset;
    const item = responsesFunctionCallItem(toolCall);
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
    if (item.type === "function_call") {
      const callId = (item as { call_id?: unknown }).call_id;
      const rewritten =
        typeof callId === "string" ? byCallId.get(callId) : undefined;
      if (rewritten) {
        replaced.add(rewritten.id);
        next.push(responsesFunctionCallItem(rewritten));
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

export function toSse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
