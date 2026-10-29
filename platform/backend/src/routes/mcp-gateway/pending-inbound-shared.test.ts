import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, type Mock, test, vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  PendingInboundRequests,
  type PendingRequestRecord,
} from "./pending-inbound-requests";
import { cachedPendingRequests } from "./pending-inbound-shared";

setupTestCacheManager();

const ORG = "org";
const CALLER = "user:caller";

describe("shared pending inbound requests", () => {
  const registries: PendingInboundRequests[] = [];

  afterEach(async () => {
    await Promise.all(registries.splice(0).map((registry) => registry.close()));
  });

  test("the first answer wins and a conflicting or identical replay cannot restage it", async () => {
    const onmessage = clientMessage();
    const asking = registry(onmessage);
    const other = registry();
    const wireId = await asking.register(pending(onmessage));
    const message = (choice: string) => ({
      jsonrpc: "2.0",
      id: wireId,
      result: { choice },
    });

    await expect(
      other.acceptAnswer(answer(wireId, message("first"))),
    ).resolves.toBe(true);
    await expect(
      other.acceptAnswer(answer(wireId, message("first"))),
    ).resolves.toBe(false);
    await expect(
      asking.acceptAnswer(answer(wireId, message("second"))),
    ).resolves.toBe(false);

    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledTimes(1));
    expect(onmessage).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      result: { choice: "first" },
    });
  });

  test("simultaneous local and remote claims deliver one answer", async () => {
    const onmessage = clientMessage();
    const asking = registry(onmessage);
    const other = registry();
    const wireId = await asking.register(pending(onmessage));
    const message = (choice: string) => ({
      jsonrpc: "2.0",
      id: wireId,
      result: { choice },
    });

    const claims = await Promise.all([
      asking.acceptAnswer(answer(wireId, message("local"))),
      other.acceptAnswer(answer(wireId, message("remote"))),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledTimes(1));
    expect(["local", "remote"]).toContain(
      deliveredChoice(onmessage.mock.calls[0]?.[0]),
    );
  });

  test("rejects a different organization or caller and still accepts the asked caller", async () => {
    const onmessage = clientMessage();
    const asking = registry(onmessage);
    const other = registry();
    const wireId = await asking.register(pending(onmessage));

    await expect(
      other.acceptAnswer({
        ...answer(wireId, {
          jsonrpc: "2.0",
          id: wireId,
          result: { choice: "no" },
        }),
        organizationId: "other-org",
      }),
    ).resolves.toBe(false);
    await expect(
      other.acceptAnswer({
        ...answer(wireId, {
          jsonrpc: "2.0",
          id: wireId,
          result: { choice: "no" },
        }),
        caller: "token:other",
      }),
    ).resolves.toBe(false);
    expect(onmessage).not.toHaveBeenCalled();

    await expect(
      other.acceptAnswer(
        answer(wireId, {
          jsonrpc: "2.0",
          id: wireId,
          result: { choice: "yes" },
        }),
      ),
    ).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(onmessage).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id: 1,
        result: { choice: "yes" },
      }),
    );
  });

  test("does not claim or deliver after the owner lease or the absolute deadline has passed", async () => {
    const onmessage = clientMessage();
    const asking = registry(onmessage, 60_000);
    const wireId = await asking.register(pending(onmessage));
    await cacheManager.deleteByPrefix(
      `${CacheKey.McpGatewayPendingRequest}-owner-`,
    );
    await expect(
      cachedPendingRequests.claim(
        answer(wireId, {
          jsonrpc: "2.0",
          id: wireId,
          result: { choice: "late" },
        }),
      ),
    ).resolves.toBe(false);

    const fresh = registry(onmessage, 60_000);
    const liveId = await fresh.register(pending(onmessage));
    const record = await cacheManager.get<PendingRequestRecord>(
      recordKey(liveId),
    );
    if (!record) throw new Error("registration was not stored");
    await cacheManager.set(
      recordKey(liveId),
      { ...record, deadlineAt: 1 },
      60_000,
    );
    await expect(
      cachedPendingRequests.claim(
        answer(liveId, {
          jsonrpc: "2.0",
          id: liveId,
          result: { choice: "expired" },
        }),
      ),
    ).resolves.toBe(false);
    expect(onmessage).not.toHaveBeenCalled();
  });

  test("a dead owner does not receive an answer that was already queued", async () => {
    const onmessage = clientMessage();
    const asking = registry(onmessage, 60_000);
    const wireId = await asking.register(pending(onmessage));
    await expect(
      cachedPendingRequests.claim(
        answer(wireId, {
          jsonrpc: "2.0",
          id: wireId,
          result: { choice: "queued" },
        }),
      ),
    ).resolves.toBe(true);
    await cacheManager.deleteByPrefix(
      `${CacheKey.McpGatewayPendingRequest}-owner-`,
    );
    await expect(
      cachedPendingRequests.take({
        ownerId: asking.ownerId,
        wireIds: [wireId],
      }),
    ).resolves.toEqual([]);
    await expect(
      cachedPendingRequests.claim(
        answer(wireId, {
          jsonrpc: "2.0",
          id: wireId,
          result: { choice: "restage" },
        }),
      ),
    ).resolves.toBe(false);
    expect(onmessage).not.toHaveBeenCalled();
  });

  test("storage failures during remember, claim, and take propagate and do not deliver", async () => {
    const onmessage = clientMessage();
    const failing = registry(onmessage, 60_000);
    vi.spyOn(cacheManager, "withLock").mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(failing.register(pending(onmessage))).rejects.toThrow(
      "db down",
    );

    const asking = registry(onmessage, 60_000);
    const wireId = await asking.register(pending(onmessage));
    vi.spyOn(cacheManager, "withLock").mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(
      asking.acceptAnswer(
        answer(wireId, {
          jsonrpc: "2.0",
          id: wireId,
          result: { choice: "post" },
        }),
      ),
    ).rejects.toThrow("db down");
    expect(onmessage).not.toHaveBeenCalled();

    await cachedPendingRequests.claim(
      answer(wireId, {
        jsonrpc: "2.0",
        id: wireId,
        result: { choice: "queued" },
      }),
    );
    vi.spyOn(cacheManager, "withLock").mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(
      cachedPendingRequests.take({
        ownerId: asking.ownerId,
        wireIds: [wireId],
      }),
    ).rejects.toThrow("db down");
    const taken = await cachedPendingRequests.take({
      ownerId: asking.ownerId,
      wireIds: [wireId],
    });
    expect(taken).toHaveLength(1);
    expect(taken[0]?.parked.message).toMatchObject({
      result: { choice: "queued" },
    });
    expect(onmessage).not.toHaveBeenCalled();
  });

  test("close forgets the shared registration and finishes in-flight writes", async () => {
    const asking = registry(undefined, 60_000);
    const wireId = await asking.register(pending());
    await asking.close();
    await expect(cachedPendingRequests.lookup(wireId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      cachedPendingRequests.claim(
        answer(wireId, { jsonrpc: "2.0", id: wireId, result: {} }),
      ),
    ).resolves.toBe(false);
  });

  test("an expired owner lease does not consume a queued answer", async () => {
    const onmessage = clientMessage();
    const asking = registry(onmessage, 60_000);
    const wireId = await asking.register(pending(onmessage));
    await cachedPendingRequests.claim(
      answer(wireId, {
        jsonrpc: "2.0",
        id: wireId,
        result: { choice: "kept" },
      }),
    );
    await cacheManager.deleteByPrefix(
      `${CacheKey.McpGatewayPendingRequest}-owner-`,
    );
    await expect(
      cachedPendingRequests.take({
        ownerId: asking.ownerId,
        wireIds: [wireId],
      }),
    ).resolves.toEqual([]);
    await expect(cachedPendingRequests.lookup(wireId)).resolves.toMatchObject({
      status: "queued",
    });
    await cachedPendingRequests.renewOwner({
      ownerId: asking.ownerId,
      expiresAt: Date.now() + 30_000,
      ttlMs: 30_000,
    });
    const taken = await cachedPendingRequests.take({
      ownerId: asking.ownerId,
      wireIds: [wireId],
    });
    expect(taken).toHaveLength(1);
    expect(taken[0]?.parked.message).toMatchObject({
      result: { choice: "kept" },
    });
    expect(onmessage).not.toHaveBeenCalled();
  });

  function registry(
    onmessage?: ClientMessage,
    pollMs = 20,
  ): PendingInboundRequests {
    const created = new PendingInboundRequests({
      shared: cachedPendingRequests,
      pollMs,
    });
    registries.push(created);
    if (onmessage) {
      const transport = pending(onmessage).transport;
      transport.onmessage = sdkOnMessage(onmessage);
    }
    return created;
  }

  function pending(onmessage?: ClientMessage) {
    const transport = {
      onmessage: onmessage ? sdkOnMessage(onmessage) : undefined,
    } as StreamableHTTPServerTransport;
    return {
      id: 1 as const,
      transport,
      agentId: "agent",
      organizationId: ORG,
      caller: CALLER,
    };
  }

  function answer(wireId: string, message: Record<string, unknown>) {
    return {
      wireId,
      agentId: "agent",
      organizationId: ORG,
      caller: CALLER,
      message,
    };
  }

  function recordKey(wireId: string) {
    return `${CacheKey.McpGatewayPendingRequest}-${wireId}` as const;
  }
});

type ClientMessage = (
  message: JSONRPCMessage,
  extra?: MessageExtraInfo,
) => void;

type SdkOnMessage = NonNullable<StreamableHTTPServerTransport["onmessage"]>;

function clientMessage(): Mock<ClientMessage> {
  return vi.fn<ClientMessage>();
}

function sdkOnMessage(heard: ClientMessage): SdkOnMessage {
  return (...args) => heard(...args);
}

function deliveredChoice(
  message: JSONRPCMessage | undefined,
): string | undefined {
  if (!message || !("result" in message)) return undefined;
  const { result } = message;
  if (result == null || typeof result !== "object" || !("choice" in result)) {
    return undefined;
  }
  return typeof result.choice === "string" ? result.choice : undefined;
}
