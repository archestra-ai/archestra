import { isDeepStrictEqual } from "node:util";
import {
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import config from "@/config";
import { openappaBatteriesService } from "@/openappa/batteries";
import { NoticeArguments, RemedyExecutionSchema } from "@/openappa/notice";
import { OfferJwsSchema, verifyOfferClaims } from "@/openappa/offer-claims";
import {
  chatOpenAppaSession,
  executeRemedyByOffer,
  executeYell,
} from "@/openappa/service";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { ApiError } from "@/types";
import {
  UpdateGuardrailsPolicySchema,
  ValidateGuardrailsPolicySchema,
} from "@/types/guardrails-policy";
import type { EffectivePolicy } from "@/types/openappa-batteries";
import { defineArchestraTool, defineArchestraTools } from "./helpers";

const RemedyPlanArgumentsSchema = z.object({
  offer_id: z.string().min(1),
  plan: z.string().optional(),
  label: z
    .object({
      trust: z.string().optional(),
      audience: z.array(z.string()).optional(),
    })
    .optional(),
  return_schema: z.record(z.string(), z.unknown()).optional(),
});

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
      "Read organization.appa.toml and its revision before changing guardrails. This is the organization's own policy text, used for new conversations; batteries installed for MCP servers compose into enforcement on top of it, and `effective` shows the composed result the runtime enforces. Preserve unrelated rules and comments when editing.",
    schema: z.strictObject({}),
    async handler({ context }) {
      if (!context.organizationId)
        throw new ApiError(401, "Organization context is required");
      const [root, effective] = await Promise.all([
        guardrailsPolicyService.get(context.organizationId),
        openappaBatteriesService.getEffectivePolicy(context.organizationId),
      ]);
      return result({ ...root, effective: enforced(effective) });
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
      const saved = await guardrailsPolicyService.update({
        ...args,
        organizationId: context.organizationId,
        userId: context.userId,
      });
      const effective = await openappaBatteriesService.getEffectivePolicy(
        context.organizationId,
      );
      return result({ ...saved, effective: enforced(effective) });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_REMEDY_PLANS_SHORT_NAME,
    title: "Read a blocked call's ruling and remedy plans",
    description:
      "Read why the guardrails policy blocked a tool call and which remedy plans it offers. The platform gives you this call in place of a blocked call. It runs nothing and changes nothing. The plans are for you. When the ruling offers a plan, name it to the user, choose it, and call execute_remedy_plan with the offer_id and plan from the ruling. Then retry the original call. If the ruling offers no plan, explain the block. If you need the user's decision, use ask_user, never a plain-text question.",
    schema: NoticeArguments,
    async handler({ args }) {
      // The ruling the runtime already made, carried by the call itself. This
      // opens no root, emits no OpenAPPA event and reads no policy: the runtime
      // refused the call when it was proposed, and this is that refusal being
      // delivered to the model's own loop.
      return { content: [{ type: "text", text: args.ruling }] };
    },
  }),
  defineArchestraTool({
    shortName: TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
    title: "Execute OpenAPPA remedy plan",
    description:
      "Execute a remedy plan offered by the guardrails policy for a blocked call. Pass the exact offer_id and the plan description shown in the ruling. The plan argument describes what will change so the user can review it before approving the call. After execution succeeds, retry the original call or use the admitted output. If permission is denied, stop and inform the user.",
    schema: RemedyPlanArgumentsSchema.extend({
      execution: RemedyExecutionSchema.optional().describe(
        "Transport record added by the proxy for retry identity and exact history restoration. It does not authorize the remedy.",
      ),
      protected: OfferJwsSchema.shape.protected
        .optional()
        .describe(
          "Flattened JWS protected header (RFC 7515). Added by the proxy.",
        ),
      payload: OfferJwsSchema.shape.payload
        .optional()
        .describe(
          "Flattened JWS unencoded payload (RFC 7797). Added by the proxy.",
        ),
      signature: OfferJwsSchema.shape.signature
        .optional()
        .describe("Flattened JWS signature (RFC 7515). Added by the proxy."),
    }),
    async handler({ args, context }) {
      const {
        execution,
        protected: protectedHeader,
        payload,
        signature,
        ...submittedArguments
      } = args;
      const submittedSemantic =
        RemedyPlanArgumentsSchema.parse(submittedArguments);
      const originalArguments = execution?.original_arguments;
      let originalSemantic = submittedSemantic;
      if (originalArguments) {
        try {
          originalSemantic = RemedyPlanArgumentsSchema.parse(
            JSON.parse(originalArguments),
          );
        } catch {
          throw new ApiError(
            400,
            "Malformed original arguments in execution record",
          );
        }
      }
      if (
        execution &&
        !isDeepStrictEqual(originalSemantic, submittedSemantic)
      ) {
        throw new ApiError(
          400,
          "OpenAPPA execution arguments do not match the remedy call",
        );
      }
      // `plan` remains in the exact original arguments for receipt matching but
      // is not runtime remedy input.
      const { plan: _plan, ...remedy } = submittedSemantic;
      const claims = verifyOfferClaims(
        {
          protected: protectedHeader,
          payload,
          signature,
        },
        config.openappa.offerSigningSecret,
      );
      if (
        !context.organizationId ||
        !claims ||
        claims.offer_id !== submittedSemantic.offer_id ||
        claims.organization_id !== context.organizationId
      ) {
        return unknownOfferResult();
      }
      const byOffer = await executeRemedyByOffer({
        organizationId: context.organizationId,
        ...(context.userId ? { callerId: `user:${context.userId}` } : {}),
        sessionId: claims.session_id,
        ...(claims.parent_id ? { parentId: claims.parent_id } : {}),
        ...(claims.caller_id ? { ownerCallerId: claims.caller_id } : {}),
        ...(claims.tool ? { tool: claims.tool } : {}),
        ...(claims.spelling ? { spelling: claims.spelling } : {}),
        toolCallId: execution?.call_id ?? context.currentToolCallId,
        controlToolName: execution?.tool_name,
        originalArguments:
          originalArguments ?? JSON.stringify(submittedSemantic),
        args: remedy,
      });
      return byOffer.result;
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

/**
 * What the runtime enforces: the root composed with the installed batteries,
 * or the root alone with the error when the last composition failed.
 */
function enforced(effective: EffectivePolicy) {
  return { content: effective.content, error: effective.lastError };
}

function result(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { ...value },
  };
}

function unknownOfferResult() {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "[appa] No live offer with this id",
      },
    ],
  };
}

export function isOpenappaTool(shortName: string | null | undefined): boolean {
  return (
    shortName === "yell" ||
    shortName === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
    shortName === TOOL_GET_REMEDY_PLANS_SHORT_NAME ||
    shortName === "get_guardrails_policy" ||
    shortName === "validate_guardrails_policy" ||
    shortName === "update_guardrails_policy"
  );
}
