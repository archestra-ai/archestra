import type { UIMessage } from "@ai-sdk/react";
import type { ArchestraToolShortName } from "@archestra/shared";
import {
  getPolicyOutputPayload,
  parsePolicyChange,
} from "./openappa-policy-change.utils";
import { getPolicyDiffRows } from "./policy-diff-rows";

export type PolicyDiffReference = {
  before: string;
  after: string;
  path: string;
  changes: string;
};

const NO_REFERENCES: readonly PolicyDiffReference[] = [];
type CachedPreview = {
  payload: unknown;
  reference: PolicyDiffReference | null;
  preceding: readonly PolicyDiffReference[];
  references: readonly PolicyDiffReference[];
};

/** Reuse completed previews while text streams; retain only the current transcript. */
export class PolicyDiffReferenceCollector {
  private previews = new Map<string, CachedPreview>();

  collect(
    messages: UIMessage[],
    getToolShortName: (name: string) => ArchestraToolShortName | null,
  ) {
    const result = new Map<
      string,
      Map<number, readonly PolicyDiffReference[]>
    >();
    const previews = new Map<string, CachedPreview>();
    let references = NO_REFERENCES;
    const targets = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "assistant") {
        references = NO_REFERENCES;
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
        const key = `${message.id}:${index}`;
        const cached = this.previews.get(key);
        const payload = getPolicyOutputPayload(part.output);
        const reference =
          cached && samePolicyContent(cached.payload, payload)
            ? cached.reference
            : createReference(part.output);
        const next =
          cached?.reference === reference && cached.preceding === references
            ? cached.references
            : reference
              ? [...references, reference]
              : references;
        previews.set(key, {
          payload,
          reference,
          preceding: references,
          references: next,
        });
        references = next;
      }
    }
    this.previews = previews;
    return result;
  }
}

function samePolicyContent(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (
    !previous ||
    !next ||
    typeof previous !== "object" ||
    typeof next !== "object"
  )
    return false;
  // The SDK structured-clones the active message on each streamed chunk.
  // Compare the fields used by the diff, without serializing large policies.
  const a = previous as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  return ["delivery", "before", "after", "diff", "path"].every(
    (key) => a[key] === b[key],
  );
}

function createReference(output: unknown): PolicyDiffReference | null {
  const change = parsePolicyChange(output);
  if (!change || typeof change.diff !== "string") return null;
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
  return changes.length
    ? {
        before,
        after,
        path: change.path ?? "organization.appa.toml",
        changes: JSON.stringify(changes),
      }
    : null;
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
  const original = `\n${reference.before}\n`;
  const modified = `\n${reference.after}\n`;
  // Models may omit the unified diff's leading space on context lines.
  return [true, false].some((stripContextPrefix) => {
    let originalOffset = 0;
    let modifiedOffset = 0;
    return chunks.every((chunk) => {
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
      // Hunks follow document order. Resume each search at the previous
      // match, allowing overlapping context without rescanning the prefix.
      if (before.length) {
        const index = original.indexOf(
          `\n${before.join("\n")}\n`,
          originalOffset,
        );
        if (index < 0) return false;
        originalOffset = index + 1;
      }
      if (after.length) {
        const index = modified.indexOf(
          `\n${after.join("\n")}\n`,
          modifiedOffset,
        );
        if (index < 0) return false;
        modifiedOffset = index + 1;
      }
      return true;
    });
  });
}
