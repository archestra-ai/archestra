import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ParkedClientMessage,
  PendingInboundRequests,
  type PendingRequestRecord,
  type SharedPendingRequests,
} from "./pending-inbound-requests";

const transports = new Set<StreamableHTTPServerTransport>();
let pendingInboundRequests: PendingInboundRequests;

beforeEach(() => {
  pendingInboundRequests = new PendingInboundRequests();
});

afterEach(() => {
  vi.useRealTimers();
  for (const transport of transports) {
    pendingInboundRequests.forgetTransport({ transport });
  }
  transports.clear();
});

function makeTransport(): StreamableHTTPServerTransport {
  const transport = {} as StreamableHTTPServerTransport;
  transports.add(transport);
  return transport;
}

describe("pending inbound MCP requests", () => {
  test("refuses an over-limit caller without evicting its live request", async () => {
    const transport = makeTransport();
    const wireIds = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        pendingInboundRequests.register({
          id: index,
          transport,
          agentId: "agent",
          caller: "caller",
        }),
      ),
    );

    await expect(
      pendingInboundRequests.register({
        id: 16,
        transport,
        agentId: "agent",
        caller: "caller",
      }),
    ).rejects.toThrow(
      "Too many pending server-initiated requests for this caller",
    );
    expect(
      pendingInboundRequests.consume({
        wireId: wireIds[0],
        agentId: "agent",
        caller: "caller",
      }),
    ).toMatchObject({ id: 0, transport });
  });

  test("refuses a global overflow without evicting a live request", async () => {
    const transport = makeTransport();
    const wireIds = await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        pendingInboundRequests.register({
          id: index,
          transport,
          agentId: "agent",
          caller: `caller-${index}`,
        }),
      ),
    );

    await expect(
      pendingInboundRequests.register({
        id: 256,
        transport,
        agentId: "agent",
        caller: "another-caller",
      }),
    ).rejects.toThrow("Too many pending server-initiated requests");
    expect(
      pendingInboundRequests.consume({
        wireId: wireIds[0],
        agentId: "agent",
        caller: "caller-0",
      }),
    ).toMatchObject({ id: 0, transport });
  });

  test("expires registrations without another request arriving", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const expiredWireIds = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        pendingInboundRequests.register({
          id: index,
          transport,
          agentId: "agent",
          caller: "caller",
        }),
      ),
    );

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(
      pendingInboundRequests.consume({
        wireId: expiredWireIds[0],
        agentId: "agent",
        caller: "caller",
      }),
    ).toBeUndefined();
    await expect(
      pendingInboundRequests.register({
        id: 2,
        transport,
        agentId: "agent",
        caller: "caller",
      }),
    ).resolves.toEqual(expect.any(String));
  });

  test("retains a request after an answer from another caller", async () => {
    const transport = makeTransport();
    const wireId = await pendingInboundRequests.register({
      id: 1,
      transport,
      agentId: "agent",
      caller: "asked-caller",
    });

    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        caller: "other-caller",
      }),
    ).toBeUndefined();
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        caller: "asked-caller",
      }),
    ).toMatchObject({ id: 1, transport });
  });

  test("maps one answer back to its original request and transport", async () => {
    const transport = makeTransport();
    const wireId = await pendingInboundRequests.register({
      id: "original-id",
      transport,
      agentId: "agent",
      caller: "caller",
    });

    expect(
      pendingInboundRequests.wireIdOf({ transport, id: "original-id" }),
    ).toBe(wireId);
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        caller: "caller",
      }),
    ).toMatchObject({ id: "original-id", transport });
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        caller: "caller",
      }),
    ).toBeUndefined();
  });

  test("forgets a cancelled request immediately", async () => {
    const transport = makeTransport();
    const wireId = await pendingInboundRequests.register({
      id: 1,
      transport,
      agentId: "agent",
      caller: "caller",
    });

    pendingInboundRequests.forget({ wireId });
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        caller: "caller",
      }),
    ).toBeUndefined();
  });

  test("forgets every request when its transport closes", async () => {
    const transport = makeTransport();
    const wireId = await pendingInboundRequests.register({
      id: 1,
      transport,
      agentId: "agent",
      caller: "caller",
    });

    pendingInboundRequests.forgetTransport({ transport });
    expect(
      pendingInboundRequests.consume({
        wireId,
        agentId: "agent",
        caller: "caller",
      }),
    ).toBeUndefined();
  });
});

describe("pending inbound MCP requests across replicas", () => {
  // Two replicas behind one load balancer, sharing one store as the pods
  // share the Postgres-backed cache.
  let shared: SharedPendingRequests;
  let asking: PendingInboundRequests;
  let other: PendingInboundRequests;

  beforeEach(() => {
    shared = inMemorySharedStore();
    asking = new PendingInboundRequests({ shared, pollMs: 5 });
    other = new PendingInboundRequests({ shared, pollMs: 5 });
  });

  afterEach(() => {
    asking.close();
    other.close();
  });

  test("an answer that reaches another replica gets to the transport that asked", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register({
      id: 7,
      transport,
      agentId: "agent",
      caller: "caller",
    });

    const answer = {
      jsonrpc: "2.0",
      id: wireId,
      result: { action: "accept", content: { choice: "Approve" } },
    };
    await expect(
      other.parkForOtherReplica({
        wireId,
        agentId: "agent",
        caller: "caller",
        message: answer,
      }),
    ).resolves.toBe(true);

    await vi.waitFor(() =>
      expect(onmessage).toHaveBeenCalledWith({ ...answer, id: 7 }),
    );
    expect(onmessage).toHaveBeenCalledTimes(1);
    // Consume-once: the request is no longer waiting anywhere.
    expect(
      asking.consume({ wireId, agentId: "agent", caller: "caller" }),
    ).toBeUndefined();
    await expect(shared.lookup(wireId)).resolves.toBeUndefined();
  });

  test("a cancellation that reaches another replica cancels the request that was asked", async () => {
    const onmessage = vi.fn();
    const transport = makeTransport();
    transport.onmessage = onmessage;
    const wireId = await asking.register({
      id: 3,
      transport,
      agentId: "agent",
      caller: "caller",
    });

    await other.parkForOtherReplica({
      wireId,
      agentId: "agent",
      caller: "caller",
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
    const wireId = await asking.register({
      id: 1,
      transport,
      agentId: "agent",
      caller: "asked-caller",
    });

    for (const intruder of [
      { agentId: "agent", caller: "other-caller" },
      { agentId: "other-agent", caller: "asked-caller" },
    ]) {
      await expect(
        other.parkForOtherReplica({
          wireId,
          ...intruder,
          message: { jsonrpc: "2.0", id: wireId, result: {} },
        }),
      ).resolves.toBe(false);
    }
    await expect(shared.take([wireId])).resolves.toEqual([]);
    expect(onmessage).not.toHaveBeenCalled();
  });

  test("a replica keeps nothing for a request no replica sent, or one it holds itself", async () => {
    const transport = makeTransport();
    const wireId = await asking.register({
      id: 1,
      transport,
      agentId: "agent",
      caller: "caller",
    });
    const unknown = "archestra-00000000-0000-4000-8000-000000000000";

    for (const [replica, id] of [
      [other, unknown],
      [asking, wireId],
    ] as const) {
      await expect(
        replica.parkForOtherReplica({
          wireId: id,
          agentId: "agent",
          caller: "caller",
          message: { jsonrpc: "2.0", id, result: {} },
        }),
      ).resolves.toBe(false);
    }
    await expect(shared.take([unknown, wireId])).resolves.toEqual([]);
  });
});

/** The shared cache's contract, held in this process. */
function inMemorySharedStore(): SharedPendingRequests {
  const records = new Map<string, PendingRequestRecord>();
  const parked = new Map<string, ParkedClientMessage>();
  return {
    async remember({ wireId, record }) {
      records.set(wireId, record);
    },
    async lookup(wireId) {
      return records.get(wireId);
    },
    async park({ wireId, parked: message }) {
      parked.set(wireId, message);
    },
    async take(wireIds) {
      const taken = [];
      for (const wireId of wireIds) {
        const message = parked.get(wireId);
        if (!message) continue;
        parked.delete(wireId);
        taken.push({ wireId, parked: message });
      }
      return taken;
    },
    async forget(wireId) {
      records.delete(wireId);
      parked.delete(wireId);
    },
  };
}
