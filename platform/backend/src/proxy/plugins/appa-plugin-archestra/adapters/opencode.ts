import type { AppaSessionIdentity } from "@/openappa/wire";
import { ApiError } from "@/types";
import type { AppaClientAdapter, AskUserArguments } from "../types";
import { questionHeader, readHeader } from "../utils";

// OpenCode labels each question's tab with a header of at most 30 characters,
// the same bound ask_user declares for it.
const QUESTION_HEADER_MAX_LENGTH = 30;

/** Identifies OpenCode Chat Completions requests and normalizes local tool names. */
export class AppaOpenCodeAdapter implements AppaClientAdapter {
  readonly id = "opencode" as const;

  matches(context: Parameters<AppaClientAdapter["matches"]>[0]): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("opencode") ||
      originator.includes("opencode") ||
      readHeader(context.headers, "x-opencode-session") !== undefined
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp:") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    // `builtin:` is OpenCode's local-tool decoration. The embedded runtime
    // derives the bare spelling to host/archestra/<name> itself.
    return name.startsWith("builtin:") ? name.slice("builtin:".length) : name;
  }

  // OpenCode shows no MCP forms (its client declares no elicitation), but its
  // own `question` tool renders one.
  readonly nativeQuestion = {
    toolName: "question",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          question: args.question,
          header: questionHeader(args.header, QUESTION_HEADER_MAX_LENGTH),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multiple: args.allowMultiple === true,
        },
      ],
    }),
  };

  /**
   * Extracts OpenCode session identity from request headers: `X-Session-Id`,
   * `x-session-affinity`, `session-id` on Responses, or `x-opencode-session`.
   * The ID remains stable across resumes and compactions.
   * Contradictory session headers are rejected.
   */
  extractSessionIdentity(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }): AppaSessionIdentity | undefined {
    const claims = OPENCODE_SESSION_HEADERS.flatMap((header) => {
      const value = readHeader(context.headers, header);
      return value ? [value] : [];
    });
    const hosted = readHeader(context.headers, "x-opencode-session");
    const [normal] = claims;
    if (claims.some((claim) => claim !== normal)) {
      throw new ApiError(
        400,
        "OpenAPPA cannot bind contradictory OpenCode session headers",
      );
    }
    if (normal && hosted && normal !== hosted) {
      throw new ApiError(
        400,
        "OpenAPPA cannot bind contradictory OpenCode session headers",
      );
    }
    if (normal) {
      return { sessionId: normal, provenance: "opencode-session-header" };
    }
    return hosted
      ? { sessionId: hosted, provenance: "opencode-hosted-header" }
      : undefined;
  }
}

/** Request headers where OpenCode provides its session ID. */
const OPENCODE_SESSION_HEADERS = [
  "x-session-id",
  "x-session-affinity",
  "session-id",
] as const;
