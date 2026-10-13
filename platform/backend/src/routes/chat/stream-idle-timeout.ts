import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { LLMModel } from "@/clients/llm-client";
import { ModelStreamStalledError } from "./errors";

type ModelStreamPart =
  Awaited<
    ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/**
 * Ends a model stream that goes silent for `idleTimeoutMs`. The timer runs on
 * the provider's parsed stream parts, so SSE comments (OpenRouter's
 * `: PROCESSING`) and proxy keep-alives never count as progress, and it covers
 * only the provider call itself — tool execution happens after the provider
 * stream has closed. (The AI SDK's own `timeout.chunkMs` keeps ticking through
 * tool execution and aborts long-running tools.)
 */
export function withStreamIdleTimeout(
  model: LLMModel,
  idleTimeoutMs: number,
): LLMModel {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    return model;
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            createIdleTimeoutTransform(idleTimeoutMs),
          ),
        };
      },
    },
  });
}

function createIdleTimeoutTransform(
  idleTimeoutMs: number,
): TransformStream<ModelStreamPart, ModelStreamPart> {
  let timer: NodeJS.Timeout | undefined;
  const arm = (
    controller: TransformStreamDefaultController<ModelStreamPart>,
  ) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        controller.enqueue({
          type: "error",
          error: new ModelStreamStalledError(idleTimeoutMs),
        });
        // Closes the readable side and cancels the upstream body.
        controller.terminate();
      } catch {
        // The stream already ended (aborted or errored) before the deadline.
      }
    }, idleTimeoutMs);
    timer.unref();
  };
  return new TransformStream({
    start: arm,
    transform(part, controller) {
      arm(controller);
      controller.enqueue(part);
    },
    flush() {
      clearTimeout(timer);
    },
  });
}
