import type OpenAI from "openai";

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  tool_choice?: OpenAI.ChatCompletionToolChoiceOption;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAI.ChatCompletion.Choice[];
  usage?: OpenAI.CompletionUsage;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAI.ChatCompletionChunk.Choice[];
}

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface LLMProvider {
  chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse>;
  chatCompletionStream(
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatCompletionChunk>;
  listModels(): Promise<Model[]>;
}
