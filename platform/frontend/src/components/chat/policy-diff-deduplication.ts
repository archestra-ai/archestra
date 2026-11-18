import type { UIMessage } from "@ai-sdk/react";
import type { ArchestraToolShortName } from "@archestra/shared";
import { parsePolicyChange } from "./openappa-policy-change.utils";
import { getPolicyDiffRows } from "./policy-diff-rows";

export type PolicyDiffReference = {
  before: string;
  after: string;
  path: string;
  changes: string;
};

/** Only preceding previews in this assistant turn can replace a text diff. */
export function collectPolicyDiffReferences(
  messages: UIMessage[],
  getToolShortName: (name: string) => ArchestraToolShortName | null,
) {
  const result = new Map<string, Map<number, readonly PolicyDiffReference[]>>();
  let references: PolicyDiffReference[] = [];
  const targets = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      references = [];
      targets.clear();
      continue;
    }
    const byPart = new Map<number, readonly PolicyDiffReference[]>();
    result.set(message.id, byPart);
    for (const [index, part] of (message.parts ?? []).entries()) {
      if (part.type === "text") {
        if (references.length) byPart.set(index, references);
        continue;
      }
      if (!("toolCallId" in part)) continue;
      let name =
        part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
      if (getToolShortName(name) === "run_tool") {
        const input = part.input as { tool_name?: unknown } | undefined;
        if (typeof input?.tool_name === "string") name = input.tool_name;
        else name = targets.get(part.toolCallId) ?? name;
      }
      targets.set(part.toolCallId, name);
      if (
        getToolShortName(name) !== "preview_guardrails_policy_change" ||
        part.state !== "output-available"
      )
        continue;
      const change = parsePolicyChange(part.output);
      if (!change || typeof change.diff !== "string") continue;
      const before = change.before.replace(/\r\n/g, "\n");
      const after = change.after.replace(/\r\n/g, "\n");
      const changes = getPolicyDiffRows({
        before,
        after,
        diff: change.diff.replace(/\r\n/g, "\n"),
      }).flatMap((row) =>
        row.kind === "add" || row.kind === "remove"
          ? [`${row.kind === "add" ? "+" : "-"}${row.text}`]
          : [],
      );
      if (!changes.length) continue;
      references = [
        ...references,
        {
          before,
          after,
          path: change.path ?? "organization.appa.toml",
          changes: JSON.stringify(changes),
        },
      ];
    }
  }
  return result;
}

/**
 * Display-only: remove complete diff fences whose edits AND surrounding text
 * match a rendered preview. Keep raw messages intact for copying and editing.
 */
export function omitRepeatedPolicyDiffs(
  text: string,
  references: readonly PolicyDiffReference[] = [],
): string {
  if (!references.length) return text;
  const lines = text.split("\n");
  let fence: {
    start: number;
    marker: string;
    length: number;
    diff: boolean;
  } | null = null;
  const removed = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(lines[index]);
    if (!match) continue;
    if (!fence) {
      if (match[1][0] === "`" && match[2].includes("`")) continue;
      fence = {
        start: index,
        marker: match[1][0],
        length: match[1].length,
        diff: /^(diff|patch)(?:\s|$)/i.test(match[2].trim()),
      };
    } else if (
      match[1][0] === fence.marker &&
      match[1].length >= fence.length &&
      match[2].trim() === ""
    ) {
      const body = lines
        .slice(fence.start + 1, index)
        .map((line) => line.replace(/\r$/, ""));
      if (
        fence.diff &&
        references.some((reference) => matchesPreview(body, reference))
      ) {
        for (let line = fence.start; line <= index; line++) removed.add(line);
      }
      fence = null;
    }
  }
  return removed.size
    ? lines.filter((_, index) => !removed.has(index)).join("\n")
    : text;
}

function matchesPreview(
  lines: string[],
  reference: PolicyDiffReference,
): boolean {
  const chunks: string[][] = [[]];
  const changes: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      chunks.push([]);
      inHunk = true;
      continue;
    }
    if (!inHunk && /^(---|\+\+\+) /.test(line)) {
      const path = line.slice(4).replace(/^[ab]\//, "");
      if (path !== reference.path && path !== "/dev/null") return false;
      continue;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line === "\\ No newline at end of file"
    )
      continue;
    chunks[chunks.length - 1].push(line);
    if (line.startsWith("+") || line.startsWith("-")) changes.push(line);
  }
  if (JSON.stringify(changes) !== reference.changes) return false;
  // Models may omit the unified diff's leading space on context lines.
  return [true, false].some((stripContextPrefix) =>
    chunks.every((chunk) => {
      const before: string[] = [];
      const after: string[] = [];
      for (const line of chunk) {
        if (line.startsWith("-")) before.push(line.slice(1));
        else if (line.startsWith("+")) after.push(line.slice(1));
        else {
          const context =
            stripContextPrefix && line.startsWith(" ") ? line.slice(1) : line;
          before.push(context);
          after.push(context);
        }
      }
      return (
        containsLines(reference.before, before) &&
        containsLines(reference.after, after)
      );
    }),
  );
}

function containsLines(content: string, lines: string[]): boolean {
  return (
    lines.length === 0 || `\n${content}\n`.includes(`\n${lines.join("\n")}\n`)
  );
}
