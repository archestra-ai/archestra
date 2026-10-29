import type { IncomingMessage } from "node:http";
import type { FastifyRequest } from "fastify";
import { describe, expect, test } from "vitest";
import {
  applyAzureProxyDeployment,
  getAzureProxyIngress,
  prepareAzureProxyIngress,
  rewriteAzureProxyUrl,
} from "./azure-ingress";

function requestFor(url: string): FastifyRequest {
  const headers = {};
  const raw = { url, headers, rawHeaders: [] } as unknown as IncomingMessage;
  return {
    raw,
    headers,
    body: { model: "body-model" },
  } as unknown as FastifyRequest;
}

describe("Azure SDK routing normalization", () => {
  test.each([
    [
      "/v1/azure/openai/deployments/sdk%2Ddeployment/chat/completions",
      "/v1/azure/chat/completions",
      "sdk-deployment",
    ],
    ["/v1/azure/deployments/sdk/embeddings", "/v1/azure/embeddings", "sdk"],
    ["/v1/azure/openai/v1/responses", "/v1/azure/responses", undefined],
    [
      "/v1/azure/openai/files/file-1/content",
      "/v1/azure/files/file-1/content",
      undefined,
    ],
    ["/v1/azure/openai/v1/files", "/v1/azure/files", undefined],
    [
      "/v1/azure/12345678-1234-1234-1234-123456789012/openai/deployments/sdk/audio/speech",
      "/v1/azure/12345678-1234-1234-1234-123456789012/audio/speech",
      "sdk",
    ],
  ])("normalizes %s before route selection", (url, canonical, deployment) => {
    const request = requestFor(url);
    const query = "api-version=2025-01-01-preview&tag=a%2Fb&tag=a+b&empty=";
    expect(rewriteAzureProxyUrl(request.raw, `${url}?${query}`)).toBe(
      `${canonical}?${query}`,
    );
    expect(getAzureProxyIngress(request)).toEqual({
      deployment,
      rawQuery: query,
    });
    applyAzureProxyDeployment(request);
    expect(request.body).toEqual({ model: deployment ?? "body-model" });
  });

  test("decodes deployment once and cannot rewrite another provider", () => {
    const request = requestFor("");
    rewriteAzureProxyUrl(
      request.raw,
      "/v1/azure/openai/deployments/alias%252Fencoded/chat/completions",
    );
    expect(getAzureProxyIngress(request)?.deployment).toBe("alias%2Fencoded");
    const other = requestFor("");
    expect(
      rewriteAzureProxyUrl(
        other.raw,
        "/v1/openai/openai/deployments/sdk/chat/completions",
      ),
    ).toBe("/v1/openai/openai/deployments/sdk/chat/completions");
    expect(getAzureProxyIngress(other)).toBeUndefined();
  });

  test.each([
    "%2Fother",
    "%5Cother",
    "%2e%2e",
    "%00bad",
    "%invalid",
  ])("rejects invalid segment %s without throwing during route lookup", (segment) => {
    const request = requestFor("");
    rewriteAzureProxyUrl(
      request.raw,
      `/v1/azure/openai/deployments/${segment}/chat/completions`,
    );
    expect(() => prepareAzureProxyIngress(request)).toThrow(
      "single valid path segment",
    );
  });

  test.each([
    "api-version=one&api-version=two",
    "api-version=",
    "api-version=a%2Fb",
  ])("rejects ambiguous or malformed version %s", (query) => {
    const request = requestFor("");
    rewriteAzureProxyUrl(request.raw, `/v1/azure/chat/completions?${query}`);
    expect(() => prepareAzureProxyIngress(request)).toThrow(
      "one valid Azure api-version",
    );
  });
});
