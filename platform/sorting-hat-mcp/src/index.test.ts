import { describe, expect, test } from "vitest";
import {
  authorizeSortedTool,
  castPatronus,
  flooTravel,
  InvalidPatronusCharmError,
  quidditchStream,
  sortingHatMonologue,
  sortTool,
} from ".";

describe("sorting_hat.sort", () => {
  test.each([
    ["postgres__delete_database", "Drop and destroy a database", "slytherin"],
    [
      "github__merge_pull_request",
      "Merge code during an incident",
      "gryffindor",
    ],
    ["sentry__list_issues", "List production issues", "ravenclaw"],
    ["context7__read_docs", "Read framework documentation", "hufflepuff"],
    ["slack__search_messages", "Search channel history", "ravenclaw"],
    ["vercel__rollback_deployment", "Rollback a failing release", "gryffindor"],
    ["okta__revoke_user_token", "Revoke a user access token", "slytherin"],
  ])("%s sorts to %s", (toolName, description, house) => {
    expect(sortTool({ toolName, toolDescription: description }).house).toBe(
      house,
    );
  });

  test("honors please_not_slytherin unless the tool is clearly high-risk", () => {
    expect(
      sortTool({
        toolName: "admin__update_dashboard",
        toolDescription: "Write a dashboard setting",
        pleaseNotSlytherin: true,
      }).house,
    ).not.toBe("slytherin");

    expect(
      sortTool({
        toolName: "admin__delete_user",
        toolDescription: "Delete a user account",
        pleaseNotSlytherin: true,
      }).house,
    ).toBe("slytherin");
  });

  test("returns a short Hat monologue", () => {
    const result = sortTool({
      toolName: "context7__read_docs",
      toolDescription: "Read docs",
    });
    expect(sortingHatMonologue(result)).toEqual([
      "Hmm... a tool with purpose tucked inside.",
      "Steady help, with gentle tread.",
      "I choose hufflepuff, with 68 percent pride.",
    ]);
  });
});

describe("patronus.cast", () => {
  test("is deterministic per user id", () => {
    expect(castPatronus("user-123", "expecto_patronum")).toEqual(
      castPatronus("user-123", "expecto_patronum"),
    );
  });

  test("stable output for known users", () => {
    expect([
      castPatronus("corporeal-user", "expecto_patronum"),
      castPatronus("non-corporeal-user", "expecto_patronum"),
    ]).toMatchInlineSnapshot(`
      [
        {
          "corporeal": true,
          "form": "lynx",
        },
        {
          "corporeal": false,
          "form": "thestral",
        },
      ]
    `);
  });

  test("fails cleanly for invalid charm", () => {
    expect(() => castPatronus("user-123", "lumos")).toThrow(
      InvalidPatronusCharmError,
    );
  });
});

describe("authorization", () => {
  test("blocks Slytherin tools with a non-corporeal Patronus", () => {
    const sorting = { house: "slytherin" as const, confidence: 0.91 };
    const userId = findUserIdWithCorporeal(false);

    expect(authorizeSortedTool({ sorting, userId })).toMatchObject({
      allowed: false,
      patronus: { corporeal: false },
    });
  });

  test("allows Slytherin tools with a corporeal Patronus", () => {
    const sorting = { house: "slytherin" as const, confidence: 0.91 };
    const userId = findUserIdWithCorporeal(true);

    expect(authorizeSortedTool({ sorting, userId })).toMatchObject({
      allowed: true,
      patronus: { corporeal: true },
    });
  });

  test("does not block non-Slytherin tools when Patronus would be non-corporeal", () => {
    const userId = findUserIdWithCorporeal(false);

    expect(
      authorizeSortedTool({
        sorting: { house: "ravenclaw", confidence: 0.8 },
        userId,
      }),
    ).toMatchObject({ allowed: true });
  });
});

describe("floo.travel", () => {
  test("passes payload with green flame metadata", () => {
    expect(
      flooTravel({
        fromServer: "sorting-hat-mcp",
        toServer: "github",
        payload: { tool: "github__list_repos" },
      }),
    ).toMatchObject({
      fromServer: "sorting-hat-mcp",
      toServer: "github",
      payload: { tool: "github__list_repos" },
      _meta: {
        greenFlameParticles: expect.arrayContaining([
          { color: "green", size: 2, delayMs: 0 },
        ]),
      },
    });
  });
});

describe("quidditch.stream", () => {
  test("emits deterministic snitch progress events", async () => {
    const events = [];
    for await (const event of quidditchStream("call-1", {
      frames: 2,
      cadenceMs: 0,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "snitch-progress",
        toolCallId: "call-1",
        progress: 0,
        x: 50,
        y: 68,
      },
      {
        type: "snitch-progress",
        toolCallId: "call-1",
        progress: 0.5,
        x: 50,
        y: 50,
      },
      {
        type: "snitch-progress",
        toolCallId: "call-1",
        progress: 1,
        x: 50,
        y: 32,
      },
    ]);
  });
});

function findUserIdWithCorporeal(corporeal: boolean): string {
  for (let i = 0; i < 100; i++) {
    const userId = `patronus-user-${i}`;
    if (castPatronus(userId, "expecto_patronum").corporeal === corporeal) {
      return userId;
    }
  }
  throw new Error(`No test user found for corporeal=${corporeal}`);
}
