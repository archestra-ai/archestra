import OpenappaExternalConsultModel from "@/models/openappa-external-consult";
import OpenAppaOperationModel from "@/models/openappa-operation";
import OpenAppaYellModel from "@/models/openappa-yell";
import {
  type TunerCandidate,
  type TunerCandidateScan,
  type TunerCandidateSource,
  type TunerEvidenceRef,
  type TunerSeverity,
  tunerFingerprint,
} from "@/types/tuner";

/**
 * Recurring OpenAPPA issues of one organization over the last
 * `WINDOW_DAYS` days, each with a fingerprint that stays the same while the
 * issue does.
 */
export async function collectAppaCandidates(params: {
  organizationId: string;
  now: Date;
}): Promise<TunerCandidateScan> {
  const window = {
    organizationId: params.organizationId,
    since: new Date(params.now.getTime() - WINDOW_DAYS * DAY_MS),
    until: params.now,
  };
  const scan = {
    ...window,
    limit: TOOL_SCAN_LIMIT,
    evidenceLimit: EVIDENCE_LIMIT,
  };
  const [
    { canonicalOpenappaTool },
    platformHitl,
    platformDenied,
    stock,
    waivers,
    agentYells,
  ] = await Promise.all([
    import("@archestra/openappa-rs"),
    OpenappaExternalConsultModel.hitlRulingsByTool(scan),
    OpenAppaOperationModel.deniedCallsByTool(scan),
    OpenappaExternalConsultModel.stockApprovalsByTool(scan),
    // An unresolved yell stays a candidate however old it is; otherwise its
    // suggestion would be resolved while the yell is still open.
    OpenAppaYellModel.unresolvedWaiversByTool({ ...scan, since: new Date(0) }),
    OpenAppaYellModel.unresolvedAgentYellsByCaller({
      ...scan,
      since: new Date(0),
    }),
  ]);
  const complete = [
    platformHitl,
    platformDenied,
    stock,
    waivers,
    agentYells,
  ].every((rows) => rows.length < TOOL_SCAN_LIMIT);
  // Operations name a tool as the platform does; consults and rules name it
  // as the policy does. Candidates use the policy's name.
  const byPolicyName = <T extends { tool: string }>(row: T): T => ({
    ...row,
    tool: canonicalOpenappaTool(row.tool) ?? row.tool,
  });
  const hitl = platformHitl.map(byPolicyName);
  const denied = platformDenied.map(byPolicyName);

  const candidates = [
    ...top(
      hitl
        .filter(
          (row) =>
            row.approved >= RULES.hitlApprovals.threshold &&
            row.denied === 0 &&
            row.unreadable === 0,
        )
        .map((row) =>
          candidate({
            source: "appa_hitl_approvals",
            rule: RULES.hitlApprovals,
            count: row.approved,
            key: row.tool,
            title: `Human reviewers always approve ${row.tool}`,
            detail: `Human reviewers approved calls to ${row.tool} at least ${row.approved} times and denied none, across ${sessionsText(row.sessions)}, ${spanText(row)}. The policy may ask for review where none is needed.`,
            evidence: consultRefs(row.approvedIds),
          }),
        ),
    ),
    ...top(
      hitl
        .filter((row) => row.denied >= RULES.hitlDenials.threshold)
        .map((row) =>
          candidate({
            source: "appa_hitl_denials",
            rule: RULES.hitlDenials,
            count: row.denied,
            key: row.tool,
            title: `Human reviewers often deny ${row.tool}`,
            detail: `Human reviewers denied calls to ${row.tool} at least ${row.denied} times and approved at least ${row.approved}, across ${sessionsText(row.sessions)}, ${spanText(row)}. Agents keep attempting calls a person refuses.`,
            evidence: consultRefs(row.deniedIds),
          }),
        ),
    ),
    ...top(
      denied
        .filter(
          (row) =>
            row.denials >= RULES.repeatedDenials.threshold &&
            row.sessions >= MIN_DENIAL_SESSIONS,
        )
        .map((row) =>
          candidate({
            source: "appa_repeated_denials",
            rule: RULES.repeatedDenials,
            count: row.denials,
            key: row.tool,
            title: `The policy repeatedly denies ${row.tool}`,
            detail: `The policy denied at least ${row.denials} calls to ${row.tool} across ${sessionsText(row.sessions)}, ${spanText(row)}.`,
            evidence: row.recent.map(
              (ref): TunerEvidenceRef => ({
                type: "openappa_operation",
                ...ref,
              }),
            ),
          }),
        ),
    ),
    ...top(
      waivers.map((row) =>
        candidate({
          source: "appa_unresolved_yell",
          rule: RULES.waiverYells,
          count: row.yells,
          key: row.tool,
          title: `Unresolved waiver yells for ${row.tool}`,
          detail: `${row.yells} unresolved yells (${row.kinds.join(", ")}) record at least ${row.calls} calls to ${row.tool} let through under the Break the glass settings, across ${sessionsText(row.sessions)}, raised ${spanText(row)}.`,
          evidence: yellRefs(row.recentIds),
        }),
      ),
    ),
    ...top(
      agentYells.map((row) =>
        candidate({
          source: "appa_unresolved_yell",
          rule: AGENT_YELL_RULE,
          count: row.yells,
          key: `caller:${row.callerId}`,
          title: `Unresolved agent yells from ${row.callerId}`,
          detail: `Agents running as ${row.callerId} raised ${row.yells} yells that are still unresolved, across ${sessionsText(row.sessions)}, raised ${spanText(row)}.`,
          evidence: yellRefs(row.recentIds),
        }),
      ),
    ),
    ...top(
      stock
        .filter((row) => row.approvals >= RULES.observeAutoApprovals.threshold)
        .map((row) =>
          candidate({
            source: "appa_observe_auto_approvals",
            rule: RULES.observeAutoApprovals,
            count: row.approvals,
            key: row.tool,
            title: `The policy auto-approves ${row.tool}`,
            detail: `The stock approve authority approved at least ${row.approvals} calls to ${row.tool} without asking anyone, across ${sessionsText(row.sessions)}, ${spanText(row)}. The rule lets every such call through, so it may be ready to allow the tool outright or to ask a person instead.`,
            evidence: consultRefs(row.recentIds),
          }),
        ),
    ),
  ];
  return { candidates, complete };
}

// =============================================================================
// Internal helpers
// =============================================================================

type Rule = { threshold: number; severity: TunerSeverity };
type Counted = { candidate: TunerCandidate; count: number };

const WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows read per source; a scan that fills it is incomplete. */
const TOOL_SCAN_LIMIT = 500;
const EVIDENCE_LIMIT = 5;
/** A count this many times its threshold raises the severity one level. */
const SEVERITY_BUMP_FACTOR = 4;
const MIN_DENIAL_SESSIONS = 2;

const RULES = {
  hitlApprovals: { threshold: 5, severity: "info" },
  hitlDenials: { threshold: 3, severity: "warn" },
  repeatedDenials: { threshold: 5, severity: "warn" },
  observeAutoApprovals: { threshold: 5, severity: "info" },
  waiverYells: { threshold: 1, severity: "info" },
} as const satisfies Record<string, Rule>;
const AGENT_YELL_RULE: Rule = { threshold: 1, severity: "warn" };

function candidate(params: {
  source: TunerCandidateSource;
  rule: Rule;
  count: number;
  /** What the issue is about: a tool, or the caller agent yells came from. */
  key: string;
  title: string;
  detail: string;
  evidence: TunerEvidenceRef[];
}): Counted {
  return {
    count: params.count,
    candidate: {
      fingerprint: tunerFingerprint(params.source, params.key),
      source: params.source,
      severity: severityFor(params.rule, params.count),
      title: params.title,
      detail: params.detail,
      evidence: params.evidence,
    },
  };
}

function top(counted: Counted[]): TunerCandidate[] {
  return [...counted]
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.candidate);
}

function severityFor(rule: Rule, count: number): TunerSeverity {
  if (count < rule.threshold * SEVERITY_BUMP_FACTOR) return rule.severity;
  switch (rule.severity) {
    case "info":
      return "warn";
    case "warn":
    case "critical":
      return "critical";
  }
}

function consultRefs(ids: string[]): TunerEvidenceRef[] {
  return ids.map((id) => ({ type: "openappa_consult", id }));
}

function yellRefs(ids: string[]): TunerEvidenceRef[] {
  return ids.map((id) => ({ type: "openappa_yell", id }));
}

function sessionsText(sessions: number): string {
  return sessions === 1 ? "1 session" : `${sessions} sessions`;
}

function spanText(row: { firstAt: Date; lastAt: Date }): string {
  return `between ${row.firstAt.toISOString()} and ${row.lastAt.toISOString()} (counts are lower bounds: records sealed from the database are not read)`;
}
