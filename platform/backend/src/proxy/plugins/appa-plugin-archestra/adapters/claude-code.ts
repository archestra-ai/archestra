import { parseClaudeMetadataSessionId } from "@/routes/proxy/utils/headers/session-id";
import type { AppaClientAdapter, AppaMatchContext } from "../types";
import { readHeader } from "../utils";
import {
  asRecord,
  bindMintedChildTrajectory,
  localToolName,
  namesChildrenFromArguments,
  stringField,
} from "./trajectory";

const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const CHILD_PATHS = [
  { prefix: "tasks/", suffix: ".output" },
  { prefix: "subagents/agent-", suffix: ".jsonl" },
] as const;

/** Identifies Claude Code Messages requests and normalizes local tool names. */
export class AppaClaudeCodeAdapter implements AppaClientAdapter {
  readonly id = "claude-code" as const;
  readonly trajectoryPrefix = "cc";

  matches(context: AppaMatchContext): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("claude-code") ||
      userAgent.includes("claude-cli") ||
      readHeader(context.headers, "x-claude-code-session-id") !== undefined
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp/") || name.startsWith("mcp__")
      ? "gateway"
      : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name.startsWith("host/") ? name : `host/claude-code/${name}`;
  }

  isSpawnTool(name: string): boolean {
    return SPAWN_TOOLS.has(localToolName(name));
  }

  namesChildren(params: { rootId: string; arguments: unknown }): string[] {
    return namesChildrenFromArguments({
      rootId: params.rootId,
      arguments: params.arguments,
      pathPatterns: CHILD_PATHS,
    });
  }

  bindChildTrajectory(context: AppaMatchContext) {
    return bindMintedChildTrajectory({
      context,
      parentNativeId: parentSessionId(context),
      childNativeId: childAgentId(context),
    });
  }
}

function parentSessionId(context: AppaMatchContext): string | undefined {
  const header = readHeader(context.headers, "x-claude-code-session-id");
  if (header) return header;
  const userId = stringField(
    asRecord(asRecord(context.requestBody)?.metadata)?.user_id,
  );
  return userId ? (parseClaudeMetadataSessionId(userId) ?? userId) : undefined;
}

function childAgentId(context: AppaMatchContext): string | undefined {
  const header = readHeader(context.headers, "x-claude-code-agent-id");
  if (header) return header;
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  const fromMetadata = stringField(metadata?.agent_id);
  if (fromMetadata) return fromMetadata;
  const userId = stringField(metadata?.user_id);
  if (!userId?.trimStart().startsWith("{")) return undefined;
  try {
    return stringField(asRecord(JSON.parse(userId))?.agent_id);
  } catch {
    return undefined;
  }
}
