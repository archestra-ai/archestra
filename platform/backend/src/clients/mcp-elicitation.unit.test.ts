import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";
import {
  type McpElicitationHandler,
  McpElicitationRouter,
} from "./mcp-elicitation";

/** A client that keeps the one elicitation handler the SDK would call. */
function fakeClient() {
  let installed: McpElicitationHandler | undefined;
  const client = {
    setRequestHandler: (_schema: unknown, handler: McpElicitationHandler) => {
      installed = handler;
    },
  } as unknown as Client;
  return {
    client,
    /** The server asks a question; resolves to the name of who answered. */
    ask: async () => {
      if (!installed) throw new Error("no handler installed");
      const result = await installed(QUESTION, {} as never);
      return (result.content as { by: string } | undefined)?.by;
    },
  };
}

const QUESTION = {
  method: "elicitation/create",
  params: { message: "Continue?", requestedSchema: { type: "object" } },
} as unknown as ElicitRequest;

const answering =
  (by: string): McpElicitationHandler =>
  async () => ({ action: "accept", content: { by } });

/** A request that stays in flight until `finish` is called. */
function pending() {
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { request: () => done, finish };
}

describe("McpElicitationRouter", () => {
  test("a question asked inside a call's own request reaches that call", async () => {
    const router = new McpElicitationRouter();
    const { client, ask } = fakeClient();
    router.attach(client);
    const older = pending();
    const olderRun = router.run(client, answering("older"), older.request);

    // The SDK reads a request's response stream in that request's async
    // context, so the question arrives inside the newer call's run.
    const answeredBy = await router.run(client, answering("newer"), ask);

    expect(answeredBy).toBe("newer");
    older.finish();
    await olderRun;
  });

  test("a question asked outside any call goes to the oldest call still in flight", async () => {
    const router = new McpElicitationRouter();
    const { client, ask } = fakeClient();
    router.attach(client);
    const [a, b, c] = [pending(), pending(), pending()];
    const runA = router.run(client, answering("a"), a.request);
    const runB = router.run(client, answering("b"), b.request);
    const runC = router.run(client, answering("c"), c.request);

    expect(await ask()).toBe("a");

    // The oldest call ends: the next oldest is now first in line, not the
    // call that started last.
    a.finish();
    await runA;
    expect(await ask()).toBe("b");

    b.finish();
    await runB;
    expect(await ask()).toBe("c");

    c.finish();
    await runC;
  });

  test("a question after every call returned still reaches the latest call's handler", async () => {
    const router = new McpElicitationRouter();
    const { client, ask } = fakeClient();
    router.attach(client);
    await router.run(client, answering("first"), async () => {});
    await router.run(client, answering("last"), async () => {});

    expect(await ask()).toBe("last");
  });

  test("a question on a connection no call has used is cancelled", async () => {
    const router = new McpElicitationRouter();
    const { client } = fakeClient();
    let installed: McpElicitationHandler | undefined;
    (client as unknown as { setRequestHandler: unknown }).setRequestHandler = (
      _schema: unknown,
      handler: McpElicitationHandler,
    ) => {
      installed = handler;
    };
    router.attach(client);

    expect(await installed?.(QUESTION, {} as never)).toEqual({
      action: "cancel",
    });
  });
});
