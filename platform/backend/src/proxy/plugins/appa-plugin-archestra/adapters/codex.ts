import type { AppaClientAdapter, AskUserArguments } from "../types";
import { readHeader } from "../utils";

/** Identifies Codex Responses requests and normalizes local tool names. */
export class AppaCodexAdapter implements AppaClientAdapter {
  readonly id = "codex" as const;
  readonly nativeQuestion = {
    toolName: "request_user_input",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          id: "archestra_question",
          header: questionHeader(args.header),
          question: args.question,
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
        },
      ],
    }),
  };

  matches(context: Parameters<AppaClientAdapter["matches"]>[0]): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("codex") ||
      originator.includes("codex") ||
      readHeader(context.headers, "x-codex-turn-metadata") !== undefined
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp:") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    // OpenAPPA's Archestra adapter derives a bare host spelling to its typed
    // host/archestra identity. Codex's function and builtin decorations are
    // client syntax, not part of that spelling.
    const stripped = name.startsWith("functions.")
      ? name.slice("functions.".length)
      : name;
    return stripped.startsWith("builtin:")
      ? stripped.slice("builtin:".length)
      : stripped;
  }
}

function questionHeader(header: unknown): string {
  const trimmed = typeof header === "string" ? header.trim() : "";
  return trimmed.length > 0 ? trimmed.slice(0, 12).trimEnd() : "Question";
}
