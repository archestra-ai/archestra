import type { ZodError, ZodType, z } from "zod";
import { readRunToolArgs, resolveRunToolDispatch } from "./run-tool-target";

/**
 * The model's tool calls with the arguments a built-in (called directly or
 * through `run_tool`) would repair at execution already repaired, so policy,
 * approval, proof and execution all see one payload. A `run_tool` target is
 * unwrapped first, then reparsed, in the order `run_tool` applies them. Null
 * when no call needs it.
 */
export function repairStringifiedToolCallArgs<
  T extends { name: string; namespace?: string; arguments: string },
>(
  toolCalls: readonly T[],
  params: {
    canonicalize: (name: string, namespace?: string) => string;
    argsSchemaOf: (toolName: string) => ZodType | undefined;
    /** `run_tool`'s envelope repair; returns `args` itself when nothing fired. */
    unwrapEnvelopes: (
      toolName: string,
      args: Record<string, unknown>,
    ) => Record<string, unknown>;
  },
): T[] | null {
  const repairArgs = (toolName: string, args: Record<string, unknown>) => {
    const parsed = params.argsSchemaOf(toolName)?.safeParse(args);
    return parsed && !parsed.success
      ? reparseStringifiedObjectArgs(args, parsed.error)
      : null;
  };
  let changed = false;
  const repaired = toolCalls.map((call) => {
    const args = readRunToolArgs(call.arguments);
    if (!args) return call;
    const toolName = params.canonicalize(call.name, call.namespace);
    const dispatch = resolveRunToolDispatch({ toolName, args });
    let repairedArgs: Record<string, unknown> | null;
    if (dispatch.kind === "target") {
      const targetArgs = readRunToolArgs(args.tool_args);
      const unwrapped =
        targetArgs && params.unwrapEnvelopes(dispatch.toolName, targetArgs);
      const target = unwrapped
        ? (repairArgs(dispatch.toolName, unwrapped) ??
          (unwrapped === targetArgs ? null : unwrapped))
        : null;
      repairedArgs = target && {
        ...args,
        tool_args:
          typeof args.tool_args === "string" ? JSON.stringify(target) : target,
      };
    } else {
      repairedArgs = repairArgs(toolName, args);
    }
    if (!repairedArgs) return call;
    changed = true;
    return { ...call, arguments: JSON.stringify(repairedArgs) };
  });
  return changed ? repaired : null;
}

/**
 * Reparses exactly the keys the validation error names, and only into the
 * container the schema expects there, so a legitimately-string parameter that
 * happens to hold JSON is never rewritten. Null when nothing was reparsed.
 */
export function reparseStringifiedObjectArgs(
  args: Record<string, unknown> | undefined,
  error: ZodError,
): Record<string, unknown> | null {
  if (!args) return null;
  let repaired: Record<string, unknown> | null = null;
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string") continue;
    const value = (repaired ?? args)[key];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      const parsedValue: unknown = JSON.parse(text);
      if (typeof parsedValue !== "object" || parsedValue === null) continue;
      if (!expectsParsedValue(issue, parsedValue)) continue;
      repaired = { ...(repaired ?? args), [key]: parsedValue };
    } catch {
      // Not JSON after all — leave the value (and the original error) as is.
    }
  }
  return repaired;
}

function expectsParsedValue(issue: z.core.$ZodIssue, value: object): boolean {
  switch (issue.code) {
    case "invalid_type":
      return Array.isArray(value)
        ? issue.expected === "array" || issue.expected === "tuple"
        : issue.expected === "object" || issue.expected === "record";
    case "invalid_union":
      return issue.errors.some((branch) =>
        branch.some((inner) => expectsParsedValue(inner, value)),
      );
    default:
      return false;
  }
}
