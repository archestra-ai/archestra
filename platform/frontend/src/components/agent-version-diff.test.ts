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
    const absent = compareAgentSnapshots(
      makeSnapshot({ systemPrompt: null }),
      makeSnapshot({ systemPrompt: null }),
    );
    expect(absent.map((s) => s.id)).not.toContain("system-prompt");

    const moved = compareAgentSnapshots(
      makeSnapshot({ systemPrompt: "New prompt." }),
      makeSnapshot(),
    );
    expect(section(moved, "system-prompt").change).toBe("changed");
  });

  // Order is configuration, not presentation: the snapshot stores the prompts
  // as a sequence, reordering them changes the content hash and mints a
  // version, and `agent-version-restore.ts` compares the array as a sequence
  // and rewrites the prompts on any difference. Pairing on the title alone
  // read a reorder as no change at all.
  it("reads a pure reorder of suggested prompts as a change", () => {
    const first = { summaryTitle: "Ideas", prompt: "Give me release ideas" };
    const second = { summaryTitle: "Bugs", prompt: "Triage the bug queue" };
    const sections = compareAgentSnapshots(
      makeSnapshot({ suggestedPrompts: [second, first] }),
      makeSnapshot({ suggestedPrompts: [first, second] }),
    );
    const prompts = section(sections, "suggested-prompts") as AgentListSection;
    expect(prompts.change).toBe("changed");
    expect(prompts.changedCount).toBe(2);
    expect(changedSections(sections).map((s) => s.id)).toContain(
      "suggested-prompts",
    );
  });

  // The same id-not-name rule the scalars follow: a restore reads these rows
  // by id and writes nothing when only the name moved, so badging the row
  // "changed" would mark a row whose visible detail lines are identical.
  it("reads a renamed assignment as unchanged", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({
        tools: [
          {
            toolId: "t1",
            name: "github__open_pr",
            mcpServerId: "s1",
            credentialResolutionMode: "profile",
          },
        ],
        knowledgeBases: [{ id: "kb1", name: "Runbooks (2026)" }],
      }),
      makeSnapshot({
        tools: [
          {
            toolId: "t1",
            name: "github__create_pr",
            mcpServerId: "s1",
            credentialResolutionMode: "profile",
          },
        ],
        knowledgeBases: [{ id: "kb1", name: "Runbooks" }],
      }),
    );
    expect(section(sections, "tools").change).toBe("unchanged");
    expect(section(sections, "knowledge-bases").change).toBe("unchanged");
    expect(changedSections(sections)).toEqual([]);
  });

  // The rendered list joins on ", " and a pip specifier idiomatically carries
  // commas, so two different requirement lists render one string. A restore
  // reads them apart and rewrites the hook.
  it("tells two requirement lists rendering alike apart", () => {
    const hook = {
      event: "session_start",
      fileName: "setup.py",
      content: "print('hi')",
      enabled: true,
    };
    const sections = compareAgentSnapshots(
      makeSnapshot({ hooks: [{ ...hook, requirements: ["numpy>=1", "<2"] }] }),
      makeSnapshot({ hooks: [{ ...hook, requirements: ["numpy>=1, <2"] }] }),
    );
    const hookSection = section(sections, "hook:session_start/setup.py");
    expect(hookSection.change).toBe("changed");
    if (hookSection.kind !== "text") throw new Error("expected text");
    // One requirement pinning a range, against two requirements — the same
    // rendered string on both sides, which is the whole point.
    expect(
      hookSection.fields.find((f) => f.label === "Requirements"),
    ).toMatchObject({
      change: "changed",
      previous: "numpy>=1, <2",
      current: "numpy>=1, <2",
    });
  });

  // `stableStringify` hashes null and "" apart — which is why clearing a
  // setting to the empty string records a version — and the restore plan
  // writes the difference. Folding them together rendered that version as
  // having changed nothing at all.
  it("reads clearing a setting to the empty string as a change", () => {
    const sections = compareAgentSnapshots(
      makeSnapshot({ description: "", systemPrompt: "" }),
      makeSnapshot({ description: null, systemPrompt: null }),
    );
    const config = section(sections, "configuration");
    if (config.kind !== "fields") throw new Error("expected fields");
    expect(config.fields.find((f) => f.label === "Description")).toMatchObject({
      change: "changed",
      previous: null,
      current: "",
    });
    // And the section survives: an empty body is a value this version holds,
    // so the pane cannot drop it as "nothing on either side".
    expect(section(sections, "system-prompt").change).toBe("changed");
    expect(changedSections(sections).map((s) => s.id)).toEqual([
      "configuration",
      "system-prompt",
    ]);
  });
});

/**
 * Where each snapshot key is read: a row of the configuration table, or a
 * section of its own. Written as a total map so a field added to
 * `AgentConfigSnapshotSchema` fails to compile until it is given a home —
 * new snapshot fields are mandated optional, so one left out of the
 * comparison would otherwise pass type-check, the suite, and CI, and then be
 * restored silently. That is the drift this table exists to prevent.
 */
const SNAPSHOT_KEY_HOMES: Record<
  keyof AgentConfigSnapshot,
  { field: string } | { section: string }
> = {
  name: { field: "Name" },
  description: { field: "Description" },
  icon: { field: "Icon" },
  agentType: { field: "Type" },
  model: { field: "Model" },
  llmApiKey: { field: "LLM API key" },
  toolExposureMode: { field: "Tool exposure" },
  accessAllTools: { field: "Access all tools" },
  accessAllSubagents: { field: "Access all subagents" },
  considerContextUntrusted: { field: "Treat context as untrusted" },
  passthroughHeaders: { field: "Passthrough headers" },
  incomingEmailEnabled: { field: "Incoming email" },
  incomingEmailSecurityMode: { field: "Email security mode" },
  incomingEmailAllowedDomain: { field: "Email allowed domain" },
  identityProviderId: { field: "Identity provider" },
  environmentId: { field: "Environment" },
  builtInAgentConfig: { field: "Built-in configuration" },
  systemPrompt: { section: "system-prompt" },
  tools: { section: "tools" },
  excludedTools: { section: "excluded-tools" },
  excludedSubagents: { section: "excluded-subagents" },
  suggestedPrompts: { section: "suggested-prompts" },
  knowledgeBases: { section: "knowledge-bases" },
  connectors: { section: "connectors" },
  hooks: { section: "hook" },
};

describe("snapshot coverage", () => {
  // Every scalar set and every collection non-empty, so nothing drops out as
  // "neither side carries anything" and the comparison has to account for the
  // whole snapshot.
  const populated = makeSnapshot({
    description: "Answers support mail",
    icon: "bot",
    incomingEmailAllowedDomain: "example.com",
    passthroughHeaders: ["x-request-id"],
    builtInAgentConfig: { kind: "support" },
    llmApiKey: { id: "k1", name: "prod", provider: "anthropic" },
    identityProviderId: "idp1",
    environmentId: "env1",
    excludedTools: [{ toolId: "t9", name: "danger__wipe" }],
    excludedSubagents: [{ agentId: "a9", name: "Old bot" }],
    suggestedPrompts: [{ summaryTitle: "Ideas", prompt: "Give me ideas" }],
    knowledgeBases: [{ id: "kb1", name: "Runbooks" }],
    connectors: [{ id: "c1", name: "Drive" }],
    hooks: [
      {
        event: "session_start",
        fileName: "setup.py",
        content: "print('hi')",
        requirements: [],
        enabled: true,
      },
    ],
  });

  it("reads every field the snapshot carries", () => {
    const sections = compareAgentSnapshots(populated, null);
    const config = section(sections, "configuration");
    if (config.kind !== "fields") throw new Error("expected fields");

    const homes = Object.values(SNAPSHOT_KEY_HOMES);
    expect(new Set(config.fields.map((f) => f.label))).toEqual(
      new Set(homes.flatMap((home) => ("field" in home ? [home.field] : []))),
    );
    for (const home of homes) {
      if (!("section" in home)) continue;
      expect(
        sections.some(
          (s) => s.id === home.section || s.id.startsWith(`${home.section}:`),
        ),
      ).toBe(true);
    }
  });
});
