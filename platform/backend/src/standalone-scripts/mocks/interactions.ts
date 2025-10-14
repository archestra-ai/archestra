import { randomUUID } from "node:crypto";
import type { InsertInteraction } from "@/types/interaction";
import { randomBool, randomElement, randomInt } from "./utils";

export interface ConversationTemplate {
  userPrompts: string[];
  toolName: string;
  systemPrompt: string;
}

export const CONVERSATION_TEMPLATES: ConversationTemplate[] = [
  {
    userPrompts: ["Can you analyze the logs?", "What errors do you see?"],
    toolName: "analyze_logs",
    systemPrompt: "You are a helpful assistant that analyzes system logs.",
  },
  {
    userPrompts: ["Read the config file", "What's in the configuration?"],
    toolName: "read_file",
    systemPrompt: "You are a helpful assistant that reads and explains files.",
  },
  {
    userPrompts: [
      "Send me a notification when done",
      "Alert me if there's an issue",
    ],
    toolName: "send_notification",
    systemPrompt: "You are a helpful assistant that manages notifications.",
  },
  {
    userPrompts: ["Fetch data from the API", "Get the latest API response"],
    toolName: "fetch_api",
    systemPrompt: "You are a helpful assistant that interacts with APIs.",
  },
  {
    userPrompts: ["Backup the database", "Can you backup the data?"],
    toolName: "backup_data",
    systemPrompt: "You are a helpful assistant that manages data backups.",
  },
  {
    userPrompts: ["Scan for vulnerabilities", "Check security issues"],
    toolName: "scan_vulnerabilities",
    systemPrompt:
      "You are a security assistant that scans for vulnerabilities.",
  },
  {
    userPrompts: ["Optimize the performance", "Can you improve the speed?"],
    toolName: "optimize_performance",
    systemPrompt: "You are a performance optimization assistant.",
  },
  {
    userPrompts: [
      "Review this code",
      "What do you think about the code quality?",
    ],
    toolName: "review_code",
    systemPrompt: "You are a code review assistant.",
  },
  {
    userPrompts: ["Generate a report", "Create a summary report"],
    toolName: "generate_report",
    systemPrompt: "You are a reporting assistant.",
  },
  {
    userPrompts: ["Execute this query", "Run the database query"],
    toolName: "execute_query",
    systemPrompt: "You are a database assistant.",
  },
];

interface ToolInfo {
  name: string;
  description: string | null;
  allowUsageWhenUntrustedDataIsPresent: boolean;
}

/**
 * Generate a single mock interaction
 */
export function generateMockInteraction(
  agentId: string,
  tools: ToolInfo[],
  shouldBlock: boolean,
): InsertInteraction {
  const template = randomElement(CONVERSATION_TEMPLATES);
  const selectedTool =
    tools.find((t) => t.name === template.toolName) || randomElement(tools);

  const toolCallId = `call_${randomUUID().replace(/-/g, "").substring(0, 24)}`;
  const userPrompt = randomElement(template.userPrompts);

  // Create the messages array - start with system and initial user message
  // biome-ignore lint/suspicious/noExplicitAny: Mock data generation requires flexible message structure
  const messages: Array<Record<string, any>> = [
    {
      role: "system",
      content: template.systemPrompt,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];

  // Add some random context messages to make it more realistic
  if (randomBool(0.4)) {
    // 40% chance
    messages.push({
      role: "assistant",
      content: "I'll help you with that. Let me check...",
      refusal: null,
    });
  }

  // Add tool call from assistant
  messages.push({
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [
      {
        id: toolCallId,
        type: "function",
        function: {
          name: selectedTool.name,
          arguments: "{}",
        },
      },
    ],
  });

  // Add tool response - sometimes with untrusted data
  const hasUntrustedData = shouldBlock && randomBool();
  const toolResponseContent = hasUntrustedData
    ? JSON.stringify({
        data: "some external data",
        source: "untrusted@external.com",
      })
    : JSON.stringify({ success: true, result: "operation completed" });

  messages.push({
    role: "tool",
    content: toolResponseContent,
    tool_call_id: toolCallId,
  });

  // Add final assistant response or blocked response
  if (shouldBlock) {
    messages.push({
      role: "assistant",
      content: `\nI tried to invoke the ${selectedTool.name} tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains untrusted data`,
      refusal: `\n<archestra-tool-name>${selectedTool.name}</archestra-tool-name>\n<archestra-tool-arguments>{}</archestra-tool-arguments>\n<archestra-tool-reason>Tool invocation blocked: context contains untrusted data</archestra-tool-reason>\n\nI tried to invoke the ${selectedTool.name} tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains untrusted data`,
    });
  } else {
    messages.push({
      role: "assistant",
      content: `I've successfully executed the ${selectedTool.name} operation. The task is complete!`,
      refusal: null,
    });
  }

  const request = {
    model: "gpt-4o",
    tools: tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        parameters: {
          type: "object",
          required: [],
          properties: {},
        },
        description: t.description || `${t.name} tool`,
      },
    })),
    stream: false,
    // biome-ignore lint/suspicious/noExplicitAny: Messages array is dynamically constructed for mock data
    messages: messages as any,
    tool_choice: "auto" as const,
  };

  const responseMessage = messages[messages.length - 1];
  const response = {
    id: `chatcmpl-${randomUUID().replace(/-/g, "").substring(0, 29)}`,
    model: "gpt-4o-2024-08-06",
    usage: {
      total_tokens: randomInt(100, 1000),
      prompt_tokens: randomInt(50, 800),
      completion_tokens: randomInt(20, 200),
      prompt_tokens_details: {
        audio_tokens: 0,
        cached_tokens: 0,
      },
      completion_tokens_details: {
        audio_tokens: 0,
        reasoning_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
    object: "chat.completion" as const,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: responseMessage.content,
          refusal: responseMessage.refusal || null,
          annotations: [],
        },
        logprobs: null,
        finish_reason: "stop" as const,
      },
    ],
    created: Math.floor(Date.now() / 1000) - randomInt(0, 86400 * 7), // Random time in last 7 days
    service_tier: "default",
    system_fingerprint: "fp_f64f290af2",
  };

  return {
    agentId,
    request,
    response,
    createdAt: new Date(response.created * 1000),
  };
}

/**
 * Generate multiple mock interactions
 */
export function generateMockInteractions(
  agentIds: string[],
  toolsByAgent: Map<string, ToolInfo[]>,
  count: number,
  blockProbability = 0.3,
): InsertInteraction[] {
  const interactions: InsertInteraction[] = [];

  for (let i = 0; i < count; i++) {
    // Pick a random agent
    const agentId = randomElement(agentIds);

    // Get tools for this agent
    const agentTools = toolsByAgent.get(agentId) || [];

    // Randomly decide if this interaction should be blocked
    const shouldBlock = randomBool(blockProbability);

    const interaction = generateMockInteraction(
      agentId,
      agentTools,
      shouldBlock,
    );
    interactions.push(interaction);
  }

  return interactions;
}
