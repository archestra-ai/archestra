import type { PanelApp } from "./apps-context";

export interface AppGroup {
  /** `appId ?? toolCallId` — the shared open-state key for this app's renders. */
  key: string;
  /** Owned-app id, or null for an external MCP-UI render. */
  appId: string | null;
  /** Every render of this app, in appearance order. */
  renders: PanelApp[];
  /**
   * The visible render: the user's picked render when it's still present, else
   * the latest by `createdAt`. External apps always have a single render.
   */
  activeRender: PanelApp;
}

/**
 * Group a flat, per-render app list into one {@link AppGroup} per app. Owned
 * apps (shared `appId`) fold their many renders into one group that shares open
 * state and exposes a single visible `activeRender`; external MCP-UI renders are
 * singleton groups keyed by their `toolCallId`. Returns the groups in
 * first-appearance order plus a lookup from any render's `toolCallId` to its
 * group, so callers translate a render id to its app in O(1).
 */
export function buildAppGroups(
  apps: PanelApp[],
  pickedOwnedRender: ReadonlyMap<string, string>,
): { groups: AppGroup[]; groupByToolCallId: Map<string, AppGroup> } {
  const rendersByKey = new Map<string, PanelApp[]>();
  const keyOrder: string[] = [];
  for (const app of apps) {
    const key = app.appId ?? app.toolCallId;
    const existing = rendersByKey.get(key);
    if (existing) {
      existing.push(app);
    } else {
      rendersByKey.set(key, [app]);
      keyOrder.push(key);
    }
  }

  const groups: AppGroup[] = [];
  const groupByToolCallId = new Map<string, AppGroup>();
  for (const key of keyOrder) {
    const renders = rendersByKey.get(key) as PanelApp[];
    const appId = renders[0].appId ?? null;
    const picked = appId ? pickedOwnedRender.get(appId) : undefined;
    const pickedRender = picked
      ? renders.find((r) => r.toolCallId === picked)
      : undefined;
    const group: AppGroup = {
      key,
      appId,
      renders,
      activeRender: pickedRender ?? latestByCreatedAt(renders),
    };
    groups.push(group);
    for (const render of renders) {
      groupByToolCallId.set(render.toolCallId, group);
    }
  }

  return { groups, groupByToolCallId };
}

// Latest render by `createdAt`; ties resolve to the later render in appearance
// order (streaming leaves `createdAt` at 0, so ties are common).
function latestByCreatedAt(renders: PanelApp[]): PanelApp {
  return renders.reduce((latest, r) =>
    r.createdAt >= latest.createdAt ? r : latest,
  );
}
