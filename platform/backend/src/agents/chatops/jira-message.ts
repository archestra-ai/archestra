/** Convert Jira's ADF or legacy wiki body without treating display names as identities. */
export function jiraMessageText(body: unknown, omitAccountId?: string): string {
  if (typeof body === "string") {
    if (!omitAccountId) return body;
    const escaped = escapeRegExp(omitAccountId);
    return body
      .replace(new RegExp(`\\[~(?:accountid:)?${escaped}\\]`, "g"), "")
      .trim();
  }
  return adfText(body, omitAccountId).trim();
}

export function jiraMentionsAccount(body: unknown, accountId: string): boolean {
  if (typeof body === "string") {
    return new RegExp(`\\[~(?:accountid:)?${escapeRegExp(accountId)}\\]`).test(
      body,
    );
  }
  if (!isRecord(body)) return false;
  if (
    body.type === "mention" &&
    isRecord(body.attrs) &&
    body.attrs.id === accountId
  )
    return true;
  return (
    Array.isArray(body.content) &&
    body.content.some((node) => jiraMentionsAccount(node, accountId))
  );
}

/** Plain text only: model output cannot inject ADF nodes or Jira mentions. */
export function jiraReplyDocument(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .slice(0, 30_000)
      .split(/\n\n+/)
      .map((paragraph) => ({
        type: "paragraph",
        content: paragraph
          .split("\n")
          .flatMap((line, index) => [
            ...(index > 0 ? [{ type: "hardBreak" }] : []),
            ...linkTextNodes(line),
          ]),
      })),
  };
}

export function parseJiraApprovalCommand(message: { text: string }): {
  approved: boolean;
  approvalId?: string;
} | null {
  const match = /^(approve|decline)(?:\s+([a-zA-Z0-9_-]{1,128}))?\s*$/i.exec(
    message.text.trim(),
  );
  if (!match) return null;
  return {
    approved: match[1].toLowerCase() === "approve",
    ...(match[2] && { approvalId: match[2] }),
  };
}

function adfText(value: unknown, omitAccountId?: string): string {
  if (!isRecord(value)) return "";
  if (value.type === "text")
    return typeof value.text === "string" ? value.text : "";
  if (value.type === "hardBreak") return "\n";
  if (value.type === "mention") {
    const attrs = isRecord(value.attrs) ? value.attrs : {};
    if (attrs.id === omitAccountId) return "";
    return typeof attrs.text === "string" ? attrs.text : "@participant";
  }
  const content = Array.isArray(value.content)
    ? value.content.map((node) => adfText(node, omitAccountId)).join("")
    : "";
  if (value.type === "listItem") return `${content.trimEnd()}\n`;
  return ["paragraph", "heading", "blockquote", "codeBlock"].includes(
    String(value.type),
  )
    ? `${content.trimEnd()}\n\n`
    : content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linkTextNodes(line: string): Array<{
  type: string;
  text: string;
  marks?: Array<{ type: string; attrs: { href: string } }>;
}> {
  const nodes: Array<{
    type: string;
    text: string;
    marks?: Array<{ type: string; attrs: { href: string } }>;
  }> = [];
  let offset = 0;
  for (const match of line.matchAll(/https?:\/\/[^\s<>]+/gi)) {
    const start = match.index;
    const text = match[0].replace(/[.,!?;:)\]]+$/, "");
    let href: string;
    try {
      const url = new URL(text);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue;
      href = url.href;
    } catch {
      continue;
    }
    if (start > offset)
      nodes.push({ type: "text", text: line.slice(offset, start) });
    nodes.push({
      type: "text",
      text,
      marks: [{ type: "link", attrs: { href } }],
    });
    offset = start + text.length;
  }
  if (offset < line.length)
    nodes.push({ type: "text", text: line.slice(offset) });
  return nodes;
}
