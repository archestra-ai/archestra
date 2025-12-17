import type { SupportedProvider } from "@shared";
import logger from "@/logging";
import { DualLlmConfigModel, DualLlmResultModel } from "@/models";
import type {
  CommonDualLlmParams,
  DualLlmConfig,
  DualLlmMessage,
} from "@/types";
import { createDualLlmClient, type DualLlmClient } from "./dual-llm-client";

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

  static async create(
    params: CommonDualLlmParams,
    agentId: string,
    apiKey: string | undefined,
    provider: SupportedProvider,
  ): Promise<DualLlmSubagent> {
    logger.debug(
      { agentId, toolCallId: params.toolCallId, provider },
      "[dualLlmSubagent] create: creating dual LLM subagent",
    );
    const config = await DualLlmConfigModel.getDefault();
    logger.debug(
      { agentId, maxRounds: config.maxRounds },
      "[dualLlmSubagent] create: loaded config",
    );
    return new DualLlmSubagent(
      config,
      agentId,
      params.toolCallId,
      createDualLlmClient(provider, apiKey),
      params.userRequest,
      params.toolResult,
    );
  }

  /**
   * Main entry point for the quarantine pattern.
   * Runs a Q&A session between main agent and quarantined agent.
   *
   * @param onProgress - Optional callback for streaming Q&A progress
   * @returns A safe summary of the information extracted
   */
  async processWithMainAgent(
    onProgress?: (progress: {
      question: string;
      options: string[];
      answer: string;
    }) => void,
  ): Promise<string> {
    logger.debug(
      {
        agentId: this.agentId,
        toolCallId: this.toolCallId,
        maxRounds: this.config.maxRounds,
      },
      "[dualLlmSubagent] processWithMainAgent: starting Q&A loop",
    );

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
    logger.info(
      `\n=== Starting Dual LLM Q&A Loop (max ${this.config.maxRounds} rounds) ===`,
    );

    for (let round = 0; round < this.config.maxRounds; round++) {
      logger.debug(
        {
          agentId: this.agentId,
          round: round + 1,
          maxRounds: this.config.maxRounds,
        },
        "[dualLlmSubagent] processWithMainAgent: starting round",
      );
      logger.info(`\n--- Round ${round + 1}/${this.config.maxRounds} ---`);

      // Step 1: Main agent formulates a multiple choice question
      logger.debug(
        { agentId: this.agentId, conversationLength: conversation.length },
        "[dualLlmSubagent] processWithMainAgent: requesting question from main agent",
      );
      const response = await this.llmClient.chat(conversation, 0);
      conversation.push({ role: "assistant", content: response });

      // Check if main agent is done questioning
      if (response === "DONE" || response.includes("DONE")) {
        logger.debug(
          { agentId: this.agentId, round: round + 1 },
          "[dualLlmSubagent] processWithMainAgent: main agent signaled DONE",
        );
        logger.info("✓ Main agent signaled DONE. Ending Q&A loop.");
        break;
      }

      // Step 2: Parse the question and options from main agent's response
      const questionMatch = response.match(/QUESTION:\s*(.+?)(?=\nOPTIONS:)/s);
      const optionsMatch = response.match(/OPTIONS:\s*([\s\S]+)/);

      if (!questionMatch || !optionsMatch) {
        logger.debug(
          { agentId: this.agentId, responseLength: response.length },
          "[dualLlmSubagent] processWithMainAgent: failed to parse question format",
        );
        logger.info("✗ Main agent did not format question correctly. Ending.");
        break;
      }

      const question = questionMatch[1].trim();
      const optionsText = optionsMatch[1].trim();
      const options = optionsText
        .split("\n")
        .map((line) => line.replace(/^\d+:\s*/, "").trim())
        .filter((opt) => opt.length > 0);

      logger.debug(
        { agentId: this.agentId, question, optionCount: options.length },
        "[dualLlmSubagent] processWithMainAgent: parsed question and options",
      );
      logger.info(`\nQuestion: ${question}`);
      logger.info(`Options (${options.length}):`);
      for (let idx = 0; idx < options.length; idx++) {
        logger.info(`  ${idx}: ${options[idx]}`);
      }

      // Step 3: Quarantined agent answers the question (can see untrusted data)
      logger.debug(
        { agentId: this.agentId, question, optionCount: options.length },
        "[dualLlmSubagent] processWithMainAgent: requesting answer from quarantined agent",
      );
      const answerIndex = await this.answerQuestion(question, options);
      const selectedOption = options[answerIndex];

      logger.debug(
        { agentId: this.agentId, answerIndex, selectedOption },
        "[dualLlmSubagent] processWithMainAgent: quarantined agent answered",
      );
      logger.info(`\nAnswer: ${answerIndex} - "${selectedOption}"`);

      // Stream progress if callback provided
      if (onProgress) {
        onProgress({
          question,
          options,
          answer: `${answerIndex}`,
        });
      }

      // Step 4: Feed the answer back to the main agent
      conversation.push({
        role: "user",
        content: `Answer: ${answerIndex} (${selectedOption})`,
      });
    }

    logger.debug(
      { agentId: this.agentId, conversationLength: conversation.length },
      "[dualLlmSubagent] processWithMainAgent: Q&A loop complete",
    );
    logger.info("\n=== Q&A Loop Complete ===\n");

    // Log the complete conversation history
    logger.info("=== Final Messages Object ===");
    logger.info(JSON.stringify(conversation, null, 2));
    logger.info("=== End Messages Object ===\n");

    // Generate a safe summary from the Q&A conversation
    logger.debug(
      { agentId: this.agentId },
      "[dualLlmSubagent] processWithMainAgent: generating summary",
    );
    const summary = await this.generateSummary(conversation);

    // Store the result in the database
    logger.debug(
      {
        agentId: this.agentId,
        toolCallId: this.toolCallId,
        summaryLength: summary.length,
      },
      "[dualLlmSubagent] processWithMainAgent: storing result in database",
    );
    await DualLlmResultModel.create({
      agentId: this.agentId,
      toolCallId: this.toolCallId,
      conversations: conversation,
      result: summary,
    });

    logger.debug(
      { agentId: this.agentId, toolCallId: this.toolCallId },
      "[dualLlmSubagent] processWithMainAgent: complete",
    );
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
    logger.debug(
      { agentId: this.agentId, question, optionCount: options.length },
      "[dualLlmSubagent] answerQuestion: starting",
    );
    const optionsText = options.map((opt, idx) => `${idx}: ${opt}`).join("\n");

    // Load quarantined agent prompt from database configuration and replace template variables
    const quarantinedPrompt = this.config.quarantinedAgentPrompt
      .replace("{{toolResultData}}", JSON.stringify(this.toolResult, null, 2))
      .replace("{{question}}", question)
      .replace("{{options}}", optionsText)
      .replace("{{maxIndex}}", String(options.length - 1));

    logger.debug(
      { agentId: this.agentId, promptLength: quarantinedPrompt.length },
      "[dualLlmSubagent] answerQuestion: requesting answer with schema",
    );
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
      logger.debug(
        { agentId: this.agentId, parsed },
        "[dualLlmSubagent] answerQuestion: invalid response structure",
      );
      logger.warn("Invalid response structure, defaulting to last option");
      return options.length - 1;
    }

    // Bounds validation: Ensure answer is within valid range
    const answerIndex = Math.floor(parsed.answer);
    if (answerIndex < 0 || answerIndex >= options.length) {
      logger.debug(
        { agentId: this.agentId, answerIndex, optionCount: options.length },
        "[dualLlmSubagent] answerQuestion: answer out of bounds, defaulting to last option",
      );
      return options.length - 1;
    }

    logger.debug(
      { agentId: this.agentId, answerIndex },
      "[dualLlmSubagent] answerQuestion: valid answer received",
    );
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
    logger.debug(
      { agentId: this.agentId, conversationLength: conversation.length },
      "[dualLlmSubagent] generateSummary: starting",
    );
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

    logger.debug(
      { agentId: this.agentId, qaTextLength: qaText.length },
      "[dualLlmSubagent] generateSummary: requesting summary from LLM",
    );
    const summary = await this.llmClient.chat(
      [{ role: "user", content: summaryPrompt }],
      0,
    );

    logger.debug(
      { agentId: this.agentId, summaryLength: summary.length },
      "[dualLlmSubagent] generateSummary: complete",
    );
    return summary;
  }
}
