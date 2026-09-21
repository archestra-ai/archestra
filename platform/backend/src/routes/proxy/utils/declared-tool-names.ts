import {
  type DeclaredToolSpelling,
  declaredToolEntries,
} from "@/openappa/wire";

/**
 * Every tool a caller declared, as it spelled it, read from the request body
 * itself rather than from an adapter's parsed view of it.
 *
 * The proxy decides which of the model's tool calls count as available from
 * the names the caller declared. Sourcing that from
 * `LLMRequestAdapter.getTools()` is lossy by design: that method exists to feed
 * persistence, so every adapter keeps only the schema-carrying function tools
 * it can describe and drops the rest — Anthropic's `bash`/`text_editor`
 * built-ins, OpenAI chat `custom` tools, every non-function tool on the
 * Responses surface. The caller executes those itself, so dropping them refuses
 * calls it explicitly asked for, and the refusal tells the model to stop
 * trying.
 *
 * Reading the body keeps that correct for every provider at once, including
 * ones added later: there is no per-adapter method to forget to implement, so a
 * new adapter cannot silently reintroduce the refusal. Only the container and
 * item shapes differ between providers, and `declaredToolEntries` enumerates
 * them: it descends into Codex namespace members, each reported with the
 * namespace it sits in, and reads the Responses `additional_tools`, both the
 * top-level container and the input items, and the tools a client-run tool
 * search loaded (`tool_search_output` input items). A namespace's own name is
 * not a tool anyone calls, so it is no longer reported.
 *
 * This is deliberately permissive about *which* names it counts. A name here
 * only ever makes a tool reachable, and everything it admits is something the
 * caller put in its own request — the tools the guardrail exists to refuse are
 * the ones absent from that request, and they stay absent.
 *
 * An entry with no usable name is left out: nothing a model can call would
 * match it, and it would make an otherwise-empty set look populated — which
 * turns the check on and refuses everything else the caller declared.
 */
export function collectDeclaredToolNames(
  request: unknown,
): DeclaredToolSpelling[] {
  return declaredToolEntries(request).flatMap(({ name, namespace }) =>
    name ? [{ name, ...(namespace ? { namespace } : {}) }] : [],
  );
}
