import {
  type DeclaredToolSpelling,
  declaredToolEntries,
} from "@/openappa/wire";

/**
 * Collects every declared tool name and namespace directly from the request body.
 *
 * The proxy uses declared tool names to determine which model tool calls are
 * available. Extracting names directly from the raw request avoids dropping
 * non-function tools (such as Anthropic `bash`, OpenAI `custom` tools, or
 * special Responses tools) that schema-only adapters omit.
 *
 * Reading the raw request ensures consistent behavior across all providers.
 * `declaredToolEntries` extracts tools from standard containers, Codex namespaces,
 * `additional_tools`, and client `tool_search_output` items.
 *
 * Missing or nameless tool declarations are omitted.
 */
export function collectDeclaredToolNames(
  request: unknown,
): DeclaredToolSpelling[] {
  return declaredToolEntries(request).flatMap(({ name, namespace }) =>
    name ? [{ name, ...(namespace ? { namespace } : {}) }] : [],
  );
}
