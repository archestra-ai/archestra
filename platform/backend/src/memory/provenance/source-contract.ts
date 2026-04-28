import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { MemoryScopeType } from "@/types/memory-item";
import {
  type MemoryPolicyFlag,
  type MemorySourceMetadata,
  type MemorySourceMetadataFuture,
  MemorySourceMetadataSchema,
  type MemorySourceType,
  MemorySourceTypeSchema,
} from "@/types/memory-item";

export type ChatCandidateProvenance = {
  sourceRole: "user" | "assistant" | "mixed";
  userConfirmed: boolean;
  evidence: Array<{
    role: "user" | "assistant";
    quote: string;
    messageId?: string;
  }>;
};

export type MemorySourceContract = {
  sourceType: MemorySourceType;
  sourceId: string;
  sourceMetadata: MemorySourceMetadata;
};

const SOURCE_CONTRACT_SCHEMA = z.object({
  sourceType: MemorySourceTypeSchema,
  sourceId: z.string().min(1),
  sourceMetadata: MemorySourceMetadataSchema,
});

const CHAT_SOURCE_METADATA_SCHEMA = MemorySourceMetadataSchema.refine(
  (metadata) => Boolean(metadata.origin.conversationId),
  {
    message: "chat source requires origin.conversationId",
  },
);

const MANUAL_SOURCE_METADATA_SCHEMA = MemorySourceMetadataSchema.refine(
  (metadata) =>
    metadata.actor.kind === "user" && Boolean(metadata.actor.userId),
  {
    message: "manual source requires actor.userId",
  },
);

const MCP_TOOL_SOURCE_METADATA_SCHEMA = MemorySourceMetadataSchema.refine(
  (metadata) =>
    Boolean(metadata.actor.userId) ||
    Boolean(metadata.actor.agentId) ||
    metadata.actor.kind === "system",
  {
    message: "mcp_tool source requires actor identity context",
  },
);

export function validateSourceContract(
  sourceContract: MemorySourceContract,
): MemorySourceContract {
  const parsed = SOURCE_CONTRACT_SCHEMA.parse(sourceContract);

  if (parsed.sourceType === "chat") {
    CHAT_SOURCE_METADATA_SCHEMA.parse(parsed.sourceMetadata);
  } else if (parsed.sourceType === "manual") {
    MANUAL_SOURCE_METADATA_SCHEMA.parse(parsed.sourceMetadata);
  } else if (parsed.sourceType === "mcp_tool") {
    MCP_TOOL_SOURCE_METADATA_SCHEMA.parse(parsed.sourceMetadata);
  }

  return parsed;
}

export function buildManualSourceContract(params: {
  requesterUserId: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  policyFlags: MemoryPolicyFlag[];
  extractorVersion?: string | null;
  sourceId?: string | null;
  future?: MemorySourceMetadataFuture | null;
}): MemorySourceContract {
  const runId = createSourceRunId("manual");
  const sourceId =
    params.sourceId?.trim() || `manual:${params.requesterUserId}:${runId}`;

  return validateSourceContract({
    sourceType: "manual",
    sourceId,
    sourceMetadata: {
      origin: {
        channel: "manual",
        scopeType: params.scopeType,
        scopeId: params.scopeId,
      },
      ingestion: {
        runId,
        ingestedAt: new Date().toISOString(),
      },
      actor: {
        kind: "user",
        userId: params.requesterUserId,
      },
      quality: {
        extractorVersion: params.extractorVersion ?? undefined,
      },
      safety: {
        policyFlags: normalizePolicyFlags(params.policyFlags),
      },
      future: withReservedFutureFields(params.future),
    },
  });
}

export function buildMcpToolSourceContract(params: {
  conversationId?: string;
  sessionId?: string;
  userId?: string;
  agentId?: string;
  toolName: string;
  content: string;
  policyFlags: MemoryPolicyFlag[];
  extractorVersion: string;
  future?: MemorySourceMetadataFuture | null;
}): MemorySourceContract {
  const runId = createSourceRunId("mcp");
  const sourceIdentity =
    params.conversationId ?? params.sessionId ?? params.userId ?? runId;
  const sourceId = `mcp:${sourceIdentity}`;
  const idempotencyKey = buildIdempotencyKey([
    sourceId,
    params.toolName,
    params.content,
  ]);

  return validateSourceContract({
    sourceType: "mcp_tool",
    sourceId,
    sourceMetadata: {
      origin: {
        channel: "mcp_tool",
        conversationId: params.conversationId,
        toolName: params.toolName,
      },
      ingestion: {
        runId,
        idempotencyKey,
        dedupKey: idempotencyKey,
        ingestedAt: new Date().toISOString(),
      },
      actor: {
        kind: params.agentId ? "agent" : params.userId ? "user" : "system",
        userId: params.userId,
        agentId: params.agentId,
      },
      quality: {
        extractorVersion: params.extractorVersion,
      },
      safety: {
        policyFlags: normalizePolicyFlags(params.policyFlags),
      },
      future: withReservedFutureFields(params.future),
    },
  });
}

export function buildChatExtractionSourceContract(params: {
  conversationId: string;
  messageIds: string[];
  agentId?: string;
  runId: string;
  idempotencyKey: string;
  dedupKey: string;
  extractorVersion: string;
  policyFlags: MemoryPolicyFlag[];
  candidateProvenance?: ChatCandidateProvenance;
  future?: MemorySourceMetadataFuture | null;
}): MemorySourceContract {
  return validateSourceContract({
    sourceType: "chat",
    sourceId: params.conversationId,
    sourceMetadata: {
      origin: {
        conversationId: params.conversationId,
        messageIds: params.messageIds,
        channel: "chat",
      },
      ingestion: {
        runId: params.runId,
        idempotencyKey: params.idempotencyKey,
        dedupKey: params.dedupKey,
        ingestedAt: new Date().toISOString(),
      },
      actor: {
        kind: params.agentId ? "agent" : "system",
        agentId: params.agentId,
      },
      quality: {
        extractorVersion: params.extractorVersion,
        candidateProvenance: params.candidateProvenance,
      },
      safety: {
        policyFlags: normalizePolicyFlags(params.policyFlags),
      },
      future: withReservedFutureFields(params.future),
    },
  });
}

export function buildFallbackSourceContract(params: {
  sourceConversationId?: string | null;
  sourceMessageIds?: string[] | null;
  createdBy?: string | null;
  scopeType?: MemoryScopeType;
  scopeId?: string;
  policyFlags: MemoryPolicyFlag[];
  extractorVersion?: string | null;
  future?: MemorySourceMetadataFuture | null;
}): MemorySourceContract {
  if (params.sourceConversationId) {
    return validateSourceContract({
      sourceType: "chat",
      sourceId: params.sourceConversationId,
      sourceMetadata: {
        origin: {
          channel: "chat",
          conversationId: params.sourceConversationId,
          messageIds: params.sourceMessageIds ?? undefined,
        },
        ingestion: {
          runId: createSourceRunId("legacy_chat"),
          ingestedAt: new Date().toISOString(),
        },
        actor: {
          kind: "system",
        },
        quality: {
          extractorVersion: params.extractorVersion ?? undefined,
        },
        safety: {
          policyFlags: normalizePolicyFlags(params.policyFlags),
        },
        future: withReservedFutureFields(params.future),
      },
    });
  }

  if (params.createdBy) {
    return buildManualSourceContract({
      requesterUserId: params.createdBy,
      scopeType: params.scopeType ?? "user",
      scopeId: params.scopeId ?? params.createdBy,
      policyFlags: params.policyFlags,
      extractorVersion: params.extractorVersion,
      future: params.future,
    });
  }

  const runId = createSourceRunId("legacy_system");
  return validateSourceContract({
    sourceType: "system",
    sourceId: `system:${runId}`,
    sourceMetadata: {
      origin: {
        channel: "system",
      },
      ingestion: {
        runId,
        ingestedAt: new Date().toISOString(),
      },
      actor: {
        kind: "system",
      },
      quality: {
        extractorVersion: params.extractorVersion ?? undefined,
      },
      safety: {
        policyFlags: normalizePolicyFlags(params.policyFlags),
      },
      future: withReservedFutureFields(params.future),
    },
  });
}

export function createSourceRunId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

export function buildIdempotencyKey(
  parts: Array<string | undefined | null>,
): string {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("|");

  return createHash("sha256").update(normalized).digest("hex");
}

function withReservedFutureFields(
  future: MemorySourceMetadataFuture | null | undefined,
): MemorySourceMetadataFuture {
  return {
    projectId: future?.projectId ?? null,
    workspaceId: future?.workspaceId ?? null,
    sectionId: future?.sectionId ?? null,
  };
}

function normalizePolicyFlags(
  policyFlags: MemoryPolicyFlag[],
): MemoryPolicyFlag[] {
  return Array.from(new Set(policyFlags));
}
