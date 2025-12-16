import { randomUUID } from "node:crypto";
import type { InsertInteraction } from "@/types";
import { randomBool, randomElement, randomInt } from "./utils";

export interface ConversationTemplate {
  userPrompts: string[];
  toolName: string;
  systemPrompt: string;
}

export const CONVERSATION_TEMPLATES: ConversationTemplate[] = [
  // File operations
  {
    userPrompts: ["Read the config file", "What's in the configuration?"],
    toolName: "read_file",
    systemPrompt: "You are a helpful assistant that reads and explains files.",
  },
  {
    userPrompts: ["Write this to a file", "Save the output"],
    toolName: "write_file",
    systemPrompt: "You are a helpful assistant that writes files.",
  },
  {
    userPrompts: ["Delete the old logs", "Remove temporary files"],
    toolName: "delete_file",
    systemPrompt: "You are a helpful assistant that manages files.",
  },
  {
    userPrompts: ["Copy the backup", "Duplicate this file"],
    toolName: "copy_file",
    systemPrompt: "You are a helpful assistant that manages files.",
  },
  {
    userPrompts: [
      "List the directory contents",
      "Show me what's in this folder",
    ],
    toolName: "list_directory",
    systemPrompt: "You are a helpful assistant that navigates filesystems.",
  },

  // Database operations
  {
    userPrompts: ["Execute this query", "Run the database query"],
    toolName: "execute_query",
    systemPrompt: "You are a database assistant.",
  },
  {
    userPrompts: ["Backup the database", "Can you backup the data?"],
    toolName: "backup_data",
    systemPrompt: "You are a helpful assistant that manages data backups.",
  },
  {
    userPrompts: ["Restore from backup", "Recover the data"],
    toolName: "restore_data",
    systemPrompt: "You are a database recovery assistant.",
  },
  {
    userPrompts: ["Migrate the schema", "Update the database structure"],
    toolName: "migrate_schema",
    systemPrompt: "You are a database migration assistant.",
  },
  {
    userPrompts: ["Export the data", "Download the dataset"],
    toolName: "export_data",
    systemPrompt: "You are a data export assistant.",
  },

  // API operations
  {
    userPrompts: ["Fetch data from the API", "Get the latest API response"],
    toolName: "fetch_api",
    systemPrompt: "You are a helpful assistant that interacts with APIs.",
  },
  {
    userPrompts: ["Post this data", "Send the request"],
    toolName: "post_api",
    systemPrompt: "You are a helpful assistant that interacts with APIs.",
  },
  {
    userPrompts: ["Upload the file", "Send this file to the server"],
    toolName: "upload_file",
    systemPrompt: "You are a file transfer assistant.",
  },

  // Monitoring
  {
    userPrompts: ["Can you analyze the logs?", "What errors do you see?"],
    toolName: "analyze_logs",
    systemPrompt: "You are a helpful assistant that analyzes system logs.",
  },
  {
    userPrompts: ["Check the metrics", "Monitor the system"],
    toolName: "monitor_metrics",
    systemPrompt: "You are a monitoring assistant.",
  },
  {
    userPrompts: ["Track performance", "How is the system performing?"],
    toolName: "track_performance",
    systemPrompt: "You are a performance tracking assistant.",
  },
  {
    userPrompts: ["Check system health", "Is everything running ok?"],
    toolName: "check_health",
    systemPrompt: "You are a system health assistant.",
  },
  {
    userPrompts: ["Generate a report", "Create a summary report"],
    toolName: "generate_report",
    systemPrompt: "You are a reporting assistant.",
  },

  // Security
  {
    userPrompts: ["Scan for vulnerabilities", "Check security issues"],
    toolName: "scan_vulnerabilities",
    systemPrompt:
      "You are a security assistant that scans for vulnerabilities.",
  },
  {
    userPrompts: ["Encrypt this data", "Secure the information"],
    toolName: "encrypt_data",
    systemPrompt: "You are a security encryption assistant.",
  },
  {
    userPrompts: ["Verify the signature", "Check authentication"],
    toolName: "verify_signature",
    systemPrompt: "You are a security verification assistant.",
  },

  // Code operations
  {
    userPrompts: [
      "Review this code",
      "What do you think about the code quality?",
    ],
    toolName: "review_code",
    systemPrompt: "You are a code review assistant.",
  },
  {
    userPrompts: ["Run the tests", "Execute the test suite"],
    toolName: "run_tests",
    systemPrompt: "You are a testing assistant.",
  },
  {
    userPrompts: ["Deploy the code", "Push to production"],
    toolName: "deploy_code",
    systemPrompt: "You are a deployment assistant.",
  },
  {
    userPrompts: ["Optimize the performance", "Can you improve the speed?"],
    toolName: "optimize_performance",
    systemPrompt: "You are a performance optimization assistant.",
  },

  // Data transformation
  {
    userPrompts: ["Transform the data", "Convert this format"],
    toolName: "transform_data",
    systemPrompt: "You are a data transformation assistant.",
  },
  {
    userPrompts: ["Parse this JSON", "Read the JSON data"],
    toolName: "parse_json",
    systemPrompt: "You are a data parsing assistant.",
  },

  // Communication
  {
    userPrompts: [
      "Send me a notification when done",
      "Alert me if there's an issue",
    ],
    toolName: "send_notification",
    systemPrompt: "You are a helpful assistant that manages notifications.",
  },
  {
    userPrompts: ["Send an email", "Email the team"],
    toolName: "send_email",
    systemPrompt: "You are an email assistant.",
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
    delete_file: {
      path: randomElement([
        "/tmp/old_cache.json",
        "/var/log/old.log",
        "~/Downloads/temp.txt",
      ]),
    },
    copy_file: {
      source: randomElement(["/etc/config.json", "/var/backup/data.db"]),
      destination: randomElement(["/tmp/config.json", "/mnt/backup/data.db"]),
    },
    move_file: {
      source: randomElement(["/tmp/upload.csv", "/var/temp/file.txt"]),
      destination: randomElement([
        "/var/data/upload.csv",
        "/home/user/file.txt",
      ]),
    },
    list_directory: {
      path: randomElement(["/var/log", "/home/user/projects", "/etc"]),
      recursive: randomBool(),
    },
    create_directory: {
      path: randomElement([
        "/var/app/cache",
        "/home/user/new_project",
        "/tmp/session",
      ]),
      mode: randomElement(["755", "644", "700"]),
    },
    compress_files: {
      files: randomElement([
        ["/var/log/app.log"],
        ["/home/user/data.csv", "/home/user/report.pdf"],
      ]),
      output: randomElement(["archive.zip", "backup.tar.gz"]),
    },
    extract_archive: {
      archive: randomElement(["backup.zip", "data.tar.gz"]),
      destination: randomElement(["/tmp/extracted", "/var/restore"]),
    },
    restore_data: {
      backup: randomElement([
        "s3://backups/db-2024-01-15.sql",
        "/mnt/backup/latest.dump",
      ]),
      target: randomElement(["production", "staging", "development"]),
    },
    migrate_schema: {
      from: randomElement(["v1.0", "v2.0", "v3.0"]),
      to: randomElement(["v2.0", "v3.0", "v4.0"]),
      database: randomElement(["main", "analytics"]),
    },
    optimize_database: {
      database: randomElement(["main", "analytics", "production"]),
      tasks: randomElement([["vacuum"], ["reindex"], ["analyze", "vacuum"]]),
    },
    export_data: {
      table: randomElement(["users", "products", "orders"]),
      format: randomElement(["csv", "json", "xml"]),
      destination: randomElement(["/tmp/export.csv", "s3://exports/data.json"]),
    },
    import_data: {
      source: randomElement(["/tmp/import.csv", "s3://imports/data.json"]),
      table: randomElement(["users", "products", "orders"]),
      mode: randomElement(["append", "replace", "merge"]),
    },
    post_api: {
      url: randomElement([
        "https://api.example.com/users",
        "https://webhook.site/unique-id",
      ]),
      data: randomElement([
        { name: "John Doe", email: "john@example.com" },
        { status: "completed", result: "success" },
      ]),
    },
    delete_api: {
      url: randomElement([
        "https://api.example.com/users/123",
        "https://api.example.com/posts/456",
      ]),
    },
    upload_file: {
      file: randomElement(["document.pdf", "image.png", "data.csv"]),
      url: randomElement([
        "https://upload.example.com/files",
        "s3://bucket/uploads",
      ]),
    },
    download_file: {
      url: randomElement([
        "https://example.com/files/document.pdf",
        "https://cdn.example.com/assets/image.png",
      ]),
      destination: randomElement(["/tmp/downloads/", "~/Downloads/"]),
    },
    track_performance: {
      application: randomElement(["web", "api", "worker"]),
      metrics: randomElement([["cpu", "memory"], ["latency"], ["throughput"]]),
    },
    check_health: {
      services: randomElement([["api"], ["database", "cache"], ["all"]]),
      timeout: randomInt(5, 30),
    },
    create_dashboard: {
      name: randomElement([
        "System Overview",
        "Performance Metrics",
        "User Analytics",
      ]),
      widgets: randomElement([
        ["cpu", "memory"],
        ["requests", "latency"],
        ["users", "revenue"],
      ]),
    },
    decrypt_data: {
      data: randomElement(["encrypted.bin", "secure.enc"]),
      key: randomElement(["key-001", "key-prod", "key-dev"]),
    },
    verify_signature: {
      data: randomElement(["document.pdf", "message.txt"]),
      signature: randomElement(["sig.bin", "signature.asc"]),
      publicKey: randomElement(["key.pub", "cert.pem"]),
    },
    audit_access: {
      user: randomElement(["admin", "user123", "service-account"]),
      resource: randomElement(["database", "api", "files"]),
      since: randomElement(["1h", "24h", "7d"]),
    },
    run_tests: {
      suite: randomElement(["unit", "integration", "e2e"]),
      path: randomElement(["tests/", "src/**/*.test.ts"]),
    },
    deploy_code: {
      environment: randomElement(["staging", "production", "development"]),
      branch: randomElement(["main", "release-1.0", "hotfix/critical"]),
      strategy: randomElement(["blue-green", "rolling", "canary"]),
    },
    rollback_deployment: {
      environment: randomElement(["staging", "production"]),
      version: randomElement(["v1.2.3", "v1.2.2", "v1.1.0"]),
    },
    parse_json: {
      file: randomElement(["data.json", "config.json", "response.json"]),
      schema: randomElement(["user", "product", "order"]),
    },
    parse_csv: {
      file: randomElement(["data.csv", "export.csv", "users.csv"]),
      delimiter: randomElement([",", ";", "|"]),
      hasHeader: randomBool(),
    },
    convert_format: {
      input: randomElement(["data.json", "file.xml", "doc.yaml"]),
      output: randomElement(["csv", "json", "xml"]),
    },
    send_email: {
      to: randomElement(["team@example.com", "support@company.com"]),
      subject: randomElement([
        "Weekly Report",
        "System Alert",
        "Deployment Notice",
      ]),
      body: randomElement([
        "Please find attached the weekly report.",
        "A system issue was detected and resolved.",
        "The deployment to production is complete.",
      ]),
    },
    send_slack_message: {
      channel: randomElement(["#engineering", "#alerts", "#general"]),
      message: randomElement([
        "Deployment completed successfully",
        "System health check failed",
        "New feature released",
      ]),
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
  if (tools.length === 0) {
    throw new Error(
      `Cannot generate interaction for agent ${agentId}: agent has no tools`,
    );
  }

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
    profileId: agentId,
    type: "openai:chatCompletions",
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

  // Filter to only agents that have tools
  const agentsWithTools = agentIds.filter(
    (agentId) => (toolsByAgent.get(agentId)?.length ?? 0) > 0,
  );

  if (agentsWithTools.length === 0) {
    throw new Error(
      "Cannot generate interactions: no agents have tools assigned",
    );
  }

  for (let i = 0; i < count; i++) {
    // Pick a random agent that has tools
    const agentId = randomElement(agentsWithTools);

    // Get tools for this agent (guaranteed to have at least one)
    // biome-ignore lint/style/noNonNullAssertion: ok in seed script
    const agentTools = toolsByAgent.get(agentId)!;

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
