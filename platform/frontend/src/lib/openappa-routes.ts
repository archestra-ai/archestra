import {
  type ChatOpenAppaPolicyTargetMetadata,
  ChatOpenAppaPolicyTargetMetadataSchema,
} from "@archestra/shared";
import type { OpenAppaLaunchPromptKey } from "@/lib/openappa-chat-prompts";

/** Query param naming the launch prompt a new OpenAPPA chat auto-sends. */
export const OPENAPPA_PROMPT_PARAM = "openappaPrompt";

/** Marks a chat launched from the OpenAPPA pages: its header links back. */
const OPENAPPA_LAUNCH_MARKER = { name: "from", value: "openappa" } as const;

type SearchParamsReader = { get(name: string): string | null };

/**
 * Link to a new OpenAPPA policy chat in /chat. The prompt `promptKey` names in
 * `openappa-chat-prompts.ts` is auto-sent as the first message. `target`
 * scopes the conversation to one policy target. The link is marked as an
 * OpenAPPA launch, so the chat header links back to the OpenAPPA pages.
 */
export function openAppaChatHref({
  promptKey,
  target,
}: {
  promptKey?: OpenAppaLaunchPromptKey;
  target?: ChatOpenAppaPolicyTargetMetadata;
} = {}): string {
  const params = new URLSearchParams({ openappa: "1" });
  if (target) {
    params.set("targetType", target.kind);
    params.set("targetId", target.id);
  }
  if (promptKey) params.set(OPENAPPA_PROMPT_PARAM, promptKey);
  params.set(OPENAPPA_LAUNCH_MARKER.name, OPENAPPA_LAUNCH_MARKER.value);
  return `/chat?${params.toString()}`;
}

/** Whether a chat URL was opened from the OpenAPPA pages. */
export function isOpenAppaLaunch(searchParams: SearchParamsReader): boolean {
  return (
    searchParams.get(OPENAPPA_LAUNCH_MARKER.name) ===
    OPENAPPA_LAUNCH_MARKER.value
  );
}

/**
 * The URL of a conversation just started from `searchParams`, keeping the
 * OpenAPPA launch marker so the conversation still links back.
 */
export function newConversationPath(
  id: string,
  searchParams: SearchParamsReader,
): string {
  return isOpenAppaLaunch(searchParams)
    ? `/chat/${id}?${OPENAPPA_LAUNCH_MARKER.name}=${OPENAPPA_LAUNCH_MARKER.value}`
    : `/chat/${id}`;
}

/** Resolves the `targetType`/`targetId` query params into a policy target. */
export function resolveOpenAppaPolicyTarget(
  searchParams: SearchParamsReader,
): ChatOpenAppaPolicyTargetMetadata | undefined {
  const target = ChatOpenAppaPolicyTargetMetadataSchema.safeParse({
    kind: searchParams.get("targetType"),
    id: searchParams.get("targetId"),
  });
  return target.success ? target.data : undefined;
}
