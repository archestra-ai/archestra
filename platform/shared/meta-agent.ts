/**
 * The in-app assistant (the meta agent) drives the page the user has open
 * through tools the browser executes, not the backend: the backend declares
 * them to the model without an `execute`, the model's call streams to the
 * browser, and the browser answers with the tool output. Both sides key off
 * these names.
 */
export const META_AGENT_UI_TOOL_PREFIX = "ui__";

export const META_AGENT_UI_TOOL_NAMES = {
  GET_PAGE: `${META_AGENT_UI_TOOL_PREFIX}get_page`,
  NAVIGATE: `${META_AGENT_UI_TOOL_PREFIX}navigate`,
  CLICK: `${META_AGENT_UI_TOOL_PREFIX}click`,
  FILL: `${META_AGENT_UI_TOOL_PREFIX}fill`,
  PRESS_KEY: `${META_AGENT_UI_TOOL_PREFIX}press_key`,
} as const;

export type MetaAgentUiToolName =
  (typeof META_AGENT_UI_TOOL_NAMES)[keyof typeof META_AGENT_UI_TOOL_NAMES];

export function isMetaAgentUiToolName(
  name: string,
): name is MetaAgentUiToolName {
  return (Object.values(META_AGENT_UI_TOOL_NAMES) as string[]).includes(name);
}
