import {
  ARCHESTRA_TOOL_PREFIX,
  TOOL_CANCEL_AGENT_RUN_SHORT_NAME,
  TOOL_START_AGENT_RUN_SHORT_NAME,
  TOOL_STEER_AGENT_RUN_SHORT_NAME,
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
} from "@archestra/shared";
import { AgentRunModel, McpToolCallModel } from "@/models";
import type { SessionHandoffs } from "@/types";

/**
 * Where an LLM session's work moved between its client and Agent Runtime.
 *
 * A run records the session that started it, so either side finds the other:
 * the client's session lists the runs it started, and a run's own session
 * (its workload name) names its origin. The moves come from the origin
 * session's gateway calls to the run tools. `ownUserId` limits everything to
 * that user's runs and calls, as their own-logs view requires.
 */
export async function getSessionHandoffs(params: {
  organizationId: string;
  sessionId: string;
  ownUserId?: string;
}): Promise<SessionHandoffs> {
  const lookup = {
    organizationId: params.organizationId,
    llmSessionId: params.sessionId,
    actorUserId: params.ownUserId,
  };
  // Looked up apart, so a run that started many runs of its own still links
  // back to the session that started it.
  const [children, [handedFrom = null]] = await Promise.all([
    AgentRunModel.findHandoffsForLlmSession({
      ...lookup,
      side: "handedTo",
      limit: MAX_RUNS + 1,
    }),
    AgentRunModel.findHandoffsForLlmSession({
      ...lookup,
      side: "handedFrom",
      limit: 1,
    }),
  ]);
  const handedTo = children.slice(0, MAX_RUNS);

  // Each side's moves are in the session that made them: this session's for
  // the runs it started, the origin session's for the run it is.
  const [toMoves, fromMoves] = await Promise.all([
    movesOf({ ...params, originSessionId: params.sessionId, runs: handedTo }),
    handedFrom
      ? movesOf({
          ...params,
          originSessionId: handedFrom.originLlmSessionId,
          runs: [handedFrom],
        })
      : [],
  ]);
  return {
    handedTo,
    handedToTruncated: children.length > MAX_RUNS,
    handedFrom,
    moves: [...fromMoves, ...toMoves].sort(
      (a, b) => a.at.getTime() - b.at.getTime(),
    ),
  };
}

// ===

const MAX_RUNS = 20;

async function movesOf(params: {
  organizationId: string;
  ownUserId?: string;
  originSessionId: string;
  runs: { runId: string }[];
}): Promise<SessionHandoffs["moves"]> {
  if (params.runs.length === 0) return [];
  const calls = await McpToolCallModel.findArchestraCallsBySession({
    organizationId: params.organizationId,
    sessionId: params.originSessionId,
    toolNames: Object.keys(MOVE_TOOLS),
    userId: params.ownUserId,
    limit: MAX_CALLS,
  });
  return movesFromCalls({
    calls,
    runIds: new Set(params.runs.map((run) => run.runId)),
  });
}
const MAX_CALLS = 500;

type MoveKind = SessionHandoffs["moves"][number]["kind"];
type Call = Awaited<
  ReturnType<typeof McpToolCallModel.findArchestraCallsBySession>
>[number];

/** The run tools whose calls move work, and the move each makes. */
const MOVE_TOOLS: Record<string, "push" | "steer" | "pull"> = {
  [`${ARCHESTRA_TOOL_PREFIX}${TOOL_START_AGENT_RUN_SHORT_NAME}`]: "push",
  [`${ARCHESTRA_TOOL_PREFIX}${TOOL_STEER_AGENT_RUN_SHORT_NAME}`]: "steer",
  [`${ARCHESTRA_TOOL_PREFIX}${TOOL_CANCEL_AGENT_RUN_SHORT_NAME}`]: "pull",
  [`${ARCHESTRA_TOOL_PREFIX}${TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME}`]:
    "pull",
};

/**
 * One move per change of hands, per run: a steer while the run already holds
 * the work is a follow-up, and a second download after a pull is the same
 * pull.
 */
function movesFromCalls(params: {
  calls: Call[];
  runIds: Set<string>;
}): SessionHandoffs["moves"] {
  const remote = new Map<string, boolean>();
  const moves: SessionHandoffs["moves"] = [];
  for (const call of params.calls) {
    if (call.isError || !call.toolName) continue;
    const kind = MOVE_TOOLS[call.toolName];
    if (!kind) continue;
    const runId = runIdOf({ call, kind, runIds: params.runIds });
    if (!runId) continue;
    const toRemote = kind !== "pull";
    const holds = remote.get(runId);
    // Before its start call, a run holds nothing; the start always counts.
    if (holds === toRemote || (holds === undefined && kind !== "push")) {
      continue;
    }
    remote.set(runId, toRemote);
    moves.push({
      kind,
      runId,
      mcpToolCallId: call.id,
      at: call.createdAt,
    });
  }
  return moves;
}

/**
 * The run a call moved. A start names it in its result; the others take it
 * as `run_id`, and a file transfer only pulls when it downloads.
 */
function runIdOf(params: {
  call: Call;
  kind: MoveKind;
  runIds: Set<string>;
}): string | null {
  if (params.kind === "push") {
    const result = JSON.stringify(params.call.toolResult ?? null);
    for (const runId of params.runIds) {
      if (result.includes(runId)) return runId;
    }
    return null;
  }
  const args = argumentsOf(params.call.toolCall);
  if (!args) return null;
  const runId = typeof args.run_id === "string" ? args.run_id : null;
  if (!runId || !params.runIds.has(runId)) return null;
  if (
    params.call.toolName?.endsWith(TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME) &&
    args.direction !== "download"
  ) {
    return null;
  }
  return runId;
}

function argumentsOf(toolCall: unknown): Record<string, unknown> | null {
  if (!isRecord(toolCall) || !isRecord(toolCall.arguments)) return null;
  return toolCall.arguments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
