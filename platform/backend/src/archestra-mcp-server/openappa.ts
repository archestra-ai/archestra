import { TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import { chatOpenAppaSession, executeRemedy } from "@/openappa/service";
import { defineArchestraTool, defineArchestraTools } from "./helpers";

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
    title: "Execute OpenAPPA remedy plan",
    description:
      "Execute an OpenAPPA remedy using the exact offer_id in blocking feedback. After success, retry the original tool or use the admitted output.",
    schema: z.object({
      offer_id: z.string().min(1),
      label: z
        .object({
          trust: z.string().optional(),
          audience: z.array(z.string()).optional(),
        })
        .optional(),
      return_schema: z.record(z.string(), z.unknown()).optional(),
    }),
    async handler({ args, context }) {
      const sessionId = context.sessionId ?? context.conversationId;
      const session =
        context.openappaSession ??
        (context.organizationId && context.userId && sessionId
          ? chatOpenAppaSession(
              context.organizationId,
              context.userId,
              sessionId,
            )
          : undefined);
      if (!session) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "OpenAPPA remedy execution requires an authenticated session and tool-call identity",
            },
          ],
        };
      }
      return executeRemedy(
        session,
        context.currentToolCallId ?? `offer:${args.offer_id}`,
        args,
        context.elicitation,
      );
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
