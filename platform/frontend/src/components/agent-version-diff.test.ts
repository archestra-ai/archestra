import { describe, expect, it } from "vitest";
import type { AgentConfigSnapshot } from "@/lib/agent-version.query";
import {
  type AgentListSection,
  type AgentSnapshotSection,
  type AgentTextSection,
  changedSections,
  compareAgentSnapshots,
} from "./agent-version-diff";

// Carries something in most of the snapshot's sections, so a comparison has
// content on both sides rather than sections dropping out as empty.
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

  // A restore decides what to write from the ids a snapshot holds, so the
  // comparison has to read the same ids rather than the names they render as —
  // otherwise "Changes (0)" claims two versions agree while a restore rewrites
  // which credential the agent runs on.
  it("reads a tool re-pinned to another installation as a change", () => {
    const tool = {
      toolId: "t1",
      name: "github__create_pr",
      credentialResolutionMode: "profile",
    };
    const sections = compareAgentSnapshots(
      makeSnapshot({ tools: [{ ...tool, mcpServerId: "s2" }] }),
      makeSnapshot({ tools: [{ ...tool, mcpServerId: "s1" }] }),
    );
    const tools = section(sections, "tools") as AgentListSection;
    expect(tools.change).toBe("changed");
    expect(tools.items[0]).toMatchObject({ key: "t1", change: "changed" });
  });

  it("tells two models sharing an external id apart", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({ model: { id: "m2", externalId: "claude-sonnet-5" } }),
      makeSnapshot({ model: { id: "m1", externalId: "claude-sonnet-5" } }),
    );
    const config = section(sections, "configuration");
    if (config.kind !== "fields") throw new Error("expected fields");
    expect(config.fields.find((f) => f.label === "Model")?.change).toBe(
      "changed",
    );
  });

  it("tells two API keys sharing a name apart", () => {
    const key = { name: "prod", provider: "anthropic" };
    const sections = compareAgentSnapshots(
      makeSnapshot({ llmApiKey: { ...key, id: "k2" } }),
      makeSnapshot({ llmApiKey: { ...key, id: "k1" } }),
    );
    const config = section(sections, "configuration");
    if (config.kind !== "fields") throw new Error("expected fields");
    expect(config.fields.find((f) => f.label === "LLM API key")?.change).toBe(
      "changed",
    );
  });

  // The other direction, and the one a naive "compare id *and* name" fix gets
  // wrong: renaming the model row a version points at is not a change to the
  // version, because a restore would write nothing.
  it("reads a renamed model row as unchanged", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({ model: { id: "m1", externalId: "claude-opus-5" } }),
      makeSnapshot({ model: { id: "m1", externalId: "claude-sonnet-5" } }),
    );
    const config = section(sections, "configuration");
    if (config.kind !== "fields") throw new Error("expected fields");
    expect(config.fields.find((f) => f.label === "Model")?.change).toBe(
      "unchanged",
    );
    expect(changedSections(sections)).toEqual([]);
  });

  it("keeps two suggested prompts sharing a title apart", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({
        suggestedPrompts: [
          { summaryTitle: "Ideas", prompt: "Give me release ideas" },
          { summaryTitle: "Ideas", prompt: "Give me test ideas" },
        ],
      }),
      null,
    );
    const prompts = section(sections, "suggested-prompts") as AgentListSection;
    // Titles are not unique, so neither prompt may swallow the other, and two
    // rows carrying one key would collide as React children.
    expect(prompts.items.map((item) => item.detail)).toEqual([
      "Give me release ideas",
      "Give me test ideas",
    ]);
    expect(new Set(prompts.items.map((item) => item.key)).size).toBe(2);
    expect(prompts.items.every((item) => item.label === "Ideas")).toBe(true);
  });

  it("reads a deleted duplicate title as a removal, not an edit", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({
        suggestedPrompts: [
          { summaryTitle: "Ideas", prompt: "Give me release ideas" },
        ],
      }),
      makeSnapshot({
        suggestedPrompts: [
          { summaryTitle: "Ideas", prompt: "Give me release ideas" },
          { summaryTitle: "Ideas", prompt: "Give me test ideas" },
        ],
      }),
    );
    const prompts = section(sections, "suggested-prompts") as AgentListSection;
    expect({
      added: prompts.addedCount,
      removed: prompts.removedCount,
      changed: prompts.changedCount,
    }).toEqual({ added: 0, removed: 1, changed: 0 });
    // Not a "Give me test ideas" -> "Give me release ideas" edit: the prompt
    // that stayed is untouched, and the other one is gone.
    expect(
      prompts.items.find((item) => item.change === "removed"),
    ).toMatchObject({
      label: "Ideas",
      detail: null,
      previousDetail: "Give me test ideas",
    });
  });

  it("gives every hook on either side a row, keyed by event and file name", () => {
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
    const changed = section(
      sections,
      "hook:pre-tool/pre-tool.ts",
    ) as AgentTextSection;
    expect(changed).toMatchObject({
      group: "Hooks",
      change: "changed",
      language: "typescript",
      previous: "export {}",
      current: "export const x = 1",
    });
    // A hook only the baseline holds is a removal, not a missing row.
    const removed = section(
      sections,
      "hook:pre-tool/post-tool.ts",
    ) as AgentTextSection;
    expect(removed).toMatchObject({ change: "removed", current: null });
  });

  it("keeps one file name registered under two events apart", () => {
    const hook = {
      fileName: "guard.py",
      content: "print('before')",
      requirements: [],
      enabled: true,
    };
    const sections = compareAgentSnapshots(
      makeSnapshot({
        hooks: [
          { ...hook, event: "pre-tool" },
          { ...hook, event: "post-tool", content: "print('after')" },
        ],
      }),
      null,
    );
    // Neither hook may swallow the other, and neither may be read against the
    // other's body.
    expect(
      section(sections, "hook:pre-tool/guard.py") as AgentTextSection,
    ).toMatchObject({
      label: "guard.py (pre-tool)",
      current: "print('before')",
    });
    expect(
      section(sections, "hook:post-tool/guard.py") as AgentTextSection,
    ).toMatchObject({
      label: "guard.py (post-tool)",
      current: "print('after')",
    });
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
    expect(section(sections, "hook:pre-tool/pre-tool.ts").change).toBe(
      "changed",
    );
  });

  it("compares what a snapshot carries, not what its type may edit", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({ agentType: "llm_proxy" }),
      null,
    );
    // A proxy's editor offers neither a prompt nor tools, but this snapshot
    // holds both and a restore would replay both, so both get a section.
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("system-prompt");
    expect(ids).toContain("tools");
    // Nothing on either side of these, so there is nothing to compare.
    expect(ids).not.toContain("knowledge-bases");
    expect(ids).not.toContain("suggested-prompts");
  });

  it("drops a section only when neither side carries anything", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({
        agentType: "mcp_gateway",
        tools: [],
        systemPrompt: null,
        model: null,
      }),
      null,
    );
    expect(sections.map((s) => s.id)).toEqual(["configuration"]);
    const config = section(sections, "configuration");
    if (config.kind !== "fields") throw new Error("expected fields");
    const labels = config.fields.map((f) => f.label);
    // A setting neither side sets earns no row...
    expect(labels).not.toContain("Model");
    expect(labels).not.toContain("Passthrough headers");
    // ...but one every snapshot carries does, whatever the agent type is.
    expect(labels).toContain("Tool exposure");
    expect(labels).toContain("Treat context as untrusted");
  });

  it("reports a change in a setting the agent's own editor never shows", () => {
    // Comparing by agent type let a gateway's prompt, hooks, and suggested
    // prompts move without reaching the change set — so an empty change set
    // read as "these two versions agree" while a restore rewrote all three.
    const gateway = (overrides: Partial<AgentConfigSnapshot> = {}) =>
      makeSnapshot({ agentType: "mcp_gateway", ...overrides });
    const moved: [string, Partial<AgentConfigSnapshot>][] = [
      ["system prompt", { systemPrompt: "Rewritten." }],
      [
        "hooks",
        {
          hooks: [
            {
              event: "pre-tool",
              fileName: "guard.ts",
              content: "export {}",
              requirements: [],
              enabled: true,
            },
          ],
        },
      ],
      [
        "suggested prompts",
        { suggestedPrompts: [{ summaryTitle: "Ideas", prompt: "Go" }] },
      ],
      ["untrusted context", { considerContextUntrusted: true }],
    ];
    for (const [label, overrides] of moved) {
      const changed = changedSections(
        compareAgentSnapshots(gateway(overrides), gateway()),
      );
      expect(
        changed,
        `a changed ${label} must reach the change set`,
      ).not.toEqual([]);
    }
  });

  it("diffs the system prompt as text, dropping it when neither side has one", () => {
    // Null and empty read alike, so clearing a prompt that was already empty
    // is not a change — and with nothing on either side there is no section.
    const settled = compareAgentSnapshots(
      makeSnapshot({ systemPrompt: null }),
      makeSnapshot({ systemPrompt: "" }),
    );
    expect(settled.map((s) => s.id)).not.toContain("system-prompt");

    const moved = compareAgentSnapshots(
      makeSnapshot({ systemPrompt: "New prompt." }),
      makeSnapshot(),
    );
    expect(section(moved, "system-prompt").change).toBe("changed");
  });
});
