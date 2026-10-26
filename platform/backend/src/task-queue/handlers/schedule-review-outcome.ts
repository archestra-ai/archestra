import type { UIMessage } from "ai";

/**
 * A closed review without a delivery channel is a failed unattended run, even
 * when the model finishes normally after explaining the block. Inspect only
 * the platform remedy tool's result, never assistant prose or arbitrary tool
 * output. Ordinary guardrail notices may be recovered and are not failures.
 */
export function hasUnavailableScheduleReview(
  message: UIMessage,
  getToolShortName: (name: string) => string | null,
): boolean {
  return message.parts.some((part) => {
    if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) {
      return false;
    }
    if (!("state" in part) || part.state !== "output-available") return false;
    const name =
      part.type === "dynamic-tool"
        ? part.toolName
        : part.type.slice("tool-".length);
    let shortName = getToolShortName(name);
    let input = asRecord(part.input);
    // Auto tool mode invokes the same platform tool through run_tool.
    if (shortName === "run_tool" && typeof input?.tool_name === "string") {
      shortName = getToolShortName(input.tool_name);
      input = asRecord(input.tool_args);
    }
    if (shortName !== "execute_remedy_plan") return false;

    let output: unknown = part.output;
    const wrapper = asRecord(output);
    if (wrapper && typeof wrapper.content === "string")
      output = wrapper.content;
    if (typeof output === "string") {
      try {
        output = JSON.parse(output);
      } catch {
        return false;
      }
    }
    const result = asRecord(output);
    return (
      result?.ok === false &&
      result.outcome === "review_unavailable" &&
      typeof result.offer_id === "string" &&
      result.offer_id === input?.offer_id
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
