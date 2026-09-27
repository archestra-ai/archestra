import type { ChatOpenAppaPolicyTargetMetadata } from "@archestra/shared";
import {
  isOpenAppaTargetPromptKey,
  resolveOpenAppaLaunchPrompt,
} from "@/lib/openappa-chat-prompts";
import { useCoverageEntities } from "@/lib/openappa-coverage.query";

/**
 * The prompt a new OpenAPPA chat's launch link names by key. A target prompt
 * waits for the target to load (the same query the start-screen pills use)
 * and stays undefined when the target is gone.
 */
export function useOpenAppaLaunchPrompt({
  promptKey,
  target,
}: {
  promptKey: string | null;
  target: ChatOpenAppaPolicyTargetMetadata | undefined;
}): string | undefined {
  const needsTarget =
    !!promptKey && isOpenAppaTargetPromptKey(promptKey) && !!target;
  const entities = useCoverageEntities(
    {
      entityId: target?.id,
      type: target?.kind,
      limit: 1,
      offset: 0,
    },
    { enabled: needsTarget },
  );

  if (!promptKey) return undefined;
  if (!needsTarget) return resolveOpenAppaLaunchPrompt(promptKey);
  const entity = entities.isPlaceholderData
    ? undefined
    : entities.data?.data[0];
  if (!entity || entity.id !== target.id || entity.type !== target.kind)
    return undefined;
  return resolveOpenAppaLaunchPrompt(promptKey, {
    kind: target.kind,
    name: entity.name,
  });
}
