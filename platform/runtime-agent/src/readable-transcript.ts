import { rename, writeFile } from "node:fs/promises";
import type { ModelMessage } from "ai";
import type { SessionPublisher } from "./session-publisher.js";

export async function writeReadableTranscript(params: {
  messages: ModelMessage[];
  runtimeDir: string;
  publisher?: SessionPublisher;
  sessionState?: "starting" | "working" | "idle" | "failed" | "stopped";
}): Promise<void> {
  const transcript = {
    version: 1,
    provider: "archestra-agent",
    entries: params.messages.flatMap(entriesForMessage),
    ...(params.sessionState
      ? { session: { state: params.sessionState, requests: [] } }
      : {}),
  } as const;
  if (params.publisher && params.sessionState) {
    await params.publisher.publish({
      ...transcript,
      entries: transcript.entries.map((entry, index) => ({
        ...entry,
        id: `entry-${index}`,
      })),
      session: { state: params.sessionState, requests: [] },
    });
    return;
  }
  const temporaryPath = `${params.runtimeDir}/readable-transcript.tmp.json`;
  await writeFile(temporaryPath, `${JSON.stringify(transcript)}\n`, "utf8");
  await rename(temporaryPath, `${params.runtimeDir}/readable-transcript.json`);
  if (params.sessionState)
    process.stdout.write(
      `\x1b]777;archestra-readable-transcript=base64\x07${Buffer.from(JSON.stringify(transcript)).toString("base64")}\x1b]777;archestra-readable-transcript=end\x07\n`,
    );
}

function entriesForMessage(message: ModelMessage): ReadableTranscriptEntry[] {
  if (message.role === "system") return [];
  if (message.role === "tool") {
    return message.content.flatMap((part) =>
      part.type === "tool-result" ? [toolResultEntry(part)] : [],
    );
  }
  if (typeof message.content === "string") {
    return message.content
      ? [
          {
            type: "message" as const,
            role: message.role,
            text: message.content,
          },
        ]
      : [];
  }

  const parts = message.content as Array<{
    type: string;
    text?: string;
    toolName?: string;
    input?: unknown;
    toolCallId?: string;
    output?: unknown;
  }>;
  return parts.flatMap((part) => {
    if (part.type === "text" && part.text) {
      return [
        {
          type: "message" as const,
          role: message.role,
          text: part.text,
        },
      ];
    }
    if (
      message.role === "assistant" &&
      part.type === "tool-call" &&
      part.toolName &&
      part.toolCallId
    ) {
      return [
        {
          type: "tool_call" as const,
          name: part.toolName,
          input: serialize(part.input),
          toolCallId: part.toolCallId,
        },
      ];
    }
    if (
      message.role === "assistant" &&
      part.type === "tool-result" &&
      part.toolName &&
      part.toolCallId
    ) {
      return [
        toolResultEntry({ toolCallId: part.toolCallId, output: part.output }),
      ];
    }
    return [];
  });
}

function toolResultEntry(part: {
  toolCallId: string;
  output?: unknown;
}): ReadableTranscriptEntry {
  return {
    type: "tool_result" as const,
    text: toolResultText(part.output),
    toolCallId: part.toolCallId,
    ...(isErrorOutput(part.output) ? { isError: true } : {}),
  };
}

function toolResultText(output: unknown): string {
  if (!output || typeof output !== "object" || !("type" in output)) {
    return "[Unrecognized tool result omitted]";
  }
  if (output.type === "text" || output.type === "error-text") {
    return "value" in output && typeof output.value === "string"
      ? output.value
      : "[Unrecognized tool result omitted]";
  }
  if (output.type === "json" || output.type === "error-json") {
    return "value" in output
      ? serialize(output.value)
      : "[Unrecognized tool result omitted]";
  }
  if (output.type === "execution-denied") {
    return "reason" in output && typeof output.reason === "string"
      ? output.reason
      : "Tool execution denied";
  }
  if (
    output.type !== "content" ||
    !("value" in output) ||
    !Array.isArray(output.value)
  ) {
    return "[Unrecognized tool result omitted]";
  }
  return (
    output.value
      .filter(
        (part) => part && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n") || "[Non-text result omitted]"
  );
}

function isErrorOutput(output: unknown): boolean {
  if (!output || typeof output !== "object" || !("type" in output))
    return false;
  return (
    output.type === "error-text" ||
    output.type === "error-json" ||
    output.type === "execution-denied"
  );
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

type ReadableTranscriptEntry =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | {
      type: "tool_call";
      name: string;
      input: string;
      toolCallId: string;
    }
  | {
      type: "tool_result";
      text: string;
      toolCallId: string;
      isError?: boolean;
    };
