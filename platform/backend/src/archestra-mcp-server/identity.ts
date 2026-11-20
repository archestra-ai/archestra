import { TOOL_WHOAMI_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { callRustApi } from "@/utils/rust-api";
import { EmptyToolArgsSchema } from "./empty-tool-args-schema";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

const WhoAmIOutputSchema = z.object({
  agentId: z.string().describe("The ID of the current agent."),
  agentName: z.string().describe("The display name of the current agent."),
});
const NativeWhoAmIResult = z.object({
  content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
  structuredContent: WhoAmIOutputSchema,
  isError: z.literal(false),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_WHOAMI_SHORT_NAME,
    title: "Who Am I",
    description: "Returns the name and ID of the current agent.",
    schema: EmptyToolArgsSchema,
    outputSchema: WhoAmIOutputSchema,
    async handler({ context }) {
      const { agent: contextAgent } = context;
      const execution = context.gatewayExecution;
      if (execution?.signal.aborted) return errorResult("Tool call cancelled");
      if (execution?.native) {
        const socketPath = config.database.rustAuditLogSocket;
        if (!socketPath)
          throw new Error("Rust MCP tool socket is not configured");
        try {
          return NativeWhoAmIResult.parse(
            await callRustApi({
              socketPath,
              path: "/internal/v1/mcp/tools/whoami",
              json: JSON.stringify({
                agentId: contextAgent.id,
                agentName: contextAgent.name,
              }),
              signal: execution.signal,
            }),
          );
        } catch (error) {
          if (execution.signal.aborted)
            return errorResult("Tool call cancelled");
          throw error;
        }
      }

      logger.info(
        { agentId: contextAgent.id, agentName: contextAgent.name },
        "whoami tool called",
      );

      return structuredSuccessResult(
        {
          agentId: contextAgent.id,
          agentName: contextAgent.name,
        },
        `Agent Name: ${contextAgent.name}\nAgent ID: ${contextAgent.id}`,
      );
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
