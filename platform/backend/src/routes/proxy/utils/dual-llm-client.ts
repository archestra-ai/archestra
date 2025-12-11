import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import config from "@/config";
import logger from "@/logging";
import type { DualLlmMessage, SupportedProvider } from "@/types";

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
    logger.debug({ model }, "[dualLlmClient] OpenAI: initializing client");
    this.client = new OpenAI({
      apiKey,
      baseURL: config.llm.openai.baseUrl,
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] OpenAI: starting chat completion",
    );
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
    });

    const content = response.choices[0].message.content?.trim() || "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] OpenAI: chat completion complete",
    );
    return content;
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
    logger.debug(
      {
        model: this.model,
        schemaName: schema.name,
        messageCount: messages.length,
        temperature,
      },
      "[dualLlmClient] OpenAI: starting chat with schema",
    );
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
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] OpenAI: chat with schema complete, parsing response",
    );
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
    logger.debug({ model }, "[dualLlmClient] Anthropic: initializing client");
    this.client = new Anthropic({
      apiKey,
      baseURL: config.llm.anthropic.baseUrl,
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] Anthropic: starting chat completion",
    );
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
    const content =
      textBlock && "text" in textBlock ? textBlock.text.trim() : "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Anthropic: chat completion complete",
    );
    return content;
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
    logger.debug(
      {
        model: this.model,
        schemaName: schema.name,
        messageCount: messages.length,
        temperature,
      },
      "[dualLlmClient] Anthropic: starting chat with schema",
    );
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

    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Anthropic: chat with schema complete, parsing response",
    );

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
 * Google Gemini implementation of DualLlmClient
 */
export class GeminiDualLlmClient implements DualLlmClient {
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model = "gemini-2.0-flash") {
    logger.debug({ model }, "[dualLlmClient] Gemini: initializing client");
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        baseUrl: config.llm.gemini.baseUrl,
        apiVersion: "v1beta",
      },
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] Gemini: starting chat completion",
    );
    // Convert DualLlmMessage format to Gemini Content format
    const contents = messages.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    }));

    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config: {
        temperature,
      },
    });

    // Extract text from the response
    const firstCandidate = response.candidates?.[0];
    const textBlock = firstCandidate?.content?.parts?.find(
      (p) => p.text && p.text !== "",
    );
    const content = textBlock?.text?.trim() || "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Gemini: chat completion complete",
    );
    return content;
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
    logger.debug(
      {
        model: this.model,
        schemaName: schema.name,
        messageCount: messages.length,
        temperature,
      },
      "[dualLlmClient] Gemini: starting chat with schema",
    );
    // Convert DualLlmMessage format to Gemini Content format
    const contents = messages.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    }));

    // Gemini supports structured output via response schema
    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config: {
        temperature,
        responseSchema: schema.schema,
        responseMimeType: "application/json",
      },
    });

    const content =
      response.candidates?.[0].content?.parts?.find(
        (p) => p.text && p.text !== "",
      )?.text || "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Gemini: chat with schema complete, parsing response",
    );
    return JSON.parse(content) as T;
  }
}

/**
 * Factory function to create the appropriate LLM client
 */
export function createDualLlmClient(
  provider: SupportedProvider,
  apiKey: string,
): DualLlmClient {
  logger.debug(
    { provider },
    "[dualLlmClient] createDualLlmClient: creating client",
  );
  switch (provider) {
    case "anthropic":
      return new AnthropicDualLlmClient(apiKey);
    case "openai":
      return new OpenAiDualLlmClient(apiKey);
    case "gemini":
      return new GeminiDualLlmClient(apiKey);
    default:
      logger.debug(
        { provider },
        "[dualLlmClient] createDualLlmClient: unsupported provider",
      );
      throw new Error(`Unsupported provider for Dual LLM: ${provider}`);
  }
}
