export const RUNTIME_TOOL_PROOF_ARGUMENT = "runtime_proof";

/** The provider sees the original arguments, never reusable host credentials. */
export function stripRuntimeToolProofs(request: unknown): void {
  const visited = new WeakSet<object>();
  function strip(value: unknown, depth: number): boolean {
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    if (depth > 64) throw new Error("Runtime tool history is too deep");
    visited.add(value);
    const record = value as Record<string, unknown>;
    let changed = Object.hasOwn(record, RUNTIME_TOOL_PROOF_ARGUMENT);
    delete record[RUNTIME_TOOL_PROOF_ARGUMENT];
    for (const [key, nested] of Object.entries(record)) {
      if (
        (key === "arguments" || key === "tool_args") &&
        typeof nested === "string"
      ) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(nested);
        } catch {
          // Custom tools may carry non-JSON arguments; preserve them verbatim.
          continue;
        }
        if (strip(parsed, depth + 1)) {
          record[key] = JSON.stringify(parsed);
          changed = true;
        }
      } else {
        // Do not short-circuit: siblings may independently contain a proof.
        changed = strip(nested, depth + 1) || changed;
      }
    }
    return changed;
  }
  strip(request, 0);
}
