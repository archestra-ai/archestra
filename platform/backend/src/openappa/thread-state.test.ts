import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import db, { schema } from "@/database";
import { ThreadToolSchema } from "@/types/openappa-thread-state";
import { enterOpenappaEncryptedChat } from "./encrypted-chat";
import {
  clientKeepsThreadPairing,
  echoedCallsMessage,
  readThreadRequest,
  threadNotFoundBody,
  threadStates,
  threadToolsOf,
  toolSkeletonOf,
} from "./thread-state";

afterEach(() => enterOpenappaEncryptedChat(null));

describe("readThreadRequest", () => {
  test("reads a create and a continue, and nothing else", () => {
    expect(readThreadRequest({ thread: { type: "create" } })).toEqual({
      type: "create",
    });
    expect(
      readThreadRequest({
        thread: { type: "continue", previous_message_id: "msg_1" },
      }),
    ).toEqual({ type: "continue", previousMessageId: "msg_1" });
    expect(readThreadRequest({ thread: { type: "continue" } })).toBeUndefined();
    expect(readThreadRequest({})).toBeUndefined();
  });
});

describe("clientKeepsThreadPairing", () => {
  test("holds while the client has every call the provider has", () => {
    expect(
      clientKeepsThreadPairing({
        providerCallIds: ["a", "b"],
        clientCallIds: ["b", "a"],
        refused: false,
        held: false,
      }),
    ).toBe(true);
  });

  test("breaks when a call is dropped, the turn is refused, or output is held", () => {
    const base = {
      providerCallIds: ["a", "b"],
      clientCallIds: ["a", "b"],
      refused: false,
      held: false,
    };
    expect(clientKeepsThreadPairing({ ...base, clientCallIds: ["a"] })).toBe(
      false,
    );
    expect(clientKeepsThreadPairing({ ...base, refused: true })).toBe(false);
    expect(clientKeepsThreadPairing({ ...base, held: true })).toBe(false);
  });
});

describe("thread state rules", () => {
  const tools = threadToolsOf({
    declarations: [{ name: "Read" }, { name: "Bash", marker: "m" }],
    types: [undefined, "custom"],
  });
  const call = { id: "toolu_1", name: "Read", input: { path: "a" } };

  test("encrypted thread continuations retain evidence without plaintext rows or a decrypted shared cache", async () => {
    const chat = {
      organizationId: randomUUID(),
      userId: randomUUID(),
      audit: { conversationId: randomUUID(), dek: randomBytes(32) },
    };
    const messageId = randomUUID();
    const request = {
      organizationId: chat.organizationId,
      sessionId: chat.audit.conversationId,
      previousMessageId: messageId,
    };
    enterOpenappaEncryptedChat(chat);
    await threadStates.record({
      record: {
        organizationId: chat.organizationId,
        sessionId: chat.audit.conversationId,
        tools,
      },
      messageId,
      calls: [call],
      diverged: false,
    });
    expect(await threadStates.forContinue(request)).toMatchObject({
      ok: true,
      tools,
      calls: [call],
    });
    const [stored] = await db.select().from(schema.openappaThreadStatesTable);
    expect(stored.tools).toHaveProperty("__encrypted");
    expect(stored.calls).toHaveProperty("__encrypted");
    enterOpenappaEncryptedChat({
      ...chat,
      audit: { ...chat.audit, dek: randomBytes(32) },
    });
    expect(await threadStates.forContinue(request)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    enterOpenappaEncryptedChat(null);
    expect(await threadStates.forContinue(request)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    enterOpenappaEncryptedChat(chat);
    expect(await threadStates.forContinue(request)).toMatchObject({
      ok: true,
      tools,
      calls: [call],
    });
  });

  test("a tool input holding a NUL is stored and read back exactly", async () => {
    const organizationId = randomUUID();
    const sessionId = randomUUID();
    const messageId = randomUUID();
    const nulCall = {
      id: "toolu_nul",
      name: "Bash",
      input: { command: "printf 'head\u0000tail'" },
    };
    await threadStates.record({
      record: { organizationId, sessionId, tools },
      messageId,
      calls: [nulCall],
      diverged: false,
    });

    const [stored] = await db.select().from(schema.openappaThreadStatesTable);
    expect(JSON.stringify(stored.calls)).not.toContain("\\u0000");
    expect(
      await threadStates.forContinue({
        organizationId,
        sessionId,
        previousMessageId: messageId,
      }),
    ).toMatchObject({ ok: true, tools, calls: [nulCall] });
  });

  test("retains original contracts through JSON storage and continuation hydration", async () => {
    const tools = threadToolsOf({
      declarations: [
        {
          name: "gateway_a_control",
          marker: "marker",
          contract: "original-structured-contract",
        },
        {
          name: "gateway_b_control",
          marker: "marker",
          contract: "different-structured-contract",
        },
      ],
      types: [undefined, undefined],
    }).map((tool) => ThreadToolSchema.parse(JSON.parse(JSON.stringify(tool))));
    await threadStates.record({
      record: {
        organizationId: "contract-org",
        sessionId: "contract-session",
        tools,
      },
      messageId: "contract-root",
      calls: [],
      diverged: false,
    });
    const hydrated = await threadStates.forContinue({
      organizationId: "contract-org",
      sessionId: "contract-session",
      previousMessageId: "contract-root",
    });
    if (!hydrated.ok) throw new Error("expected retained thread evidence");
    expect(hydrated.tools.map((tool) => tool.contract)).toEqual([
      "original-structured-contract",
      "different-structured-contract",
    ]);
    // Generic hydration must not overwrite the evidence with equal schemas.
    expect(toolSkeletonOf(hydrated.tools)).toEqual([
      {
        name: "gateway_a_control",
        description: "",
        input_schema: { type: "object" },
      },
      {
        name: "gateway_b_control",
        description: "",
        input_schema: { type: "object" },
      },
    ]);
    expect(threadToolsOf({ declarations: hydrated.tools, types: [] })).toEqual(
      tools,
    );
  });

  test("a continue follows the root's tools and the calls the client holds, once", async () => {
    await threadStates.record({
      record: { organizationId: "org", sessionId: "s", tools },
      messageId: "msg_root",
      calls: [call],
      diverged: false,
    });
    const ask = (previousMessageId: string) =>
      threadStates.forContinue({
        organizationId: "org",
        sessionId: "s",
        previousMessageId,
      });

    // Until the next response is kept, the client may retry the continue.
    expect(await ask("msg_root")).toMatchObject({ ok: true, calls: [call] });
    expect(await ask("msg_root")).toMatchObject({ ok: true, calls: [call] });

    await threadStates.record({
      record: {
        organizationId: "org",
        sessionId: "s",
        rootMessageId: "msg_root",
        previousMessageId: "msg_root",
      },
      messageId: "msg_next",
      calls: [],
      diverged: false,
    });

    expect(await ask("msg_next")).toEqual({
      ok: true,
      tools,
      calls: [],
      rootMessageId: "msg_root",
    });
    // The provider refuses a second continue of a message, and the calls it
    // needed are gone with it.
    expect(await ask("msg_root")).toEqual({ ok: false, reason: "consumed" });
    expect(echoedCallsMessage([call])).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
      ],
    });
  });

  test.each([
    ["an unknown response", "msg_none", "s", "missing"],
    ["another session's response", "msg_other", "s", "foreign"],
    ["a response the client holds a rewrite of", "msg_bad", "s", "diverged"],
  ])("replays for %s", async (_name, previousMessageId, sessionId, reason) => {
    await threadStates.record({
      record: { organizationId: "org2", sessionId: "other", tools },
      messageId: "msg_other",
      calls: [],
      diverged: false,
    });
    await threadStates.record({
      record: { organizationId: "org2", sessionId: "s", tools },
      messageId: "msg_bad",
      calls: [],
      diverged: true,
    });

    expect(
      await threadStates.forContinue({
        organizationId: "org2",
        sessionId,
        previousMessageId,
      }),
    ).toEqual({ ok: false, reason });
  });

  test("another session learns only that the row is not its own, whatever state the row is in", async () => {
    await threadStates.record({
      record: { organizationId: "org5", sessionId: "owner", tools },
      messageId: "msg_owned_diverged",
      calls: [],
      diverged: true,
    });
    await threadStates.record({
      record: { organizationId: "org5", sessionId: "owner", tools },
      messageId: "msg_owned_spent",
      calls: [],
      diverged: false,
    });
    await threadStates.record({
      record: {
        organizationId: "org5",
        sessionId: "owner",
        rootMessageId: "msg_owned_spent",
        previousMessageId: "msg_owned_spent",
      },
      messageId: "msg_owned_next",
      calls: [],
      diverged: false,
    });

    for (const previousMessageId of ["msg_owned_diverged", "msg_owned_spent"])
      expect(
        await threadStates.forContinue({
          organizationId: "org5",
          sessionId: "intruder",
          previousMessageId,
        }),
      ).toEqual({ ok: false, reason: "foreign" });
  });

  test("replays when the root that set the tools has expired", async () => {
    await threadStates.record({
      record: { organizationId: "org3", sessionId: "s", tools },
      messageId: "msg_old_root",
      calls: [],
      diverged: false,
    });
    await threadStates.record({
      record: {
        organizationId: "org3",
        sessionId: "s",
        rootMessageId: "msg_old_root",
      },
      messageId: "msg_child",
      calls: [],
      diverged: false,
    });
    await threadStates.deleteExpired(new Date(Date.now() + 8 * 86_400_000));

    expect(
      await threadStates.forContinue({
        organizationId: "org3",
        sessionId: "s",
        previousMessageId: "msg_child",
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });

  test("keeps no calls for a response whose calls are too large to hold, and replays it", async () => {
    await threadStates.record({
      record: { organizationId: "org4", sessionId: "s", tools },
      messageId: "msg_big",
      calls: [{ id: "x", name: "Write", input: { text: "x".repeat(300_000) } }],
      diverged: false,
    });

    expect(
      await threadStates.forContinue({
        organizationId: "org4",
        sessionId: "s",
        previousMessageId: "msg_big",
      }),
    ).toEqual({ ok: false, reason: "diverged" });
  });

  test("measures the calls limit in bytes, not characters", async () => {
    // 150,000 characters, but 300,000 bytes in UTF-8.
    await threadStates.record({
      record: { organizationId: "org4", sessionId: "s", tools },
      messageId: "msg_wide",
      calls: [{ id: "x", name: "Write", input: { text: "é".repeat(150_000) } }],
      diverged: false,
    });

    expect(
      await threadStates.forContinue({
        organizationId: "org4",
        sessionId: "s",
        previousMessageId: "msg_wide",
      }),
    ).toEqual({ ok: false, reason: "diverged" });
  });
});

describe("what the ruling is given", () => {
  test("a tool skeleton names every declared tool and its type", () => {
    expect(
      toolSkeletonOf([{ name: "Read" }, { name: "Search", type: "custom" }]),
    ).toEqual([
      { name: "Read", description: "", input_schema: { type: "object" } },
      {
        name: "Search",
        type: "custom",
        description: "",
        input_schema: { type: "object" },
      },
    ]);
  });

  test("the proxy's own not-found names itself in the request id", () => {
    expect(threadNotFoundBody("req-7").request_id).toBe("req_archestra_req-7");
    expect(threadNotFoundBody("req-7").error.details.error_code).toBe(
      "thread_not_found",
    );
  });
});
