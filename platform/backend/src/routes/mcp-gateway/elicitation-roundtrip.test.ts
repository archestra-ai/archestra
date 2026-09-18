/**
 * In-band elicitation round trip through the real gateway route, over a real
 * socket.
 *
 * A client that declares elicitation gets an SSE response; the gateway sends
 * elicitation/create on it mid tools/call and the client answers with a
 * separate POST. Stateless mode builds a fresh Server per POST, so without
 * routing the answer back to the Server that is still waiting, the call hangs
 * until the SDK timeout — this test pins that the round trip completes.
 */

import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { TeamTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";
import { MCP_CLIENT_CAPABILITIES_META_KEY } from "./protocol";

describe("MCP Gateway - in-band elicitation round trip", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a client that declares elicitation answers elicitation/create on a separate POST", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/mcp/${agent.id}`;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token.value}`,
    };

    const callResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__ask_user",
          arguments: {
            question: "Accept this change for the rest of this session?",
            options: [
              { label: "Accept for this session" },
              { label: "Do not accept" },
            ],
          },
          _meta: {
            [MCP_CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} },
          },
        },
        id: 2,
      }),
    });

    expect(callResponse.status).toBe(200);
    expect(callResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    );

    const reader = callResponse.body?.getReader();
    if (!reader) throw new Error("no response body");
    const decoder = new TextDecoder();
    let buffer = "";
    const nextEvent = async () => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) {
            return JSON.parse(data.slice("data: ".length)) as Record<
              string,
              unknown
            >;
          }
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended early");
        buffer += decoder.decode(value, { stream: true });
      }
    };

    const elicitation = await nextEvent();
    expect(elicitation).toMatchObject({
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Accept this change for the rest of this session?",
      },
    });

    const answer = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: elicitation.id,
        result: {
          action: "accept",
          content: { choice: "Accept for this session" },
        },
      }),
    });
    expect(answer.status).toBe(202);

    const result = await nextEvent();
    expect(result).toMatchObject({
      id: 2,
      result: {
        structuredContent: {
          action: "accept",
          selected: ["Accept for this session"],
        },
      },
    });
  });

  test("a legacy client that declared elicitation at initialize gets the same round trip", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/mcp/${agent.id}`;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token.value}`,
    };

    // Legacy clients declare capabilities once, at initialize, and carry no
    // per-request `_meta` afterwards.
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: { elicitation: {} },
          clientInfo: { name: "legacy-test-client", version: "1.0.0" },
        },
        id: 1,
      }),
    });
    expect(init.status).toBe(200);
    await init.arrayBuffer();

    const callResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__ask_user",
          arguments: {
            question: "Accept this change for the rest of this session?",
            options: [
              { label: "Accept for this session" },
              { label: "Do not accept" },
            ],
          },
        },
        id: 2,
      }),
    });

    expect(callResponse.status).toBe(200);
    expect(callResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    );

    const reader = callResponse.body?.getReader();
    if (!reader) throw new Error("no response body");
    const decoder = new TextDecoder();
    let buffer = "";
    const nextEvent = async () => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) {
            return JSON.parse(data.slice("data: ".length)) as Record<
              string,
              unknown
            >;
          }
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended early");
        buffer += decoder.decode(value, { stream: true });
      }
    };

    const elicitation = await nextEvent();
    expect(elicitation.method).toBe("elicitation/create");

    const answer = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: elicitation.id,
        result: {
          action: "accept",
          content: { choice: "Do not accept" },
        },
      }),
    });
    expect(answer.status).toBe(202);

    const result = await nextEvent();
    expect(result).toMatchObject({
      id: 2,
      result: {
        structuredContent: {
          action: "accept",
          selected: ["Do not accept"],
        },
      },
    });
  });

  test("a client without elicitation keeps a plain JSON response", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/mcp/${agent.id}`;

    const callResponse = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__ask_user",
          arguments: {
            question: "Accept this change for the rest of this session?",
            options: [
              { label: "Accept for this session" },
              { label: "Do not accept" },
            ],
          },
        },
        id: 2,
      }),
    });

    expect(callResponse.status).toBe(200);
    expect(callResponse.headers.get("content-type")).toContain(
      "application/json",
    );
    const body = (await callResponse.json()) as {
      result: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content?.[0]?.text).toContain(
      "did not complete a choice form",
    );
  });
});
