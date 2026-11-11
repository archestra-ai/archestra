/**
 * An auto router as a chat's model choice. It travels the setup menu's model
 * pool channel because, like a pool, it stands in for the key and model: the
 * server stores the normal tier as the chat's key and model and routes each
 * session to a fast, normal or smart model. The choice carries the router's
 * id behind a prefix no pool id has.
 */
const AUTO_MODEL_CHOICE_PREFIX = "auto:";

export function autoModelChoice(autoRouterId: string): string {
  return `${AUTO_MODEL_CHOICE_PREFIX}${autoRouterId}`;
}

/** The router a model pool choice stands for, or null when it is a pool or nothing. */
export function autoRouterIdOfChoice(
  choice: string | null | undefined,
): string | null {
  return choice?.startsWith(AUTO_MODEL_CHOICE_PREFIX)
    ? choice.slice(AUTO_MODEL_CHOICE_PREFIX.length)
    : null;
}
