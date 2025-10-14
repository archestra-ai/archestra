import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { DualLlmConfigModel, DualLlmResultModel } from "@/models";
import type { DualLlmConfig } from "@/types";
import type { ChatCompletionRequestMessages } from "../types";

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
  messages: ChatCompletionRequestMessages; // Full conversation history
  currentMessage: ChatCompletionRequestMessages[number]; // Current tool message being analyzed
  config: DualLlmConfig; // Configuration loaded from database
  agentId: string; // The agent ID for tracking
  toolCallId: string; // The tool call ID for tracking
  openai: OpenAI; // OpenAI client instance

  constructor(
    messages: ChatCompletionRequestMessages,
    currentMessage: ChatCompletionRequestMessages[number],
    config: DualLlmConfig,
    agentId: string,
    apiKey: string,
  ) {
    this.messages = messages;
    this.currentMessage = currentMessage;
    this.config = config;
    this.agentId = agentId;
    this.openai = new OpenAI({ apiKey });

    // Extract tool_call_id from current message
    if (currentMessage.role !== "tool") {
      throw new Error("currentMessage must be a tool message");
    }
    this.toolCallId = currentMessage.tool_call_id;
  }

  /**
   * Create a DualLlmSubagent instance with configuration loaded from database
   */
  static async create(
    messages: ChatCompletionRequestMessages,
    currentMessage: ChatCompletionRequestMessages[number],
    agentId: string,
    apiKey: string,
  ): Promise<DualLlmSubagent> {
    const config = await DualLlmConfigModel.getDefault();
    return new DualLlmSubagent(
      messages,
      currentMessage,
      config,
      agentId,
      apiKey,
    );
  }

  /**
   * Extract the user's original request from the conversation.
   * Currently gets the last user message.
   * In the future, this could use smarter intent extraction.
   */
  private extractUserRequest(): string {
    const userContent =
      this.messages.filter((m) => m.role === "user").slice(-1)[0]?.content ||
      "process this data";

    // Convert to string if it's an array (multimodal content)
    return typeof userContent === "string"
      ? userContent
      : JSON.stringify(userContent);
  }

  /**
   * Extract the tool result data from the current message.
   * Parses JSON if possible, otherwise returns as-is.
   */
  private extractToolResult(): unknown {
    if (this.currentMessage.role !== "tool") {
      throw new Error("Current message is not a tool message");
    }

    const content = this.currentMessage.content;

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
   * Main entry point for the quarantine pattern.
   * Runs a Q&A session between main agent and quarantined agent.
   *
   * @returns A safe summary of the information extracted
   */
  async processWithMainAgent(): Promise<string> {
    // Extract data from messages
    const originalUserRequest = this.extractUserRequest();
    const toolResult = this.extractToolResult();

    // Load prompt from database configuration and replace template variable
    const mainAgentPrompt = this.config.mainAgentPrompt.replace(
      "{{originalUserRequest}}",
      originalUserRequest,
    );

    const conversation: ChatCompletionMessageParam[] = [
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
      const mainAgentResponse = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: conversation,
        temperature: 0,
      });

      const response =
        mainAgentResponse.choices[0].message.content?.trim() || "";
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
      const answerIndex = await this.answerQuestion(
        question,
        options,
        toolResult,
      );
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
   * @param toolResult - The untrusted tool result data
   * @returns Index of the selected option (0-based)
   */
  private async answerQuestion(
    question: string,
    options: string[],
    toolResult: unknown,
  ): Promise<number> {
    const optionsText = options.map((opt, idx) => `${idx}: ${opt}`).join("\n");

    // Load quarantined agent prompt from database configuration and replace template variables
    const quarantinedPrompt = this.config.quarantinedAgentPrompt
      .replace("{{toolResultData}}", JSON.stringify(toolResult, null, 2))
      .replace("{{question}}", question)
      .replace("{{options}}", optionsText)
      .replace("{{maxIndex}}", String(options.length - 1));

    const response = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: quarantinedPrompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
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
      },
      temperature: 0,
    });

    const content = response.choices[0].message.content || "";
    const parsed = JSON.parse(content);

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
    conversation: ChatCompletionMessageParam[],
  ): Promise<string> {
    // Extract just the Q&A pairs and summarize
    const qaText = conversation
      .map((msg) =>
        "content" in msg && typeof msg.content === "string" ? msg.content : "",
      )
      .filter((content) => content.length > 0)
      .join("\n");

    // Load summary prompt from database configuration and replace template variables
    const summaryPrompt = this.config.summaryPrompt.replace(
      "{{qaText}}",
      qaText,
    );

    const summaryResponse = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: summaryPrompt }],
      temperature: 0,
    });

    return summaryResponse.choices[0].message.content?.trim() || "";
  }
}
