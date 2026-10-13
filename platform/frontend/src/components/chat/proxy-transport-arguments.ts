import {
  type ArchestraToolShortName,
  isAgentTool,
  PROXY_STAMPED_TOOL_ARGUMENTS,
} from "@archestra/shared";

/**
 * Returns tool call input without proxy transport arguments such as signed
 * remedy offers and JWS envelopes. Returns `input` unchanged when no transport
 * arguments exist.
 */
export function withoutProxyTransportArguments<T>({
  toolName,
  shortName,
  input,
}: {
  toolName: string;
  shortName: ArchestraToolShortName | null;
  input: T;
}): T {
  const hidden = isAgentTool(toolName)
    ? AGENT_TOOL_STAMPED_ARGUMENTS
    : shortName
      ? PROXY_TRANSPORT_ARGUMENTS[shortName]
      : undefined;
  if (
    !hidden ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !hidden.some((key) => key in input)
  ) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !hidden.includes(key)),
  ) as T;
}

// === Internal helpers ===

const PROXY_TRANSPORT_ARGUMENTS: Partial<
  Record<ArchestraToolShortName, readonly string[]>
> = PROXY_STAMPED_TOOL_ARGUMENTS;

// OpenAPPA signs the delegation (`agent__*`) calls it releases.
const AGENT_TOOL_STAMPED_ARGUMENTS: readonly string[] = ["runtime_proof"];
