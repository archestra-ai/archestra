import type { CostHealth, CostHealthDimension } from "@/types";

// --- Inputs ---

interface LimitSummary {
  entityType: string;
  entityId: string;
}

interface RuleSummary {
  enabled: boolean;
}

interface AgentToolCount {
  agentId: string;
  toolCount: number;
}

export interface CostHealthInput {
  limits: LimitSummary[];
  rules: RuleSummary[];
  toonEnabled: boolean;
  totalAgents: number;
  agentToolCounts: AgentToolCount[];
  agentIds: string[];
}

// --- Constants ---

const DIMENSION_LINKS = {
  limits: "/llm/limits",
  optimizationRules: "/llm/optimization-rules",
  compression: "/settings/llm",
  toolHygiene: "/agents",
} as const;

const TOOL_COUNT_THRESHOLD = 20;

enum LimitsMessage {
  NoAgents = "No agents configured",
  FullCoverage = "Organization and per-agent spending limits configured",
  PartialCoverage = "Organization limit set, but only {covered} of {total} agent(s) have individual limits",
  OrgOnly = "Organization spending limit is set, but no agent-level limits exist. Any single agent could consume the entire budget.",
  AgentOnly = "{covered} of {total} agent(s) have spending limits",
  None = "No spending limits configured",
}

enum RulesMessage {
  Active = "{count} active optimization rule(s)",
  Inactive = "{count} rule(s) configured but none enabled",
  None = "No optimization rules configured",
}

enum CompressionMessage {
  Enabled = "TOON compression enabled org-wide",
  Disabled = "TOON compression is disabled",
}

enum ToolHygieneMessage {
  Healthy = "No agents with excessive tool counts",
  Excessive = "{count} agent(s) have {threshold}+ tools assigned",
}

// --- Public API ---

export function computeCostHealth(input: CostHealthInput): CostHealth {
  const dimensions = {
    limits: toDimension(scoreLimits(input), DIMENSION_LINKS.limits),
    optimizationRules: toDimension(scoreRules(input.rules), DIMENSION_LINKS.optimizationRules),
    compression: toDimension(scoreCompression(input.toonEnabled), DIMENSION_LINKS.compression),
    toolHygiene: toDimension(scoreToolHygiene(input.agentToolCounts), DIMENSION_LINKS.toolHygiene),
  };

  const scores = Object.values(dimensions).map((d) => d.score);
  const overall = Math.round(
    scores.reduce((sum, s) => sum + s, 0) / scores.length,
  );

  return { score: overall, dimensions };
}

// --- Internal ---

type ScoringResult = { score: number; message: string };

type Severity = CostHealthDimension["severity"];

function toSeverity(score: number): Severity {
  if (score >= 80) return "low";
  if (score >= 40) return "moderate";
  return "high";
}

function toDimension(result: ScoringResult, link: string): CostHealthDimension {
  return { ...result, severity: toSeverity(result.score), link };
}

function interpolate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (msg, [key, val]) => msg.replace(`{${key}}`, String(val)),
    template,
  );
}

function scoreLimits(input: CostHealthInput): ScoringResult {
  const { limits, totalAgents, agentIds } = input;

  if (totalAgents === 0) {
    return { score: 100, message: LimitsMessage.NoAgents };
  }

  const hasOrgLimit = limits.some((l) => l.entityType === "organization");
  const agentIdsWithLimits = new Set(
    limits.filter((l) => l.entityType === "agent").map((l) => l.entityId),
  );
  const covered = agentIds.filter((id) => agentIdsWithLimits.has(id)).length;

  if (hasOrgLimit && covered === totalAgents) {
    return { score: 100, message: LimitsMessage.FullCoverage };
  }

  if (hasOrgLimit && covered > 0) {
    const score = Math.max(50, Math.round((covered / totalAgents) * 100));
    return {
      score,
      message: interpolate(LimitsMessage.PartialCoverage, { covered, total: totalAgents }),
    };
  }

  if (hasOrgLimit) {
    return { score: 25, message: LimitsMessage.OrgOnly };
  }

  if (covered > 0) {
    return {
      score: Math.round((covered / totalAgents) * 100),
      message: interpolate(LimitsMessage.AgentOnly, { covered, total: totalAgents }),
    };
  }

  return { score: 0, message: LimitsMessage.None };
}

function scoreRules(rules: RuleSummary[]): ScoringResult {
  const enabledCount = rules.filter((r) => r.enabled).length;

  if (enabledCount > 0) {
    return { score: 100, message: interpolate(RulesMessage.Active, { count: enabledCount }) };
  }

  if (rules.length > 0) {
    return { score: 50, message: interpolate(RulesMessage.Inactive, { count: rules.length }) };
  }

  return { score: 0, message: RulesMessage.None };
}

function scoreCompression(toonEnabled: boolean): ScoringResult {
  return toonEnabled
    ? { score: 100, message: CompressionMessage.Enabled }
    : { score: 0, message: CompressionMessage.Disabled };
}

function scoreToolHygiene(agentToolCounts: AgentToolCount[]): ScoringResult {
  const excessiveCount = agentToolCounts.filter(
    (a) => a.toolCount >= TOOL_COUNT_THRESHOLD,
  ).length;

  if (excessiveCount === 0) {
    return { score: 100, message: ToolHygieneMessage.Healthy };
  }

  return {
    score: 0,
    message: interpolate(ToolHygieneMessage.Excessive, {
      count: excessiveCount,
      threshold: TOOL_COUNT_THRESHOLD,
    }),
  };
}
