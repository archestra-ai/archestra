/** The auto router every organization starts with; others are `auto:<name>`. */
export const AUTO_ROUTER_NAME = "auto";
export const AUTO_ROUTER_NAME_PREFIX = `${AUTO_ROUTER_NAME}:`;

/**
 * How a model picker names an auto router: "Auto" for `auto`, and
 * "Auto · support" for `auto:support`.
 */
export function autoRouterLabel(name: string): string {
  return name.startsWith(AUTO_ROUTER_NAME_PREFIX)
    ? `Auto · ${name.slice(AUTO_ROUTER_NAME_PREFIX.length)}`
    : "Auto";
}

/** Whether a requested model name asks for an auto router. */
export function isAutoRouterName(model: string): boolean {
  return (
    model === AUTO_ROUTER_NAME || model.startsWith(AUTO_ROUTER_NAME_PREFIX)
  );
}
