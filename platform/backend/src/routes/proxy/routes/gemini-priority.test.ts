import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelModel } from "@/models";
import { expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { useMswServer as setupMswServer } from "@/test/msw";
import { geminiAdapterFactory } from "../adapters/gemini";
import geminiProxyRoutes from "./gemini";

const server = setupMswServer();

for (const streaming of [false, true]) {
  test(`forwards Vertex tier headers and returns served traffic type (${streaming ? "streaming" : "buffered"})`, async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    config.llm.gemini.vertexAi.enabled = false;
    config.llm.gemini.baseUrl = "https://gemini-tier.example.test";
    const outgoingHeaders: Headers[] = [];
    const upstream = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Hello" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 1,
        totalTokenCount: 3,
        trafficType: "ON_DEMAND_PRIORITY",
      },
      modelVersion: "gemini-3.5-flash",
      responseId: "tier-response",
    };
    server.use(
      http.post(
        "https://gemini-tier.example.test/:version/models/:operation",
        ({ request }) => {
          outgoingHeaders.push(request.headers);
          return streaming
            ? new HttpResponse(`data: ${JSON.stringify(upstream)}\n\n`, {
                headers: { "content-type": "text/event-stream" },
              })
            : HttpResponse.json(upstream);
        },
      ),
    );
    await ModelModel.create({
      externalId: "gemini/gemini-3.5-flash",
      provider: "gemini",
      modelId: "gemini-3.5-flash",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const agent = await makeAgent();
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const app = createFastifyInstance();
    onTestFinished(() => app.close());
    await app.register(geminiProxyRoutes);
    const response = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-3.5-flash:${streaming ? "streamGenerateContent" : "generateContent"}`,
      headers: {
        "x-goog-api-key": "test-key",
        "x-archestra-virtual-key": await makePassthroughCredential({
          organizationId: agent.organizationId,
          ownerId: owner.id,
        }),
        "X-Vertex-AI-LLM-Request-Type": "shared",
        "X-Vertex-AI-LLM-Shared-Request-Type": "priority",
        "x-unrelated-secret": "must-not-forward",
      },
      payload: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
    });
    expect(response.statusCode).toBe(200);
    expect(outgoingHeaders).toHaveLength(1);
    expect(outgoingHeaders[0].get("x-vertex-ai-llm-request-type")).toBe(
      "shared",
    );
    expect(outgoingHeaders[0].get("x-vertex-ai-llm-shared-request-type")).toBe(
      "priority",
    );
    expect(outgoingHeaders[0].has("x-unrelated-secret")).toBe(false);
    expect(response.body).toContain('"trafficType":"ON_DEMAND_PRIORITY"');
  });
}

// Per-key headers use the same adapter options as configured custom providers.
test("honors configured Gemini provider headers without a caller tier", async () => {
  config.llm.gemini.vertexAi.enabled = false;
  const headersSeen: Headers[] = [];
  server.use(
    http.post(
      "https://gemini-configured.example.test/:version/models/:operation",
      ({ request }) => {
        headersSeen.push(request.headers);
        return HttpResponse.json({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "OK" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            trafficType: "ON_DEMAND_PRIORITY",
            totalTokenCount: 3,
          },
        });
      },
    ),
  );
  const client = geminiAdapterFactory.createClient("test-key", {
    source: "api",
    baseUrl: "https://gemini-configured.example.test",
    model: "gemini-3.5-flash",
    defaultHeaders: {
      "x-vertex-ai-llm-shared-request-type": "priority",
      "x-configured-provider-header": "configured-value",
    },
  });
  await geminiAdapterFactory.execute(client, {
    _model: "gemini-3.5-flash",
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  });
  expect(headersSeen).toHaveLength(1);
  expect(headersSeen[0].get("x-vertex-ai-llm-shared-request-type")).toBe(
    "priority",
  );
  expect(headersSeen[0].get("x-configured-provider-header")).toBe(
    "configured-value",
  );
});

test("sends configured tier headers with Vertex ADC authentication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gemini-tier-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const credentialsFile = join(directory, "credentials.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      type: "authorized_user",
      client_id: "test-client",
      client_secret: "test-secret",
      refresh_token: "test-refresh-token",
    }),
  );
  Object.assign(config.llm.gemini.vertexAi, {
    enabled: true,
    project: "vertex-tier-test",
    location: "global",
    credentialsFile,
  });
  const headersSeen: Headers[] = [];
  server.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({
        access_token: "test-access-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    ),
    http.post(
      "https://aiplatform.googleapis.com/:version/projects/:project/locations/:location/publishers/google/models/:operation",
      ({ request }) => {
        headersSeen.push(request.headers);
        return HttpResponse.json({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "OK" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            trafficType: "ON_DEMAND_PRIORITY",
            totalTokenCount: 3,
          },
        });
      },
    ),
  );
  const client = geminiAdapterFactory.createClient(undefined, {
    source: "api",
    model: "gemini-3.5-flash",
    defaultHeaders: {
      "x-vertex-ai-llm-request-type": "shared",
      "x-vertex-ai-llm-shared-request-type": "priority",
    },
  });
  const result = await geminiAdapterFactory.execute(client, {
    _model: "gemini-3.5-flash",
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  });
  expect(headersSeen).toHaveLength(1);
  expect(headersSeen[0].get("authorization")).toBe("Bearer test-access-token");
  expect(headersSeen[0].get("x-vertex-ai-llm-request-type")).toBe("shared");
  expect(headersSeen[0].get("x-vertex-ai-llm-shared-request-type")).toBe(
    "priority",
  );
  expect(result.usageMetadata?.trafficType).toBe("ON_DEMAND_PRIORITY");
});
