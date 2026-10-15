// white-label-ok: These are stable private wire header identifiers.
const TOKEN_HEADER = "x-archestra-client-runtime-token";
const ALIASES_HEADER = "x-archestra-mcp-aliases";

export type ClientRuntimeEvidence = {
  token: string;
  serverNames: readonly string[];
};
type HeaderCarrier = {
  headers: Record<string, unknown>;
  raw: { headers: Record<string, unknown>; rawHeaders: string[] };
};
const evidenceByRequest = new WeakMap<
  HeaderCarrier["raw"],
  ClientRuntimeEvidence
>();

/** Strip both Node representations before inference or catch-all forwarding. */
export function captureClientRuntimeEvidence(request: HeaderCarrier): void {
  let token: unknown;
  let aliases: unknown;
  for (const headers of new Set([request.headers, request.raw.headers])) {
    for (const key of Object.keys(headers)) {
      const name = key.toLowerCase();
      if (name === TOKEN_HEADER) {
        token ??= headers[key];
        delete headers[key];
      } else if (name === ALIASES_HEADER) {
        aliases ??= headers[key];
        delete headers[key];
      }
    }
  }
  for (let index = request.raw.rawHeaders.length - 2; index >= 0; index -= 2) {
    const name = request.raw.rawHeaders[index]?.toLowerCase();
    if (name === TOKEN_HEADER || name === ALIASES_HEADER)
      request.raw.rawHeaders.splice(index, 2);
  }
  if (
    typeof token !== "string" ||
    typeof aliases !== "string" ||
    aliases.length > 8_192
  )
    return;
  try {
    const names: unknown = JSON.parse(aliases);
    if (
      !Array.isArray(names) ||
      !names.length ||
      names.length > 64 ||
      names.some(
        (name) =>
          typeof name !== "string" ||
          !name.length ||
          name.length > 256 ||
          name.includes("\0") ||
          name.includes("\r") ||
          name.includes("\n"),
      )
    )
      return;
    evidenceByRequest.set(request.raw, {
      token,
      serverNames: [...new Set(names as string[])],
    });
  } catch {
    /* Malformed evidence never relaxes replay protection. */
  }
}

export function consumeClientRuntimeEvidence(
  request: HeaderCarrier,
): ClientRuntimeEvidence | undefined {
  if (!evidenceByRequest.has(request.raw))
    captureClientRuntimeEvidence(request);
  const evidence = evidenceByRequest.get(request.raw);
  evidenceByRequest.delete(request.raw);
  return evidence;
}
