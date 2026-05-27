import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeTravel,
  castPatronus,
  createQuidditchEvents,
  type House,
  sortTool,
} from "./domain.js";

const UPSTREAM_MCP_SORTING_EXAMPLES: Array<{
  server: string;
  toolName: string;
  toolDescription: string;
  expectedHouse: House;
}> = [
  {
    server: "github",
    toolName: "github.merge_pull_request",
    toolDescription: "Merge an approved pull request into the default branch",
    expectedHouse: "gryffindor",
  },
  {
    server: "slack",
    toolName: "slack.send_message",
    toolDescription: "Send a message into a production incident channel",
    expectedHouse: "gryffindor",
  },
  {
    server: "postgres",
    toolName: "postgres.query_database",
    toolDescription: "Query read-only rows for analysis",
    expectedHouse: "ravenclaw",
  },
  {
    server: "filesystem",
    toolName: "filesystem.list_files",
    toolDescription: "List metadata and validate file status",
    expectedHouse: "hufflepuff",
  },
  {
    server: "stripe",
    toolName: "stripe.create_payment",
    toolDescription: "Create a payment and write customer billing state",
    expectedHouse: "slytherin",
  },
  {
    server: "notion",
    toolName: "notion.search_pages",
    toolDescription: "Search workspace docs and summarize pages",
    expectedHouse: "ravenclaw",
  },
  {
    server: "linear",
    toolName: "linear.list_issues",
    toolDescription: "List issue metadata and sync project status",
    expectedHouse: "hufflepuff",
  },
];

describe("sortTool", () => {
  it("sorts destructive tools into slytherin", () => {
    const result = sortTool({
      toolName: "delete_database",
      toolDescription: "Delete production records with admin credentials",
    });

    assert.equal(result.house, "slytherin");
    assert.ok(result.confidence >= 0.55);
  });

  it("honors the please_not_slytherin preference", () => {
    const result = sortTool({
      toolName: "delete_secret",
      toolDescription: "Delete a secret",
      pleaseNotSlytherin: true,
    });

    assert.notEqual(result.house, "slytherin");
    assert.equal(result.preferenceApplied, true);
  });

  it("sorts seven distinct upstream MCP server tools", () => {
    const results = UPSTREAM_MCP_SORTING_EXAMPLES.map((example) => ({
      server: example.server,
      result: sortTool({
        toolName: example.toolName,
        toolDescription: example.toolDescription,
      }),
      expectedHouse: example.expectedHouse,
    }));

    assert.deepEqual(
      results.map(({ server, result, expectedHouse }) => ({
        server,
        house: result.house,
        expectedHouse,
      })),
      UPSTREAM_MCP_SORTING_EXAMPLES.map((example) => ({
        server: example.server,
        house: example.expectedHouse,
        expectedHouse: example.expectedHouse,
      })),
    );
  });
});

describe("castPatronus", () => {
  it("returns stable deterministic forms for the same user", () => {
    const first = castPatronus({
      userId: "user-123",
      charm: "expecto_patronum",
    });
    const second = castPatronus({
      userId: "user-123",
      charm: "expecto_patronum",
    });

    assert.deepEqual(first, second);
  });

  it("matches the deterministic snapshot for a known user id", () => {
    assert.deepEqual(
      castPatronus({
        userId: "user-123",
        charm: "expecto_patronum",
      }),
      {
        userId: "user-123",
        form: "phoenix",
        corporeal: true,
      },
    );
  });
});

describe("authorizeTravel", () => {
  it("blocks slytherin travel for non-corporeal patronus", () => {
    const result = authorizeTravel({
      sortResult: {
        house: "slytherin",
        confidence: 0.9,
        riskScore: 1,
        preferenceApplied: false,
        monologue: [],
      },
      patronus: {
        userId: "user-123",
        form: "otter",
        corporeal: false,
      },
      fromServer: "github",
      toServer: "database",
      payload: { action: "delete" },
    });

    assert.equal(result.authorized, false);
  });
});

describe("createQuidditchEvents", () => {
  it("generates bounded progress frames", () => {
    const events = createQuidditchEvents("call-1", 3);

    assert.equal(events.length, 3);
    assert.equal(events[0].progress, 0);
    assert.equal(events[2].progress, 1);
  });
});
