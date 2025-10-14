import { randomUUID } from "node:crypto";
import { randomBool } from "./utils";

export const TOOL_NAMES = [
  "read_file",
  "write_file",
  "execute_query",
  "fetch_api",
  "send_notification",
  "analyze_logs",
  "scan_vulnerabilities",
  "optimize_performance",
  "review_code",
  "generate_report",
  "monitor_metrics",
  "backup_data",
  "validate_schema",
  "transform_data",
  "encrypt_data",
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
      parameters: {},
      allowUsageWhenUntrustedDataIsPresent: randomBool(),
      dataIsTrustedByDefault: randomBool(0.3), // 30% chance
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
}
