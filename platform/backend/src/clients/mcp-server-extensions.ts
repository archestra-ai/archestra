import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface DirectServerSession {
  /** Raw `capabilities.extensions` from the initialize result. */
  serverExtensions: () => Record<string, unknown>;
}

/** Observe the initialize result before the SDK prunes unknown extensions. */
export function captureServerExtensions(
  transport: Transport,
): () => Record<string, unknown> {
  let extensions: Record<string, unknown> | undefined;
  let downstream: Transport["onmessage"];
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get: () => downstream,
    set: (handler: Transport["onmessage"]) => {
      downstream = handler
        ? (message, extra) => {
            if (extensions === undefined) {
              extensions = readInitializeExtensions(message);
            }
            handler(message, extra);
          }
        : handler;
    },
  });
  return () => extensions ?? {};
}

function readInitializeExtensions(
  message: unknown,
): Record<string, unknown> | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const result = (message as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return undefined;
  const { protocolVersion, capabilities } = result as {
    protocolVersion?: unknown;
    capabilities?: { extensions?: unknown };
  };
  if (typeof protocolVersion !== "string" || !capabilities) return undefined;
  const extensions = capabilities.extensions;
  return typeof extensions === "object" && extensions !== null
    ? (extensions as Record<string, unknown>)
    : {};
}
