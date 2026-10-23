import type { IncomingHttpHeaders } from "node:http";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { ApiError } from "@/types/api";
import { asRecord } from "@/utils/as-record";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AskUserArguments,
  NativeQuestionReading,
  NativeQuestionResult,
} from "../types";
import { readHeader } from "../utils";

/** Pi's extension supplies its durable session ID on each provider request. */
export class AppaPiAdapter implements AppaClientAdapter {
  readonly id = "pi";
  readonly trajectoryPrefix = "pi";

  readonly nativeQuestion = {
    toolName: "pi_ask_user",
    supportsMultiple: false,
    isAvailable: (headers: IncomingHttpHeaders) =>
      readHeader(headers, "x-archestra-native-question") === "pi_ask_user",
    fromAskUser: (args: AskUserArguments) => ({
      question: args.question,
      options: args.options,
    }),
    rulingFromResult: (
      result: NativeQuestionResult,
      asked: AskUserArguments,
    ): NativeQuestionReading => readPiAnswer(result, asked.question),
  };

  matches(context: AppaMatchContext): boolean {
    return (
      readHeader(context.headers, "x-archestra-agent-id") === "pi" ||
      readHeader(context.headers, "x-pi-session-id") !== undefined
    );
  }

  classifyToolName(name: string, namespace?: string): "gateway" | "local" {
    return name.startsWith("mcp__") || namespace?.startsWith("mcp__")
      ? "gateway"
      : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name;
  }

  extractSessionIdentity(context: AppaMatchContext): AppaSessionIdentity {
    const claims = Object.entries(context.headers)
      .filter(([name]) => name.toLowerCase() === "x-pi-session-id")
      .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
    const sessionId = claims[0];
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,512}$/.test(sessionId) ||
      claims.some((claim) => claim !== sessionId)
    ) {
      throw new ApiError(
        400,
        "Pi must send one valid session ID. Reload the connection extension and retry.",
      );
    }
    return { sessionId, provenance: "pi-session-header" };
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    return this.extractSessionIdentity(context).sessionId;
  }

  gatewayToolsHint(serverName: string): string {
    return `Run pi mcp login ${serverName}, then use /mcp to check the connection. The gateway tools must use direct exposure.`;
  }

  // Pi has no built-in delegated-agent protocol. Extension-specific spawns
  // must not inherit another client's authority or child identity rules.
  isSpawnTool(_name: string): boolean {
    return false;
  }

  spawnPromptField(): undefined {
    return undefined;
  }

  namesChildren(): string[] {
    return [];
  }

  bindChildTrajectory(): undefined {
    return undefined;
  }

  stripCarrierMetadata(): void {}
}

function readPiAnswer(
  result: NativeQuestionResult,
  question: string,
): NativeQuestionReading {
  if (result.isError) return "unavailable";
  let answer: Record<string, unknown> | undefined;
  try {
    answer = asRecord(JSON.parse(result.content));
  } catch {
    return "unrecognized";
  }
  if (!answer || answer.question !== question) return "unrecognized";
  if (answer.status === "cancelled") return "cancelled";
  if (answer.status === "unavailable") return "unavailable";
  if (answer.status !== "answered") return "unrecognized";
  if (answer.selection === "Approve") return "approve";
  if (answer.selection === "Deny") return "deny";
  return "unrecognized";
}
