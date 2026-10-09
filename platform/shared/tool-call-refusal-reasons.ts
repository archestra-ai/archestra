// Client-visible reasons for tool calls the gateway or proxy refuses because
// the tool is not callable from the current request. The refusal template
// renders them verbatim.

export const TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON =
  "Tool is not enabled for this conversation";

/**
 * Distinct from {@link TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON}: the
 * tool is not disabled at all, it is simply absent from the request's tool list
 * because the agent advertises only the search_tools/run_tool dispatch pair
 * (`search_and_run_only` exposure, which Auto tool mode implies). The call is
 * still blocked — a direct call to an unlisted name is never executed — but the
 * tool remains reachable by retrying through run_tool, so blocked-call metrics
 * and logs must not file this under "disabled for conversation".
 */
export const TOOL_INVOCATION_NOT_DIRECTLY_CALLABLE_REASON =
  "Tool is not directly callable in this chat; it must be invoked through run_tool";
