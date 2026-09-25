import { isDeepStrictEqual } from "node:util";
import {
  MCP_HUMAN_RULING_META_KEY,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import UserModel from "@/models/user";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  clearHitlReview,
  consumeHitlRuling,
  stageHitlReview,
} from "@/openappa/hitl-review";
import { NoticeArguments, RemedyExecutionSchema } from "@/openappa/notice";
import { OfferJwsSchema, verifyOfferClaims } from "@/openappa/offer-claims";
import {
  chatOpenAppaSession,
  executeRemedyByOffer,
  executeYell,
  loadOfferReview,
} from "@/openappa/service";
import {
  recallYellSession,
  YellArgumentsSchema,
} from "@/openappa/yell-session";
import {
  getGuardrailsDeployment,
  setGuardrailsDeployment,
} from "@/services/guardrails-deployment";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { getAppaGithubSync } from "@/services/openappa-github-sync";
import {
  getOpenAppaPolicyChangeStatus,
  publishOpenAppaPolicyChange,
} from "@/services/openappa-policy-change";
import { ApiError } from "@/types";
import {
  UpdateGuardrailsPolicySchema,
  ValidateGuardrailsPolicySchema,
} from "@/types/guardrails-policy";
import { defineArchestraTool, defineArchestraTools } from "./helpers";
import type { ArchestraContext } from "./types";

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

// Shared by the chat elicitation bridge and the MRTR input-required signal.
// Both channels request the same approve/deny ruling form.
const HITL_RULING_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["approve", "deny"],
      description: "Approve or deny this remedy plan",
    },
  },
  required: ["action"],
} as const;

// The binding records a precheck refusal verbatim and rejects values over 64 KiB.
const MAX_PRECHECK_REFUSAL_BYTES = 64 * 1024;

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: "yell",
    title: "Report OpenAPPA feedback",
    description:
      "Report confusing OpenAPPA blocks or remedies to the OpenAPPA developers. Sends your message and filtered policy diagnostics to the shared OpenAPPA reporting service (GCS and Slack). with_trajectory includes this session's policy decisions, never raw prompts, tool arguments, or outputs. Your message is sent verbatim: do not include secrets, personal data, or task content. This does not change policy or grant permission.",
    schema: YellArgumentsSchema,
    async handler({ args, context }) {
      const id = context.sessionId ?? context.conversationId;
      const known =
        context.openappaSession ??
        (context.organizationId && context.userId && id
          ? chatOpenAppaSession(context.organizationId, context.userId, id)
          : undefined);
      const identity =
        known && context.currentToolCallId
          ? { session: known, callId: context.currentToolCallId }
          : context.organizationId
            ? await recallYellSession({
                organizationId: context.organizationId,
                args,
              })
            : undefined;
      if (!identity) {
        logger.warn(
          {
            agentId: context.agentId,
            hasSession: Boolean(known),
            hasToolCallId: Boolean(context.currentToolCallId),
          },
          "OpenAPPA yell refused: no session or tool-call identity",
        );
        throw new ApiError(
          400,
          "OpenAPPA reporting requires an authenticated session and tool-call identity",
        );
      }
      return executeYell({
        session: identity.session,
        toolCallId: identity.callId,
        args,
      });
    },
  }),
  defineArchestraTool({
    shortName: "get_guardrails_policy",
    title: "Read OpenAPPA policy",
    description:
      "Read organization.appa.toml and its revision before changing guardrails. This is the organization's own policy text, used for new conversations; its `include` list names the batteries that compose into enforcement on top of it, `[server_aliases]` points each battery's namespace at the MCP servers it governs, `[credentials]` names the runtime credential each battery helper reads, and `effective` shows the composed result the runtime enforces, with one entry per declared battery and the status it composed under. Report any battery whose status is not `active`, and any `effective.error`, to the user. Preserve unrelated rules and comments when editing.",
    schema: z.strictObject({}),
    async handler({ context }) {
      if (!context.organizationId)
        throw new ApiError(401, "Organization context is required");
      const [root, effective] = await Promise.all([
        guardrailsPolicyService.get(context.organizationId),
        enforced(context.organizationId),
      ]);
      const sync = await getAppaGithubSync(context.organizationId);
      return result({
        ...root,
        effective,
        delivery: sync.source?.interval
          ? {
              mode: "pull_request",
              repo: sync.source.repo,
              path: sync.source.path,
              githubAppReady: Boolean(sync.source.githubAppConfigId),
            }
          : { mode: "revision" },
      });
    },
  }),
  defineArchestraTool({
    shortName: "validate_guardrails_policy",
    title: "Validate OpenAPPA policy",
    description:
      "Validate proposed organization.appa.toml without applying changes. The batteries its `include` list names are composed into the check, so an entry no battery answers is refused unless the current revision already spells it — an entry the current revision keeps is valid with a warning instead, and `warnings` names every battery that would govern nothing. Report the warnings; do not read `valid` alone as working. Explain the intended behavior to the user before updating their policy.",
    schema: ValidateGuardrailsPolicySchema,
    async handler({ args, context }) {
      if (!context.organizationId)
        throw new ApiError(401, "Organization context is required");
      return result(
        await guardrailsPolicyService.validate(args.content, {
          organizationId: context.organizationId,
        }),
      );
    },
  }),
  defineArchestraTool({
    shortName: "preview_guardrails_policy_change",
    title: "Preview OpenAPPA policy change",
    description:
      "Validate and show a reviewable diff for a proposed organization.appa.toml. Read the current policy and pass its revision. This changes nothing. Show the diff and warnings to the user before publishing with update_guardrails_policy.",
    schema: UpdateGuardrailsPolicySchema,
    async handler({ args, context }) {
      if (!context.organizationId)
        throw new ApiError(401, "Organization context is required");
      const before = await guardrailsPolicyService.get(context.organizationId);
      if (before.revision !== args.expectedRevision)
        throw new ApiError(
          409,
          "The policy changed. Read it again before previewing.",
        );
      const validation = await guardrailsPolicyService.validate(args.content, {
        organizationId: context.organizationId,
        previous: before.content,
      });
      const sync = await getAppaGithubSync(context.organizationId);
      return result({
        stage: "preview",
        delivery: sync.source?.interval ? "pull_request" : "revision",
        path: sync.source?.path ?? "organization.appa.toml",
        before: before.content,
        after: args.content,
        ...validation,
      });
    },
  }),
  defineArchestraTool({
    shortName: "update_guardrails_policy",
    title: "Publish OpenAPPA policy change",
    description:
      "Publish a validated change to organization.appa.toml. Read the current policy first, preserve unrelated rules, and use its revision as expectedRevision. Call preview_guardrails_policy_change first and explain its diff and warnings. When GitHub sync is configured, this creates a pull request using the configured GitHub App; the policy takes effect after merge and sync. Otherwise it saves a local revision immediately. On conflict, re-read and reconcile. A local revision affects new conversations only, and turns OpenAPPA enforcement on when it was off and the caller is an administrator: report `enforcement` to the user. Report any inactive effective battery.",
    schema: UpdateGuardrailsPolicySchema.extend({
      title: z
        .string()
        .trim()
        .min(3)
        .max(120)
        .default("Update OpenAPPA policy"),
      summary: z
        .string()
        .trim()
        .max(4000)
        .default("OpenAPPA policy change proposed in chat."),
    }),
    async handler({ args, context }) {
      if (!context.organizationId || !context.userId)
        throw new ApiError(
          401,
          "Authenticated organization context is required",
        );
      const saved = await publishOpenAppaPolicyChange({
        ...args,
        organizationId: context.organizationId,
        userId: context.userId,
      });
      if (saved.delivery !== "revision") return result(saved);
      return result({
        ...saved,
        effective: await enforced(context.organizationId),
        enforcement: await turnOnAfterPolicySave({
          organizationId: context.organizationId,
          userId: context.userId,
        }),
      });
    },
  }),
  defineArchestraTool({
    shortName: "get_guardrails_policy_change_status",
    title: "Check OpenAPPA policy pull request",
    description:
      "Check the review state of an OpenAPPA policy pull request and whether GitHub sync has processed the merged policy. Use the pull request number returned by update_guardrails_policy.",
    schema: z.strictObject({ number: z.number().int().positive() }),
    async handler({ args, context }) {
      if (!context.organizationId || !context.userId)
        throw new ApiError(
          401,
          "Authenticated organization context is required",
        );
      return result(
        await getOpenAppaPolicyChangeStatus({
          organizationId: context.organizationId,
          userId: context.userId,
          number: args.number,
        }),
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_REMEDY_PLANS_SHORT_NAME,
    title: "Read a blocked call's ruling and remedy plans",
    description:
      "Read why the guardrails policy blocked a tool call and which remedy plans it offers. The platform gives you this call in place of a blocked call. It runs nothing and changes nothing. The plans are for you. When the ruling offers a plan, choose the appropriate plan and immediately call execute_remedy_plan with the offer_id and plan from the ruling. Do not ask the user for permission first. The execute_remedy_plan tool opens required human reviews directly. Then retry the original call. If the ruling offers no plan, explain the block.",
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
      "Execute a remedy plan offered by the guardrails policy for a blocked call. Call this tool as soon as a ruling offers the plan. Do not ask the user for permission first. Pass the exact offer_id and plan description from the ruling. If the result says review_required, immediately call the declared ask_user tool with that offer ID. Do not ask the user in plain text. After approval, call execute_remedy_plan again with the same offer and plan. After execution succeeds, retry the original call or use the admitted output. If review is denied, canceled, unavailable, or unanswered, stop and state that the action remains blocked.",
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

      // Check if this offer requires human review before executing or acquiring locks.
      // Session routing uses the verified claims, so the review lookup
      // requires no offer-owner table.
      const review = await loadOfferReview({
        organizationId: context.organizationId,
        sessionId: claims.session_id,
        offerId: remedy.offer_id,
      });

      let ruling: "approve" | "deny" | undefined;
      let precheckRefusal: string | undefined;
      if (review) {
        const reviewSession = {
          organization_id: claims.organization_id,
          session_id: claims.session_id,
          ...(claims.caller_id ? { caller_id: claims.caller_id } : {}),
          ...(claims.parent_id ? { parent_id: claims.parent_id } : {}),
        };
        // Check that the reviewed call can run before prompting the user.
        // A refusal is recorded as this remedy's result.
        const precheck = {
          review,
          spelling: claims.spelling ?? claims.tool ?? undefined,
          context,
        };
        precheckRefusal = await precheckReviewedCall(precheck);
        if (precheckRefusal) {
          await clearHitlReview({
            session: reviewSession,
            offerId: remedy.offer_id,
          });
        } else {
          const cachedRuling = await consumeHitlRuling({
            session: reviewSession,
            offerId: remedy.offer_id,
          });
          if (cachedRuling === "approve" || cachedRuling === "deny") {
            ruling = cachedRuling;
          } else if (cachedRuling === "none") {
            ruling = undefined;
          } else if (context.mrtr) {
            // External MCP clients reach their native question tool through ask_user.
            // Stage the exact review first so the model cannot alter
            // the question or bind an answer to a different offer.
            await stageHitlReview({
              session: reviewSession,
              review: {
                offerId: remedy.offer_id,
                text: review.text,
                ...(review.tool ? { tool: review.tool } : {}),
                ...(review.arguments ? { arguments: review.arguments } : {}),
                remedyArguments: unstampedRemedyArguments(args),
              },
            });
            return nativeReviewRequiredResult(remedy.offer_id);
          } else if (context.elicitation) {
            // Archestra Chat keeps its inline approval card.
            const outcome = await context.elicitation.elicit({
              toolName: TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
              message: review.text,
              requestedSchema: HITL_RULING_SCHEMA,
              kind: "openappa_review",
              ...(review.tool ? { reviewedTool: review.tool } : {}),
              ...(review.arguments
                ? { reviewedArguments: review.arguments }
                : {}),
            });
            ruling = parseHitlRuling(
              outcome.status === "answered" ? outcome.result : undefined,
            );
          }
        }
      }

      const byOffer = await executeRemedyByOffer({
        organizationId: context.organizationId,
        ...(context.userId ? { callerId: `user:${context.userId}` } : {}),
        sessionId: claims.session_id,
        ...(claims.parent_id ? { parentId: claims.parent_id } : {}),
        ...(claims.caller_id ? { ownerCallerId: claims.caller_id } : {}),
        ...(claims.tool ? { tool: claims.tool } : {}),
        ...(claims.spelling ? { spelling: claims.spelling } : {}),
        ...(claims.dispatch ? { dispatch: claims.dispatch } : {}),
        toolCallId: execution?.call_id ?? context.currentToolCallId,
        controlToolName: execution?.tool_name,
        originalArguments:
          originalArguments ?? JSON.stringify(submittedSemantic),
        args: remedy,
        ruling,
        ...(precheckRefusal ? { precheckRefusal } : {}),
      });
      if (!ruling || !byOffer.known) return byOffer.result;
      // Display-only: the chat card displays the human ruling.
      // `_meta` does not reach the model; the model reads the ruling from result text.
      return {
        ...byOffer.result,
        _meta: {
          ...byOffer.result._meta,
          [MCP_HUMAN_RULING_META_KEY]: ruling,
        },
      };
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

/**
 * What the runtime enforces: the root composed with the batteries it declares,
 * or the last composition that opened with the error the newest one raised.
 * Every declared battery is listed with its status, because a battery that
 * governs nothing still composes and would otherwise read as success.
 */
async function enforced(organizationId: string) {
  const [effective, declarations] = await Promise.all([
    openappaBatteriesService.getEffectivePolicy(organizationId),
    openappaBatteriesService.policyDeclarations(organizationId),
  ]);
  return {
    content: effective.content,
    error: effective.lastError,
    batteries: declarations.batteries.map((battery) => ({
      entry: battery.entry,
      name: battery.name,
      status: battery.status,
    })),
  };
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

function nativeReviewRequiredResult(offerId: string): CallToolResult {
  return result({
    ok: false,
    outcome: "review_required",
    offer_id: offerId,
    instruction:
      "Call the declared ask_user tool now with this offer ID in remedy_offer_ids. Do not ask the user in plain text. The platform will show the exact review and fixed Approve/Deny choices in the client's native question UI when available. Follow the ask_user result. Call execute_remedy_plan again only after an Approve answer.",
  });
}

function unstampedRemedyArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...args };
  for (const key of ["execution", "protected", "payload", "signature"]) {
    delete result[key];
  }
  return result;
}

/**
 * The model-visible refusal for a reviewed call that cannot run even if approved.
 * Only Archestra built-in tools are checked through executor gates.
 * Other tools, reviews without call details, or failed prechecks continue
 * to the reviewer.
 */
async function precheckReviewedCall(params: {
  review: { tool?: string; arguments?: string };
  /** The name the model knows the tool by, when the claims carry one. */
  spelling?: string;
  context: ArchestraContext;
}): Promise<string | undefined> {
  const { review, context } = params;
  const args = parseArgumentsRecord(review.arguments);
  if (!review.tool || !args) return undefined;
  // Dynamic import avoids the circular import between this file and ./index
  // (index.ts imports every tool group, including this one).
  const { getArchestraToolInputSchema, preflightArchestraToolCall } =
    await import("./index");
  if (!getArchestraToolInputSchema(review.tool)) return undefined;
  let refused: CallToolResult | null;
  try {
    refused = await preflightArchestraToolCall({
      toolName: review.tool,
      args,
      context,
    });
  } catch (error) {
    logger.warn(
      { err: error, tool: review.tool },
      "OpenAPPA review precheck failed; asking the reviewer",
    );
    return undefined;
  }
  if (!refused) return undefined;
  return precheckRefusalText({
    tool: params.spelling ?? review.tool,
    detail: refused.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n"),
  });
}

function precheckRefusalText(params: { tool: string; detail: string }) {
  const head = `[appa] Not submitted for approval: this call to ${params.tool} could not run even if approved.\n`;
  const tail = `\nFix the arguments and call ${params.tool} again; the corrected call gets its own approval.`;
  const budget =
    MAX_PRECHECK_REFUSAL_BYTES - Buffer.byteLength(head + tail, "utf8");
  if (budget <= 0) {
    return truncateUtf8(head + tail, MAX_PRECHECK_REFUSAL_BYTES);
  }
  return head + truncateUtf8(params.detail, budget) + tail;
}

/** Cuts text to at most `maxBytes` of UTF-8, marking the cut with an ellipsis. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes - Buffer.byteLength("…", "utf8"));
  // Back off out of a continuation-byte run to cut on a character boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function parseArgumentsRecord(
  json: string | undefined,
): Record<string, unknown> | undefined {
  if (json === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A policy saved in chat is what the operator wanted enforced, so it turns
 * OpenAPPA on when it was off. Only someone who may flip the switch turns it
 * on, and a refusal keeps the saved policy and says why, for the agent to
 * report. The switch is audited as the HTTP route audits it.
 */
async function turnOnAfterPolicySave({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}): Promise<{ enabled: boolean; turnedOn: boolean; reason?: string }> {
  const current = await getGuardrailsDeployment();
  if (current.enabled || !current.featureEnabled)
    return { enabled: current.active, turnedOn: false };
  if (
    !(await userHasPermission(userId, organizationId, "organization", "update"))
  )
    return {
      enabled: false,
      turnedOn: false,
      reason:
        "Only an administrator can turn OpenAPPA on, from the OpenAPPA switch in the sidebar.",
    };
  const before = await GuardrailsDeploymentModel.findByIdForAudit();
  try {
    await setGuardrailsDeployment(true);
  } catch (error) {
    if (error instanceof ApiError)
      return { enabled: false, turnedOn: false, reason: error.message };
    throw error;
  }
  const actor = await UserModel.getById(userId);
  await AuditLogModel.create({
    organizationId,
    actorId: userId,
    actorType: "user",
    actorName: actor?.name ?? null,
    actorEmail: actor?.email ?? null,
    action: "organization.updated",
    outcome: "success",
    resourceType: "organization",
    resourceId: organizationId,
    resourceName: null,
    before,
    after: await GuardrailsDeploymentModel.findByIdForAudit(),
    httpMethod: null,
    httpPath: "mcp-tool:update_guardrails_policy",
    httpRoute: null,
    httpStatus: null,
    requestId: null,
    sourceIp: null,
    userAgent: null,
    occurredAt: new Date(),
  }).catch((err) =>
    logger.error({ err }, "audit: failed to record OpenAPPA turning on"),
  );
  return { enabled: true, turnedOn: true };
}

/**
 * Parses the unified elicitation envelope into a remedy ruling.
 * An `accept` action must include an explicit `approve` or `deny` content action.
 * Malformed or missing actions yield no ruling, causing the upstream runtime
 * to resolve the review as `NoAnswer` (fail closed).
 * A `decline` action maps to `deny`.
 * A `cancel` action or unrecognized payload yields no ruling.
 */
function parseHitlRuling(envelope: unknown): "approve" | "deny" | undefined {
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const { action, content } = envelope as {
    action?: unknown;
    content?: unknown;
  };
  if (action === "decline") return "deny";
  if (action !== "accept") return undefined;
  const contentAction =
    typeof content === "object" && content !== null
      ? (content as { action?: unknown }).action
      : undefined;
  if (contentAction === "approve") return "approve";
  if (contentAction === "deny") return "deny";
  return undefined;
}

export function isOpenappaTool(shortName: string | null | undefined): boolean {
  return (
    shortName === "yell" ||
    shortName === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
    shortName === TOOL_GET_REMEDY_PLANS_SHORT_NAME ||
    shortName === "get_guardrails_policy" ||
    shortName === "validate_guardrails_policy" ||
    shortName === "preview_guardrails_policy_change" ||
    shortName === "update_guardrails_policy" ||
    shortName === "get_guardrails_policy_change_status"
  );
}
