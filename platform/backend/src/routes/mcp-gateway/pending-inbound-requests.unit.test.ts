import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ParkedClientMessage,
  PendingInboundRequests,
  type PendingRequestRecord,
  type SharedPendingRequests,
} from "./pending-inbound-requests";

const ORG = "org";
const CALLER = "user:caller";
const transports = new Set<StreamableHTTPServerTransport>();
let pendingInboundRequests: PendingInboundRequests;

beforeEach(() => {
  pendingInboundRequests = new PendingInboundRequests();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const transport of transports) {
    pendingInboundRequests.forgetTransport({ transport });
  }
  transports.clear();
  await pendingInboundRequests.close();
});

function makeTransport(): StreamableHTTPServerTransport {
  const transport = {} as StreamableHTTPServerTransport;
  transports.add(transport);
  return transport;
}

function registration(overrides: {
  id: string | number;
  transport: StreamableHTTPServerTransport;
  caller?: string;
  organizationId?: string;
}) {
  return {
    id: overrides.id,
    transport: overrides.transport,
    agentId: "agent",
    organizationId: overrides.organizationId ?? ORG,
    caller: overrides.caller ?? CALLER,
  };
}

describe("pending inbound MCP requests", () => {
  test("refuses an anonymous caller before sharing the request", async () => {
    const shared = inMemorySharedStore();
    const registry = new PendingInboundRequests({ shared });
    await expect(
      registry.register(
        registration({
          id: 1,
          transport: makeTransport(),
          caller: "anonymous",
        }),
      ),
    ).rejects.toThrow(
      "Server-initiated requests require an authenticated caller",
    );
    await registry.close();
  });

  test("refuses an over-limit caller without evicting its live request", async () => {
    const transport = makeTransport();
    const wireIds = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        pendingInboundRequests.register(registration({ id: index, transport })),
      ),
    );

    await expect(
      pendingInboundRequests.register(registration({ id: 16, transport })),
    ).rejects.toThrow(
      "Too many pending server-initiated requests for this caller",
    );
    expect(
      pendingInboundRequests.consume({
        wireId: wireIds[0],
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
      }),
    ).toMatchObject({ id: 0, transport });
  });

  test("refuses a global overflow without evicting a live request", async () => {
    const transport = makeTransport();
    const wireIds = await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        pendingInboundRequests.register(
          registration({
            id: index,
            transport,
            caller: `user:caller-${index}`,
          }),
        ),
      ),
    );

    await expect(
      pendingInboundRequests.register(
        registration({
          id: 256,
          transport,
          caller: "user:another-caller",
        }),
      ),
    ).rejects.toThrow("Too many pending server-initiated requests");
    expect(
      pendingInboundRequests.consume({
        wireId: wireIds[0],
        agentId: "agent",
        organizationId: ORG,
        caller: "user:caller-0",
      }),
    ).toMatchObject({ id: 0, transport });
  });

  test("expires registrations without another request arriving", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const expiredWireIds = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        pendingInboundRequests.register(registration({ id: index, transport })),
      ),
    );

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(
      pendingInboundRequests.consume({
        wireId: expiredWireIds[0],
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
      }),
    ).toBeUndefined();
    await expect(
      pendingInboundRequests.register(registration({ id: 2, transport })),
    ).resolves.toEqual(expect.any(String));
  });

  test("retains a request after an answer from another caller or organization", async () => {
    const transport = makeTransport();
    const wireId = await pendingInboundRequests.register(
      registration({ id: 1, transport, caller: "user:asked-caller" }),
    );

    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: "user:other-caller",
      }),
    ).toBeUndefined();
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        organizationId: "other-org",
        caller: "user:asked-caller",
      }),
    ).toBeUndefined();
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: "user:asked-caller",
      }),
    ).toMatchObject({ id: 1, transport });
  });

  test("maps one answer back to its original request and transport", async () => {
    const transport = makeTransport();
    const wireId = await pendingInboundRequests.register(
      registration({ id: "original-id", transport }),
    );

    expect(
      pendingInboundRequests.wireIdOf({ transport, id: "original-id" }),
    ).toBe(wireId);
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
      }),
    ).toMatchObject({ id: "original-id", transport });
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
      }),
    ).toBeUndefined();
  });

  test("forgets a cancelled request immediately", async () => {
    const transport = makeTransport();
    const wireId = await pendingInboundRequests.register(
      registration({ id: 1, transport }),
    );

    await pendingInboundRequests.forget({ wireId });
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
      }),
    ).toBeUndefined();
  });

  test("forgets every request when its transport closes", async () => {
    const transport = makeTransport();
    const wireId = await pendingInboundRequests.register(
      registration({ id: 1, transport }),
    );

    pendingInboundRequests.forgetTransport({ transport });
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
      }),
    ).toBeUndefined();
  });

  test("close waits for an in-flight registration and does not publish it", async () => {
    const events: string[] = [];
    let releaseRemember: () => void = () => {};
    const rememberGate = new Promise<void>((resolve) => {
      releaseRemember = resolve;
    });
    let rememberStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      rememberStarted = resolve;
    });
    const shared = inMemorySharedStore();
    const originalRemember = shared.remember.bind(shared);
    shared.remember = async (params) => {
      events.push("remember-start");
      rememberStarted();
      await rememberGate;
      events.push("remember-end");
      await originalRemember(params);
    };
    const originalForget = shared.forget.bind(shared);
    shared.forget = async (wireId) => {
      events.push("forget");
      await originalForget(wireId);
    };
    const registry = new PendingInboundRequests({ shared });
    const registering = registry.register(
      registration({ id: 1, transport: makeTransport() }),
    );
    await started;

    let closed = false;
    const closing = registry.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseRemember();
    await closing;
    await expect(registering).rejects.toThrow(
      "Pending request registry is closed",
    );
    expect(closed).toBe(true);
    expect(events).toEqual(["remember-start", "remember-end", "forget"]);
    const writes = events.length;
    await Promise.resolve();
    expect(events).toHaveLength(writes);
    expect(await shared.lookup("unused")).toBeUndefined();
  });
});

describe("pending inbound MCP requests across replicas", () => {
  let shared: SharedPendingRequests;
  let asking: PendingInboundRequests;
  let other: PendingInboundRequests;

  beforeEach(() => {
    shared = inMemorySharedStore();
    asking = new PendingInboundRequests({ shared, pollMs: 5 });
    other = new PendingInboundRequests({ shared, pollMs: 5 });
  });

  afterEach(async () => {
    await asking.close();
    await other.close();
  });

  test("an answer that reaches another replica gets to the transport that asked", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register(registration({ id: 7, transport }));

    const answer = {
      jsonrpc: "2.0",
      id: wireId,
      result: { action: "accept", content: { choice: "Approve" } },
    };
    await expect(
      other.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message: answer,
      }),
    ).resolves.toBe(true);

    await vi.waitFor(() =>
      expect(onmessage).toHaveBeenCalledWith({ ...answer, id: 7 }),
    );
    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(
      asking.consume({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
      }),
    ).toBeUndefined();
    await expect(shared.lookup(wireId)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  test("the same user principal matches across tokens; a token principal does not", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register(
      registration({ id: 4, transport, caller: "user:same-user" }),
    );

    await expect(
      other.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: "token:other-token",
        message: { jsonrpc: "2.0", id: wireId, result: { action: "decline" } },
      }),
    ).resolves.toBe(false);
    await expect(
      other.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: "user:same-user",
        message: { jsonrpc: "2.0", id: wireId, result: { action: "accept" } },
      }),
    ).resolves.toBe(true);
    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledTimes(1));
    expect(onmessage).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 4,
      result: { action: "accept" },
    });
  });

  test("simultaneous local and remote answers deliver once", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register(registration({ id: 9, transport }));
    const message = (choice: string) => ({
      jsonrpc: "2.0",
      id: wireId,
      result: { choice },
    });

    const [local, remote] = await Promise.all([
      asking.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message: message("local"),
      }),
      other.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message: message("remote"),
      }),
    ]);

    expect([local, remote].filter(Boolean)).toHaveLength(1);
    await vi.waitFor(() => expect(onmessage).toHaveBeenCalledTimes(1));
    const delivered = onmessage.mock.calls[0][0].result.choice;
    expect(["local", "remote"]).toContain(delivered);
    await expect(
      other.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message: message("replay"),
      }),
    ).resolves.toBe(false);
    expect(onmessage).toHaveBeenCalledTimes(1);
  });

  test("a cancellation that reaches another replica cancels the request that was asked", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register(registration({ id: 3, transport }));

    await other.acceptAnswer({
      wireId,
      agentId: "agent",
      organizationId: ORG,
      caller: CALLER,
      message: {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: wireId, reason: "User closed the form" },
      },
    });

    await vi.waitFor(() =>
      expect(onmessage).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 3, reason: "User closed the form" },
      }),
    );
  });

  test("another replica keeps no answer from a caller that was not asked", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register(
      registration({ id: 1, transport, caller: "user:asked-caller" }),
    );

    for (const intruder of [
      { organizationId: ORG, caller: "user:other-caller" },
      { organizationId: "other-org", caller: "user:asked-caller" },
      { organizationId: ORG, caller: "anonymous" },
    ]) {
      await expect(
        other.acceptAnswer({
          wireId,
          agentId: "agent",
          ...intruder,
          message: { jsonrpc: "2.0", id: wireId, result: {} },
        }),
      ).resolves.toBe(false);
    }
    await expect(
      shared.take({ ownerId: asking.ownerId, wireIds: [wireId] }),
    ).resolves.toEqual([]);
    expect(onmessage).not.toHaveBeenCalled();
  });

  test("an unknown request is not claimed, and the owner claims its own answer once", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register(registration({ id: 1, transport }));
    const unknown = "archestra-00000000-0000-4000-8000-000000000000";
    const message = {
      jsonrpc: "2.0",
      id: wireId,
      result: { action: "accept" },
    };

    await expect(
      other.acceptAnswer({
        wireId: unknown,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message: { jsonrpc: "2.0", id: unknown, result: {} },
      }),
    ).resolves.toBe(false);
    await expect(
      asking.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message,
      }),
    ).resolves.toBe(true);
    expect(onmessage).toHaveBeenCalledTimes(1);
    await expect(
      asking.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message,
      }),
    ).resolves.toBe(false);
    await expect(
      shared.take({ ownerId: asking.ownerId, wireIds: [unknown, wireId] }),
    ).resolves.toEqual([]);
  });

  test("a lease blip leaves the queued answer for a later take", async () => {
    const slow = new PendingInboundRequests({ shared, pollMs: 60_000 });
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await slow.register(registration({ id: 8, transport }));
    await other.acceptAnswer({
      wireId,
      agentId: "agent",
      organizationId: ORG,
      caller: CALLER,
      message: { jsonrpc: "2.0", id: wireId, result: { choice: "kept" } },
    });
    await shared.renewOwner({
      ownerId: slow.ownerId,
      expiresAt: Date.now() - 1,
      ttlMs: 1,
    });
    await expect(
      shared.take({ ownerId: slow.ownerId, wireIds: [wireId] }),
    ).resolves.toEqual([]);
    await expect(shared.lookup(wireId)).resolves.toMatchObject({
      status: "queued",
    });
    expect(onmessage).not.toHaveBeenCalled();
    await shared.renewOwner({
      ownerId: slow.ownerId,
      expiresAt: Date.now() + 30_000,
      ttlMs: 30_000,
    });
    await expect(
      shared.take({ ownerId: slow.ownerId, wireIds: [wireId] }),
    ).resolves.toHaveLength(1);
    expect(onmessage).not.toHaveBeenCalled();
    await slow.close();
  });

  test("cleanup failure does not drop an answer that was delivered", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    let forgets = 0;
    const originalForget = shared.forget.bind(shared);
    shared.forget = async (wireId) => {
      forgets += 1;
      if (forgets === 1) throw new Error("cleanup down");
      await originalForget(wireId);
    };
    const wireId = await asking.register(registration({ id: 11, transport }));
    await expect(
      asking.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message: { jsonrpc: "2.0", id: wireId, result: { choice: "kept" } },
      }),
    ).resolves.toBe(true);
    expect(onmessage).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(shared.lookup(wireId)).resolves.toMatchObject({
        status: "cancelled",
      }),
    );
  });

  test("a failed transport cancel is retried and is not claimable while it fails", async () => {
    const transport = makeTransport();
    const wireId = await asking.register(registration({ id: 12, transport }));
    let releaseCancel: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let started: () => void = () => {};
    const failedOnce = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalForget = shared.forget.bind(shared);
    let forgets = 0;
    shared.forget = async (id) => {
      forgets += 1;
      if (forgets === 1) {
        started();
        await gate;
        throw new Error("cancel down");
      }
      await originalForget(id);
    };
    asking.forgetTransport({ transport });
    await failedOnce;
    await expect(
      other.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message: { jsonrpc: "2.0", id: wireId, result: {} },
      }),
    ).resolves.toBe(false);
    releaseCancel();
    await vi.waitFor(() =>
      expect(shared.lookup(wireId)).resolves.toMatchObject({
        status: "cancelled",
      }),
    );
    expect(forgets).toBeGreaterThan(1);
  });

  test("the owner does not accept an answer it did not deliver", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register(registration({ id: 13, transport }));
    shared.take = async () => [];
    await expect(
      asking.acceptAnswer({
        wireId,
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
        message: { jsonrpc: "2.0", id: wireId, result: { choice: "local" } },
      }),
    ).resolves.toBe(false);
    expect(onmessage).not.toHaveBeenCalled();
    await expect(shared.lookup(wireId)).resolves.toMatchObject({
      status: "queued",
    });
  });

  test("a failed shared write does not leave a request that can be answered", async () => {
    shared.remember = async () => {
      throw new Error("db down");
    };
    const transport = makeTransport();
    await expect(
      asking.register(registration({ id: 1, transport })),
    ).rejects.toThrow("db down");
    expect(
      asking.consume({
        wireId: "missing",
        agentId: "agent",
        organizationId: ORG,
        caller: CALLER,
      }),
    ).toBeUndefined();
    await expect(shared.lookup("missing")).resolves.toBeUndefined();
  });
});

function inMemorySharedStore(): SharedPendingRequests {
  const records = new Map<string, PendingRequestRecord>();
  const parked = new Map<string, ParkedClientMessage>();
  const leases = new Map<string, number>();
  let tail = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    async remember({ wireId, record }) {
      records.set(wireId, record);
    },
    async renewOwner({ ownerId, expiresAt }) {
      leases.set(ownerId, expiresAt);
    },
    async lookup(wireId) {
      return records.get(wireId);
    },
    claim(params) {
      return exclusive(async () => {
        await Promise.resolve();
        const record = records.get(params.wireId);
        if (!record || record.status !== "waiting") return false;
        if (
          record.organizationId !== params.organizationId ||
          record.agentId !== params.agentId ||
          record.caller !== params.caller
        ) {
          return false;
        }
        const now = Date.now();
        if (now >= record.deadlineAt) return false;
        const expiresAt = leases.get(record.ownerId);
        if (expiresAt === undefined || now >= expiresAt) return false;
        records.set(params.wireId, { ...record, status: "queued" });
        parked.set(params.wireId, {
          organizationId: params.organizationId,
          agentId: params.agentId,
          caller: params.caller,
          message: params.message,
        });
        return true;
      });
    },
    take({ ownerId, wireIds }) {
      return exclusive(async () => {
        const now = Date.now();
        if ((leases.get(ownerId) ?? 0) <= now) return [];
        const taken = [];
        for (const wireId of [...wireIds].sort()) {
          const message = parked.get(wireId);
          const record = records.get(wireId);
          if (!message || !record || record.status !== "queued") continue;
          if ((leases.get(ownerId) ?? 0) <= Date.now()) return taken;
          if (record.ownerId !== ownerId || now >= record.deadlineAt) continue;
          parked.delete(wireId);
          records.set(wireId, { ...record, status: "answered" });
          taken.push({ wireId, parked: message });
        }
        return taken;
      });
    },
    async forget(wireId) {
      const record = records.get(wireId);
      if (record) records.set(wireId, { ...record, status: "cancelled" });
      parked.delete(wireId);
    },
  };
}
