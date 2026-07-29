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
import type { FastifyReply, FastifyRequest } from "fastify";
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
  let ended = false;

  const reply = {
    hijack: () => {},
    raw: {
      writeHead: () => {},
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
      end: () => {
        ended = true;
      },
    },
  } as unknown as FastifyReply;

  const request = { raw: requestRaw } as unknown as FastifyRequest;

  const events = () =>
    written
      .filter((chunk) => chunk.startsWith("event:"))
      .map(
        (chunk) =>
          JSON.parse(chunk.split("data: ")[1]) as Record<string, unknown>,
      );

  return { reply, request, requestRaw, written, events, isEnded: () => ended };
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
    harness.requestRaw.emit("close");

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
    harness.requestRaw.emit("close");
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
    harness.requestRaw.emit("close");

    expect(harness.events()[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: {} },
    });
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
});
