import { TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import { chatOpenAppaSession, executeRemedy } from "@/openappa/service";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError } from "@/types";
import {
  UpdateGuardrailsPolicySchema,
  ValidateGuardrailsPolicySchema,
} from "@/types/guardrails-policy";
import { defineArchestraTool, defineArchestraTools } from "./helpers";

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: "get_guardrails_policy",
    title: "Read guardrails policy",
    description:
      "Read organization.appa.toml and its revision before changing guardrails. This is the policy used for new conversations. Preserve unrelated rules and comments when editing.",
    schema: z.strictObject({}),
    async handler({ context }) {
      if (!context.organizationId)
        throw new ApiError(401, "Organization context is required");
      return result(await guardrailsPolicyService.get(context.organizationId));
    },
  }),
  defineArchestraTool({
    shortName: "validate_guardrails_policy",
    title: "Validate guardrails policy",
    description:
      "Validate proposed organization.appa.toml without applying changes. Explain the intended behavior to the user before updating their policy.",
    schema: ValidateGuardrailsPolicySchema,
    async handler({ args }) {
      return result(await guardrailsPolicyService.validate(args.content));
    },
  }),
  defineArchestraTool({
    shortName: "update_guardrails_policy",
    title: "Update guardrails policy",
    description:
      "Save and activate organization.appa.toml for new conversations. Read the current policy first, preserve unrelated rules, validate changes, and use the revision returned by get_guardrails_policy as expectedRevision. On conflict, re-read and reconcile edits. Existing conversations keep their original policy. Requires toolPolicy:update permission.",
    schema: UpdateGuardrailsPolicySchema,
    async handler({ args, context }) {
      if (!context.organizationId || !context.userId)
        throw new ApiError(
          401,
          "Authenticated organization context is required",
        );
      return result(
        await guardrailsPolicyService.update({
          ...args,
          organizationId: context.organizationId,
          userId: context.userId,
        }),
      );
    },
  }),
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
      );
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

function result(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { ...value },
  };
}

export function isOpenappaTool(shortName: string | null | undefined): boolean {
  return (
    shortName === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
    shortName === "get_guardrails_policy" ||
    shortName === "validate_guardrails_policy" ||
    shortName === "update_guardrails_policy"
  );
}
