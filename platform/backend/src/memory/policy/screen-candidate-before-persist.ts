import MemoryTombstoneModel from "@/models/memory-tombstone";
import type { MemoryPolicyFlag, MemoryScopeType } from "@/types/memory-item";
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
      policyFlags: MemoryPolicyFlag[];
      matchedDetectors: string[];
      reason: "none" | "instruction_like_medium";
    }
  | {
      allowed: false;
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
  if (sensitivity.blocked) {
    const blockCode =
      sensitivity.blockReason === "high_risk_pii"
        ? "high_risk_pii"
        : sensitivity.blockReason === "instruction_like_high"
          ? "instruction_like_high"
          : "sensitive";
    const screenReason =
      sensitivity.blockReason === "high_risk_pii"
        ? "high_risk_pii"
        : sensitivity.blockReason === "instruction_like_high"
          ? "instruction_like_high"
          : "secret";
    reportBlocked(params.source, {
      policyReason: blockCode,
      screenReason,
    });
    return {
      allowed: false,
      code: blockCode,
      message:
        sensitivity.blockReason === "instruction_like_high"
          ? "Memory candidate blocked by policy: high-confidence instruction-like prompt injection detected."
          : "Memory candidate blocked by policy: secret or sensitive markers detected.",
      matchedDetectors: sensitivity.matchedDetectors,
    };
  }

  reportMemoryScreenDecision({
    decision: sensitivity.decision,
    reason: sensitivity.reason,
  });

  return {
    allowed: true,
    policyFlags: sensitivity.policyFlags,
    matchedDetectors: sensitivity.matchedDetectors,
    reason:
      sensitivity.decision === "flag" ? "instruction_like_medium" : "none",
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
