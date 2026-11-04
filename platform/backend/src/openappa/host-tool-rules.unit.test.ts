import { describe, expect, test } from "vitest";
import { type HostToolContext, withHostToolRules } from "./host-tool-rules";
import { toolEntries } from "./policy-text";

const ANNOTATED_CATCH_ALL = `[policy]
version = 2

[[policy.annotator]]
name = "tool-call"
builtin = "archestra"
ranks = ["suspicious", "trusted"]
audiences = []
marks = []
effects = []

[[policy.tool]]
name = "*"
annotator = "tool-call"
`;

const accept = async () => [];

const HOST: HostToolContext = {
  serverName: "archestra",
  gitSyncAudience: null,
};

const emptyRule = (name: string) =>
  expect.objectContaining({
    name,
    delta: {},
    annotator: undefined,
    requires: undefined,
  });

describe("withHostToolRules", () => {
  test("gives yell and the peer read empty rules ahead of an annotated catch-all", async () => {
    const text = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      host: HOST,
      validate: accept,
    });

    expect(toolEntries(text)).toEqual([
      emptyRule("mcp/appa/yell"),
      emptyRule("mcp/archestra/read_peer_message"),
      expect.objectContaining({ name: "*", annotator: "tool-call" }),
    ]);
  });

  test("composes the same bytes from the same document", async () => {
    const first = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      host: HOST,
      validate: accept,
    });
    const second = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      host: HOST,
      validate: accept,
    });

    expect(second).toBe(first);
    expect(
      await withHostToolRules({
        composed: first,
        host: HOST,
        validate: accept,
      }),
    ).toBe(first);
  });

  test("keeps the rules the organization wrote for both tools", async () => {
    const own = `${ANNOTATED_CATCH_ALL}
[[policy.tool]]
name = "mcp/appa/yell"
annotator = "tool-call"

[[policy.tool]]
name = "mcp/archestra/read_peer_message"
annotator = "tool-call"
`;

    expect(
      await withHostToolRules({ composed: own, host: HOST, validate: accept }),
    ).toBe(own);
  });

  test("keeps the composition when the runtime refuses the rules", async () => {
    const text = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      host: HOST,
      validate: async () => ["refused"],
    });

    expect(text).toBe(ANNOTATED_CATCH_ALL);
  });

  test("a refused peer read rule does not cost yell its rule", async () => {
    const text = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      host: HOST,
      validate: async (candidate) =>
        toolEntries(candidate).some(
          (tool) => tool.name === "mcp/archestra/read_peer_message",
        )
          ? ["refused"]
          : [],
    });

    expect(toolEntries(text).map((tool) => tool.name)).toEqual([
      "mcp/appa/yell",
      "*",
    ]);
  });

  test("rules the peer read under the white-labeled server name", async () => {
    const text = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      host: { ...HOST, serverName: "acme" },
      validate: accept,
    });

    expect(toolEntries(text).map((tool) => tool.name)).toEqual([
      "mcp/appa/yell",
      "mcp/acme/read_peer_message",
      "*",
    ]);
  });

  test("a Git-synced policy change requires the repository's audience over the organization's rules", async () => {
    const own = `${ANNOTATED_CATCH_ALL}
[[policy.tool]]
name = "mcp/archestra/update_guardrails_policy"
delta = {}

[[policy.tool]]
name = "mcp/archestra/update_guardrails_validation(content:*)"
delta = {}
`;
    const text = await withHostToolRules({
      composed: own,
      host: { ...HOST, gitSyncAudience: "public" },
      validate: accept,
    });

    const requires = { trust: "trusted", audience: { contains: ["public"] } };
    expect(
      toolEntries(text).filter((tool) => tool.name.includes("update_")),
    ).toEqual([
      expect.objectContaining({
        name: "mcp/archestra/update_guardrails_validation",
        requires,
      }),
      expect.objectContaining({
        name: "mcp/archestra/update_guardrails_policy",
        requires,
      }),
    ]);
  });
});
