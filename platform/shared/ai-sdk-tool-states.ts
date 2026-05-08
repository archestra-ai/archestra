/**
 * AI SDK (v6.x) tool-part lifecycle states. The SDK does not export these as
 * a runtime value, so we centralize the literal set here for backend +
 * frontend reuse. Update if the `ai` package adds or removes states.
 */
export const TOOL_STATE_VALUES = [
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
] as const;

export type ToolState = (typeof TOOL_STATE_VALUES)[number];

export const TOOL_STATE = {
  INPUT_STREAMING: "input-streaming",
  INPUT_AVAILABLE: "input-available",
  APPROVAL_REQUESTED: "approval-requested",
  APPROVAL_RESPONDED: "approval-responded",
  OUTPUT_AVAILABLE: "output-available",
  OUTPUT_ERROR: "output-error",
  OUTPUT_DENIED: "output-denied",
} as const satisfies Record<string, ToolState>;
