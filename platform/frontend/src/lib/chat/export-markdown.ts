import type { UIMessage } from "@ai-sdk/react";

type ToolishPart = {
  type: string;
  toolName?: string;
  state?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type MarkdownExportOptions = {
  messages: UIMessage[];
  conversationId: string;
  title?: string | null;
  agentName?: string | null;
  exportedAt?: Date;
};

export function messagesToMarkdown(opts: MarkdownExportOptions): string {
  const exportedAt = opts.exportedAt ?? new Date();
  const heading = opts.title?.trim() || `Chat ${opts.conversationId}`;

  const out: string[] = [];
  out.push(`# ${heading}`);
  out.push("");
  out.push(`- Conversation: \`${opts.conversationId}\``);
  if (opts.agentName) out.push(`- Agent: ${opts.agentName}`);
  out.push(`- Exported: ${exportedAt.toISOString()}`);
  out.push(`- Messages: ${opts.messages.length}`);
  out.push("");

  for (const message of opts.messages) {
    out.push(`## ${message.role}`);
    out.push("");
    for (const part of message.parts ?? []) {
      renderPart(part, out);
    }
  }

  return `${out.join("\n").trimEnd()}\n`;
}

export function downloadConversationMarkdown(
  opts: MarkdownExportOptions,
): void {
  const body = messagesToMarkdown(opts);
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filenameFor(opts);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function renderPart(part: unknown, out: string[]): void {
  if (!isObject(part) || typeof part.type !== "string") return;

  const type = part.type;

  if (type === "text" && typeof part.text === "string") {
    out.push(part.text.trimEnd());
    out.push("");
    return;
  }

  if (type === "reasoning" && typeof part.text === "string") {
    out.push("> _reasoning_");
    for (const line of part.text.split("\n")) {
      out.push(`> ${line}`);
    }
    out.push("");
    return;
  }

  if (type === "file" && typeof part.url === "string") {
    const filename = typeof part.filename === "string" ? part.filename : "file";
    const mediaType =
      typeof part.mediaType === "string" ? ` (${part.mediaType})` : "";
    out.push(`📎 [${filename}](${part.url})${mediaType}`);
    out.push("");
    return;
  }

  if (isToolish(part)) {
    renderToolPart(part, out);
    return;
  }

  out.push(`<!-- unsupported part: ${type} -->`);
  out.push(jsonBlock(part));
}

function renderToolPart(part: ToolishPart, out: string[]): void {
  const toolName = part.toolName ?? part.type.replace(/^tool-/, "");
  const stateBits: string[] = [];
  if (part.state) stateBits.push(`state=\`${part.state}\``);
  if (part.toolCallId) stateBits.push(`id=\`${part.toolCallId}\``);
  const suffix = stateBits.length > 0 ? ` (${stateBits.join(", ")})` : "";

  out.push(`### Tool: \`${toolName}\`${suffix}`);
  out.push("");

  if (part.input !== undefined) {
    out.push("**Input:**");
    out.push(jsonBlock(part.input));
  }

  if (part.output !== undefined) {
    out.push("**Output:**");
    out.push(jsonBlock(part.output));
  }

  if (part.errorText) {
    out.push("**Error:**");
    out.push("```");
    out.push(part.errorText);
    out.push("```");
    out.push("");
  }
}

function jsonBlock(value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return ["```json", body ?? "null", "```", ""].join("\n");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isToolish(part: Record<string, unknown>): part is ToolishPart {
  return (
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

function filenameFor(opts: MarkdownExportOptions): string {
  const slug =
    (opts.title ?? "chat")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chat";
  const stamp = (opts.exportedAt ?? new Date())
    .toISOString()
    .replace(/[:.]/g, "-");
  return `${slug}-${opts.conversationId.slice(0, 8)}-${stamp}.md`;
}
