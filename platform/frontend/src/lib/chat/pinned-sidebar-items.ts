/**
 * Merge every pinnable sidebar resource into one list, sorted by pin time
 * (most recently pinned first).
 * Pure and generic so it can be unit-tested independent of the React tree.
 *
 * Note: this sorts pinned CHATS by their `pinnedAt` too, which is a deliberate
 * change from the previous API-order rendering of pinned chats.
 */
type Pinnable = { pinnedAt?: string | Date | null };

export type PinnedSidebarItem<C, P, A = never, E = never> =
  | { type: "chat"; pinnedAt: string | Date; item: C }
  | { type: "project"; pinnedAt: string | Date; item: P }
  | { type: "app"; pinnedAt: string | Date; item: A }
  | { type: "execution"; pinnedAt: string | Date; item: E };

export function buildPinnedSidebarItems<
  C extends Pinnable,
  P extends Pinnable,
  A extends Pinnable = never,
  E extends Pinnable = never,
>(args: {
  chats: C[];
  projects: P[];
  apps?: A[];
  executions?: E[];
}): PinnedSidebarItem<C, P, A, E>[] {
  const items: PinnedSidebarItem<C, P, A, E>[] = [];
  for (const chat of args.chats) {
    if (chat.pinnedAt) {
      items.push({ type: "chat", pinnedAt: chat.pinnedAt, item: chat });
    }
  }
  for (const project of args.projects) {
    if (project.pinnedAt) {
      items.push({
        type: "project",
        pinnedAt: project.pinnedAt,
        item: project,
      });
    }
  }
  for (const app of args.apps ?? []) {
    if (app.pinnedAt) {
      items.push({ type: "app", pinnedAt: app.pinnedAt, item: app });
    }
  }
  for (const execution of args.executions ?? []) {
    if (execution.pinnedAt) {
      items.push({
        type: "execution",
        pinnedAt: execution.pinnedAt,
        item: execution,
      });
    }
  }
  return items.sort(
    (a, b) => new Date(b.pinnedAt).getTime() - new Date(a.pinnedAt).getTime(),
  );
}
