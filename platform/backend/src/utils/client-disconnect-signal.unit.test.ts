import { describe, expect, test } from "vitest";
import { fetchWithAbortSignal } from "./client-disconnect-signal";

describe("fetchWithAbortSignal", () => {
  async function effectiveSignal(
    call: (fetch: NonNullable<ReturnType<typeof fetchWithAbortSignal>>) => void,
    disconnect: AbortSignal,
  ) {
    let seen: AbortSignal | undefined;
    const wrapped = fetchWithAbortSignal(async (input, init) => {
      seen = new Request(input, init).signal;
      return new Response("{}");
    }, disconnect);
    if (!wrapped) throw new Error("Expected a wrapped fetch");
    call(wrapped);
    await Promise.resolve();
    if (!seen) throw new Error("Expected the base fetch to run");
    return seen;
  }

  for (const shape of ["init", "Request"] as const) {
    test(`keeps the caller's own signal passed on ${shape === "init" ? "init" : "a Request"}`, async () => {
      const caller = new AbortController();
      const disconnect = new AbortController();
      const url = "http://upstream.test/v1/messages";
      const seen = await effectiveSignal(
        (wrapped) =>
          shape === "init"
            ? wrapped(url, { signal: caller.signal })
            : wrapped(new Request(url, { signal: caller.signal })),
        disconnect.signal,
      );
      caller.abort();
      expect(seen.aborted).toBe(true);
    });
  }

  test("aborts on the disconnect signal", async () => {
    const caller = new AbortController();
    const disconnect = new AbortController();
    const seen = await effectiveSignal(
      (wrapped) =>
        wrapped("http://upstream.test/v1/messages", { signal: caller.signal }),
      disconnect.signal,
    );
    disconnect.abort();
    expect(seen.aborted).toBe(true);
  });
});
