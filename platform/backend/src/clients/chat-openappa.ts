import { randomUUID } from "node:crypto";
import { buildPolicyDeniedMcpToolError } from "@archestra/shared";
import {
  type LanguageModel,
  type Tool,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import {
  APPA_CHAT_BLOCK_HEADER,
  APPA_CHAT_BLOCK_VERSION,
  decodeChatBlock,
} from "@/openappa/chat-block";
import { type OpenAppaSession, openappaEnabled } from "@/openappa/service";

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];
type StreamPart =
  Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;

/** One bridge per Chat run. The proxy remains the policy enforcement point. */
export function withOpenAppaChat(params: {
  model: LanguageModel;
  tools: ToolSet;
  session: OpenAppaSession;
}): { model: LanguageModel; tools: ToolSet } {
  const { model, tools, session } = params;
  if (
    !openappaEnabled() ||
    typeof model === "string" ||
    model.specificationVersion !== "v3"
  )
    return { model, tools };
  let requestId = randomUUID();
  let blocked: ReturnType<typeof decodeChatBlock> = null;
  const blockedCall = (id: string) =>
    blocked?.calls.find((call) => call.id === id);
  const wrappedTools: ToolSet = Object.fromEntries(
    Object.entries(tools).map(([name, original]): [string, Tool] => {
      const tool: Tool = original;
      return [
        name,
        {
          ...tool,
          needsApproval: async (input, options) => {
            if (blockedCall(options.toolCallId)) return false;
            return typeof tool.needsApproval === "function"
              ? tool.needsApproval(input, options)
              : (tool.needsApproval ?? false);
          },
          execute: (input, options) => {
            const call = blockedCall(options.toolCallId);
            if (call && blocked) {
              const error = buildPolicyDeniedMcpToolError({
                toolName: call.name,
                input: call.arguments,
                reason: blocked.feedback,
                message: blocked.feedback,
              });
              return {
                isError: true,
                content: [{ type: "text", text: blocked.feedback }],
                _meta: {
                  archestraError: error,
                  appaBlockedReceipt: blocked.receipt,
                },
              };
            }
            if (!tool.execute) throw new Error(`Tool ${name} has no executor`);
            return tool.execute(input, options);
          },
          toModelOutput: async (options) => {
            if (blockedCall(options.toolCallId)) {
              // Keep the signed receipt with this synthetic result on subsequent steps.
              return { type: "text", value: JSON.stringify(options.output) };
            }
            return tool.toModelOutput
              ? tool.toModelOutput(options)
              : { type: "text", value: JSON.stringify(options.output) };
          },
        },
      ];
    }),
  );
  const capture = (text: string) => {
    const decoded = decodeChatBlock(text, session);
    blocked = decoded?.requestId === requestId ? decoded : null;
    return blocked?.calls.map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.arguments),
    }));
  };
  return {
    tools: wrappedTools,
    model: wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v3",
        transformParams: async ({ params }) => {
          requestId = randomUUID();
          return {
            ...params,
            headers: {
              ...params.headers,
              [APPA_CHAT_BLOCK_HEADER]: `${APPA_CHAT_BLOCK_VERSION}:${requestId}`,
            },
          };
        },
        wrapGenerate: async ({ doGenerate }) => {
          blocked = null;
          const result = await doGenerate();
          const calls = capture(
            result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          );
          return calls
            ? {
                ...result,
                content: [
                  ...result.content.filter((part) => part.type === "reasoning"),
                  ...calls,
                ],
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
              }
            : result;
        },
        wrapStream: async ({ doStream }) => {
          blocked = null;
          const result = await doStream();
          // Hold this step until the complete proxy decision is available.
          // No tool executor can run on a partial or subsequently denied batch.
          const parts: StreamPart[] = [];
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream<StreamPart, StreamPart>({
                transform(part) {
                  parts.push(part);
                },
                flush(controller) {
                  const calls = capture(
                    parts
                      .filter((part) => part.type === "text-delta")
                      .map((part) => part.delta)
                      .join(""),
                  );
                  if (!calls) {
                    for (const part of parts) controller.enqueue(part);
                    return;
                  }
                  for (const part of parts) {
                    if (
                      part.type === "stream-start" ||
                      part.type === "response-metadata" ||
                      part.type.startsWith("reasoning") ||
                      part.type === "error"
                    )
                      controller.enqueue(part);
                  }
                  for (const call of calls) controller.enqueue(call);
                  const finish = parts.find((part) => part.type === "finish");
                  if (finish)
                    controller.enqueue({
                      ...finish,
                      finishReason: {
                        unified: "tool-calls",
                        raw: "tool_calls",
                      },
                    });
                },
              }),
            ),
          };
        },
      },
    }),
  };
}
