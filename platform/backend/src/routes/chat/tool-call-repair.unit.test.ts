import { InvalidToolInputError, NoSuchToolError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import {
  createToolCallRepair,
  repairHarmonyToolName,
  repairMalformedToolInput,
} from "./tool-call-repair";

const AVAILABLE = [
  "archestra__run_command",
  "archestra__search_tools",
  "context7__resolve-library-id",
];

describe("repairHarmonyToolName", () => {
  test("strips a harmony channel marker and matches the registered tool", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
  });

  test("strips any harmony token, not just channel", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|constrain|>json",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
    expect(
      repairHarmonyToolName(
        "archestra__search_tools<|channel|>analysis",
        AVAILABLE,
      ),
    ).toBe("archestra__search_tools");
  });

  test("repairs non-archestra MCP tools too", () => {
    expect(
      repairHarmonyToolName(
        "context7__resolve-library-id<|channel|>final",
        AVAILABLE,
      ),
    ).toBe("context7__resolve-library-id");
  });

  test("returns null for an already-valid name (no token)", () => {
    expect(
      repairHarmonyToolName("archestra__run_command", AVAILABLE),
    ).toBeNull();
  });

  test("returns null when the cleaned prefix is not a registered tool", () => {
    expect(
      repairHarmonyToolName(
        "archestra__ghost_tool<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBeNull();
  });

  test("returns null when the token is at the very start (nothing left)", () => {
    expect(
      repairHarmonyToolName("<|channel|>commentary", AVAILABLE),
    ).toBeNull();
  });

  test("returns null for a genuinely-unknown name without a token", () => {
    expect(repairHarmonyToolName("totally_made_up", AVAILABLE)).toBeNull();
  });

  test("does not strip an unclosed `<|` that is not a harmony token", () => {
    // a partial/garbage marker must not silently re-map to a different tool.
    expect(
      repairHarmonyToolName("archestra__run_command<|garbage", AVAILABLE),
    ).toBeNull();
  });

  test("does not strip a closed sentinel outside the harmony vocabulary", () => {
    // a closed `<|word|>` that is not a real harmony token must not trigger
    // repair — only the registered-tool match would otherwise gate it.
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|garbage|>suffix",
        AVAILABLE,
      ),
    ).toBeNull();
  });

  test("splits on the first harmony token when several are present", () => {
    expect(
      repairHarmonyToolName(
        "archestra__run_command<|constrain|>json<|channel|>commentary",
        AVAILABLE,
      ),
    ).toBe("archestra__run_command");
  });
});

describe("repairMalformedToolInput", () => {
  test("returns valid JSON unchanged", () => {
    const input = '{"path":"/a","count":2}';
    expect(repairMalformedToolInput(input)).toBe(input);
  });

  test("drops a stray trailing brace on a new line", () => {
    const repaired = repairMalformedToolInput('{"path":"/a"}\n}');
    expect(repaired).toBe('{"path":"/a"}');
    expect(JSON.parse(repaired as string)).toEqual({ path: "/a" });
  });

  test("drops trailing prose after a complete object", () => {
    expect(repairMalformedToolInput('{"a":1} here you go!')).toBe('{"a":1}');
  });

  test("recovers an object whose string values contain braces and escaped quotes, then trailing garbage", () => {
    // Mirrors the real failure: a large text field full of `}` and `\"`, with a
    // duplicated closing brace appended by the model.
    const intended = {
      path: "/home/sandbox/app.html",
      source: { type: "text", text: 'body { color: red; } and a "quote"' },
    };
    const malformed = `${JSON.stringify(intended)}\n}`;
    const repaired = repairMalformedToolInput(malformed);
    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired as string)).toEqual(intended);
  });

  test("recovers a top-level array with trailing garbage", () => {
    expect(repairMalformedToolInput("[1,2,3]]")).toBe("[1,2,3]");
  });

  test("returns null for an unterminated string (not safely recoverable)", () => {
    expect(repairMalformedToolInput('{"a":"no close')).toBeNull();
  });

  test("returns null for a missing closing brace", () => {
    expect(repairMalformedToolInput('{"a":1')).toBeNull();
  });

  test("returns null when there is no JSON value at all", () => {
    expect(repairMalformedToolInput("just some text")).toBeNull();
  });
});

describe("createToolCallRepair", () => {
  const INPUT_SCHEMA = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  } as const;

  /**
   * A model that answers a `generateObject` re-ask with the given object. The
   * re-ask runs for real against it, so these tests break if the prompt or the
   * schema handoff regresses.
   */
  function repairModelReturning(object: unknown) {
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        content: [{ type: "text" as const, text: JSON.stringify(object) }],
        warnings: [],
      }),
    });
  }

  function repair(params: {
    createRepairModel: () => Promise<never> | Promise<MockLanguageModelV3>;
  }) {
    return createToolCallRepair({
      toolNames: AVAILABLE,
      logContext: { sessionId: "s1" },
      createRepairModel: params.createRepairModel,
    });
  }

  const inputSchema = async () => INPUT_SCHEMA as unknown as never;

  test("recovers a harmony-marked tool name without consulting a model", async () => {
    const createRepairModel = vi.fn();
    const repaired = await repair({ createRepairModel })({
      toolCall: {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "archestra__run_command<|channel|>commentary",
        input: "{}",
      },
      error: new NoSuchToolError({
        toolName: "archestra__run_command<|channel|>commentary",
      }),
      tools: {},
      inputSchema,
      messages: [],
      system: undefined,
    } as never);

    expect(repaired?.toolName).toBe("archestra__run_command");
    expect(createRepairModel).not.toHaveBeenCalled();
  });

  test("repairs trailing-garbage arguments without paying for a model re-ask", async () => {
    const createRepairModel = vi.fn();
    const repaired = await repair({ createRepairModel })({
      toolCall: {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "archestra__search_tools",
        input: '{"query":"tickets"}}',
      },
      error: new InvalidToolInputError({
        toolName: "archestra__search_tools",
        toolInput: '{"query":"tickets"}}',
        cause: new Error("parse"),
      }),
      tools: {},
      inputSchema,
      messages: [],
      system: undefined,
    } as never);

    expect(JSON.parse(repaired?.input as string)).toEqual({
      query: "tickets",
    });
    // The deterministic pass must short-circuit: a re-ask costs a round-trip.
    expect(createRepairModel).not.toHaveBeenCalled();
  });

  test("re-asks the model when the arguments cannot be recovered deterministically", async () => {
    // A `>` where the `:` belongs. The braces balance, so isolating the first
    // complete JSON value returns the input unchanged and cannot help.
    const malformed = '{"query">"volume drop by client"}';
    expect(repairMalformedToolInput(malformed)).toBeNull();

    const repaired = await repair({
      createRepairModel: async () =>
        repairModelReturning({ query: "volume drop by client" }),
    })({
      toolCall: {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "archestra__search_tools",
        input: malformed,
      },
      error: new InvalidToolInputError({
        toolName: "archestra__search_tools",
        toolInput: malformed,
        cause: new Error("parse"),
      }),
      tools: {},
      inputSchema,
      messages: [],
      system: undefined,
    } as never);

    expect(JSON.parse(repaired?.input as string)).toEqual({
      query: "volume drop by client",
    });
  });

  test("gives up rather than throwing when the re-ask itself fails", async () => {
    const repaired = await repair({
      createRepairModel: async () => {
        throw new Error("no credential");
      },
    })({
      toolCall: {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "archestra__search_tools",
        input: '{"query">"x"}',
      },
      error: new InvalidToolInputError({
        toolName: "archestra__search_tools",
        toolInput: '{"query">"x"}',
        cause: new Error("parse"),
      }),
      tools: {},
      inputSchema,
      messages: [],
      system: undefined,
    } as never);

    expect(repaired).toBeNull();
  });

  test("leaves errors it does not understand alone", async () => {
    const createRepairModel = vi.fn();
    const repaired = await repair({ createRepairModel })({
      toolCall: {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "archestra__search_tools",
        input: "{}",
      },
      error: new Error("something else"),
      tools: {},
      inputSchema,
      messages: [],
      system: undefined,
    } as never);

    expect(repaired).toBeNull();
    expect(createRepairModel).not.toHaveBeenCalled();
  });
});
