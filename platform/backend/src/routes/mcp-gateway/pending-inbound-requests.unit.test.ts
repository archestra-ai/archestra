import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { pendingInboundRequests } from "./pending-inbound-requests";

const transports = new Set<StreamableHTTPServerTransport>();

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
  test("refuses an over-limit caller without evicting its live request", () => {
    const transport = makeTransport();
    const wireIds = Array.from({ length: 16 }, (_, index) =>
      pendingInboundRequests.register({
        id: index,
        transport,
        agentId: "agent",
        caller: "caller",
      }),
    );

    expect(() =>
      pendingInboundRequests.register({
        id: 16,
        transport,
        agentId: "agent",
        caller: "caller",
      }),
    ).toThrow("Too many pending server-initiated requests for this caller");
    expect(
      pendingInboundRequests.consume({
        wireId: wireIds[0],
        agentId: "agent",
        caller: "caller",
      }),
    ).toMatchObject({ id: 0, transport });
  });

  test("refuses a global overflow without evicting a live request", () => {
    const transport = makeTransport();
    const wireIds = Array.from({ length: 256 }, (_, index) =>
      pendingInboundRequests.register({
        id: index,
        transport,
        agentId: "agent",
        caller: `caller-${index}`,
      }),
    );

    expect(() =>
      pendingInboundRequests.register({
        id: 256,
        transport,
        agentId: "agent",
        caller: "another-caller",
      }),
    ).toThrow("Too many pending server-initiated requests");
    expect(
      pendingInboundRequests.consume({
        wireId: wireIds[0],
        agentId: "agent",
        caller: "caller-0",
      }),
    ).toMatchObject({ id: 0, transport });
  });

  test("expires registrations without another request arriving", () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const expiredWireIds = Array.from({ length: 16 }, (_, index) =>
      pendingInboundRequests.register({
        id: index,
        transport,
        agentId: "agent",
        caller: "caller",
      }),
    );

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(
      pendingInboundRequests.consume({
        wireId: expiredWireIds[0],
        agentId: "agent",
        caller: "caller",
      }),
    ).toBeUndefined();
    expect(() =>
      pendingInboundRequests.register({
        id: 2,
        transport,
        agentId: "agent",
        caller: "caller",
      }),
    ).not.toThrow();
  });

  test("retains a request after an answer from another caller", () => {
    const transport = makeTransport();
    const wireId = pendingInboundRequests.register({
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

  test("maps one answer back to its original request and transport", () => {
    const transport = makeTransport();
    const wireId = pendingInboundRequests.register({
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

  test("forgets a cancelled request immediately", () => {
    const transport = makeTransport();
    const wireId = pendingInboundRequests.register({
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

  test("forgets every request when its transport closes", () => {
    const transport = makeTransport();
    const wireId = pendingInboundRequests.register({
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
