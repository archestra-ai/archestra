import { context as otelContext, trace } from "@opentelemetry/api";
import {
  TOOL_LIST_MY_MEMORY_SHORT_NAME,
  TOOL_PROPOSE_MEMORY_CANDIDATE_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import logger from "@/logging";
import { screenCandidateBeforePersist } from "@/memory/policy/screen-candidate-before-persist";
import { reportMemoryCandidates } from "@/memory/telemetry/metrics";
import { MemoryItemModel } from "@/models";
import {
  MemoryKindSchema,
  MemoryPolicyFlagSchema,
  MemoryScopeTypeSchema,
  MemoryStatusSchema,
} from "@/types";
import type { MemoryItem } from "@/types/memory-item";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const MEMORY_ITEM_OUTPUT_SCHEMA = z.object({
  id: z.string().describe("Memory item id."),
  scopeType: MemoryScopeTypeSchema.describe("Memory scope type."),
  scopeId: z.string().describe("Memory scope id."),
  kind: MemoryKindSchema.describe("Memory kind."),
  status: MemoryStatusSchema.describe("Memory status."),
  content: z.string().describe("Memory content."),
  policyFlags: z
    .array(MemoryPolicyFlagSchema)
    .describe("Policy flags associated with the memory item."),
  createdBy: z
    .string()
    .nullable()
    .describe("User id that created the candidate, if set."),
  reviewedBy: z
    .string()
    .nullable()
    .describe("User id that reviewed the candidate, if set."),
  confidenceBand: z
    .enum(["low", "medium", "high"])
    .nullable()
    .describe("Confidence band, if available."),
  language: z.string().nullable().describe("Language tag, if available."),
  createdAt: z.string().describe("Creation timestamp in ISO format."),
  updatedAt: z.string().describe("Update timestamp in ISO format."),
  reviewedAt: z
    .string()
    .nullable()
    .describe("Review timestamp in ISO format, if available."),
  lastVerifiedAt: z
    .string()
    .nullable()
    .describe("Verification timestamp in ISO format, if available."),
  expiresAt: z
    .string()
    .nullable()
    .describe("Expiry timestamp in ISO format, if available."),
});

const LIST_MY_MEMORY_OUTPUT_SCHEMA = z.object({
  memoryItems: z
    .array(MEMORY_ITEM_OUTPUT_SCHEMA)
    .describe("Approved user-scope memory items owned by the current user."),
});

const PROPOSE_MEMORY_CANDIDATE_ARGS_SCHEMA = z
  .object({
    kind: MemoryKindSchema.describe("Candidate memory kind."),
    content: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Proposed durable memory content."),
  })
  .strict();

const PROPOSE_MEMORY_CANDIDATE_OUTPUT_SCHEMA = z.object({
  memoryItem: MEMORY_ITEM_OUTPUT_SCHEMA.describe(
    "Created candidate memory item.",
  ),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_LIST_MY_MEMORY_SHORT_NAME,
    title: "List My Memory",
    description:
      "List approved user-scope memory items for the current user only.",
    schema: z.strictObject({}),
    outputSchema: LIST_MY_MEMORY_OUTPUT_SCHEMA,
    async handler({ context }) {
      return handleListMyMemory({ context });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_PROPOSE_MEMORY_CANDIDATE_SHORT_NAME,
    title: "Propose Memory Candidate",
    description:
      "Propose a new user-scope memory candidate. This tool never writes approved memory directly.",
    schema: PROPOSE_MEMORY_CANDIDATE_ARGS_SCHEMA,
    outputSchema: PROPOSE_MEMORY_CANDIDATE_OUTPUT_SCHEMA,
    async handler({ args, context, toolName }) {
      return handleProposeMemoryCandidate({ args, context, toolName });
    },
  }),
] as const);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

async function handleListMyMemory(params: { context: ArchestraContext }) {
  const { context } = params;

  if (!context.userId || !context.organizationId) {
    return errorResult("User context not available");
  }

  const memoryItems = await MemoryItemModel.listForUser({
    userId: context.userId,
    organizationId: context.organizationId,
    teamIds: [],
    isOrgAdmin: false,
    scopeType: "user",
    status: "approved",
    limit: 100,
    offset: 0,
  });

  const result = {
    memoryItems: memoryItems.map(toMemoryItemOutput),
  };
  return structuredSuccessResult(result, JSON.stringify(result, null, 2));
}

async function handleProposeMemoryCandidate(params: {
  args: z.infer<typeof PROPOSE_MEMORY_CANDIDATE_ARGS_SCHEMA>;
  context: ArchestraContext;
  toolName: string;
}) {
  const { args, context, toolName } = params;

  if (!context.userId || !context.organizationId) {
    return errorResult("User context not available");
  }

  const policyScreen = await screenCandidateBeforePersist({
    organizationId: context.organizationId,
    scopeType: "user",
    scopeId: context.userId,
    content: args.content,
    source: "mcp_propose",
    checkExternalContextMarkers: true,
  });
  if (!policyScreen.allowed) {
    emitPolicyBlockAuditMetric({
      reason: policyScreen.code,
      toolName,
      context,
      detectors: policyScreen.matchedDetectors,
    });
    return errorResult(policyScreen.message);
  }

  const memoryItem = await MemoryItemModel.create({
    organizationId: context.organizationId,
    scopeType: "user",
    scopeId: context.userId,
    kind: args.kind,
    status: "candidate",
    content: args.content,
    createdBy: context.userId,
    policyFlags: policyScreen.policyFlags,
  });

  reportMemoryCandidates({
    scopeType: "user",
    extractorVersion: "manual_mcp_propose",
    policyFlags: policyScreen.policyFlags,
  });

  const result = { memoryItem: toMemoryItemOutput(memoryItem) };
  return structuredSuccessResult(result, JSON.stringify(result, null, 2));
}

function emitPolicyBlockAuditMetric(params: {
  reason: string;
  toolName: string;
  context: ArchestraContext;
  detectors: string[];
}): void {
  const activeSpan = trace.getSpan(otelContext.active());
  if (activeSpan) {
    activeSpan.setAttribute("archestra.memory.propose_policy_blocked", 1);
    activeSpan.setAttribute(
      "archestra.memory.propose_policy_block_reason",
      params.reason,
    );
    activeSpan.setAttribute(
      "archestra.memory.propose_policy_block_detectors",
      params.detectors.join(","),
    );
  }

  logger.warn(
    {
      toolName: params.toolName,
      userId: params.context.userId ?? null,
      organizationId: params.context.organizationId ?? null,
      reason: params.reason,
      detectors: params.detectors,
    },
    "Blocked memory candidate due to policy violation",
  );
}

function toMemoryItemOutput(item: MemoryItem) {
  return {
    id: item.id,
    scopeType: item.scopeType,
    scopeId: item.scopeId,
    kind: item.kind,
    status: item.status,
    content: item.content,
    policyFlags: item.policyFlags,
    createdBy: item.createdBy,
    reviewedBy: item.reviewedBy,
    confidenceBand: item.confidenceBand,
    language: item.language,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    reviewedAt: item.reviewedAt ? item.reviewedAt.toISOString() : null,
    lastVerifiedAt: item.lastVerifiedAt
      ? item.lastVerifiedAt.toISOString()
      : null,
    expiresAt: item.expiresAt ? item.expiresAt.toISOString() : null,
  };
}
