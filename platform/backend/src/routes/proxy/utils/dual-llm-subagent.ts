import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { DualLlmConfigModel, DualLlmResultModel } from "@/models";
import type { DualLlmConfig } from "@/types";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
  data: any; // The untrusted tool result data
  config: DualLlmConfig; // Configuration loaded from database
  agentId: string; // The agent ID for tracking
  toolCallId: string; // The tool call ID for tracking

  constructor(
    toolResult: any,
    config: DualLlmConfig,
    agentId: string,
    toolCallId: string,
  ) {
    this.data = toolResult;
    this.config = config;
    this.agentId = agentId;
    this.toolCallId = toolCallId;
  }

  /**
   * Create a DualLlmSubagent instance with configuration loaded from database
   */
  static async create(
    toolResult: any,
    agentId: string,
    toolCallId: string,
  ): Promise<DualLlmSubagent> {
    const config = await DualLlmConfigModel.getDefault();
    return new DualLlmSubagent(toolResult, config, agentId, toolCallId);
  }

  /**
   * Main entry point for the quarantine pattern.
   * Runs a Q&A session between main agent and quarantined agent.
   *
   * @param originalUserRequest - What the user actually asked for (e.g., "summarize my emails")
   * @returns A safe summary of the information extracted
   */
  async processWithMainAgent(originalUserRequest: string) {
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
      const mainAgentResponse = await openai.chat.completions.create({
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
      options.forEach((opt, idx) => console.log(`  ${idx}: ${opt}`));

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
  async answerQuestion(question: string, options: string[]) {
    const optionsText = options.map((opt, idx) => `${idx}: ${opt}`).join("\n");

    // Load quarantined agent prompt from database configuration and replace template variables
    const quarantinedPrompt = this.config.quarantinedAgentPrompt
      .replace("{{toolResultData}}", JSON.stringify(this.data, null, 2))
      .replace("{{question}}", question)
      .replace("{{options}}", optionsText)
      .replace("{{maxIndex}}", String(options.length - 1));

    const response = await openai.chat.completions.create({
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
  async generateSummary(conversation: ChatCompletionMessageParam[]) {
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

    const summaryResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: summaryPrompt }],
      temperature: 0,
    });

    return summaryResponse.choices[0].message.content?.trim() || "";
  }
}
