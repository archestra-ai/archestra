import { createServer, type Server, type ServerResponse } from "node:http";
import { type GenerateContentParameters, GoogleGenAI } from "@google/genai";
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, test, vi } from "vitest";

const generation = (signal: AbortSignal): GenerateContentParameters => ({
  model: "test-model",
  contents: [
    { role: "user", parts: [{ text: "Use the result" }] },
    {
      role: "model",
      parts: [
        {
          functionCall: {
            id: "call-1",
            name: "lookup",
            args: { query: "test" },
          },
          thoughtSignature: "synthetic-signature",
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call-1",
            name: "lookup",
            response: { result: "test" },
          },
        },
      ],
    },
  ],
  config: {
    abortSignal: signal,
    temperature: 0.2,
    maxOutputTokens: 8,
    tools: [{ functionDeclarations: [{ name: "lookup" }] }],
  },
});

const responseChunk = {
  candidates: [{ content: { role: "model", parts: [{ text: "test" }] } }],
};

const operations = [
  {
    name: "generateContent",
    run: async (client: GoogleGenAI, signal: AbortSignal) =>
      (await client.models.generateContent(generation(signal))).text,
    expected: "test",
  },
  {
    name: "generateContentStream",
    run: async (client: GoogleGenAI, signal: AbortSignal) => {
      let text = "";
      for await (const chunk of await client.models.generateContentStream(
        generation(signal),
      )) {
        text += chunk.text;
      }
      return text;
    },
    expected: "test",
  },
  {
    name: "embedContent",
    run: async (client: GoogleGenAI, signal: AbortSignal) =>
      (
        await client.models.embedContent({
          model: "test-model",
          contents: "test",
          config: { abortSignal: signal },
        })
      ).embeddings?.[0].values,
    expected: [0.1, 0.2],
  },
];

// Pins SDK cancellation behavior at the real HTTP boundary. An early rejection
// alone is not enough: a canceled operation must not dispatch behind it.
describe("Gemini SDK cancellation", () => {
  let upstream: Server | undefined;
  let response: ServerResponse | undefined;
  let requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let closed = false;
  let completed = false;

  afterEach(async () => {
    response?.destroy();
    upstream?.closeAllConnections();
    await new Promise<void>((resolve) =>
      upstream ? upstream.close(() => resolve()) : resolve(),
    );
    upstream = undefined;
    response = undefined;
    requests = [];
    closed = false;
    completed = false;
  });

  async function start(mode: "api-key" | "oauth" | "vertex", stall = false) {
    upstream = createServer((req, res) => {
      response = res;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ url: req.url ?? "", body: JSON.parse(body) });
        res.on("close", () => {
          closed = true;
          completed = res.writableEnded;
        });
        if (req.url?.includes("streamGenerateContent")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify(responseChunk)}\n\n`);
          if (!stall) res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ...responseChunk,
              embeddings: [{ values: [0.1, 0.2] }],
              predictions: [{ embeddings: { values: [0.1, 0.2] } }],
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream?.once("error", reject);
      upstream?.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    const authClient = new OAuth2Client();
    authClient.setCredentials({
      access_token: "synthetic-local-token",
      expiry_date: Date.now() + 3_600_000,
    });
    return new GoogleGenAI({
      ...(mode === "api-key"
        ? { apiKey: "synthetic-local-key" }
        : { googleAuthOptions: { authClient } }),
      ...(mode === "vertex" && {
        vertexai: true,
        project: "synthetic-project",
        location: "us-central1",
      }),
      httpOptions: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiVersion: "v1beta1",
        timeout: 2000,
      },
    });
  }

  for (const mode of ["api-key", "oauth", "vertex"] as const) {
    for (const operation of operations) {
      for (const timing of ["pre-aborted", "immediately after call"] as const) {
        test(`${mode} ${operation.name}: ${timing} sends no request`, async () => {
          const client = await start(mode);
          const controller = new AbortController();
          if (timing === "pre-aborted") controller.abort();
          // Attach rejection handling before abort, including stream iteration.
          const settled = operation.run(client, controller.signal).then(
            () => "resolved",
            () => "rejected",
          );
          if (timing === "immediately after call") controller.abort();
          const outcome = await settled;
          // Also catch an implementation that races a rejection against a
          // request still being dispatched asynchronously in the background.
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect({ outcome, requests: requests.length }).toEqual({
            outcome: "rejected",
            requests: 0,
          });
        });
      }

      test(`${mode} ${operation.name}: normal completion preserves the request`, async () => {
        const client = await start(mode);
        const controller = new AbortController();
        expect(await operation.run(client, controller.signal)).toEqual(
          operation.expected,
        );
        expect(requests).toHaveLength(1);
        if (operation.name !== "embedContent") {
          expect(requests[0].body).toMatchObject({
            contents: generation(controller.signal).contents,
            generationConfig: { temperature: 0.2, maxOutputTokens: 8 },
            tools: [{ functionDeclarations: [{ name: "lookup" }] }],
          });
        }
        await vi.waitFor(() => expect(completed).toBe(true));
      });
    }

    test(`${mode}: abort after a streamed event closes the connection`, async () => {
      const client = await start(mode, true);
      const controller = new AbortController();
      const stream = await client.models.generateContentStream(
        generation(controller.signal),
      );
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.text).toBe("test");
      const settled = iterator.next().then(
        () => "resolved",
        () => "rejected",
      );
      controller.abort();
      expect(await settled).toBe("rejected");
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1500 });
      expect(completed).toBe(false);
      expect(requests).toHaveLength(1);
    });
  }
});
