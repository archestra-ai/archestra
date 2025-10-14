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
 * Generate realistic arguments based on tool name
 */
function generateToolArguments(toolName: string): Record<string, unknown> {
  const argumentsMap: Record<string, Record<string, unknown>> = {
    read_file: {
      path: randomElement([
        "/var/log/app.log",
        "/etc/config.json",
        "/home/user/data.csv",
        "~/Documents/report.pdf",
      ]),
    },
    write_file: {
      path: randomElement([
        "/tmp/output.txt",
        "/var/app/cache.json",
        "~/Desktop/notes.md",
      ]),
      content: randomElement([
        "Hello World",
        "Configuration updated",
        "Log entry saved",
      ]),
    },
    execute_query: {
      query: randomElement([
        "SELECT * FROM users WHERE active = true",
        "UPDATE products SET stock = stock - 1 WHERE id = 123",
        "DELETE FROM logs WHERE created_at < '2024-01-01'",
      ]),
      database: randomElement(["main", "analytics", "production"]),
    },
    fetch_api: {
      url: randomElement([
        "https://api.example.com/users",
        "https://jsonplaceholder.typicode.com/posts",
        "https://api.github.com/repos/archestra-ai/archestra",
      ]),
      method: randomElement(["GET", "POST", "PUT"]),
    },
    send_notification: {
      to: randomElement([
        "user@example.com",
        "admin@company.com",
        "alert@monitoring.io",
      ]),
      subject: randomElement([
        "Alert: System Issue Detected",
        "Report Generated",
        "Task Completed",
      ]),
      message: randomElement([
        "The system has detected an anomaly",
        "Your report is ready",
        "The task has been completed successfully",
      ]),
    },
    analyze_logs: {
      path: randomElement([
        "/var/log/syslog",
        "/var/log/application.log",
        "/var/log/error.log",
      ]),
      since: randomElement(["1h", "24h", "7d"]),
      level: randomElement(["error", "warning", "info"]),
    },
    scan_vulnerabilities: {
      target: randomElement(["192.168.1.100", "example.com", "/var/www/html"]),
      scanType: randomElement(["quick", "full", "custom"]),
    },
    optimize_performance: {
      component: randomElement(["database", "api", "cache", "frontend"]),
      metric: randomElement(["latency", "throughput", "memory"]),
    },
    review_code: {
      repository: randomElement([
        "github.com/company/app",
        "gitlab.com/team/project",
      ]),
      branch: randomElement(["main", "develop", "feature/new-ui"]),
      files: randomElement([["src/app.ts"], ["lib/utils.js", "tests/unit.js"]]),
    },
    generate_report: {
      type: randomElement(["daily", "weekly", "monthly"]),
      format: randomElement(["pdf", "csv", "json"]),
      metrics: randomElement([
        ["sales", "revenue"],
        ["users", "sessions"],
        ["errors", "warnings"],
      ]),
    },
    monitor_metrics: {
      service: randomElement(["api", "database", "cache"]),
      interval: randomElement(["1m", "5m", "15m"]),
      threshold: randomInt(50, 95),
    },
    backup_data: {
      source: randomElement([
        "/var/lib/database",
        "/home/user/documents",
        "/etc/config",
      ]),
      destination: randomElement([
        "s3://backups",
        "/mnt/backup",
        "ftp://backup-server",
      ]),
      compression: randomElement([true, false]),
    },
    validate_schema: {
      schema: randomElement(["users", "products", "orders"]),
      file: randomElement(["data.json", "input.csv", "config.yaml"]),
    },
    transform_data: {
      input: randomElement(["data.csv", "raw.json", "logs.txt"]),
      output: randomElement(["transformed.json", "processed.csv"]),
      format: randomElement(["json", "csv", "xml"]),
    },
    encrypt_data: {
      data: randomElement(["sensitive-info.txt", "credentials.json"]),
      algorithm: randomElement(["AES-256", "RSA-2048", "ChaCha20"]),
      key: randomElement(["key-001", "key-prod", "key-dev"]),
    },
  };

  return argumentsMap[toolName] || {};
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
  const toolArguments = generateToolArguments(selectedTool.name);

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
          arguments: JSON.stringify(toolArguments),
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

  // Create the final assistant response (but DON'T add it to request messages)
  const argsString = JSON.stringify(toolArguments);
  const responseMessage = shouldBlock
    ? {
        role: "assistant",
        content: `\nI tried to invoke the ${selectedTool.name} tool with the following arguments: ${argsString}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains untrusted data`,
        refusal: `\n<archestra-tool-name>${selectedTool.name}</archestra-tool-name>\n<archestra-tool-arguments>${argsString}</archestra-tool-arguments>\n<archestra-tool-reason>Tool invocation blocked: context contains untrusted data</archestra-tool-reason>\n\nI tried to invoke the ${selectedTool.name} tool with the following arguments: ${argsString}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains untrusted data`,
      }
    : {
        role: "assistant",
        content: `I've successfully executed the ${selectedTool.name} operation. The task is complete!`,
        refusal: null,
      };

  // The request should NOT include the final assistant response
  // It should end with the tool response
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
