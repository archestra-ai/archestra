import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, test } from "vitest";
import { internalCallHeader } from "@/clients/internal-call";
import config from "@/config";
import { gatewayLlmSessionId, gatewayLlmToolCallId } from "./llm-link";

describe("gatewayLlmSessionId", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
    config.enterpriseFeatures.core = true;
  });

  test("follows an OpenAPPA session header the way the proxy does", () => {
    expect(
      gatewayLlmSessionId(
        fakeRequest({
          "x-archestra-session-id": "ordinary",
          "x-appa-session-id": "appa-session",
        }),
      ),
    ).toBe("appa-session");
  });

  test("keeps the ordinary session for the verified built-in chat", () => {
    expect(
      gatewayLlmSessionId(
        fakeRequest(
          {
            ...internalCallHeader(),
            "x-archestra-source": "chat",
            "x-archestra-session-id": "conversation",
            "x-appa-session-id": "appa-session",
          },
          "127.0.0.1",
        ),
      ),
    ).toBe("conversation");
  });

  test("does not honor a chat source claimed from outside", () => {
    // The proxy treats this caller as "api" and follows the OpenAPPA header;
    // reading it as chat here would file its calls under another session.
    expect(
      gatewayLlmSessionId(
        fakeRequest({
          "x-archestra-source": "chat",
          "x-archestra-session-id": "conversation",
          "x-appa-session-id": "appa-session",
        }),
      ),
    ).toBe("appa-session");
  });

  test("does not honor a chat source forwarded over loopback", () => {
    expect(
      gatewayLlmSessionId(
        fakeRequest(
          {
            "x-archestra-source": "chat",
            "x-archestra-session-id": "conversation",
            "x-appa-session-id": "appa-session",
          },
          "127.0.0.1",
        ),
      ),
    ).toBe("appa-session");
  });

  test("ignores the OpenAPPA header while OpenAPPA is off", () => {
    config.openappa.enabled = false;
    expect(
      gatewayLlmSessionId(fakeRequest({ "x-appa-session-id": "appa-session" })),
    ).toBeUndefined();
  });
});

describe("gatewayLlmToolCallId", () => {
  const toolsCall = (meta: unknown) => ({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "t", arguments: {}, _meta: meta },
  });

  test("prefers the provider's tool-use id over a logical call id", () => {
    expect(
      gatewayLlmToolCallId(
        toolsCall({
          "com.archestra/logicalToolCallId": "logical-1",
          "claudecode/toolUseId": "toolu_01",
        }),
      ),
    ).toBe("toolu_01");
    expect(
      gatewayLlmToolCallId(
        toolsCall({ "com.archestra/logicalToolCallId": "logical-1" }),
      ),
    ).toBe("logical-1");
  });

  test("rejects malformed ids and other methods", () => {
    expect(
      gatewayLlmToolCallId(
        toolsCall({ "claudecode/toolUseId": "x".repeat(257) }),
      ),
    ).toBeUndefined();
    expect(
      gatewayLlmToolCallId(toolsCall({ "claudecode/toolUseId": "a\nb" })),
    ).toBeUndefined();
    expect(
      gatewayLlmToolCallId({
        method: "tools/list",
        params: { _meta: { "claudecode/toolUseId": "toolu_01" } },
      }),
    ).toBeUndefined();
  });
});

function fakeRequest(
  headers: Record<string, string>,
  remoteAddress = "203.0.113.7",
): FastifyRequest {
  return { headers, socket: { remoteAddress } } as unknown as FastifyRequest;
}
