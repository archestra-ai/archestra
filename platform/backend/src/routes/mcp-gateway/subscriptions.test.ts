/**
 * subscriptions/listen stream mechanics.
 *
 * The wire contract these pin: the acknowledgment is the FIRST message and
 * names exactly the subset the gateway honors; every notification carries the
 * subscription id; a closed client stops the polling. Change detection runs
 * against an injected fingerprint so the timing is deterministic — the
 * route-level suite covers the real fingerprint path.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import McpServerModel from "@/models/mcp-server";
import { describe, expect, test } from "@/test";
import {
  acknowledgedFilter,
  parseSubscriptionFilter,
  runSubscriptionStream,
  toolsListFingerprint,
} from "./subscriptions";

function makeStreamHarness() {
  const written: string[] = [];
  const requestRaw = new EventEmitter();
  const replyRaw = new EventEmitter();
  let ended = false;

  const reply = {
    hijack: () => {},
    raw: Object.assign(replyRaw, {
      writeHead: () => {},
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
      end: () => {
        ended = true;
        replyRaw.emit("close");
      },
    }),
  } as unknown as FastifyReply;

  const request = { raw: requestRaw } as unknown as FastifyRequest;

  const events = () =>
    written
      .filter((chunk) => chunk.startsWith("event:"))
      .map(
        (chunk) =>
          JSON.parse(chunk.split("data: ")[1]) as Record<string, unknown>,
      );

  return {
    reply,
    request,
    requestRaw,
    written,
    events,
    isEnded: () => ended,
    // Client disconnect is the response closing, not the request body finishing.
    disconnect: () => replyRaw.emit("close"),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("parseSubscriptionFilter", () => {
  test("reads the notification filter from params", () => {
    expect(
      parseSubscriptionFilter({
        method: "subscriptions/listen",
        params: {
          notifications: {
            toolsListChanged: true,
            resourceSubscriptions: ["file:///a", 42],
          },
        },
        id: 1,
      }),
    ).toEqual({
      toolsListChanged: true,
      resourceSubscriptions: ["file:///a"],
    });
  });

  test("an absent filter subscribes to nothing", () => {
    expect(parseSubscriptionFilter({ params: {} })).toEqual({});
    expect(parseSubscriptionFilter(null)).toEqual({});
  });
});

describe("acknowledgedFilter", () => {
  test("honors toolsListChanged and omits what the gateway cannot serve", () => {
    // Prompt and resource lists are proxied from upstreams, so honoring their
    // change types would mean polling every upstream per tick. The spec has
    // the ack omit unsupported types so the client knows not to wait.
    expect(
      acknowledgedFilter({
        toolsListChanged: true,
        promptsListChanged: true,
        resourcesListChanged: true,
        resourceSubscriptions: ["file:///a"],
      }),
    ).toEqual({ toolsListChanged: true });
  });

  test("an empty request is acknowledged empty", () => {
    expect(acknowledgedFilter({})).toEqual({});
  });
});

describe("runSubscriptionStream", () => {
  test("acknowledges first, then notifies on each fingerprint change", async () => {
    const harness = makeStreamHarness();
    const fingerprints = ["a", "a", "b", "b"];
    let call = 0;

    await runSubscriptionStream({
      request: harness.request,
      reply: harness.reply,
      agentId: "agent-1",
      subscriptionId: 7,
      requested: { toolsListChanged: true },
      computeFingerprint: async () => fingerprints[Math.min(call++, 3)],
      pollIntervalMs: 20,
      heartbeatMs: 10_000,
    });

    await sleep(120);
    harness.disconnect();

    const events = harness.events();
    expect(events[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": 7 },
        notifications: { toolsListChanged: true },
      },
    });

    const changes = events.filter(
      (e) => e.method === "notifications/tools/list_changed",
    );
    // Fingerprint went a → b once, so exactly one notification — repeated
    // identical fingerprints must not re-fire.
    expect(changes).toHaveLength(1);
    expect(changes[0].params).toMatchObject({
      _meta: { "io.modelcontextprotocol/subscriptionId": 7 },
    });
  });

  test("a closed client stops the polling", async () => {
    const harness = makeStreamHarness();
    let calls = 0;

    await runSubscriptionStream({
      request: harness.request,
      reply: harness.reply,
      agentId: "agent-1",
      subscriptionId: 1,
      requested: { toolsListChanged: true },
      computeFingerprint: async () => String(calls++),
      pollIntervalMs: 15,
      heartbeatMs: 10_000,
    });

    await sleep(50);
    harness.disconnect();
    const callsAtClose = calls;
    await sleep(60);

    // No polls after close: the interval was torn down, not orphaned.
    expect(calls).toBe(callsAtClose);
  });

  test("an unresolvable baseline ends the stream gracefully", async () => {
    const harness = makeStreamHarness();

    await runSubscriptionStream({
      request: harness.request,
      reply: harness.reply,
      agentId: "agent-1",
      subscriptionId: 3,
      requested: { toolsListChanged: true },
      computeFingerprint: async () => {
        throw new Error("db down");
      },
      pollIntervalMs: 20,
      heartbeatMs: 10_000,
    });

    const events = harness.events();
    // Graceful closure is the JSON-RPC response to the listen request — the
    // signal that distinguishes a clean end from a dropped transport.
    const closure = events.find((e) => "id" in e && e.id === 3);
    expect(closure).toMatchObject({
      result: {
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/subscriptionId": 3 },
      },
    });
    expect(harness.isEnded()).toBe(true);
  });

  test("an unset or zero duration does not end the stream", async () => {
    for (const maxDurationMs of [undefined, 0]) {
      const harness = makeStreamHarness();
      await runSubscriptionStream({
        request: harness.request,
        reply: harness.reply,
        agentId: "agent-1",
        subscriptionId: 12,
        requested: { promptsListChanged: true },
        pollIntervalMs: 10_000,
        heartbeatMs: 10_000,
        ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      });
      await sleep(40);
      expect(harness.isEnded()).toBe(false);
      expect(harness.events().some((event) => event.id === 12)).toBe(false);
      harness.disconnect();
    }
  });

  test("rotates at the duration cap with the ack first and a terminal result last", async () => {
    const harness = makeStreamHarness();
    const heartbeats: string[] = [];
    const originalWrite = harness.reply.raw.write.bind(harness.reply.raw);
    harness.reply.raw.write = ((chunk: string) => {
      if (chunk.startsWith(":")) heartbeats.push(chunk);
      return originalWrite(chunk);
    }) as typeof harness.reply.raw.write;

    await runSubscriptionStream({
      request: harness.request,
      reply: harness.reply,
      agentId: "agent-1",
      subscriptionId: 11,
      requested: { toolsListChanged: true },
      computeFingerprint: async () => "stable",
      pollIntervalMs: 10_000,
      heartbeatMs: 15,
      maxDurationMs: 50,
    });

    await sleep(120);

    const events = harness.events();
    expect(events[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": 11 },
        notifications: { toolsListChanged: true },
      },
    });
    expect(heartbeats.length).toBeGreaterThan(0);
    const terminal = events.find((event) => event.id === 11);
    expect(terminal).toMatchObject({
      result: {
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/subscriptionId": 11 },
      },
    });
    expect(events.at(-1)).toBe(terminal);
    expect(harness.isEnded()).toBe(true);
    const writesAtEnd = harness.written.length;
    await sleep(40);
    expect(harness.written.length).toBe(writesAtEnd);
  });

  test("a fingerprint resolving after rotation does not write", async () => {
    const harness = makeStreamHarness();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;

    await runSubscriptionStream({
      request: harness.request,
      reply: harness.reply,
      agentId: "agent-1",
      subscriptionId: 4,
      requested: { toolsListChanged: true },
      computeFingerprint: async () => {
        started += 1;
        if (started === 1) return "a";
        await gate;
        return "b";
      },
      pollIntervalMs: 10,
      heartbeatMs: 10_000,
      maxDurationMs: 40,
    });

    await sleep(80);
    expect(harness.isEnded()).toBe(true);
    const eventsAtRotation = harness.events().length;
    release();
    await sleep(30);
    expect(
      harness
        .events()
        .filter((event) => event.method === "notifications/tools/list_changed"),
    ).toHaveLength(0);
    expect(harness.events()).toHaveLength(eventsAtRotation);
  });

  test("a subscription honoring nothing still acknowledges", async () => {
    const harness = makeStreamHarness();

    await runSubscriptionStream({
      request: harness.request,
      reply: harness.reply,
      agentId: "agent-1",
      subscriptionId: 9,
      requested: { promptsListChanged: true },
      pollIntervalMs: 20,
      heartbeatMs: 10_000,
    });
    harness.disconnect();

    expect(harness.events()[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: {} },
    });
  });

  test("a real socket rotates on the duration timer and stops when the client disconnects", async () => {
    let polls = 0;
    const server = http.createServer((req, res) => {
      void runSubscriptionStream({
        request: { raw: req } as unknown as FastifyRequest,
        reply: { hijack: () => {}, raw: res } as unknown as FastifyReply,
        agentId: "agent-1",
        subscriptionId: 8,
        requested: { toolsListChanged: true },
        computeFingerprint: async () => {
          polls += 1;
          return "stable";
        },
        pollIntervalMs: 20,
        heartbeatMs: 15,
        maxDurationMs: 70,
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/listen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await response.text();
      const frames = body
        .split("\n\n")
        .filter((frame) => frame.includes("data: "))
        .map(
          (frame) =>
            JSON.parse(frame.split("data: ")[1]) as Record<string, unknown>,
        );

      expect(frames[0]).toMatchObject({
        method: "notifications/subscriptions/acknowledged",
      });
      expect(body).toContain(": keep-alive");
      expect(frames.at(-1)).toMatchObject({
        id: 8,
        result: { resultType: "complete" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const pollsAtEnd = polls;
    await sleep(50);
    expect(polls).toBe(pollsAtEnd);

    polls = 0;
    let writesAfterDisconnect = 0;
    let disconnected = false;
    const abortServer = http.createServer((req, res) => {
      const write = res.write.bind(res);
      res.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        if (disconnected) writesAfterDisconnect += 1;
        return write(chunk, ...(args as []));
      }) as typeof res.write;
      void runSubscriptionStream({
        request: { raw: req } as unknown as FastifyRequest,
        reply: { hijack: () => {}, raw: res } as unknown as FastifyReply,
        agentId: "agent-1",
        subscriptionId: 9,
        requested: { toolsListChanged: true },
        computeFingerprint: async () => {
          polls += 1;
          return String(polls);
        },
        pollIntervalMs: 20,
        heartbeatMs: 10_000,
        maxDurationMs: 160,
      });
    });
    await new Promise<void>((resolve) => {
      abortServer.listen(0, "127.0.0.1", () => resolve());
    });
    const abortPort = (abortServer.address() as AddressInfo).port;
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${abortPort}/listen`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no response body");
      let buffer = "";
      while (!buffer.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
      }
      expect(buffer).toContain("notifications/subscriptions/acknowledged");
      const armed = Date.now() + 100;
      while (polls < 2 && Date.now() < armed) {
        await sleep(5);
      }
      expect(polls).toBeGreaterThanOrEqual(2);
      const pollsAtDisconnect = polls;
      disconnected = true;
      controller.abort();
      // Past the duration cap, so a timer that was not cleared would write.
      await sleep(200);
      expect(polls).toBe(pollsAtDisconnect);
      expect(writesAfterDisconnect).toBe(0);
    } finally {
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        abortServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("toolsListFingerprint", () => {
  test("changes when the assigned tool set changes", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "fp-catalog",
    });
    const toolA = await makeTool({
      catalogId: catalog.id,
      name: "fp-catalog__alpha",
    });
    await makeAgentTool(agent.id, toolA.id);

    const before = await toolsListFingerprint(agent.id);

    const toolB = await makeTool({
      catalogId: catalog.id,
      name: "fp-catalog__beta",
    });
    await makeAgentTool(agent.id, toolB.id);

    const after = await toolsListFingerprint(agent.id);
    expect(after).not.toBe(before);

    // Stable when nothing changed — an unstable fingerprint would spam
    // list_changed on every poll.
    expect(await toolsListFingerprint(agent.id)).toBe(after);
  });

  test("changes when the tool's pinned install is uninstalled", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
    makeAgentTool,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "uninstall-fp-catalog",
    });
    const mcpServer = await makeMcpServer({ catalogId: catalog.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "uninstall-fp-catalog__alpha",
    });
    await makeAgentTool(agent.id, tool.id, { mcpServerId: mcpServer.id });

    const before = await toolsListFingerprint(agent.id);

    await McpServerModel.delete(mcpServer.id);

    // The fingerprint hashes the same name set the gateway advertises, so
    // dropping the tool is what lets subscribers get a list_changed at all.
    expect(await toolsListFingerprint(agent.id)).not.toBe(before);
  });
});
