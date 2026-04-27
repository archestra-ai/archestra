import {
  determinePolicyDecision,
  SCORER_VERSION,
  scoreMemoryCandidate,
} from "@/memory/scoring/scorer";
import MemoryTombstoneModel from "@/models/memory-tombstone";
import type {
  MemoryConfidenceBand,
  MemoryItemClassifications,
  MemoryItemScores,
  MemoryKind,
  MemoryPolicyFlag,
  MemoryScopeType,
} from "@/types/memory-item";
import {
  reportMemoryMcpProposeBlock,
  reportMemoryPolicyBlocked,
  reportMemorySafetyBlock,
  reportMemoryScreenDecision,
  reportMemoryTombstoneHit,
} from "../telemetry/metrics";
import { screenSensitiveData } from "./sensitive-data-screen";

export type CandidatePersistSource =
  | "extractor"
  | "manual_create"
  | "mcp_propose"
  | "supersede";

export type CandidatePersistBlockCode =
  | "external_context"
  | "sensitive"
  | "high_risk_pii"
  | "instruction_like_high"
  | "tombstone_hit";

export type CandidatePersistScreenResult =
  | {
      allowed: true;
      quarantine: false;
      policyFlags: MemoryPolicyFlag[];
      matchedDetectors: string[];
      reason: "none" | "instruction_like_medium";
      scores: MemoryItemScores;
      classifications: MemoryItemClassifications;
      scorerVersion: string;
    }
  | {
      allowed: false;
      quarantine: true;
      code: CandidatePersistBlockCode;
      message: string;
      matchedDetectors: string[];
      policyFlags: MemoryPolicyFlag[];
      scores: MemoryItemScores;
      classifications: MemoryItemClassifications;
      scorerVersion: string;
    }
  | {
      allowed: false;
      quarantine?: false;
      code: CandidatePersistBlockCode;
      message: string;
      matchedDetectors: string[];
    };

export async function screenCandidateBeforePersist(params: {
  organizationId: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  content: string;
  source: CandidatePersistSource;
  checkExternalContextMarkers?: boolean;
  kind?: MemoryKind;
  confidenceBand?: MemoryConfidenceBand | null;
}): Promise<CandidatePersistScreenResult> {
  if (
    params.checkExternalContextMarkers &&
    hasExternalContextMarker(params.content)
  ) {
    reportBlocked(params.source, {
      policyReason: "external_context",
      screenReason: "external_context_marker",
    });
    return {
      allowed: false,
      code: "external_context",
      message:
        "Memory candidate blocked by policy: external context markers are not allowed.",
      matchedDetectors: ["external_context_marker"],
    };
  }

  const tombstoneMatch = await MemoryTombstoneModel.findActiveMatchByContent({
    organizationId: params.organizationId,
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    content: params.content,
  });
  if (tombstoneMatch.matched) {
    reportBlocked(params.source, {
      policyReason: "tombstone_hit",
      screenReason: "tombstone_hit",
    });
    if (tombstoneMatch.reason && tombstoneMatch.matchType) {
      reportMemoryTombstoneHit({
        reason: tombstoneMatch.reason,
        matchType: tombstoneMatch.matchType,
      });
    }
    return {
      allowed: false,
      code: "tombstone_hit",
      message:
        "Memory candidate blocked by policy: content previously rejected and tombstoned.",
      matchedDetectors: ["tombstone_hit"],
    };
  }

  const sensitivity = screenSensitiveData({ content: params.content });

  // Hard blocks: secrets and high-risk PII are never persisted.
  if (
    sensitivity.blocked &&
    sensitivity.blockReason !== "instruction_like_high"
  ) {
    const blockCode =
      sensitivity.blockReason === "high_risk_pii"
        ? "high_risk_pii"
        : "sensitive";
    const screenReason =
      sensitivity.blockReason === "high_risk_pii" ? "high_risk_pii" : "secret";
    reportBlocked(params.source, {
      policyReason: blockCode,
      screenReason,
    });
    return {
      allowed: false,
      code: blockCode,
      message:
        "Memory candidate blocked by policy: secret or sensitive markers detected.",
      matchedDetectors: sensitivity.matchedDetectors,
    };
  }

  // Build classifications from screen results.
  const userExplicitlyRequestedMemory =
    params.source === "manual_create" ||
    params.source === "mcp_propose" ||
    params.source === "supersede";

  const classifications: MemoryItemClassifications = {
    secretDetected: sensitivity.secretDetected,
    piiCategories: sensitivity.piiCategories,
    instructionLike:
      sensitivity.reason === "instruction_like_high" ||
      sensitivity.reason === "instruction_like_medium",
    userExplicitlyRequestedMemory,
    derivedFromExternalContext: false,
  };

  // Determine policyFlags from screen result.
  const policyFlags: MemoryPolicyFlag[] = [...sensitivity.policyFlags];
  if (
    sensitivity.blocked &&
    sensitivity.blockReason === "instruction_like_high"
  ) {
    policyFlags.push("instruction_like", "instruction_like_high");
  }

  const sourceType = mapSourceToSourceType(params.source);
  const kind: MemoryKind = params.kind ?? "preference";

  const scores = scoreMemoryCandidate({
    content: params.content,
    kind,
    scopeType: params.scopeType,
    sourceType,
    policyFlags,
    classifications,
    confidenceBand: params.confidenceBand,
  });

  const decision = determinePolicyDecision({
    scores,
    classifications,
    kind,
    scopeType: params.scopeType,
  });

  if (decision === "block") {
    reportBlocked(params.source, {
      policyReason: "sensitive",
      screenReason: "secret",
    });
    return {
      allowed: false,
      code: "sensitive",
      message:
        "Memory candidate blocked by policy: secret or sensitive markers detected.",
      matchedDetectors: sensitivity.matchedDetectors,
    };
  }

  if (decision === "quarantine") {
    const code: CandidatePersistBlockCode = "instruction_like_high";
    reportBlocked(params.source, {
      policyReason: "instruction_like_high",
      screenReason: "instruction_like_high",
    });
    return {
      allowed: false,
      quarantine: true,
      code,
      message:
        "Memory candidate quarantined: instruction-like or high-risk content requires security review before use.",
      matchedDetectors: sensitivity.matchedDetectors,
      policyFlags,
      scores,
      classifications,
      scorerVersion: SCORER_VERSION,
    };
  }

  reportMemoryScreenDecision({
    decision: sensitivity.decision,
    reason: sensitivity.reason,
  });

  return {
    allowed: true,
    quarantine: false as const,
    policyFlags,
    matchedDetectors: sensitivity.matchedDetectors,
    reason:
      sensitivity.reason === "instruction_like_medium"
        ? "instruction_like_medium"
        : "none",
    scores,
    classifications,
    scorerVersion: SCORER_VERSION,
  };
}

export function hasExternalContextMarker(content: string): boolean {
  const normalized = normalizeExternalContextInput(content);
  if (!normalized) {
    return false;
  }

  // Also match compact variants like "unsafe_context-boundary" after separators collapse.
  const collapsed = normalized.replace(/[\s_-]+/g, "");

  return EXTERNAL_CONTEXT_MARKERS.some((marker) => {
    if (normalized.includes(marker.normalizedNeedle)) {
      return true;
    }
    return collapsed.includes(marker.collapsedNeedle);
  });
}

// ============================================================================
// Internal helpers
// ============================================================================

function reportBlocked(
  source: CandidatePersistSource,
  params: {
    policyReason:
      | "external_context"
      | "high_risk_pii"
      | "instruction_like_high"
      | "sensitive"
      | "tombstone_hit";
    screenReason:
      | "external_context_marker"
      | "high_risk_pii"
      | "instruction_like_high"
      | "secret"
      | "tombstone_hit";
  },
): void {
  reportMemoryPolicyBlocked(params.policyReason);
  reportMemorySafetyBlock({
    sourceType: mapSourceToSourceType(source),
    reason: params.policyReason,
  });
  // Keep MCP-propose blocks separately visible because they cross an explicit tool boundary.
  if (source === "mcp_propose") {
    reportMemoryMcpProposeBlock(params.screenReason);
  }
}

function mapSourceToSourceType(
  source: CandidatePersistSource,
): "chat" | "manual" | "mcp_tool" | "system" {
  if (source === "extractor") {
    return "chat";
  }
  if (source === "manual_create") {
    return "manual";
  }
  if (source === "mcp_propose") {
    return "mcp_tool";
  }
  return "system";
}

function normalizeExternalContextInput(content: string): string {
  return content.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const EXTERNAL_CONTEXT_MARKERS = [
  "unsafecontextboundary",
  "unsafe context boundary",
  "unsafe context",
  "external_context",
  "external context",
  "tool result",
  "from tool output",
  "browser output",
  "remote source",
].map((value) => ({
  normalizedNeedle: value,
  collapsedNeedle: value.replace(/[\s_-]+/g, ""),
}));
