/**
 * Elicitation round trips through the real gateway route, over a real socket.
 *
 * A legacy client that declares elicitation gets an SSE response; the gateway
 * sends elicitation/create on it mid tools/call and the client answers with a
 * separate POST. Stateless mode builds a fresh Server per POST, so without
 * routing the answer back to the Server that is still waiting, the call hangs
 * until the answer timeout. A client on the stateless revision instead gets
 * the question as an input request and answers it on a retry.
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

  test("a client on the stateless revision gets its question as an input request, never mid-call", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const token = await TeamTokenModel.create({
      organizationId: (await makeOrganization()).id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/mcp/${agent.id}`;
    const call = (extraParams: Record<string, unknown>) =>
      fetch(url, {
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
            // Capabilities on the request itself: a 2026-07-28 client.
            _meta: {
              [MCP_CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} },
            },
            ...extraParams,
          },
          id: 2,
        }),
      });

    // Such a client drops a request opened mid-call, so the question comes
    // back as the call's result instead.
    const first = await firstMessage(await call({}));
    expect(first.method).toBeUndefined();
    const interim = first.result as Record<string, unknown>;
    expect(interim).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        gateway_elicitation: {
          method: "elicitation/create",
          params: {
            message: "Accept this change for the rest of this session?",
          },
        },
      },
    });

    const answered = await firstMessage(
      await call({
        inputResponses: {
          gateway_elicitation: {
            action: "accept",
            content: { choice: "Accept for this session" },
          },
        },
        requestState: interim.requestState,
      }),
    );
    expect(answered).toMatchObject({
      id: 2,
      result: {
        // Such a client rejects a result that does not say it is complete.
        resultType: "complete",
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
      "did not answer the choice form",
    );
  });

  test("a client without elicitation on the same token does not take another client's forms away", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const token = await TeamTokenModel.create({
      organizationId: (await makeOrganization()).id,
      name: "Shared Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/mcp/${agent.id}`;
    const post = (userAgent: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.value}`,
          "user-agent": userAgent,
        },
        body: JSON.stringify(body),
      });
    const initialize = (userAgent: string, capabilities: unknown) =>
      post(userAgent, {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities,
          clientInfo: { name: userAgent, version: "1" },
        },
        id: 1,
      });

    // Two clients share one personal token; the one without forms connects
    // last.
    expect((await initialize("forms-client/1", { elicitation: {} })).ok).toBe(
      true,
    );
    expect((await initialize("plain-client/1", { roots: {} })).ok).toBe(true);

    const call = await post("forms-client/1", {
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
    });
    expect(call.headers.get("content-type")).toContain("text/event-stream");
    const events = readEvents(call);
    const question = await events.next();
    expect(question.method).toBe("elicitation/create");

    await post("forms-client/1", {
      jsonrpc: "2.0",
      id: question.id,
      result: { action: "accept", content: { choice: "Do not accept" } },
    });
    expect(await events.next()).toMatchObject({
      id: 2,
      result: { structuredContent: { selected: ["Do not accept"] } },
    });
  });

  test("a legacy client keeps its forms when this process no longer remembers it", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const token = await TeamTokenModel.create({
      organizationId: (await makeOrganization()).id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    const otherToken = await TeamTokenModel.create({
      organizationId: (await makeOrganization()).id,
      name: "Other Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/mcp/${agent.id}`;
    const post = (params: {
      bearer: string;
      userAgent: string;
      sessionId?: string;
      body: unknown;
    }) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${params.bearer}`,
          "user-agent": params.userAgent,
          ...(params.sessionId && { "mcp-session-id": params.sessionId }),
        },
        body: JSON.stringify(params.body),
      });
    const askUser = {
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
    };

    const init = await post({
      bearer: token.value,
      userAgent: "legacy-client/1",
      body: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: { elicitation: {} },
          clientInfo: { name: "legacy-client", version: "1" },
        },
        id: 1,
      },
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await init.arrayBuffer();

    // Under a User-Agent this process never saw initialize, it remembers
    // nothing about the client, as after a restart or on another replica:
    // the echoed session id alone carries what the client declared.
    const call = await post({
      bearer: token.value,
      userAgent: "legacy-client/1 (after restart)",
      sessionId: sessionId ?? undefined,
      body: askUser,
    });
    const events = readEvents(call);
    const question = await events.next();
    expect(question.method).toBe("elicitation/create");
    await post({
      bearer: token.value,
      userAgent: "legacy-client/1 (after restart)",
      body: {
        jsonrpc: "2.0",
        id: question.id,
        result: { action: "accept", content: { choice: "Do not accept" } },
      },
    });
    expect(await events.next()).toMatchObject({
      id: 2,
      result: { structuredContent: { selected: ["Do not accept"] } },
    });

    // The id is bound to the caller it was issued to: another caller who
    // presents it is not treated as able to answer a form.
    const foreign = await post({
      bearer: otherToken.value,
      userAgent: "legacy-client/1",
      sessionId: sessionId ?? undefined,
      body: askUser,
    });
    const foreignResult = (await firstMessage(foreign)).result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(foreignResult.isError).toBe(true);
    expect(foreignResult.content?.[0]?.text).toContain(
      "did not answer the choice form",
    );
  });

  test("only the caller that was asked can answer, under an id no other question shares", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const ownerToken = await TeamTokenModel.create({
      organizationId: (await makeOrganization()).id,
      name: "Owner Token",
      teamId: null,
      isOrganizationToken: true,
    });
    const otherToken = await TeamTokenModel.create({
      organizationId: (await makeOrganization()).id,
      name: "Other Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/mcp/${agent.id}`;
    const post = (token: { value: string }, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.value}`,
        },
        body: JSON.stringify(body),
      });
    const ask = async (id: number) =>
      readEvents(
        await post(ownerToken, {
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
          id,
        }),
      );
    // A legacy client: it declares elicitation once, at initialize.
    await post(ownerToken, {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
        clientInfo: { name: "owner", version: "1" },
      },
      id: 0,
    });
    const answer = (id: unknown, choice: string) => ({
      jsonrpc: "2.0",
      id,
      result: { action: "accept", content: { choice } },
    });

    // The other caller is a client this gateway serves in its own right.
    const probe = await post(otherToken, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });
    expect(probe.status).toBe(200);

    const first = await ask(2);
    const second = await ask(3);
    const firstQuestion = await first.next();
    const secondQuestion = await second.next();
    expect(firstQuestion.method).toBe("elicitation/create");
    expect(secondQuestion.method).toBe("elicitation/create");
    expect(firstQuestion.id).not.toBe(secondQuestion.id);

    // Another caller answers the owner's question. Any bare response is
    // acknowledged, so the proof is below: had this answer been routed, the
    // first question would resolve with "Do not accept".
    await post(otherToken, answer(firstQuestion.id, "Do not accept"));

    // The owner still answers both questions, each with its own pick.
    expect(
      (await post(ownerToken, answer(secondQuestion.id, "Do not accept")))
        .status,
    ).toBe(202);
    expect(
      (
        await post(
          ownerToken,
          answer(firstQuestion.id, "Accept for this session"),
        )
      ).status,
    ).toBe(202);
    expect(await first.next()).toMatchObject({
      id: 2,
      result: { structuredContent: { selected: ["Accept for this session"] } },
    });
    expect(await second.next()).toMatchObject({
      id: 3,
      result: { structuredContent: { selected: ["Do not accept"] } },
    });
  });
});

/** Reads the SSE frames of a gateway response one JSON-RPC message at a time. */
function readEvents(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no response body");
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<Record<string, unknown>> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) {
            return JSON.parse(data.slice("data: ".length));
          }
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended early");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

/** The first JSON-RPC message of a gateway response, SSE or plain JSON. */
async function firstMessage(
  response: Response,
): Promise<Record<string, unknown>> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    return (await response.json()) as Record<string, unknown>;
  }
  return readEvents(response).next();
}
