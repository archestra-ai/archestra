import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { z } from "zod";
import type {
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
} from "@/types";
import { ApiError, Azure, createStreamAccumulatorState } from "@/types";
import { azureAdapterFactory, getAzureClientForRequest } from "./azure";

type ImageRequest = z.infer<typeof Azure.API.ImageGenerationRequestSchema>;
type ImageResponse = z.infer<typeof Azure.API.ImageGenerationResponseSchema>;
type Messages = OpenAi.Types.ChatCompletionsRequest["messages"];

/** Image generation goes through the normal proxy auth, limits and audit path. */
export const azureImagesAdapterFactory: LLMProvider<
  ImageRequest,
  ImageResponse,
  Messages,
  never,
  Azure.Types.ChatCompletionsHeaders
> = {
  provider: "azure",
  interactionType: "azure:images",
  unavailableUsageAccounting: true,
  spanName: "generate_content",
  getBaseUrl: azureAdapterFactory.getBaseUrl,
  extractApiKey: azureAdapterFactory.extractApiKey,
  createClient: azureAdapterFactory.createClient,
  extractErrorMessage: azureAdapterFactory.extractErrorMessage,
  extractInternalCode: azureAdapterFactory.extractInternalCode,
  createRequestAdapter: (request) => new ImageRequestAdapter(request),
  createResponseAdapter: (response) => new ImageResponseAdapter(response),
  createStreamAdapter: () => new ImageStreamAdapter(),
  async execute(client, request) {
    const response = await getAzureClientForRequest(
      client,
      request.model,
    ).images.generate({
      ...request,
      stream: false,
    } as OpenAI.Images.ImageGenerateParamsNonStreaming);
    return Azure.API.ImageGenerationResponseSchema.parse({
      ...response,
      model: request.model,
    });
  },
  async executeStream() {
    throw new ApiError(
      400,
      "Image generation returns a complete image; use stream: false.",
    );
  },
};

class ImageRequestAdapter implements LLMRequestAdapter<ImageRequest, Messages> {
  readonly provider = "azure" as const;
  private model: string;
  constructor(private readonly request: ImageRequest) {
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
  readonly provider = "azure" as const;
  private readonly id = randomUUID();
  constructor(private readonly response: ImageResponse) {}
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
  readonly provider = "azure" as const;
  readonly state = createStreamAccumulatorState();
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
