import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type {
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
} from "@/types";
import { ApiError, type Azure, createStreamAccumulatorState } from "@/types";

type ImageRequest = z.infer<typeof Azure.API.ImageGenerationRequestSchema>;
type ImageResponse = z.infer<typeof Azure.API.ImageGenerationResponseSchema>;
type ImageProvider = "openai" | "azure";
type Messages = OpenAi.Types.ChatCompletionsRequest["messages"];

/** Shared image adapters retain the native image wire and provider attribution. */
export function createImageGenerationAdapters(provider: ImageProvider) {
  return {
    createRequestAdapter: (request: ImageRequest) =>
      new ImageRequestAdapter(request, provider),
    createResponseAdapter: (response: ImageResponse) =>
      new ImageResponseAdapter(response, provider),
    createStreamAdapter: () => new ImageStreamAdapter(provider),
  };
}

class ImageRequestAdapter implements LLMRequestAdapter<ImageRequest, Messages> {
  private model: string;
  constructor(
    private readonly request: ImageRequest,
    readonly provider: ImageProvider,
  ) {
    this.model = request.model;
  }
  getModel() {
    return this.model;
  }
  isStreaming() {
    return false;
  }
  getMessages() {
    return [{ role: "user" as const, content: this.request.prompt }];
  }
  getProviderMessages(): Messages {
    return this.getMessages();
  }
  getTools() {
    return [];
  }
  getToolResults() {
    return [];
  }
  hasTools() {
    return false;
  }
  getOriginalRequest() {
    return this.request;
  }
  setModel(model: string) {
    this.model = model;
  }
  updateToolResult() {}
  applyToolResultUpdates() {}
  convertToolResultContent(messages: Messages) {
    return messages;
  }
  toProviderRequest() {
    return { ...this.request, model: this.model };
  }
}

class ImageResponseAdapter implements LLMResponseAdapter<ImageResponse> {
  private readonly id = randomUUID();
  constructor(
    private readonly response: ImageResponse,
    readonly provider: ImageProvider,
  ) {}
  getId() {
    return this.id;
  }
  getModel() {
    return this.response.model ?? "unknown";
  }
  getText() {
    return (
      this.response.data
        ?.map((image) => image.revised_prompt ?? "")
        .join("\n") ?? ""
    );
  }
  getToolCalls() {
    return [];
  }
  hasToolCalls() {
    return false;
  }
  getUsage() {
    return {
      usageUnavailable: !this.response.usage,
      costUnavailable: true,
      inputTokens: this.response.usage?.input_tokens ?? 0,
      outputTokens: this.response.usage?.output_tokens ?? 0,
    };
  }
  getOriginalResponse() {
    return this.response;
  }
  getFinishReasons() {
    return ["stop"];
  }
  toRefusalResponse() {
    return { ...this.response, data: [] };
  }
}

/** The image API is non-streaming; Chat emits the completed file in its UI stream. */
class ImageStreamAdapter implements LLMStreamAdapter<never, ImageResponse> {
  readonly state = createStreamAccumulatorState();
  constructor(readonly provider: ImageProvider) {}
  processChunk(): never {
    return unsupported();
  }
  getSSEHeaders(): never {
    return unsupported();
  }
  formatTextDeltaSSE(): never {
    return unsupported();
  }
  getRawToolCallEvents() {
    return [];
  }
  formatCompleteTextSSE(): never {
    return unsupported();
  }
  formatEndSSE(): never {
    return unsupported();
  }
  toProviderResponse(): never {
    return unsupported();
  }
}

function unsupported(): never {
  throw new ApiError(
    400,
    "Image generation returns a complete image; use stream: false.",
  );
}
