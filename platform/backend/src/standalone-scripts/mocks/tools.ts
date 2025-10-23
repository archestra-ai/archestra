import { randomUUID } from "node:crypto";
import { randomBool, randomElement } from "./utils";

const PARAMETER_TYPES = ["string", "number", "boolean", "object", "array"];

const COMMON_PARAMETERS = {
  file: ["path", "filename", "encoding", "mode"],
  data: ["data", "format", "schema", "validation"],
  api: ["url", "method", "headers", "body", "timeout"],
  query: ["query", "params", "filters", "limit", "offset"],
  config: ["config", "options", "settings", "preferences"],
};

/**
 * Generate random parameters for a tool based on its name
 */
function generateRandomParameters(toolName: string): Record<string, unknown> {
  const paramCount = Math.floor(Math.random() * 4) + 1; // 1-4 parameters
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];

  // Determine parameter category based on tool name
  let paramCategory = "config";
  if (toolName.includes("file")) paramCategory = "file";
  else if (toolName.includes("data")) paramCategory = "data";
  else if (toolName.includes("api")) paramCategory = "api";
  else if (toolName.includes("query")) paramCategory = "query";

  const availableParams =
    COMMON_PARAMETERS[paramCategory as keyof typeof COMMON_PARAMETERS];

  for (let i = 0; i < paramCount; i++) {
    const paramName = availableParams[i] || `param_${i + 1}`;
    const paramType = randomElement(PARAMETER_TYPES);

    properties[paramName] = {
      type: paramType,
      description: `${paramName} parameter for ${toolName}`,
    };

    // 70% chance to be required
    if (Math.random() < 0.7) {
      required.push(paramName);
    }
  }

  return {
    type: "object",
    properties,
    required,
  };
}

export const TOOL_NAMES = [
  // File operations
  "read_file",
  "write_file",
  "delete_file",
  "copy_file",
  "move_file",
  "list_directory",
  "create_directory",
  "compress_files",
  "extract_archive",

  // Database operations
  "execute_query",
  "backup_data",
  "restore_data",
  "migrate_schema",
  "validate_schema",
  "optimize_database",
  "export_data",
  "import_data",

  // API operations
  "fetch_api",
  "post_api",
  "delete_api",
  "upload_file",
  "download_file",

  // Monitoring & Analysis
  "analyze_logs",
  "monitor_metrics",
  "track_performance",
  "check_health",
  "generate_report",
  "create_dashboard",

  // Security
  "scan_vulnerabilities",
  "encrypt_data",
  "decrypt_data",
  "verify_signature",
  "audit_access",

  // Code operations
  "review_code",
  "run_tests",
  "deploy_code",
  "rollback_deployment",
  "optimize_performance",

  // Data transformation
  "transform_data",
  "parse_json",
  "parse_csv",
  "convert_format",

  // Communication
  "send_notification",
  "send_email",
  "send_slack_message",
];

export interface MockTool {
  id: string;
  agentId: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  allowUsageWhenUntrustedDataIsPresent: boolean;
  dataIsTrustedByDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Generate mock tools distributed across agents
 */
export function generateMockTools(
  agentIds: string[],
  toolNames: string[] = TOOL_NAMES,
): MockTool[] {
  return toolNames.map((name, index) => {
    // Distribute tools across agents
    const agentId = agentIds[index % agentIds.length];
    const agentName = `Agent ${index % agentIds.length}`;

    return {
      id: randomUUID(),
      agentId,
      name,
      description: `${name.replace(/_/g, " ")} tool for ${agentName}`,
      parameters: generateRandomParameters(name),
      allowUsageWhenUntrustedDataIsPresent: randomBool(),
      dataIsTrustedByDefault: randomBool(0.3), // 30% chance
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
}
