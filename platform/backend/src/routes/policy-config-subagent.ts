import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { PolicyConfigSubagent } from "@/subagents";
import { constructResponseSchema } from "@/types";

const policyConfigSubagentRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Get the policy configuration subagent analysis prompt template
   */
  fastify.get(
    "/api/policy-config-subagent/prompt",
    {
      schema: {
        tags: ["policy-config-subagent"],
        summary: "Get analysis prompt template",
        description:
          "Returns the prompt template used by the Policy Configuration Subagent to analyze tools",
        response: constructResponseSchema(
          z.object({
            promptTemplate: z.string(),
          }),
        ),
      },
    },
    async () => {
      return {
        promptTemplate: PolicyConfigSubagent.ANALYSIS_PROMPT_TEMPLATE,
      };
    },
  );
};

export default policyConfigSubagentRoutes;
