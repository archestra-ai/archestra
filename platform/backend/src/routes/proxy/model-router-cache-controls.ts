import { ApiError } from "@archestra/shared/types";

/** Reject extensions a translated provider would otherwise silently discard. */
export function assertModelRouterCacheControls(
  provider: string,
  value: unknown,
): void {
  if (
    provider !== "anthropic" &&
    provider !== "bedrock" &&
    provider !== "cohere" &&
    provider !== "gemini"
  )
    return;
  const body = value as Record<string, unknown>;
  const reject = (field: string): never => {
    throw new ApiError(
      400,
      `${field} is not supported when routing to ${provider}`,
    );
  };
  if (provider !== "gemini" && body.cachedContent !== undefined)
    reject("cachedContent");
  for (const field of [
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
  ]) {
    if (body[field] !== undefined) reject(field);
  }
  if (provider === "bedrock" && body.cache_control !== undefined)
    reject("Top-level cache_control");

  // Inspect protocol fields only: JSON tool schemas or user data can contain
  // identically named properties without specifying a cache boundary.
  const nodes: Record<string, unknown>[] = [body];
  for (const field of ["messages", "input", "tools"]) {
    const entries = body[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      nodes.push(entry);
      if (entry.function && typeof entry.function === "object")
        nodes.push(entry.function);
      const contentArrays = [entry.content];
      if (entry.type === "function_call_output")
        contentArrays.push(entry.output);
      for (const content of contentArrays) {
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part && typeof part === "object") nodes.push(part);
        }
      }
    }
  }
  for (const node of nodes) {
    if (
      (provider === "gemini" || provider === "cohere") &&
      node.cache_control !== undefined
    )
      reject("cache_control");
    if (node.prompt_cache_breakpoint !== undefined)
      reject("prompt_cache_breakpoint");
  }
}
