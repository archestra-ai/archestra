import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENT_ENTRIES,
  findAuditEventEntry,
} from "./audit-event-taxonomy";
import { ALL_ACTIONS, formatAction } from "./audit-log-action-labels";

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
    const files = AUDIT_EVENT_ENTRIES.find(
      (entry) => entry.label === "Knowledge file",
    );
    expect(files?.key).toBe("knowledgeFile,knowledgeDirectory");
    expect(findAuditEventEntry({ resourceType: files?.key })).toBe(files);
    expect(findAuditEventEntry({ resourceType: "knowledgeDirectory" })).toBe(
      files,
    );
    expect(findAuditEventEntry({ action: "knowledgeDirectory.created" })).toBe(
      files,
    );
  });

  it("reads an event name it has no label for as a sentence", () => {
    expect(formatAction("optimizationRule.created")).toBe(
      "Optimization rule created",
    );
    expect(formatAction("teamToken.rotated")).toBe("Team token rotated");
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
