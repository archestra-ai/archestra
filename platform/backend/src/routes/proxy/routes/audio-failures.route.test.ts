import { createServer, type Server } from "node:http";
import type OpenAI from "openai";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import logger from "@/logging";
import { InteractionModel } from "@/models";
import LimitModel from "@/models/limit";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { PROXY_BODY_LIMIT } from "../common";
import azureRoutes from "./azure";
import openaiRoutes from "./openai";

vi.mock("@/logging");

const audio = Buffer.from(
  "RIFF\u0000\u0000\u0000\u0000WAVEfmt \u0000\u00ff",
  "latin1",
);

describe.each([
  "openai",
  "azure",
] as const)("%s audio failure and transport behavior", (provider) => {
  let app: ReturnType<typeof createFastifyInstance>;
  let upstream: Server;
  let client: OpenAI;
  let agentId: string;
  let token: string;
  let calls: number;
  let closed: boolean;
  let handler: (
    response: import("node:http").ServerResponse,
    body: Buffer,
    type: string,
  ) => void;
  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    config.llmProxy.upstreamTimeoutMs = 600_000;
    config.llmProxy.usageAccountingMode = "off";
    calls = 0;
    closed = false;
    handler = (response) => {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(audio);
    };
    upstream = createServer((request, response) => {
      // Count the call when it arrives: a request the proxy aborts while its
      // body is still in flight still reached the upstream.
      calls++;
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        response.once("close", () => {
          closed = true;
        });
        handler(
          response,
          Buffer.concat(chunks),
          String(request.headers["content-type"]),
        );
      })().catch((error) => {
        if (!request.aborted) response.destroy(error);
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    config.llm[provider].baseUrl =
      `http://127.0.0.1:${address.port}${provider === "azure" ? "/openai/v1" : "/v1"}`;
    config.llmProxy.plugins = [];
    const agent = await makeAgent({ isDefault: true, agentType: "llm_proxy" });
    agentId = agent.id;
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    token = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: user.id,
    });
    app = createFastifyInstance();
    await app.register(provider === "azure" ? azureRoutes : openaiRoutes);
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    const SDK = (await import(process.env.ARCHESTRA_AUDIO_JS_SDK ?? "openai"))
      .default as typeof OpenAI;
    client = new SDK({
      baseURL: `${origin}/v1/${provider}/${agentId}`,
      apiKey: "synthetic-provider-key",
      defaultHeaders: { "x-archestra-virtual-key": token },
      maxRetries: 0,
    });
  });
  afterEach(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  for (const status of [400, 401, 404, 413, 415, 429, 500, 503]) {
    test(`preserves upstream ${status}, makes one attempt, and redacts echoed audio from logs`, async () => {
      handler = (response) => {
        response.writeHead(status, {
          "content-type": "application/json",
          "retry-after": "17",
        });
        response.end(
          JSON.stringify({
            error: {
              message: "PRIVATE_AUDIO_BYTES",
              request: { audio: "PRIVATE_AUDIO_BYTES" },
            },
          }),
        );
      };
      const failure = await client.audio.speech
        .create({
          model: "tts-alias",
          input: "Synthetic.",
          voice: "alloy",
          response_format: "wav",
        })
        .then(
          () => undefined,
          (error: InstanceType<typeof OpenAI.APIError>) => error,
        );
      expect(failure).toMatchObject({ status });
      expect(failure?.headers?.get("retry-after")).toBe("17");
      expect(calls).toBe(1);
      const rows = await InteractionModel.getAllInteractionsForProfile(agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        cost: null,
        response: {
          __mediaUsage: { tokensAvailable: false, costAvailable: false },
        },
      });
      expect(JSON.stringify(rows)).not.toContain("PRIVATE_AUDIO_BYTES");
      expect(
        JSON.stringify([
          vi.mocked(logger.error).mock.calls,
          vi.mocked(logger.info).mock.calls,
          vi.mocked(logger.debug).mock.calls,
          vi.mocked(logger.trace).mock.calls,
        ]),
      ).not.toContain("PRIVATE_AUDIO_BYTES");
    });
  }
  test("rejects anonymous, provider-only and wrong-tenant calls without upstream dispatch", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const payload = { model: "tts-alias", input: "Synthetic.", voice: "alloy" };
    for (const headers of [
      {},
      { authorization: "Bearer synthetic-provider-key" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/${provider}/audio/speech`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(401);
    }
    const foreign = await makeAgent({
      organizationId: (await makeOrganization()).id,
      agentType: "llm_proxy",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/${provider}/${foreign.id}/audio/speech`,
          headers: {
            authorization: "Bearer synthetic-provider-key",
            "x-archestra-virtual-key": token,
          },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(calls).toBe(0);
  });
  test("fails closed for enforced accounting and an applicable budget", async () => {
    const payload = { model: "tts-alias", input: "Synthetic.", voice: "alloy" };
    config.llmProxy.usageAccountingMode = "enforce";
    await expect(client.audio.speech.create(payload)).rejects.toMatchObject({
      status: 422,
    });
    config.llmProxy.usageAccountingMode = "off";
    await LimitModel.create({
      entityType: "agent",
      entityId: agentId,
      limitType: "token_cost",
      limitValue: 100,
      model: ["tts-alias"],
      lastCleanup: new Date(),
    });
    await expect(client.audio.speech.create(payload)).rejects.toMatchObject({
      status: 422,
    });
    expect(calls).toBe(0);
  });
  test("rejects malformed schema, empty files and unsupported media before upstream", async () => {
    for (const extra of [
      { input: "" },
      { speed: 0 },
      { response_format: "exe" },
      { voice: "" },
    ]) {
      await expect(
        client.audio.speech.create({
          model: "tts-alias",
          input: "Synthetic.",
          voice: "alloy",
          ...extra,
        } as OpenAI.Audio.SpeechCreateParams),
      ).rejects.toMatchObject({ status: 400 });
    }
    for (const file of [
      new File([], "empty.wav"),
      new File(["PRIVATE_AUDIO_BYTES"], "bad.wav"),
      new File([audio], "bad.exe"),
    ]) {
      await expect(
        client.audio.transcriptions.create({ model: "alias", file }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(calls).toBe(0);
  });
  test("accepts exactly 25 MiB and rejects a larger file before any partial upstream dispatch", async () => {
    handler = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          text: "Synthetic transcript.",
          usage: { type: "duration", seconds: 1 },
        }),
      );
    };
    const exact = new Uint8Array(25 * 1024 * 1024);
    exact.set(audio);
    expect(
      await client.audio.transcriptions.create({
        model: "alias",
        file: new File([exact], "boundary.wav", { type: "audio/wav" }),
      }),
    ).toMatchObject({ text: "Synthetic transcript." });
    expect(calls).toBe(1);
    const over = new Uint8Array(exact.length + 1);
    over.set(audio);
    await expect(
      client.audio.transcriptions.create({
        model: "alias",
        file: new File([over], "over.wav", { type: "audio/wav" }),
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(calls).toBe(1);
    const rows = await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cost: null,
      request: { file: { size: exact.length } },
      response: { usage_available: true, usage: { seconds: 1 } },
    });
  });
  test("preserves native text/subtitle responses and converts multipart numeric/array fields", async () => {
    for (const format of ["text", "srt", "vtt"] as const) {
      handler = (response, body, type) => {
        void new Request("http://upstream.test", {
          method: "POST",
          headers: { "content-type": type },
          body: new Uint8Array(body),
        })
          .formData()
          .then((form) => {
            expect(form.get("temperature")).toBe("0");
            expect(form.getAll("timestamp_granularities[]")).toEqual([
              "word",
              "segment",
            ]);
            response.writeHead(200, {
              "content-type":
                format === "vtt" ? "text/vtt" : "text/plain; charset=utf-8",
            });
            response.end("Synthetic transcript.\n");
          });
      };
      const result = await client.audio.transcriptions.create({
        model: "alias",
        file: new File([audio], "synthetic.wav"),
        response_format: format,
        temperature: 0,
        timestamp_granularities: ["word", "segment"],
      });
      expect(result).toBe("Synthetic transcript.\n");
    }
  });
  test("preserves speech SSE and transcription SSE without injected framing", async () => {
    const speech =
      'data: {"type":"speech.audio.delta","audio":"AAE="}\n\ndata: {"type":"speech.audio.done","usage":{"input_tokens":2,"output_tokens":3}}\n\n';
    handler = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(speech);
    };
    expect(
      await (
        await client.audio.speech.create({
          model: "tts-alias",
          input: "Synthetic.",
          voice: "alloy",
          stream_format: "sse",
        })
      ).text(),
    ).toBe(speech);
    handler = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"type":"transcript.text.delta","delta":"Synthetic."}\n\ndata: {"type":"transcript.text.done","text":"Synthetic.","usage":{"input_tokens":4,"output_tokens":2}}\n\n',
      );
    };
    const stream = await client.audio.transcriptions.create({
      model: "alias",
      file: new File([audio], "synthetic.wav"),
      stream: true,
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "transcript.text.delta",
      "transcript.text.done",
    ]);
    const rows = await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.cost === null && row.inputTokens !== null),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("AAE=");
  });
  test("rejects malformed JSON and wrong content types before streaming headers", async () => {
    handler = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("PRIVATE_AUDIO_BYTES");
    };
    await expect(
      client.audio.transcriptions.create({
        model: "alias",
        file: new File([audio], "synthetic.wav"),
      }),
    ).rejects.toMatchObject({ status: 502 });
    handler = (response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("PRIVATE_AUDIO_BYTES");
    };
    await expect(
      client.audio.speech.create({
        model: "tts-alias",
        input: "Synthetic.",
        voice: "alloy",
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
  test("cancels upstream work when the SDK caller disconnects", async () => {
    handler = (response) => {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.write(audio);
    };
    const controller = new AbortController();
    const response = await client.audio.speech.create(
      {
        model: "tts-alias",
        input: "Synthetic.",
        voice: "alloy",
        response_format: "wav",
      },
      { signal: controller.signal },
    );
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.length).toBeGreaterThan(0);
    controller.abort();
    await reader?.cancel().catch(() => {});
    await vi.waitFor(() => expect(closed).toBe(true), {
      timeout: 1500,
      interval: 10,
    });
    expect(calls).toBe(1);
  });
  test("rejects an oversized declared upstream response before emitting bytes", async () => {
    handler = (response) => {
      response.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": String(PROXY_BODY_LIMIT + 1),
      });
      response.write(audio);
    };
    await expect(
      client.audio.speech.create({
        model: "tts-alias",
        input: "Synthetic.",
        voice: "alloy",
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(1);
    await vi.waitFor(() => expect(closed).toBe(true));
  });
  test("times out and cancels a stalled binary body after headers", async () => {
    config.llmProxy.upstreamTimeoutMs = 100;
    handler = (response) => {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.write(audio);
    };
    const response = await client.audio.speech.create({
      model: "tts-alias",
      input: "Synthetic.",
      voice: "alloy",
    });
    await expect(response.arrayBuffer()).rejects.toThrow();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(calls).toBe(1);
  });
  test("times out without retrying a stalled upstream", async () => {
    config.llmProxy.upstreamTimeoutMs = 250;
    handler = () => {};
    await expect(
      client.audio.speech.create({
        model: "tts-alias",
        input: "Synthetic.",
        voice: "alloy",
      }),
    ).rejects.toMatchObject({ status: 504 });
    expect(calls).toBe(1);
  });
  test("terminates a broken binary stream without appending SSE error bytes", async () => {
    handler = (response) => {
      response.writeHead(200, { "content-type": "audio/wav" });
      response.write(audio);
      setTimeout(() => response.destroy(), 20);
    };
    const response = await client.audio.speech.create({
      model: "tts-alias",
      input: "Synthetic.",
      voice: "alloy",
      response_format: "wav",
    });
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
