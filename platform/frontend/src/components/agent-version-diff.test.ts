import { describe, expect, it } from "vitest";
import type { AgentConfigSnapshot } from "@/lib/agent-version.query";
import {
  type AgentListSection,
  type AgentSnapshotSection,
  type AgentTextSection,
  changedSections,
  compareAgentSnapshots,
} from "./agent-version-diff";

// An internal agent edits the whole snapshot surface, so nothing the
// per-type filtering would hide gets in the way of the comparison tests.
function makeSnapshot(
  overrides: Partial<AgentConfigSnapshot> = {},
): AgentConfigSnapshot {
  return {
    agentType: "agent",
    name: "prod-gateway",
    description: null,
    icon: null,
    systemPrompt: "Be careful.",
    considerContextUntrusted: false,
    toolExposureMode: "all",
    accessAllTools: true,
    accessAllSubagents: false,
    passthroughHeaders: [],
    incomingEmailEnabled: false,
    incomingEmailSecurityMode: "strict",
    incomingEmailAllowedDomain: null,
    builtInAgentConfig: null,
    model: { id: "m1", externalId: "claude-sonnet-5" },
    llmApiKey: null,
    identityProviderId: null,
    environmentId: null,
    tools: [
      {
        toolId: "t1",
        name: "github__create_pr",
        mcpServerId: "s1",
        credentialResolutionMode: "profile",
      },
    ],
    excludedTools: [],
    excludedSubagents: [],
    suggestedPrompts: [],
    hooks: [],
    knowledgeBases: [],
    connectors: [],
    ...overrides,
  };
}

function section(sections: AgentSnapshotSection[], id: string) {
  const found = sections.find((s) => s.id === id);
  if (!found) throw new Error(`missing section ${id}`);
  return found;
}

describe("compareAgentSnapshots", () => {
  it("claims nothing without a baseline", () => {
    const sections = compareAgentSnapshots(makeSnapshot(), null);
    expect(sections.every((s) => s.change === null)).toBe(true);
    const config = section(sections, "configuration");
    expect(
      config.kind === "fields" && config.fields.every((f) => f.change === null),
    ).toBe(true);
    expect(changedSections(sections)).toEqual([]);
  });

  it("reports an unchanged version as unchanged everywhere", () => {
    const sections = compareAgentSnapshots(makeSnapshot(), makeSnapshot());
    expect(changedSections(sections)).toEqual([]);
    expect(sections.every((s) => s.change === "unchanged")).toBe(true);
  });

  it("detects a scalar change and renders both sides", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({ model: { id: "m2", externalId: "claude-opus-5" } }),
      makeSnapshot(),
    );
    const config = section(sections, "configuration");
    expect(config.change).toBe("changed");
    if (config.kind !== "fields") throw new Error("expected fields");
    const model = config.fields.find((f) => f.label === "Model");
    expect(model).toMatchObject({
      change: "changed",
      previous: "claude-sonnet-5",
      current: "claude-opus-5",
    });
    // An untouched scalar stays out of the change set.
    const name = config.fields.find((f) => f.label === "Name");
    expect(name?.change).toBe("unchanged");
  });

  it("pairs collection items by id: added, removed, and mode changes", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({
        tools: [
          {
            toolId: "t1",
            name: "github__create_pr",
            mcpServerId: "s1",
            credentialResolutionMode: "user",
          },
          {
            toolId: "t3",
            name: "slack__post_message",
            mcpServerId: "s2",
            credentialResolutionMode: "profile",
          },
        ],
      }),
      makeSnapshot({
        tools: [
          {
            toolId: "t1",
            name: "github__create_pr",
            mcpServerId: "s1",
            credentialResolutionMode: "profile",
          },
          {
            toolId: "t2",
            name: "github__list_issues",
            mcpServerId: "s1",
            credentialResolutionMode: "profile",
          },
        ],
      }),
    );
    const tools = section(sections, "tools") as AgentListSection;
    expect(tools.change).toBe("changed");
    expect({
      added: tools.addedCount,
      removed: tools.removedCount,
      changed: tools.changedCount,
    }).toEqual({ added: 1, removed: 1, changed: 1 });
    const byKey = new Map(tools.items.map((item) => [item.key, item]));
    expect(byKey.get("t3")?.change).toBe("added");
    expect(byKey.get("t2")?.change).toBe("removed");
    expect(byKey.get("t1")).toMatchObject({
      change: "changed",
      previousDetail: "profile",
      detail: "user",
    });
  });

  it("gives every hook on either side a row, keyed by file name", () => {
    const hook = {
      event: "pre-tool",
      fileName: "pre-tool.ts",
      content: "export {}",
      requirements: [],
      enabled: true,
    };
    const sections = compareAgentSnapshots(
      makeSnapshot({
        hooks: [{ ...hook, content: "export const x = 1" }],
      }),
      makeSnapshot({
        hooks: [hook, { ...hook, fileName: "post-tool.ts" }],
      }),
    );
    const changed = section(sections, "hook:pre-tool.ts") as AgentTextSection;
    expect(changed).toMatchObject({
      group: "Hooks",
      change: "changed",
      language: "typescript",
      previous: "export {}",
      current: "export const x = 1",
    });
    // A hook only the baseline holds is a removal, not a missing row.
    const removed = section(sections, "hook:post-tool.ts") as AgentTextSection;
    expect(removed).toMatchObject({ change: "removed", current: null });
  });

  it("treats a hook meta-only edit as a change", () => {
    const hook = {
      event: "pre-tool",
      fileName: "pre-tool.ts",
      content: "export {}",
      requirements: [],
      enabled: true,
    };
    const sections = compareAgentSnapshots(
      makeSnapshot({ hooks: [{ ...hook, enabled: false }] }),
      makeSnapshot({ hooks: [hook] }),
    );
    expect(section(sections, "hook:pre-tool.ts").change).toBe("changed");
  });

  it("shows an LLM proxy only the surface it edits", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({ agentType: "llm_proxy" }),
      null,
    );
    // No tool surface, no prompt, no hooks, no knowledge — a proxy edits none
    // of them.
    expect(sections.map((s) => s.id)).toEqual(["configuration"]);
    const config = section(sections, "configuration");
    if (config.kind !== "fields") throw new Error("expected fields");
    const labels = config.fields.map((f) => f.label);
    expect(labels).toContain("Treat context as untrusted");
    expect(labels).not.toContain("Model");
    expect(labels).not.toContain("Tool exposure");
    expect(labels).not.toContain("Passthrough headers");
  });

  it("shows an MCP gateway its tools but no prompt, model, or hooks", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({
        agentType: "mcp_gateway",
        hooks: [
          {
            event: "pre-tool",
            fileName: "pre-tool.ts",
            content: "export {}",
            requirements: [],
            enabled: true,
          },
        ],
      }),
      null,
    );
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("tools");
    expect(ids).toContain("knowledge-bases");
    expect(ids).not.toContain("system-prompt");
    expect(ids).not.toContain("suggested-prompts");
    expect(ids.some((id) => id.startsWith("hook:"))).toBe(false);
    const config = section(sections, "configuration");
    if (config.kind !== "fields") throw new Error("expected fields");
    const labels = config.fields.map((f) => f.label);
    expect(labels).toContain("Passthrough headers");
    expect(labels).not.toContain("Model");
    expect(labels).not.toContain("Treat context as untrusted");
  });

  it("diffs the system prompt as text, treating null and empty alike", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({ systemPrompt: null }),
      makeSnapshot({ systemPrompt: "" }),
    );
    expect(section(sections, "system-prompt").change).toBe("unchanged");

    const moved = compareAgentSnapshots(
      makeSnapshot({ systemPrompt: "New prompt." }),
      makeSnapshot(),
    );
    expect(section(moved, "system-prompt").change).toBe("changed");
  });
});
