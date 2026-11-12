import { describe, expect, test } from "vitest";
import {
  formatHostClientCodingAliases,
  withHostClientCodingAliases,
  withHostToolRules,
} from "./host-tool-rules";
import { asRecord, parsePolicyToml, toolEntries } from "./policy-text";

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
      serverName: "archestra",
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
      serverName: "archestra",
      validate: accept,
    });
    const second = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      serverName: "archestra",
      validate: accept,
    });

    expect(second).toBe(first);
    expect(
      await withHostToolRules({
        composed: first,
        serverName: "archestra",
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
      await withHostToolRules({
        composed: own,
        serverName: "archestra",
        validate: accept,
      }),
    ).toBe(own);
  });

  test("keeps the composition when the runtime refuses the rules", async () => {
    const text = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      serverName: "archestra",
      validate: async () => ["refused"],
    });

    expect(text).toBe(ANNOTATED_CATCH_ALL);
  });

  test("a refused peer read rule does not cost yell its rule", async () => {
    const text = await withHostToolRules({
      composed: ANNOTATED_CATCH_ALL,
      serverName: "archestra",
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
      serverName: "acme",
      validate: accept,
    });

    expect(toolEntries(text).map((tool) => tool.name)).toEqual([
      "mcp/appa/yell",
      "mcp/acme/read_peer_message",
      "*",
    ]);
  });
});

const ACTIVE_CODING_BATTERIES = [
  {
    name: "coding",
    policy: `[policy]
version = 2

[[policy.tool]]
name = "tool/coding/read_file"
delta = {}
`,
  },
  {
    name: "claude-code",
    policy: `[aliases.tool.coding]
read_file = [{ name = "host/claude-code/Read", args = { file_path = "file_path" } }]

[policy]
version = 2
`,
  },
];

describe("withHostClientCodingAliases", () => {
  test("fills missing client coding targets into a legacy saved root without duplicating existing entries", () => {
    const legacyRoot = `include = [
  "batteries/coding/appa.toml",
  "batteries/claude-code/appa.toml",
]

[aliases.host]
claude-code = ["archestra"]

[aliases.tool.coding]
read_file = [{ name = "host/archestra/read", args = { file_path = "filePath" } }]

[policy]
version = 2
`;

    const augmented = withHostClientCodingAliases({
      root: legacyRoot,
      batteries: ACTIVE_CODING_BATTERIES,
    });
    const codingAliases = asRecord(
      asRecord(asRecord(parsePolicyToml(augmented)?.aliases)?.tool)?.coding,
    );

    expect(codingAliases?.read_file).toEqual([
      { name: "host/archestra/read", args: { file_path: "filePath" } },
      { name: "host/archestra/read_file", args: { file_path: "target_file" } },
      { name: "host/archestra/view", args: { file_path: "path" } },
    ]);
    expect(codingAliases?.write_file).toEqual([
      { name: "host/archestra/write", args: { file_path: "filePath" } },
      { name: "host/archestra/create", args: { file_path: "path" } },
    ]);
    expect(codingAliases?.edit_file).toEqual([
      { name: "host/archestra/edit", args: { file_path: "filePath" } },
    ]);
    expect(codingAliases?.fetch_url).toEqual([
      { name: "host/archestra/webfetch", args: { url: "url" } },
      {
        name: "host/archestra/mcp__workspace__web_fetch",
        args: { url: "url" },
      },
      { name: "host/archestra/FetchURL", args: { url: "url" } },
      { name: "host/archestra/web_fetch", args: { url: "url" } },
    ]);
    expect(
      withHostClientCodingAliases({
        root: augmented,
        batteries: ACTIVE_CODING_BATTERIES,
      }),
    ).toBe(augmented);
  });

  test("returns a current initial policy root byte-for-byte unchanged", () => {
    const currentRoot = `include = [
  "batteries/coding/appa.toml",
  "batteries/claude-code/appa.toml",
]

[aliases.host]
claude-code = ["archestra"]

# Operator comment stays untouched when all targets are present.
${formatHostClientCodingAliases()}

[policy]
version = 2
`;

    expect(
      withHostClientCodingAliases({
        root: currentRoot,
        batteries: ACTIVE_CODING_BATTERIES,
      }),
    ).toBe(currentRoot);
  });

  test("leaves the root untouched when coding is absent, stubbed, or claude-code does not bind archestra", () => {
    const rootWithoutAliases = `[aliases.host]
claude-code = ["archestra"]

[policy]
version = 2
`;
    expect(
      withHostClientCodingAliases({
        root: rootWithoutAliases,
        batteries: [],
      }),
    ).toBe(rootWithoutAliases);
    expect(
      withHostClientCodingAliases({
        root: rootWithoutAliases,
        batteries: [{ name: "coding", policy: "[policy]\nversion = 2\n" }],
      }),
    ).toBe(rootWithoutAliases);

    const otherHostRoot = `[aliases.host]
claude-code = ["custom-host"]

[policy]
version = 2
`;
    expect(
      withHostClientCodingAliases({
        root: otherHostRoot,
        batteries: ACTIVE_CODING_BATTERIES,
      }),
    ).toBe(otherHostRoot);
  });

  test("preserves custom operator mappings for a client tool name without adding a duplicate", () => {
    const customRoot = `[aliases.host]
claude-code = ["archestra"]

[aliases.tool.custom]
reader = [{ name = "host/archestra/view", args = { target = "path" } }]

[aliases.tool.coding]
read_file = [{ name = "host/archestra/read_file", args = { file_path = "custom_arg" } }]

[policy]
version = 2
`;
    const augmented = withHostClientCodingAliases({
      root: customRoot,
      batteries: ACTIVE_CODING_BATTERIES,
    });
    const codingAliases = asRecord(
      asRecord(asRecord(parsePolicyToml(augmented)?.aliases)?.tool)?.coding,
    );

    expect(codingAliases?.read_file).toEqual([
      { name: "host/archestra/read_file", args: { file_path: "custom_arg" } },
      { name: "host/archestra/read", args: { file_path: "filePath" } },
    ]);
  });
});
