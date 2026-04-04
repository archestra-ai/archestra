import { TOOL_WHOAMI_SHORT_NAME } from "@shared";
import { z } from "zod";
import logger from "@/logging";
import {
  defineArchestraTool,
  defineArchestraTools,
  EmptyToolArgsSchema,
  structuredSuccessResult,
} from "./helpers";

const WhoAmIOutputSchema = z.object({
  agentId: z.string().describe("The ID of the current agent."),
  agentName: z.string().describe("The display name of the current agent."),
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

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
