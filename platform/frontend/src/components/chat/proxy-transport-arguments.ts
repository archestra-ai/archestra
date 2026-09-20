import {
  type ArchestraToolShortName,
  PROXY_STAMPED_TOOL_ARGUMENTS,
} from "@archestra/shared";

/**
 * A tool call's input without the arguments the proxy stamps on for its own
 * bookkeeping (signed remedy offers and their JWS envelope). They are
 * signature bytes and retry records, meaningless to the person reading the
 * card. Returns `input` itself when there is nothing to hide.
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
