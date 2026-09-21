import {
  type ArchestraToolShortName,
  PROXY_STAMPED_TOOL_ARGUMENTS,
} from "@archestra/shared";

/**
 * Returns tool call input without proxy transport arguments such as signed
 * remedy offers and JWS envelopes. Returns `input` unchanged when no transport
 * arguments exist.
 */
export function withoutProxyTransportArguments<T>({
  shortName,
  input,
}: {
  shortName: ArchestraToolShortName | null;
  input: T;
}): T {
  const hidden = shortName ? PROXY_TRANSPORT_ARGUMENTS[shortName] : undefined;
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
