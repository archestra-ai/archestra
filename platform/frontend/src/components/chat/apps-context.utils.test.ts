import { describe, expect, it } from "vitest";
import type { PanelApp } from "./apps-context";
import { buildAppGroups } from "./apps-context.utils";

const app = (
  toolCallId: string,
  appId: string | null,
  createdAt: number,
): PanelApp => ({
  toolCallId,
  label: appId ? "Dashboard" : "Excalidraw",
  uiResourceUri: appId ? `ui://archestra-app/${appId}` : "ui://excalidraw",
  appId,
  createdAt,
});

const NO_PICK = new Map<string, string>();

describe("buildAppGroups", () => {
  it("folds owned renders into one group per appId, external renders stand alone", () => {
    const apps = [
      app("tc1", "app-1", 0),
      app("tc2", "app-1", 10),
      app("tc3", null, 5),
    ];
    const { groups } = buildAppGroups(apps, NO_PICK);
    expect(groups.map((g) => g.key)).toEqual(["app-1", "tc3"]);
    expect(groups[0].renders.map((r) => r.toolCallId)).toEqual(["tc1", "tc2"]);
    expect(groups[1].renders.map((r) => r.toolCallId)).toEqual(["tc3"]);
  });

  it("defaults the active render to the latest by createdAt", () => {
    const { groupByToolCallId } = buildAppGroups(
      [app("tc1", "app-1", 0), app("tc2", "app-1", 10)],
      NO_PICK,
    );
    expect(groupByToolCallId.get("tc1")?.activeRender.toolCallId).toBe("tc2");
  });

  it("breaks a createdAt tie toward the later render in appearance order", () => {
    // Streaming leaves createdAt at 0, so ties are common.
    const { groupByToolCallId } = buildAppGroups(
      [app("tc1", "app-1", 0), app("tc2", "app-1", 0)],
      NO_PICK,
    );
    expect(groupByToolCallId.get("tc1")?.activeRender.toolCallId).toBe("tc2");
  });

  it("uses the user's picked render when it is still present", () => {
    const { groupByToolCallId } = buildAppGroups(
      [app("tc1", "app-1", 0), app("tc2", "app-1", 10)],
      new Map([["app-1", "tc1"]]),
    );
    expect(groupByToolCallId.get("tc2")?.activeRender.toolCallId).toBe("tc1");
  });

  it("falls back to the latest when the picked render is gone", () => {
    const { groupByToolCallId } = buildAppGroups(
      [app("tc1", "app-1", 0), app("tc2", "app-1", 10)],
      new Map([["app-1", "tc-removed"]]),
    );
    expect(groupByToolCallId.get("tc1")?.activeRender.toolCallId).toBe("tc2");
  });

  it("ignores a pick that names a render belonging to another app", () => {
    const { groupByToolCallId } = buildAppGroups(
      [app("tc1", "app-1", 0), app("tc2", "app-1", 10), app("tc3", "app-2", 5)],
      new Map([["app-1", "tc3"]]),
    );
    expect(groupByToolCallId.get("tc1")?.activeRender.toolCallId).toBe("tc2");
  });

  it("maps every render — older owned dups included — to its group", () => {
    const apps = [app("tc1", "app-1", 0), app("tc2", "app-1", 10)];
    const { groupByToolCallId } = buildAppGroups(apps, NO_PICK);
    expect(groupByToolCallId.get("tc1")).toBe(groupByToolCallId.get("tc2"));
    expect(groupByToolCallId.size).toBe(2);
  });
});
