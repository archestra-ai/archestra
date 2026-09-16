import { TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import {
  chatOpenAppaSession,
  executeRemedy,
  executeYell,
} from "@/openappa/service";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError } from "@/types";
import {
  UpdateGuardrailsPolicySchema,
  ValidateGuardrailsPolicySchema,
} from "@/types/guardrails-policy";
import { defineArchestraTool, defineArchestraTools } from "./helpers";

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: "yell",
    title: "Report OpenAPPA feedback",
    description:
      "Report confusing OpenAPPA blocks or remedies to the OpenAPPA developers. Sends your message and filtered policy diagnostics to the shared OpenAPPA reporting service (GCS and Slack). with_trajectory includes this session's policy decisions, never raw prompts, tool arguments, or outputs. Your message is sent verbatim: do not include secrets, personal data, or task content. This does not change policy or grant permission.",
    schema: z.strictObject({
      message: z
        .string()
        .min(1)
        .max(65536)
        .refine((value) => value.trim().length > 0, "A message is required"),
      with_trajectory: z.boolean(),
    }),
    async handler({ args, context }) {
      const id = context.sessionId ?? context.conversationId;
      const session =
        context.openappaSession ??
        (context.organizationId && context.userId && id
          ? chatOpenAppaSession(context.organizationId, context.userId, id)
          : undefined);
      if (!session || !context.currentToolCallId)
        throw new ApiError(
          400,
          "OpenAPPA reporting requires an authenticated session and tool-call identity",
        );
      return executeYell({
        session,
        toolCallId: context.currentToolCallId,
        args,
      });
    },
  }),
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
    shortName === "yell" ||
    shortName === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
    shortName === "get_guardrails_policy" ||
    shortName === "validate_guardrails_policy" ||
    shortName === "update_guardrails_policy"
  );
}
