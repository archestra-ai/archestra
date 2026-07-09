import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  buildExclusionPayload,
  buildInitialEntries,
  computeDefaultExclusionToolIds,
  exclusionsKey,
  filterExcludableTools,
  mergeExclusionsWithDefaultToolIds,
  type PendingExclusionEntry,
} from "./agent-tool-exclusions-editor.utils";

const CATALOG_A = "catalog-a";
const CATALOG_B = "catalog-b";

const toolIdsByCatalog = new Map<string, string[]>([
  [CATALOG_A, ["a1", "a2", "a3"]],
  [CATALOG_B, ["b1", "b2"]],
  [ARCHESTRA_MCP_CATALOG_ID, ["arch1", "arch2"]],
]);

function entry(
  catalogId: string,
  selectedToolIds: string[],
): PendingExclusionEntry {
  return { catalogId, selectedToolIds: new Set(selectedToolIds) };
}

describe("filterExcludableTools", () => {
  const tools = [
    { id: "1", name: `archestra__${TOOL_SEARCH_TOOLS_SHORT_NAME}` },
    { id: "2", name: `some_brand__${TOOL_RUN_TOOL_SHORT_NAME}` },
    { id: "3", name: "archestra__query_knowledge_sources" },
    // Always-exposed built-ins ARE excludable — only the meta dispatch tools
    // are rejected by the PUT validation, so the picker offers everything else.
    { id: "4", name: "archestra__list_skills" },
    { id: "5", name: "archestra__run_command" },
    { id: "6", name: "archestra__scaffold_app" },
  ];

  it("removes only the meta dispatch tools from the built-in catalog regardless of prefix", () => {
    expect(
      filterExcludableTools(ARCHESTRA_MCP_CATALOG_ID, tools).map((t) => t.id),
    ).toEqual(["3", "4", "5", "6"]);
  });

  it("leaves other catalogs' tools untouched, even name collisions", () => {
    expect(filterExcludableTools(CATALOG_A, tools)).toEqual(tools);
  });
});

describe("buildExclusionPayload", () => {
  it("maps a selection to excludedToolIds", () => {
    expect(
      buildExclusionPayload({
        entries: [entry(CATALOG_A, ["a2", "a1"])],
      }),
    ).toEqual({ excludedToolIds: ["a1", "a2"] });
  });

  it("serializes a fully-selected server to its individual tool ids (never a catalog id)", () => {
    expect(
      buildExclusionPayload({
        entries: [entry(CATALOG_A, ["a1", "a2", "a3"])],
      }),
    ).toEqual({ excludedToolIds: ["a1", "a2", "a3"] });
  });

  it("keeps the built-in catalog's fully-selected tools as tool ids", () => {
    expect(
      buildExclusionPayload({
        entries: [entry(ARCHESTRA_MCP_CATALOG_ID, ["arch1", "arch2"])],
      }),
    ).toEqual({ excludedToolIds: ["arch1", "arch2"] });
  });

  it("skips entries with an empty selection", () => {
    expect(
      buildExclusionPayload({
        entries: [entry(CATALOG_A, [])],
      }),
    ).toEqual({ excludedToolIds: [] });
  });

  it("unions multiple servers' selections", () => {
    expect(
      buildExclusionPayload({
        entries: [entry(CATALOG_B, ["b2"]), entry(CATALOG_A, ["a1"])],
      }),
    ).toEqual({ excludedToolIds: ["a1", "b2"] });
  });

  it("preserves unresolved tool ids and sorts output", () => {
    expect(
      buildExclusionPayload({
        entries: [entry(CATALOG_B, ["b2"]), entry(CATALOG_A, ["a1"])],
        unresolvedToolIds: ["zz-gone", "aa-gone"],
      }),
    ).toEqual({ excludedToolIds: ["a1", "aa-gone", "b2", "zz-gone"] });
  });
});

describe("buildInitialEntries", () => {
  it("groups excluded tool ids into per-catalog subset entries", () => {
    const { entries } = buildInitialEntries({
      exclusions: { excludedToolIds: ["a1", "b2", "a3"] },
      toolIdsByCatalog,
    });
    expect(entries.get(CATALOG_A)?.selectedToolIds).toEqual(
      new Set(["a1", "a3"]),
    );
    expect(entries.get(CATALOG_B)?.selectedToolIds).toEqual(new Set(["b2"]));
  });

  it("reconstructs a fully-excluded server from all its tool ids", () => {
    const { entries, unresolvedToolIds } = buildInitialEntries({
      exclusions: { excludedToolIds: ["a1", "a2", "a3"] },
      toolIdsByCatalog,
    });
    expect(entries.get(CATALOG_A)?.selectedToolIds).toEqual(
      new Set(["a1", "a2", "a3"]),
    );
    expect(entries.size).toBe(1);
    expect(unresolvedToolIds).toEqual([]);
  });

  it("reports tool ids that no catalog list contains as unresolved", () => {
    const { entries, unresolvedToolIds } = buildInitialEntries({
      exclusions: { excludedToolIds: ["gone-tool", "a1"] },
      toolIdsByCatalog,
    });
    expect(unresolvedToolIds).toEqual(["gone-tool"]);
    expect(entries.get(CATALOG_A)?.selectedToolIds).toEqual(new Set(["a1"]));
  });

  it("round-trips through buildExclusionPayload without spurious changes", () => {
    const exclusions = { excludedToolIds: ["a1", "a2", "a3", "b1", "arch1"] };
    const { entries, unresolvedToolIds } = buildInitialEntries({
      exclusions,
      toolIdsByCatalog,
    });
    expect(
      buildExclusionPayload({
        entries: entries.values(),
        unresolvedToolIds,
      }),
    ).toEqual({ excludedToolIds: ["a1", "a2", "a3", "arch1", "b1"] });
  });
});

describe("computeDefaultExclusionToolIds", () => {
  const builtInTools = [
    // Pre-fill-exempt: query_knowledge_sources, the sandbox/file tools, and
    // the skill tools, plus the meta dispatch tools (covered below with a
    // branded prefix).
    { id: "t-knowledge", name: "archestra__query_knowledge_sources" },
    { id: "t-run-command", name: "archestra__run_command" },
    { id: "t-list-skills", name: "archestra__list_skills" },
    { id: "t-whoami", name: "acme__whoami" },
    { id: "t-artifact", name: "archestra__artifact_write" },
    { id: "t-create-agent", name: "archestra__create_agent" },
  ];

  it("excludes every unassigned tool outside the exempt set", () => {
    expect(computeDefaultExclusionToolIds({ builtInTools })).toEqual([
      "t-whoami",
      "t-artifact",
      "t-create-agent",
    ]);
  });

  it("never includes exempt short names, regardless of branding prefix", () => {
    expect(
      computeDefaultExclusionToolIds({
        builtInTools: [
          { id: "t-search", name: `acme__${TOOL_SEARCH_TOOLS_SHORT_NAME}` },
          { id: "t-run", name: `acme__${TOOL_RUN_TOOL_SHORT_NAME}` },
          { id: "t-cmd", name: "acme__run_command" },
          { id: "t-save", name: "acme__save_file" },
          { id: "t-skills", name: "acme__list_skills" },
          { id: "t-load-skill", name: "acme__load_skill" },
        ],
      }),
    ).toEqual([]);
  });

  it("skips tools assigned by id (existing agent's saved assignments)", () => {
    expect(
      computeDefaultExclusionToolIds({
        builtInTools,
        assignedToolIds: new Set(["t-artifact", "t-create-agent"]),
      }),
    ).toEqual(["t-whoami"]);
  });

  it("skips assumed-assigned short names via parseFullToolName, handling branded prefixes", () => {
    expect(
      computeDefaultExclusionToolIds({
        builtInTools,
        assumedAssignedShortNames: new Set(["whoami", "artifact_write"]),
      }),
    ).toEqual(["t-create-agent"]);
  });
});

describe("mergeExclusionsWithDefaultToolIds", () => {
  it("union-merges server exclusions with the default set, deduped and sorted", () => {
    expect(
      mergeExclusionsWithDefaultToolIds({
        exclusions: { excludedToolIds: ["t2", "t1"] },
        defaultExcludedToolIds: ["t3", "t1"],
      }),
    ).toEqual({ excludedToolIds: ["t1", "t2", "t3"] });
  });

  it("is the identity (modulo sorting) when the default set is empty", () => {
    expect(
      mergeExclusionsWithDefaultToolIds({
        exclusions: { excludedToolIds: ["t1"] },
        defaultExcludedToolIds: [],
      }),
    ).toEqual({ excludedToolIds: ["t1"] });
  });
});

describe("exclusionsKey", () => {
  it("is order-independent", () => {
    expect(exclusionsKey({ excludedToolIds: ["t2", "t1"] })).toBe(
      exclusionsKey({ excludedToolIds: ["t1", "t2"] }),
    );
  });

  it("differs when content differs", () => {
    expect(exclusionsKey({ excludedToolIds: ["t1"] })).not.toBe(
      exclusionsKey({ excludedToolIds: ["t2"] }),
    );
  });
});
