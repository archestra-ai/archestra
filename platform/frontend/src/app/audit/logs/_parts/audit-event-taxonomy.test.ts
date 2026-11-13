import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENT_ENTRIES,
  findAuditEventEntry,
} from "./audit-event-taxonomy";
import { ALL_ACTIONS } from "./audit-log-action-labels";

describe("audit event taxonomy", () => {
  it("files every event under exactly one picker entry", () => {
    // `unknown.*` marks rows the backend could not attribute; not pickable.
    const pickable = ALL_ACTIONS.filter((a) => !a.startsWith("unknown."));
    const filed = AUDIT_EVENT_ENTRIES.flatMap((entry) =>
      entry.actions.map((action) => action.value),
    );
    expect([...filed].sort()).toEqual([...pickable].sort());
  });

  it("resolves a merged entry from its key, any of its types, or an action", () => {
    const devices = AUDIT_EVENT_ENTRIES.find(
      (entry) => entry.label === "Device",
    );
    expect(devices?.key).toBe("desktopDevice,desktopDeviceSignIn");
    expect(findAuditEventEntry({ resourceType: devices?.key })).toBe(devices);
    expect(findAuditEventEntry({ resourceType: "desktopDeviceSignIn" })).toBe(
      devices,
    );
    expect(findAuditEventEntry({ action: "desktopDeviceSignIn.updated" })).toBe(
      devices,
    );
  });

  it("drops the noun only from the primary type's verbs", () => {
    const agent = AUDIT_EVENT_ENTRIES.find((entry) => entry.label === "Agent");
    const verbs = Object.fromEntries(
      agent?.actions.map((action) => [action.value, action.verbLabel]) ?? [],
    );
    expect(verbs["agent.updated"]).toBe("Updated");
    expect(verbs["agentTool.created"]).toBe("Agent tool added");
  });
});
