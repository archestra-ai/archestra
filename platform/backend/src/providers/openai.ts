import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProvider,
  Model,
} from "./types";

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await this.client.chat.completions.create({
      ...request,
      stream: false,
    });

    return response as ChatCompletionResponse;
  }

  async *chatCompletionStream(
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatCompletionChunk> {
    const stream = await this.client.chat.completions.create({
      ...request,
      stream: true,
    });

    for await (const chunk of stream) {
      yield chunk as ChatCompletionChunk;
    }
  }

  async listModels(): Promise<Model[]> {
    const response = await this.client.models.list();
    return response.data as Model[];
  }
}
