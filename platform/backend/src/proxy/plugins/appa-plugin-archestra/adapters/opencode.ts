import type { AppaClientAdapter, AskUserArguments } from "../types";
import { readHeader } from "../utils";

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
          header: questionHeader(args.header),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multiple: args.allowMultiple === true,
        },
      ],
    }),
  };
}

// The model's arguments reach the proxy unvalidated, so a missing or blank
// header falls back to a generic label and an overlong one is cut to fit.
function questionHeader(header: unknown): string {
  const trimmed = typeof header === "string" ? header.trim() : "";
  return trimmed.length > 0
    ? trimmed.slice(0, QUESTION_HEADER_MAX_LENGTH).trimEnd()
    : "Question";
}
