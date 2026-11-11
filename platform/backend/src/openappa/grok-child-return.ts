// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ApiError } from "@/types/api";

/** Grok 1.0.70 hard-clears old tool results with these exact bytes. */
export const GROK_OMITTED_TOOL_RESULT = "[Tool result omitted — too old]";

/** Fixed host status: never includes the child's rejected bytes or schema diagnostic. */
export const GROK_REJECTED_CHILD_RETURN =
  "[appa] The subagent's return was rejected by its protected return contract. No child output was admitted. Report this failure and stop; do not retry or replace the child unless the user requests it.";

type GrokChildOutput = {
  id: string;
  status: "completed" | "running" | "failed" | "cancelled";
  value?: string;
};

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FOOTER = new RegExp(
  `\\n\\n<subagent_result>\\nsubagent_id: (${ID})\\nTo continue this subagent's conversation, use resume_from="\\1"\\.\\n</subagent_result>$`,
);
const LAUNCH = new RegExp(
  `^(?:Subagent started in background\\.|Subagent is still running[^\\n]*\\.)\\nsubagent_id: (${ID})(?:\\n|$)`,
);
const TASK = new RegExp(`^=== Task (${ID}) ===\\n`);
const MULTI_TASK = new RegExp(
  `^--- Task (${ID}) \\[(completed|running|failed|cancelled)\\] ---\\n`,
);
const NATIVE_ID = new RegExp(`^${ID}$`);

/** Native 1.0.70 envelopes contain no authority; the retained ChildEnd does. */
export function grokChildOutputs(text: string): GrokChildOutput[] | undefined {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw malformed();
  // The host renders admitted values this way. Replays still undergo the
  // same exact-value and native-child checks against retained ChildEnd rows.
  if (text.trimStart().startsWith("{")) {
    try {
      const value = JSON.parse(text);
      // Canonical host failure notices must be checked on every replay too.
      // Treat their text as a candidate, never as an already-trusted status.
      if (
        value?.status &&
        typeof value.status === "object" &&
        !Array.isArray(value.status) &&
        Object.values(value.status).some(
          (entry) => entry && typeof entry === "object" && "failed" in entry,
        )
      ) {
        return Object.entries(value.status).map(([id, entry]) => {
          if (!NATIVE_ID.test(id) || !entry || typeof entry !== "object")
            throw malformed();
          const record = entry as Record<string, unknown>;
          const output = record.failed ?? record.completed;
          if (typeof output !== "string" || Object.keys(record).length !== 1)
            throw malformed();
          return { id, status: "completed", value: output };
        });
      }
      if (
        value &&
        typeof value === "object" &&
        typeof value.subagent_id === "string" &&
        NATIVE_ID.test(value.subagent_id) &&
        typeof value.output === "string" &&
        Object.keys(value).every((key) =>
          ["subagent_id", "output"].includes(key),
        )
      )
        return [
          { id: value.subagent_id, status: "completed", value: value.output },
        ];
    } catch {
      // Other native envelope parsers below retain their fail-closed behavior.
    }
  }
  const launch = LAUNCH.exec(text);
  if (launch) return [{ id: launch[1], status: "running" }];
  if (text.startsWith("=== Multi-wait ")) return multiWaitOutputs(text);
  if (text.startsWith("=== Task ")) {
    const outputs: GrokChildOutput[] = [];
    let rest = text;
    while (rest) {
      const header = TASK.exec(rest);
      if (!header) throw malformed();
      // Each completion's closing frame must precede the next task. Embedded
      // or ambiguous frames fail closed rather than exposing unchecked bytes.
      const next = rest.indexOf("\n\n=== Task ", header[0].length);
      const chunk = next < 0 ? rest : rest.slice(0, next);
      const status = /^Status: (completed|running|failed|cancelled)$/m.exec(
        chunk,
      );
      if (!status) throw malformed();
      if (status[1] === "completed") {
        const delimiter = "\n\n=== Output ===\n";
        const split = chunk.indexOf(delimiter);
        if (split < 0) throw malformed();
        const completed = completedOutput(
          chunk.slice(split + delimiter.length),
        );
        if (!completed || completed.id !== header[1]) throw malformed();
        outputs.push(completed);
      } else {
        // A live child's partial output has not crossed ChildEnd.
        outputs.push({
          id: header[1],
          status: status[1] as "running" | "failed" | "cancelled",
        });
      }
      rest = next < 0 ? "" : rest.slice(next + 2);
    }
    return outputs;
  }
  const completed = completedOutput(text);
  return completed ? [completed] : undefined;
}

/** Batched retrieval has different framing from a single task's output. */
function multiWaitOutputs(text: string): GrokChildOutput[] {
  const opening = /^=== Multi-wait \((wait_all|wait_any)\) ===\n/.exec(text);
  const ending =
    /\n\n(\d+)\/(\d+) tasks completed \((wait_all|wait_any)\)$/.exec(text);
  if (!opening || !ending || opening[1] !== ending[3]) throw malformed();
  const outputs: GrokChildOutput[] = [];
  const seen = new Set<string>();
  let rest = text.slice(opening[0].length, ending.index);
  while (rest) {
    const header = MULTI_TASK.exec(rest);
    if (!header || seen.has(header[1])) throw malformed();
    seen.add(header[1]);
    const next = rest.indexOf("\n--- Task ", header[0].length);
    const chunk = rest.slice(header[0].length, next < 0 ? undefined : next);
    if (!/^Command: \[subagent:[^\]\n]+\][^\n]*\n/.test(chunk))
      throw malformed();
    if (header[2] === "completed") {
      const metadata =
        /^Command: \[subagent:[^\]\n]+\][^\n]*\nDuration: [^\n]+\nExit Code: -?\d+\n/.exec(
          chunk,
        );
      const completed =
        metadata && completedOutput(chunk.slice(metadata[0].length));
      if (!completed || completed.id !== header[1]) throw malformed();
      outputs.push(completed);
    } else {
      // A running or unsuccessful task has no admitted final value.
      outputs.push({
        id: header[1],
        status: header[2] as "running" | "failed" | "cancelled",
      });
    }
    rest = next < 0 ? "" : rest.slice(next + 1);
  }
  if (
    outputs.length === 0 ||
    Number(ending[2]) !== outputs.length ||
    Number(ending[1]) > outputs.length
  )
    throw malformed();
  return outputs;
}

function completedOutput(text: string): GrokChildOutput | undefined {
  const footer = FOOTER.exec(text);
  if (!footer) {
    if (text.includes("<subagent_result>") || text.includes("<subagent_meta>"))
      throw malformed();
    return undefined;
  }
  let value = text.slice(0, footer.index);
  const meta =
    /\n\n<subagent_meta>id=([^,\n]+), tool_calls=\d+, turns=\d+, duration_ms=\d+<\/subagent_meta>$/.exec(
      value,
    );
  if (meta) {
    if (meta[1] !== footer[1]) throw malformed();
    value = value.slice(0, meta.index);
  }
  return { id: footer[1], status: "completed", value };
}

function malformed(): ApiError {
  return new ApiError(
    409,
    "OpenAPPA withheld an invalid Grok subagent result.",
  );
}
