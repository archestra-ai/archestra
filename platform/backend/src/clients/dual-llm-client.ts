import Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import type { SupportedProvider } from "@shared";
import OpenAI from "openai";
import config from "@/config";
import logger from "@/logging";
import type { DualLlmMessage } from "@/types";
import { BedrockClient } from "./bedrock-client";
import { createGoogleGenAIClient } from "./gemini-client";

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
 * Cerebras implementation of DualLlmClient (OpenAI-compatible)
 */
export class CerebrasDualLlmClient implements DualLlmClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = "gpt-oss-120b") {
    logger.debug({ model }, "[dualLlmClient] Cerebras: initializing client");
    this.client = new OpenAI({
      apiKey,
      baseURL: config.llm.cerebras.baseUrl,
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] Cerebras: starting chat completion",
    );
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
    });

    const content = response.choices[0].message.content?.trim() || "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Cerebras: chat completion complete",
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
      "[dualLlmClient] Cerebras: starting chat with schema",
    );

    // Cerebras uses OpenAI-compatible API with JSON schema support
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
      "[dualLlmClient] Cerebras: chat with schema complete, parsing response",
    );
    return JSON.parse(content) as T;
  }
}

/**
 * Mistral implementation of DualLlmClient (OpenAI-compatible)
 */
export class MistralDualLlmClient implements DualLlmClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = "mistral-large-latest") {
    logger.debug({ model }, "[dualLlmClient] Mistral: initializing client");
    this.client = new OpenAI({
      apiKey,
      baseURL: config.llm.mistral.baseUrl,
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] Mistral: starting chat completion",
    );
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
    });

    const content = response.choices[0].message.content?.trim() || "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Mistral: chat completion complete",
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
      "[dualLlmClient] Mistral: starting chat with schema",
    );

    // Mistral uses OpenAI-compatible API with JSON schema support
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
      "[dualLlmClient] Mistral: chat with schema complete, parsing response",
    );
    return JSON.parse(content) as T;
  }
}

/**
 * Google Gemini implementation of DualLlmClient
 * Supports both API key authentication and Vertex AI (ADC) mode
 */
export class GeminiDualLlmClient implements DualLlmClient {
  private client: GoogleGenAI;
  private model: string;

  /**
   * Create a Gemini client for dual LLM.
   * If Vertex AI is enabled in config, uses ADC; otherwise uses API key.
   *
   * @param apiKey - API key (optional when Vertex AI is enabled)
   * @param model - Model to use
   */
  constructor(apiKey: string | undefined, model = "gemini-2.5-pro") {
    this.client = createGoogleGenAIClient(apiKey, "[dualLlmClient] Gemini:");
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
 * vLLM implementation of DualLlmClient
 * vLLM exposes an OpenAI-compatible API, so we use the OpenAI SDK with vLLM's base URL
 */
export class VllmDualLlmClient implements DualLlmClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string | undefined, model: string) {
    logger.debug({ model }, "[dualLlmClient] vLLM: initializing client");
    // vLLM typically doesn't require API keys, use dummy if not provided
    this.client = new OpenAI({
      apiKey: apiKey || "EMPTY",
      baseURL: config.llm.vllm.baseUrl,
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] vLLM: starting chat completion",
    );
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
    });

    const content = response.choices[0].message.content?.trim() || "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] vLLM: chat completion complete",
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
      "[dualLlmClient] vLLM: starting chat with schema",
    );

    // vLLM supports JSON schema via guided decoding
    // Try OpenAI-compatible structured output first
    try {
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
        "[dualLlmClient] vLLM: chat with schema complete, parsing response",
      );
      return JSON.parse(content) as T;
    } catch {
      // Fallback to prompt-based approach if structured output not supported
      logger.debug(
        { model: this.model },
        "[dualLlmClient] vLLM: structured output not supported, using prompt fallback",
      );

      const systemPrompt = `You must respond with valid JSON matching this schema:
${JSON.stringify(schema.schema, null, 2)}

Return only the JSON object, no other text.`;

      const enhancedMessages: DualLlmMessage[] = messages.map((msg, idx) => {
        if (idx === 0 && msg.role === "user") {
          return {
            ...msg,
            content: `${systemPrompt}\n\n${msg.content}`,
          };
        }
        return msg;
      });

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: enhancedMessages,
        temperature,
      });

      const content = response.choices[0].message.content || "";
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [
        null,
        content,
      ];
      const jsonText = jsonMatch[1].trim();

      return JSON.parse(jsonText) as T;
    }
  }
}

/**
 * Ollama implementation of DualLlmClient
 * Ollama exposes an OpenAI-compatible API, so we use the OpenAI SDK with Ollama's base URL
 */
export class OllamaDualLlmClient implements DualLlmClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string | undefined, model: string) {
    logger.debug({ model }, "[dualLlmClient] Ollama: initializing client");
    // Ollama typically doesn't require API keys, use dummy if not provided
    this.client = new OpenAI({
      apiKey: apiKey || "EMPTY",
      baseURL: config.llm.ollama.baseUrl,
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] Ollama: starting chat completion",
    );
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
    });

    const content = response.choices[0].message.content?.trim() || "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Ollama: chat completion complete",
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
      "[dualLlmClient] Ollama: starting chat with schema",
    );

    // Ollama supports JSON schema via format parameter for some models
    // Try OpenAI-compatible structured output first
    try {
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
        "[dualLlmClient] Ollama: chat with schema complete, parsing response",
      );
      return JSON.parse(content) as T;
    } catch {
      // Fallback to prompt-based approach if structured output not supported
      logger.debug(
        { model: this.model },
        "[dualLlmClient] Ollama: structured output not supported, using prompt fallback",
      );

      const systemPrompt = `You must respond with valid JSON matching this schema:
${JSON.stringify(schema.schema, null, 2)}

Return only the JSON object, no other text.`;

      const enhancedMessages: DualLlmMessage[] = messages.map((msg, idx) => {
        if (idx === 0 && msg.role === "user") {
          return {
            ...msg,
            content: `${systemPrompt}\n\n${msg.content}`,
          };
        }
        return msg;
      });

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: enhancedMessages,
        temperature,
      });

      const content = response.choices[0].message.content || "";
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [
        null,
        content,
      ];
      const jsonText = jsonMatch[1].trim();

      return JSON.parse(jsonText) as T;
    }
  }
}

/**
 * Cohere implementation of DualLlmClient
 * Cohere provides REST API for chat completions
 */
export class CohereDualLlmClient implements DualLlmClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model = "command-r-plus") {
    logger.debug({ model }, "[dualLlmClient] Cohere: initializing client");
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = config.llm.cohere.baseUrl;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] Cohere: starting chat completion",
    );

    const response = await fetch(`${this.baseUrl}/v2/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[dualLlmClient] Cohere API error: ${response.status} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    const content =
      data.message?.content?.[0]?.type === "text"
        ? data.message.content[0].text?.trim() || ""
        : "";

    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Cohere: chat completion complete",
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
      "[dualLlmClient] Cohere: starting chat with schema",
    );

    // Fallback to prompt-based approach since Cohere doesn't support json_schema
    const systemPrompt = `You must respond with valid JSON matching this schema:
${JSON.stringify(schema.schema, null, 2)}

Return only the JSON object, no other text.`;

    const enhancedMessages: DualLlmMessage[] = messages.map((msg, idx) => {
      if (idx === 0 && msg.role === "user") {
        return {
          ...msg,
          content: `${systemPrompt}\n\n${msg.content}`,
        };
      }
      return msg;
    });

    const response = await fetch(`${this.baseUrl}/v2/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: enhancedMessages,
        temperature,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[dualLlmClient] Cohere API error: ${response.status} - ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    const content =
      data.message?.content?.[0]?.type === "text"
        ? data.message.content[0].text || ""
        : "";

    // Strip markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [
      null,
      content,
    ];
    const jsonText = (jsonMatch[1] || content).trim();

    try {
      logger.debug(
        { model: this.model, responseLength: jsonText.length },
        "[dualLlmClient] Cohere: chat with schema complete, parsing response",
      );
      return JSON.parse(jsonText) as T;
    } catch (parseError) {
      logger.error(
        { model: this.model, content: jsonText, parseError },
        "[dualLlmClient] Cohere: failed to parse JSON response",
      );
      throw parseError;
    }
  }
}

/**
 * Zhipuai implementation of DualLlmClient
 * Zhipuai exposes an OpenAI-compatible API, so we use the OpenAI SDK with Zhipuai's base URL
 */
export class ZhipuaiDualLlmClient implements DualLlmClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = "glm-4.5-flash") {
    logger.debug({ model }, "[dualLlmClient] Zhipuai: initializing client");
    this.client = new OpenAI({
      apiKey,
      baseURL: config.llm.zhipuai.baseUrl,
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] Zhipuai: starting chat completion",
    );
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature,
    });

    const content = response.choices[0].message.content?.trim() || "";
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Zhipuai: chat completion complete",
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
      "[dualLlmClient] Zhipuai: starting chat with schema",
    );

    // Zhipuai supports JSON schema via response_format for some models
    // Try OpenAI-compatible structured output first
    try {
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
        "[dualLlmClient] Zhipuai: chat with schema complete, parsing response",
      );
      return JSON.parse(content) as T;
    } catch (error) {
      // Fallback to prompt-based approach if structured output not supported
      logger.debug(
        {
          model: this.model,
          error: error instanceof Error ? error.message : String(error),
        },
        "[dualLlmClient] Zhipuai: structured output not supported, using prompt fallback",
      );

      const systemPrompt = `You must respond with valid JSON matching this schema:
${JSON.stringify(schema.schema, null, 2)}

Return only the JSON object, no other text.`;

      const enhancedMessages: DualLlmMessage[] = messages.map((msg, idx) => {
        if (idx === 0 && msg.role === "user") {
          return {
            ...msg,
            content: `${systemPrompt}\n\n${msg.content}`,
          };
        }
        return msg;
      });

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: enhancedMessages,
        temperature,
      });

      const content = response.choices[0].message.content || "";
      // Strip markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [
        null,
        content,
      ];
      const jsonText = jsonMatch[1].trim();

      try {
        return JSON.parse(jsonText) as T;
      } catch (parseError) {
        logger.error(
          { model: this.model, content: jsonText, parseError },
          "[dualLlmClient] Zhipuai: failed to parse JSON response",
        );
        throw parseError;
      }
    }
  }
}

/**
 * Bedrock implementation of DualLlmClient
 * Uses AWS Bedrock Converse API for chat completions
 */
export class BedrockDualLlmClient implements DualLlmClient {
  private client: BedrockClient;
  private model: string;

  /**
   * Create a Bedrock client for dual LLM.
   *
   * @param apiKey - Bearer token for API key auth (optional if using AWS credentials)
   * @param model - Model ID (e.g., "anthropic.claude-3-sonnet-20240229-v1:0")
   * @param baseUrl - Bedrock runtime endpoint URL
   */
  constructor(apiKey: string | undefined, model: string, baseUrl: string) {
    logger.debug(
      { model, baseUrl },
      "[dualLlmClient] Bedrock: initializing client",
    );

    // Extract region from baseUrl (e.g., "https://bedrock-runtime.us-east-1.amazonaws.com")
    const region = this.extractRegionFromUrl(baseUrl);

    this.client = new BedrockClient({
      baseUrl,
      region,
      apiKey,
    });
    this.model = model;
  }

  async chat(messages: DualLlmMessage[], temperature = 0): Promise<string> {
    logger.debug(
      { model: this.model, messageCount: messages.length, temperature },
      "[dualLlmClient] Bedrock: starting chat completion",
    );

    // Convert DualLlmMessage format to Bedrock Converse format
    const bedrockMessages = messages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: [{ text: msg.content }],
    }));

    const response = await this.client.converse(this.model, {
      messages: bedrockMessages,
      inferenceConfig: {
        temperature,
        maxTokens: 4096,
      },
    });

    // Extract text from response content blocks
    const content = this.extractTextFromResponse(
      response as unknown as Record<string, unknown>,
    );
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Bedrock: chat completion complete",
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
      "[dualLlmClient] Bedrock: starting chat with schema",
    );

    // Bedrock doesn't have native structured output
    // Use prompt-based approach similar to Anthropic
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

    // Convert to Bedrock format
    const bedrockMessages = enhancedMessages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: [{ text: msg.content }],
    }));

    const response = await this.client.converse(this.model, {
      messages: bedrockMessages,
      inferenceConfig: {
        temperature,
        maxTokens: 4096,
      },
    });

    const content = this.extractTextFromResponse(
      response as unknown as Record<string, unknown>,
    );
    logger.debug(
      { model: this.model, responseLength: content.length },
      "[dualLlmClient] Bedrock: chat with schema complete, parsing response",
    );

    // Parse JSON response
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [
      null,
      content,
    ];
    const jsonText = jsonMatch[1].trim();

    try {
      return JSON.parse(jsonText) as T;
    } catch (parseError) {
      logger.error(
        { model: this.model, content: jsonText, parseError },
        "[dualLlmClient] Bedrock: failed to parse JSON response",
      );
      throw parseError;
    }
  }

  private extractRegionFromUrl(baseUrl: string): string {
    // Extract region from URL like "https://bedrock-runtime.us-east-1.amazonaws.com"
    const match = baseUrl.match(
      /bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/,
    );
    if (match) {
      return match[1];
    }
    // Default to us-east-1 if region can't be extracted
    logger.warn(
      { baseUrl },
      "[dualLlmClient] Bedrock: could not extract region from URL, defaulting to us-east-1",
    );
    return "us-east-1";
  }

  private extractTextFromResponse(response: Record<string, unknown>): string {
    const output = response.output as
      | { message?: { content?: Array<Record<string, unknown>> } }
      | undefined;
    const contentBlocks = output?.message?.content || [];
    const textBlock = contentBlocks.find(
      (block): block is { text: string } =>
        "text" in block && typeof block.text === "string",
    );
    return textBlock?.text?.trim() || "";
  }
}

type DualLlmClientFactory = (
  apiKey: string | undefined,
  model: string | undefined,
) => DualLlmClient;

/**
 * Maps each provider to its DualLlmClient factory.
 * Using Record<SupportedProvider, ...> ensures TypeScript enforces adding new providers here.
 */
const dualLlmClientFactories: Record<SupportedProvider, DualLlmClientFactory> =
  {
    anthropic: (apiKey) => {
      if (!apiKey) throw new Error("API key required for Anthropic dual LLM");
      return new AnthropicDualLlmClient(apiKey);
    },
    cerebras: (apiKey) => {
      if (!apiKey) throw new Error("API key required for Cerebras dual LLM");
      return new CerebrasDualLlmClient(apiKey);
    },
    cohere: (apiKey, model) => {
      if (!apiKey) throw new Error("API key required for Cohere dual LLM");
      return new CohereDualLlmClient(apiKey, model);
    },
    mistral: (apiKey, model) => {
      if (!apiKey) throw new Error("API key required for Mistral dual LLM");
      return new MistralDualLlmClient(apiKey, model);
    },
    gemini: (apiKey) => {
      // Gemini supports Vertex AI mode where apiKey may be undefined
      return new GeminiDualLlmClient(apiKey);
    },
    openai: (apiKey) => {
      if (!apiKey) throw new Error("API key required for OpenAI dual LLM");
      return new OpenAiDualLlmClient(apiKey);
    },
    vllm: (apiKey, model) => {
      if (!model) throw new Error("Model name required for vLLM dual LLM");
      return new VllmDualLlmClient(apiKey, model);
    },
    ollama: (apiKey, model) => {
      if (!model) throw new Error("Model name required for Ollama dual LLM");
      return new OllamaDualLlmClient(apiKey, model);
    },
    zhipuai: (apiKey, model) => {
      if (!apiKey) throw new Error("API key required for Zhipuai dual LLM");
      return new ZhipuaiDualLlmClient(apiKey, model);
    },
    bedrock: (apiKey, model) => {
      if (!model) throw new Error("Model name required for Bedrock dual LLM");
      if (!config.llm.bedrock.baseUrl) {
        throw new Error(
          "Bedrock base URL not configured (ARCHESTRA_BEDROCK_BASE_URL)",
        );
      }
      return new BedrockDualLlmClient(
        apiKey,
        model,
        config.llm.bedrock.baseUrl,
      );
    },
  };

/**
 * Factory function to create the appropriate LLM client
 *
 * @param provider - The LLM provider
 * @param apiKey - API key (optional for Gemini when Vertex AI is enabled, optional for vLLM/Ollama)
 * @param model - Model name. Optional in the signature, but required when provider is 'vllm' or 'ollama'
 *                since these providers can serve multiple models and need explicit model selection.
 */
export function createDualLlmClient(
  provider: SupportedProvider,
  apiKey: string | undefined,
  model?: string,
): DualLlmClient {
  logger.debug(
    { provider },
    "[dualLlmClient] createDualLlmClient: creating client",
  );
  const factory = dualLlmClientFactories[provider];
  if (!factory) {
    throw new Error(`Unsupported provider for Dual LLM: ${provider}`);
  }
  return factory(apiKey, model);
}
