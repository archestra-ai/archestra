import type {
  MemoryConfidenceBand,
  MemoryItemClassifications,
  MemoryItemScores,
  MemoryKind,
  MemoryPolicyFlag,
  MemoryScopeType,
  MemorySourceType,
} from "@/types/memory-item";

export const SCORER_VERSION = "1.0.0";

export const SAFETY_SCORE_BANDS = {
  LOW_RISK: { min: 90, max: 100 },
  PROBABLY_SAFE: { min: 70, max: 89 },
  NEEDS_REVIEW: { min: 40, max: 69 },
  HIGH_RISK: { min: 10, max: 39 },
  BLOCKED: { min: 0, max: 9 },
} as const;

export type SafetyScoreBand = keyof typeof SAFETY_SCORE_BANDS;

export type PolicyDecision =
  | "block"
  | "quarantine"
  | "review_required"
  | "allow";

export function scoreMemoryCandidate(params: {
  content: string;
  kind: MemoryKind;
  scopeType: MemoryScopeType;
  sourceType: MemorySourceType | null;
  policyFlags: MemoryPolicyFlag[];
  classifications: MemoryItemClassifications;
  confidenceBand?: MemoryConfidenceBand | null;
}): MemoryItemScores {
  const injectionRisk = computeInjectionRisk(
    params.policyFlags,
    params.classifications,
  );
  const sensitivityRisk = computeSensitivityRisk(
    params.classifications,
    params.policyFlags,
  );
  const provenanceTrustScore = computeProvenanceTrustScore(
    params.sourceType,
    params.classifications,
    params.policyFlags,
  );
  const provenanceRisk = 100 - provenanceTrustScore;
  const exfiltrationRisk = 0;
  const toolActionRisk = 0;
  const scopeRisk =
    params.scopeType === "organization"
      ? 30
      : params.scopeType === "team"
        ? 15
        : 0;

  const safetyScore = computeSafetyScore({
    sensitivityRisk,
    injectionRisk,
    exfiltrationRisk,
    toolActionRisk,
    scopeRisk,
    provenanceRisk,
  });

  const salienceScore = computeSalienceScore(
    params.kind,
    params.classifications,
  );
  const confidenceScore = computeConfidenceScore(params.confidenceBand);

  return {
    safetyScore,
    confidenceScore,
    salienceScore,
    sensitivityRisk,
    injectionRisk,
    provenanceTrustScore,
    exfiltrationRisk,
    toolActionRisk,
    scopeRisk,
  };
}

export function determinePolicyDecision(params: {
  scores: MemoryItemScores;
  classifications: MemoryItemClassifications;
  kind: MemoryKind;
  scopeType: MemoryScopeType;
}): PolicyDecision {
  if (params.classifications.secretDetected) return "block";
  if (params.scores.injectionRisk >= 70) return "quarantine";
  if (
    params.scores.sensitivityRisk >= 70 &&
    !params.classifications.userExplicitlyRequestedMemory
  )
    return "review_required";
  if (params.scopeType !== "user" && params.scores.provenanceTrustScore < 80)
    return "review_required";
  if (params.kind === "instruction") return "quarantine";
  if (params.scores.safetyScore >= 80) return "allow";
  return "review_required";
}

export function getSafetyScoreBand(score: number): SafetyScoreBand {
  if (score >= 90) return "LOW_RISK";
  if (score >= 70) return "PROBABLY_SAFE";
  if (score >= 40) return "NEEDS_REVIEW";
  if (score >= 10) return "HIGH_RISK";
  return "BLOCKED";
}

export function getSafetyScoreBucketLabel(score: number): string {
  if (score >= 90) return "90-100";
  if (score >= 70) return "70-89";
  if (score >= 40) return "40-69";
  if (score >= 10) return "10-39";
  return "0-9";
}

// ============================================================================
// Internal helpers
// ============================================================================

function computeInjectionRisk(
  policyFlags: MemoryPolicyFlag[],
  classifications: MemoryItemClassifications,
): number {
  if (policyFlags.includes("instruction_like_high")) return 90;
  if (policyFlags.includes("instruction_like_medium")) return 55;
  if (policyFlags.includes("instruction_like")) return 40;
  if (classifications.instructionLike) return 40;
  return 5;
}

function computeSensitivityRisk(
  classifications: MemoryItemClassifications,
  _policyFlags: MemoryPolicyFlag[],
): number {
  if (classifications.secretDetected) return 95;

  const highRiskCategories = [
    "health",
    "financial",
    "legal",
    "ssn",
    "government_id",
    "financial_account",
  ];
  const mediumRiskCategories = ["credit_card", "minors"];

  let risk = 5;

  if (
    classifications.piiCategories.some((c) => highRiskCategories.includes(c))
  ) {
    risk = Math.max(risk, 75);
  }
  if (
    classifications.piiCategories.some((c) => mediumRiskCategories.includes(c))
  ) {
    risk = Math.max(risk, 50);
  }
  if (classifications.piiCategories.length > 0 && risk === 5) {
    risk = 30;
  }

  return risk;
}

function computeProvenanceTrustScore(
  sourceType: MemorySourceType | null,
  classifications: MemoryItemClassifications,
  policyFlags: MemoryPolicyFlag[],
): number {
  let trust: number;

  switch (sourceType) {
    case "manual":
      trust = 85;
      break;
    case "chat":
      trust = 80;
      break;
    case "api":
      trust = 70;
      break;
    case "mcp_tool":
      trust = 60;
      break;
    case "import":
      trust = 50;
      break;
    case "system":
      trust = 40;
      break;
    default:
      trust = 80;
  }

  if (classifications.derivedFromExternalContext) {
    trust = Math.min(trust, 25);
  }
  if (policyFlags.includes("external_context")) {
    trust = Math.min(trust, 20);
  }

  return trust;
}

function computeSalienceScore(
  kind: MemoryKind,
  classifications: MemoryItemClassifications,
): number {
  let salience: number;

  switch (kind) {
    case "preference":
      salience = 85;
      break;
    case "profile_fact":
      salience = 75;
      break;
    case "instruction":
      salience = 60;
      break;
    case "team_convention":
      salience = 70;
      break;
    case "org_fact":
      salience = 70;
      break;
    case "episodic_summary":
      salience = 50;
      break;
    case "tool_usage_preference":
      salience = 65;
      break;
    case "temporary_context":
      salience = 30;
      break;
    default:
      salience = 60;
  }

  if (classifications.userExplicitlyRequestedMemory) {
    salience = Math.max(salience, 90);
  }

  return salience;
}

function computeConfidenceScore(
  confidenceBand: MemoryConfidenceBand | null | undefined,
): number {
  switch (confidenceBand) {
    case "high":
      return 85;
    case "medium":
      return 60;
    case "low":
      return 35;
    default:
      return 50;
  }
}

function computeSafetyScore(params: {
  sensitivityRisk: number;
  injectionRisk: number;
  exfiltrationRisk: number;
  toolActionRisk: number;
  scopeRisk: number;
  provenanceRisk: number;
}): number {
  const maxRisk = Math.max(
    params.sensitivityRisk,
    params.injectionRisk,
    params.exfiltrationRisk,
    params.toolActionRisk,
    params.scopeRisk,
    params.provenanceRisk,
  );
  return Math.max(0, 100 - maxRisk);
}
