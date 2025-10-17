import { DualLlmConfigModel, DualLlmResultModel } from "@/models";
import type { Anthropic, DualLlmConfig, OpenAi } from "@/types";
import {
  createDualLlmClient,
  type DualLlmClient,
  type DualLlmMessage,
} from "./dual-llm-client";

/**
 * Parameters for creating a DualLlmSubagent with OpenAI provider
 */
type OpenAiParams = {
  provider: "openai";
  messages: OpenAi.Types.ChatCompletionsRequest["messages"];
  currentMessage: OpenAi.Types.ChatCompletionsRequest["messages"][number];
};

/**
 * Parameters for creating a DualLlmSubagent with Anthropic provider
 */
type AnthropicParams = {
  provider: "anthropic";
  messages: Anthropic.Types.MessagesRequest["messages"];
  toolUseId: string; // For Anthropic, we need the tool_use_id to find the tool result
};

/**
 * DualLlmSubagent implements the dual LLM quarantine pattern for safely
 * extracting information from untrusted data sources.
 *
 * Pattern:
 * - Main Agent (privileged): Formulates questions, has no access to untrusted data
 * - Quarantined Agent: Has access to untrusted data, can only answer multiple choice
 * - Information flows through structured Q&A, preventing prompt injection
 */
export class DualLlmSubagent {
  config: DualLlmConfig; // Configuration loaded from database
  agentId: string; // The agent ID for tracking
  toolCallId: string; // The tool call ID for tracking
  llmClient: DualLlmClient; // LLM client instance
  originalUserRequest: string; // Extracted user request
  toolResult: unknown; // Extracted tool result

  private constructor(
    config: DualLlmConfig,
    agentId: string,
    toolCallId: string,
    llmClient: DualLlmClient,
    originalUserRequest: string,
    toolResult: unknown,
  ) {
    this.config = config;
    this.agentId = agentId;
    this.toolCallId = toolCallId;
    this.llmClient = llmClient;
    this.originalUserRequest = originalUserRequest;
    this.toolResult = toolResult;
  }

  /**
   * Create a DualLlmSubagent instance with OpenAI provider
   */
  static async create(
    params: OpenAiParams,
    agentId: string,
    apiKey: string,
  ): Promise<DualLlmSubagent>;

  /**
   * Create a DualLlmSubagent instance with Anthropic provider
   */
  static async create(
    params: AnthropicParams,
    agentId: string,
    apiKey: string,
  ): Promise<DualLlmSubagent>;

  /**
   * Create a DualLlmSubagent instance with configuration loaded from database
   */
  static async create(
    params: OpenAiParams | AnthropicParams,
    agentId: string,
    apiKey: string,
  ): Promise<DualLlmSubagent> {
    const config = await DualLlmConfigModel.getDefault();
    const llmClient = createDualLlmClient(params.provider, apiKey);

    // Extract user request and tool result based on provider
    if (params.provider === "openai") {
      // OpenAI: tool results are in "tool" role messages
      const { currentMessage, messages } = params;

      if (currentMessage.role !== "tool") {
        throw new Error("currentMessage must be a tool message");
      }

      const toolCallId = currentMessage.tool_call_id;
      const userRequest =
        DualLlmSubagent.extractUserRequestFromOpenAi(messages);
      const toolResult =
        DualLlmSubagent.extractToolResultFromOpenAi(currentMessage);

      return new DualLlmSubagent(
        config,
        agentId,
        toolCallId,
        llmClient,
        userRequest,
        toolResult,
      );
    }

    // Anthropic: tool results are in user message content blocks
    const { messages, toolUseId } = params;
    const userRequest =
      DualLlmSubagent.extractUserRequestFromAnthropic(messages);
    const toolResult = DualLlmSubagent.extractToolResultFromAnthropic(
      messages,
      toolUseId,
    );

    return new DualLlmSubagent(
      config,
      agentId,
      toolUseId,
      llmClient,
      userRequest,
      toolResult,
    );
  }

  /**
   * Extract the user's original request from OpenAI messages.
   * Gets the last user message from the conversation.
   */
  private static extractUserRequestFromOpenAi(
    messages: OpenAi.Types.ChatCompletionsRequest["messages"],
  ): string {
    const userContent =
      messages.filter((m) => m.role === "user").slice(-1)[0]?.content ||
      "process this data";

    // Convert to string if it's an array (multimodal content)
    return typeof userContent === "string"
      ? userContent
      : JSON.stringify(userContent);
  }

  /**
   * Extract the user's original request from Anthropic messages.
   * Gets the last user message that doesn't contain tool results.
   */
  private static extractUserRequestFromAnthropic(
    messages: Anthropic.Types.MessagesRequest["messages"],
  ): string {
    // Find the last user message that doesn't contain tool_result blocks
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user") {
        if (typeof message.content === "string") {
          return message.content;
        }
        // If content is an array, look for text blocks (not tool_result blocks)
        if (Array.isArray(message.content)) {
          const textBlock = message.content.find(
            (block) =>
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string",
          );
          if (textBlock && "text" in textBlock) {
            return textBlock.text;
          }
        }
      }
    }
    return "process this data";
  }

  /**
   * Extract the tool result data from OpenAI tool message.
   * Parses JSON if possible, otherwise returns as-is.
   */
  private static extractToolResultFromOpenAi(
    currentMessage: OpenAi.Types.ChatCompletionsRequest["messages"][number],
  ): unknown {
    if (currentMessage.role !== "tool") {
      throw new Error("Current message is not a tool message");
    }

    const content = currentMessage.content;

    if (typeof content === "string") {
      try {
        return JSON.parse(content);
      } catch {
        // If content is not valid JSON, use it as-is
        return content;
      }
    }

    return content;
  }

  /**
   * Extract the tool result data from Anthropic messages.
   * Finds the tool_result content block with the given toolUseId.
   */
  private static extractToolResultFromAnthropic(
    messages: Anthropic.Types.MessagesRequest["messages"],
    toolUseId: string,
  ): unknown {
    // Find the user message containing the tool_result block
    for (const message of messages) {
      if (
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.length > 0
      ) {
        for (const contentBlock of message.content) {
          if (
            contentBlock.type === "tool_result" &&
            "tool_use_id" in contentBlock &&
            contentBlock.tool_use_id === toolUseId
          ) {
            const content = contentBlock.content;

            if (typeof content === "string") {
              try {
                return JSON.parse(content);
              } catch {
                // If content is not valid JSON, use it as-is
                return content;
              }
            }

            return content;
          }
        }
      }
    }

    throw new Error(`Tool result not found for toolUseId: ${toolUseId}`);
  }

  /**
   * Main entry point for the quarantine pattern.
   * Runs a Q&A session between main agent and quarantined agent.
   *
   * @returns A safe summary of the information extracted
   */
  async processWithMainAgent(): Promise<string> {
    // Load prompt from database configuration and replace template variable
    const mainAgentPrompt = this.config.mainAgentPrompt.replace(
      "{{originalUserRequest}}",
      this.originalUserRequest,
    );

    const conversation: DualLlmMessage[] = [
      {
        role: "user",
        content: mainAgentPrompt,
      },
    ];

    // Q&A loop: Main agent asks questions, quarantined agent answers
    console.log(
      `\n=== Starting Dual LLM Q&A Loop (max ${this.config.maxRounds} rounds) ===`,
    );

    for (let round = 0; round < this.config.maxRounds; round++) {
      console.log(`\n--- Round ${round + 1}/${this.config.maxRounds} ---`);

      // Step 1: Main agent formulates a multiple choice question
      const response = await this.llmClient.chat(conversation, 0);
      conversation.push({ role: "assistant", content: response });

      // Check if main agent is done questioning
      if (response === "DONE" || response.includes("DONE")) {
        console.log("✓ Main agent signaled DONE. Ending Q&A loop.");
        break;
      }

      // Step 2: Parse the question and options from main agent's response
      const questionMatch = response.match(/QUESTION:\s*(.+?)(?=\nOPTIONS:)/s);
      const optionsMatch = response.match(/OPTIONS:\s*([\s\S]+)/);

      if (!questionMatch || !optionsMatch) {
        console.log("✗ Main agent did not format question correctly. Ending.");
        break;
      }

      const question = questionMatch[1].trim();
      const optionsText = optionsMatch[1].trim();
      const options = optionsText
        .split("\n")
        .map((line) => line.replace(/^\d+:\s*/, "").trim())
        .filter((opt) => opt.length > 0);

      console.log(`\nQuestion: ${question}`);
      console.log(`Options (${options.length}):`);
      for (let idx = 0; idx < options.length; idx++) {
        console.log(`  ${idx}: ${options[idx]}`);
      }

      // Step 3: Quarantined agent answers the question (can see untrusted data)
      const answerIndex = await this.answerQuestion(question, options);
      const selectedOption = options[answerIndex];

      console.log(`\nAnswer: ${answerIndex} - "${selectedOption}"`);

      // Step 4: Feed the answer back to the main agent
      conversation.push({
        role: "user",
        content: `Answer: ${answerIndex} (${selectedOption})`,
      });
    }

    console.log("\n=== Q&A Loop Complete ===\n");

    // Log the complete conversation history
    console.log("=== Final Messages Object ===");
    console.log(JSON.stringify(conversation, null, 2));
    console.log("=== End Messages Object ===\n");

    // Generate a safe summary from the Q&A conversation
    const summary = await this.generateSummary(conversation);

    // Store the result in the database
    await DualLlmResultModel.create({
      agentId: this.agentId,
      toolCallId: this.toolCallId,
      conversations: conversation,
      result: summary,
    });

    return summary;
  }

  /**
   * Quarantined agent answers a multiple choice question.
   * Has access to untrusted data but can only return an integer index.
   *
   * @param question - The question to answer
   * @param options - Array of possible answers
   * @returns Index of the selected option (0-based)
   */
  private async answerQuestion(
    question: string,
    options: string[],
  ): Promise<number> {
    const optionsText = options.map((opt, idx) => `${idx}: ${opt}`).join("\n");

    // Load quarantined agent prompt from database configuration and replace template variables
    const quarantinedPrompt = this.config.quarantinedAgentPrompt
      .replace("{{toolResultData}}", JSON.stringify(this.toolResult, null, 2))
      .replace("{{question}}", question)
      .replace("{{options}}", optionsText)
      .replace("{{maxIndex}}", String(options.length - 1));

    const parsed = await this.llmClient.chatWithSchema<{ answer: number }>(
      [{ role: "user", content: quarantinedPrompt }],
      {
        name: "multiple_choice_response",
        schema: {
          type: "object",
          properties: {
            answer: {
              type: "integer",
              description: "The index of the selected option (0-based)",
            },
          },
          required: ["answer"],
          additionalProperties: false,
        },
      },
      0,
    );

    // Code-level validation: Check if response has correct structure
    if (!parsed || typeof parsed.answer !== "number") {
      console.warn("Invalid response structure, defaulting to last option");
      return options.length - 1;
    }

    // Bounds validation: Ensure answer is within valid range
    const answerIndex = Math.floor(parsed.answer);
    if (answerIndex < 0 || answerIndex >= options.length) {
      return options.length - 1;
    }

    return answerIndex;
  }

  /**
   * Generate a safe summary from the Q&A conversation.
   * Focuses on facts discovered, not the questioning process.
   *
   * @param conversation - The Q&A conversation history
   * @returns A concise summary (2-3 sentences)
   */
  private async generateSummary(
    conversation: DualLlmMessage[],
  ): Promise<string> {
    // Extract just the Q&A pairs and summarize
    const qaText = conversation
      .map((msg) => msg.content)
      .filter((content) => content.length > 0)
      .join("\n");

    // Load summary prompt from database configuration and replace template variables
    const summaryPrompt = this.config.summaryPrompt.replace(
      "{{qaText}}",
      qaText,
    );

    const summary = await this.llmClient.chat(
      [{ role: "user", content: summaryPrompt }],
      0,
    );

    return summary;
  }
}
