import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { SupportedProviders } from "./types";

/**
 * Common message format for dual LLM Q&A conversation
 * Simple format: {role: "user" | "assistant", content: string}
 */
export type DualLlmMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Abstract interface for LLM clients used in dual LLM pattern
 * Provides a simple, provider-agnostic API for the Q&A conversation
 */
export interface DualLlmClient {
  /**
   * Send a chat completion request with simple messages
   * @param messages - Array of simple {role, content} messages
   * @param temperature - Temperature parameter for the LLM
   * @returns The LLM's text response
   */
  chat(messages: DualLlmMessage[], temperature?: number): Promise<string>;

  /**
   * Send a chat completion request with structured output
   * @param messages - Array of simple {role, content} messages
   * @param schema - JSON schema for the response
   * @param temperature - Temperature parameter for the LLM
   * @returns Parsed JSON response matching the schema
   */
  chatWithSchema<T>(
    messages: DualLlmMessage[],
    schema: {
      name: string;
      schema: {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
    },
    temperature?: number,
  ): Promise<T>;
}

/**
 * OpenAI implementation of DualLlmClient
 */
export class OpenAiDualLlmClient implements DualLlmClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = "gpt-4o") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
    });

    return response.choices[0].message.content?.trim() || "";
  }

  async chatWithSchema<T>(
    messages: DualLlmMessage[],
    schema: {
      name: string;
      schema: {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
    },
    temperature = 0,
  ): Promise<T> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: schema,
      },
      temperature,
    });

    const content = response.choices[0].message.content || "";
    return JSON.parse(content) as T;
  }
}

/**
 * Anthropic implementation of DualLlmClient
 */
export class AnthropicDualLlmClient implements DualLlmClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-5-20250929") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    // Anthropic requires separate system message
    // For dual LLM, we don't use system messages in the Q&A loop
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages,
      temperature,
    });

    // Extract text from content blocks
    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text.trim() : "";
  }

  async chatWithSchema<T>(
    messages: DualLlmMessage[],
    schema: {
      name: string;
      schema: {
        type: string;
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
    },
    temperature = 0,
  ): Promise<T> {
    // Anthropic doesn't have native structured output yet
    // We'll use a prompt-based approach with JSON mode
    const systemPrompt = `You must respond with valid JSON matching this schema:
${JSON.stringify(schema.schema, null, 2)}

Return only the JSON object, no other text.`;

    // Prepend the schema instruction to the first user message
    const enhancedMessages: DualLlmMessage[] = messages.map((msg, idx) => {
      if (idx === 0 && msg.role === "user") {
        return {
          ...msg,
          content: `${systemPrompt}\n\n${msg.content}`,
        };
      }
      return msg;
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: enhancedMessages,
      temperature,
    });

    // Extract text from content blocks
    const textBlock = response.content.find((block) => block.type === "text");
    const content =
      textBlock && "text" in textBlock ? textBlock.text.trim() : "";

    // Parse JSON response
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [
      null,
      content,
    ];
    const jsonText = jsonMatch[1].trim();

    return JSON.parse(jsonText) as T;
  }
}

/**
 * Factory function to create the appropriate LLM client
 */
export function createDualLlmClient(
  provider: SupportedProviders,
  apiKey: string,
): DualLlmClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicDualLlmClient(apiKey);
    case "openai":
      return new OpenAiDualLlmClient(apiKey);
  }
}
