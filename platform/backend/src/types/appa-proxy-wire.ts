import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import {
  appaProxyWireAliasesTable,
  appaProxyWireFramesTable,
} from "@/database/schemas/appa-proxy-wire";

export const AppaWireFrameKindSchema = z.enum([
  "model_response",
  "inbound_hold",
  "remedy_control",
]);
export type AppaWireFrameKind = z.infer<typeof AppaWireFrameKindSchema>;
export const AppaWireFrameStateSchema = z.enum([
  "held",
  "ready",
  "issued",
  "running",
  "completed",
  "cancelled",
  "quarantined",
]);
export type AppaWireFrameState = z.infer<typeof AppaWireFrameStateSchema>;
export const AppaWireAliasKindSchema = z.enum(["call", "task", "process"]);
export type AppaWireAliasKind = z.infer<typeof AppaWireAliasKindSchema>;
export const SelectAppaWireFrameSchema = createSelectSchema(
  appaProxyWireFramesTable,
);
export type AppaWireFrame = z.infer<typeof SelectAppaWireFrameSchema>;
export const SelectAppaWireAliasSchema = createSelectSchema(
  appaProxyWireAliasesTable,
);
export type AppaWireAlias = z.infer<typeof SelectAppaWireAliasSchema>;

/**
 * Encrypted payload of a gateway-issued APPA control frame. The parent proxy
 * owns creation and keeps the held parent frame until a later controller step;
 * this shape is the service's only authority for a control invocation.
 */
export const AppaControlOfferKindSchema = z.enum([
  "acceptance",
  "human_approval",
  "sanitizer",
  "authority",
  "unsupported",
]);
export type AppaControlOfferKind = z.infer<typeof AppaControlOfferKindSchema>;

const AppaControlIdentifierSchema = z.string().min(1).max(512);
const AppaControlDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const AppaControlVouchedOperationSchema = z.enum([
  "inspect",
  "execute",
  "status",
]);
export type AppaControlVouchedOperation = z.infer<
  typeof AppaControlVouchedOperationSchema
>;
export const APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM =
  "text(JSON.stringify(Object.keys(tools)));";

export const AppaControlFramePayloadSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("gateway_remedy"),
    type: z.literal("remedy_batch"),
    intent: z
      .object({
        // The intent names the held model-response frame, not the transient
        // MCP control call that carries one operation voucher.
        id: z.string().uuid(),
        descriptor: z.string().min(1).max(256),
      })
      .strict(),
    rootId: AppaControlIdentifierSchema,
    childId: AppaControlIdentifierSchema.optional(),
    heldParentFrameId: z.string().uuid(),
    controlNamespace: z
      .string()
      .regex(/^mcp__[A-Za-z0-9_-]+$/)
      .optional(),
    organizationId: z.string().uuid().optional(),
    boundThreadId: AppaControlIdentifierSchema,
    boundItemId: AppaControlIdentifierSchema.optional(),
    owner: z
      .object({
        kind: z.literal("user"),
        id: AppaControlIdentifierSchema,
      })
      .strict(),
    vouch: z
      .object({
        operation: AppaControlVouchedOperationSchema,
        chosenRemedyId: AppaControlIdentifierSchema.optional(),
      })
      .strict(),
    offers: z
      .array(
        z
          .object({
            id: AppaControlIdentifierSchema,
            // These values originate in the parent controller's held PREPARED
            // batch and are never reconstructed by the MCP control service.
            batchId: z.string().uuid(),
            position: z.number().int().nonnegative(),
            callId: AppaControlIdentifierSchema,
            kind: AppaControlOfferKindSchema,
            tool: AppaControlIdentifierSchema,
            argumentsSha256: AppaControlDigestSchema,
            effectiveArguments: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    approvalId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.intent.id !== payload.heldParentFrameId) {
      ctx.addIssue({
        code: "custom",
        message: "APPA control intent must name its held parent frame",
      });
    }
    if (
      (payload.vouch.operation === "execute") !==
      (payload.vouch.chosenRemedyId !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "APPA execute vouchers require exactly one selected remedy",
      });
    }
    if (
      payload.vouch.chosenRemedyId !== undefined &&
      !payload.offers.some((offer) => offer.id === payload.vouch.chosenRemedyId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "APPA execute voucher must select a stored remedy",
      });
    }
    if (
      new Set(payload.offers.map((offer) => offer.id)).size !==
      payload.offers.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "APPA control offers must have unique IDs",
      });
    }
    const callByBatchPosition = new Map<string, string>();
    const positionByBatchCall = new Map<string, number>();
    for (const offer of payload.offers) {
      const positionKey = `${offer.batchId}:${offer.position}`;
      const callKey = `${offer.batchId}:${offer.callId}`;
      const storedCall = callByBatchPosition.get(positionKey);
      const storedPosition = positionByBatchCall.get(callKey);
      if (
        (storedCall !== undefined && storedCall !== offer.callId) ||
        (storedPosition !== undefined && storedPosition !== offer.position)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "APPA offers must preserve their held batch call position",
        });
        break;
      }
      callByBatchPosition.set(positionKey, offer.callId);
      positionByBatchCall.set(callKey, offer.position);
    }
  });
export type AppaControlFramePayload = z.infer<
  typeof AppaControlFramePayloadSchema
>;

/**
 * Client-local bootstrap data is encrypted like every other wire frame, but is
 * deliberately not a control capability, a gateway execution, or an approval
 * receipt. The native bridge records this fixed registry observation before it
 * starts the model loop.
 */
export const AppaLocalObservationPayloadSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("client_local_observation"),
    type: z.literal("registry_discovery"),
    program: z.literal(APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM),
    toolNames: z.array(AppaControlIdentifierSchema).max(10_000),
    outputText: z.string().max(1024 * 1024),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.outputText !== JSON.stringify(payload.toolNames)) {
      ctx.addIssue({
        code: "custom",
        message: "registry discovery output must match the fixed local program",
      });
    }
  });
export type AppaLocalObservationPayload = z.infer<
  typeof AppaLocalObservationPayloadSchema
>;
