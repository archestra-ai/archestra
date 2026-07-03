/**
 * Merge pinned chats, pinned projects, and pinned apps into one list for the
 * sidebar "Pinned" section, sorted by pin time (most recently pinned first).
 * Pure and generic so it can be unit-tested independent of the React tree.
 *
 * Note: this sorts pinned CHATS by their `pinnedAt` too, which is a deliberate
 * change from the previous API-order rendering of pinned chats.
 */
type Pinnable = { pinnedAt?: string | Date | null };

export type PinnedSidebarItem<C, P, A = never> =
  | { type: "chat"; pinnedAt: string | Date; item: C }
  | { type: "project"; pinnedAt: string | Date; item: P }
  | { type: "app"; pinnedAt: string | Date; item: A };

export function buildPinnedSidebarItems<
  C extends Pinnable,
  P extends Pinnable,
  A extends Pinnable = never,
>(args: {
  chats: C[];
  projects: P[];
  apps?: A[];
}): PinnedSidebarItem<C, P, A>[] {
  const items: PinnedSidebarItem<C, P, A>[] = [];
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
  return items.sort(
    (a, b) => new Date(b.pinnedAt).getTime() - new Date(a.pinnedAt).getTime(),
  );
}
