import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import OpenAI from "openai";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  InteractionModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { accessGrants, describe, expect, test, vi } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import modelRouterRoutes from "./model-router";

setupTestCacheManager();
const AUDIO = Buffer.from("RIFF\0\0\0\0WAVEfmt \0\xff", "latin1");
const TEXT = "Synthetic transcript.";

describe.each([
  false,
  true,
])("common audio SDK path (agent: %s)", (withAgent) => {
  test("preserves native bytes, multipart, SSE and selected credentials through one URL/key", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    config.llmProxy.plugins = [];
    const calls: Array<{
      provider: string;
      operation: string;
      model: string;
      credential: unknown;
      bytes?: Buffer;
    }> = [];
    const cancelled = new Set<string>();
    const upstream = createServer(async (request, response) => {
      const raw: Buffer[] = [];
      for await (const chunk of request) raw.push(Buffer.from(chunk));
      const bytes = Buffer.concat(raw);
      const provider = request.url?.split("/")[1] ?? "";
      const operation = request.url?.split("?")[0].split("/").at(-1) ?? "";
      let parameters: Record<string, unknown>;
      let upload: Buffer | undefined;
      if (operation === "speech") parameters = JSON.parse(bytes.toString());
      else {
        const form = await new Request("http://fixture.test", {
          method: "POST",
          headers: { "content-type": String(request.headers["content-type"]) },
          body: bytes,
        }).formData();
        parameters = Object.fromEntries(form);
        upload = Buffer.from(await (form.get("file") as File).arrayBuffer());
      }
      calls.push({
        provider,
        operation,
        model: String(parameters.model),
        credential:
          provider === "azure"
            ? request.headers["api-key"]
            : request.headers.authorization,
        bytes: upload,
      });
      if (parameters.input === "timeout") {
        response.once("close", () => cancelled.add(provider));
        return;
      }
      if (parameters.input === "fail") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "synthetic-provider-secret-sensitive-echo",
              code: "rate_limit",
            },
          }),
        );
        return;
      }
      if (parameters.stream === "true" || parameters.stream_format === "sse") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          'data: {"type":"transcript.text.delta","delta":"Synthetic "}\n\n',
        );
        response.end(
          'data: {"type":"transcript.text.done","text":"Synthetic transcript.","usage":{"input_tokens":4,"output_tokens":2}}\n\n',
        );
      } else if (operation === "speech") {
        response.writeHead(200, { "content-type": "audio/wav" });
        response.write(AUDIO.subarray(0, 8));
        response.end(AUDIO.subarray(8));
      } else if (parameters.response_format === "text") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(TEXT);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            text: TEXT,
            usage: {
              type: "tokens",
              input_tokens: 4,
              output_tokens: 2,
              total_tokens: 6,
            },
          }),
        );
      }
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("No upstream port");
    const agent = await makeAgent({ isDefault: true, agentType: "llm_proxy" });
    const mappings = [];
    const modelIds = [];
    for (const provider of ["azure", "openai", "gemini"] as const) {
      const secret = await makeSecret({
        secret: { apiKey: `synthetic-${provider}-secret` },
      });
      const providerKey = await makeLlmProviderApiKey(
        agent.organizationId,
        secret.id,
        {
          provider,
          baseUrl: `http://127.0.0.1:${address.port}/${provider}/openai/v1`,
        },
      );
      const model = await ModelModel.upsert({
        externalId: `${provider}/audio-alias`,
        provider,
        modelId: "audio-alias",
        inputModalities: ["audio", "text"],
        outputModalities: ["audio", "text"],
        lastSyncedAt: new Date(),
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
        model.id,
      ]);
      mappings.push({ provider, providerApiKeyId: providerKey.id });
      if (provider !== "gemini") modelIds.push(`${provider}:audio-alias`);
    }
    const key = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "common audio SDK",
      ...accessGrants("org"),
      providerApiKeys: mappings,
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseURL = `${origin}/v1/model-router${withAgent ? `/${agent.id}` : ""}`;
    const client = new OpenAI({ baseURL, apiKey: key.value, maxRetries: 0 });
    const file = () =>
      new File([AUDIO], "synthetic.wav", { type: "audio/wav" });
    try {
      for (const model of modelIds) {
        const speech = await client.audio.speech.create({
          model,
          input: "Synthetic input.",
          voice: "alloy",
          response_format: "wav",
        });
        expect(Buffer.from(await speech.arrayBuffer())).toEqual(AUDIO);
        for (const operation of ["transcriptions", "translations"] as const) {
          const transcript = await client.audio[operation].create({
            model,
            file: file(),
          });
          expect(transcript.text).toBe(TEXT);
          const text = await client.audio[operation].create({
            model,
            file: file(),
            response_format: "text",
          });
          expect(text).toBe(TEXT);
        }
        const stream = await client.audio.transcriptions.create({
          model,
          file: file(),
          stream: true,
        });
        const events = [];
        for await (const event of stream) events.push(event);
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({
          type: "transcript.text.done",
          text: TEXT,
        });
      }
      const env = {
        ...process.env,
        MEDIA_BASE_URL: baseURL,
        MEDIA_KEY: key.value,
        MEDIA_AUDIO: AUDIO.toString("base64"),
        MEDIA_MODELS: JSON.stringify(modelIds),
      };
      const external: Array<Promise<{ stdout: string }>> = [];
      if (process.env.ARCHESTRA_MEDIA_SDK_JS)
        external.push(
          promisify(execFile)(
            process.execPath,
            ["--input-type=module", "-e", JS_CLIENT],
            { env },
          ),
        );
      if (process.env.ARCHESTRA_MEDIA_SDK_PYTHON)
        external.push(
          promisify(execFile)(
            process.env.ARCHESTRA_MEDIA_SDK_PYTHON,
            ["-c", PY_CLIENT],
            { env },
          ),
        );
      for (const result of await Promise.all(external))
        expect(JSON.parse(result.stdout).requests).toBe(8);
      expect(calls.every((call) => call.model === "audio-alias")).toBe(true);
      expect(
        calls
          .filter((call) => call.operation !== "speech")
          .every((call) => call.bytes?.equals(AUDIO)),
      ).toBe(true);
      expect(
        calls
          .filter((call) => call.provider === "azure")
          .every((call) => call.credential === "synthetic-azure-secret"),
      ).toBe(true);
      expect(
        calls
          .filter((call) => call.provider === "openai")
          .every(
            (call) => call.credential === "Bearer synthetic-openai-secret",
          ),
      ).toBe(true);
      expect(JSON.stringify(calls)).not.toContain(key.value);
      let before = calls.length;
      await expect(
        client.audio.speech.create({
          model: "gemini:audio-alias",
          input: "Synthetic input.",
          voice: "alloy",
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        client.audio.transcriptions.create({
          model: "azure:unlinked",
          file: file(),
        }),
      ).rejects.toMatchObject({ status: 404 });
      const invalid = new OpenAI({ baseURL, apiKey: "invalid", maxRetries: 0 });
      await expect(
        invalid.audio.transcriptions.create({
          model: modelIds[0],
          file: file(),
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(calls).toHaveLength(before);
      const invalidMultipart = await fetch(`${baseURL}/audio/transcriptions`, {
        method: "POST",
        headers: {
          authorization: "Bearer invalid",
          "content-type": "multipart/form-data; boundary=broken",
        },
        body: "malformed upload",
      });
      expect(invalidMultipart.status).toBe(401);
      expect(calls).toHaveLength(before);
      const malformedAgent = new OpenAI({
        baseURL: `${origin}/v1/model-router/not-a-uuid`,
        apiKey: key.value,
        maxRetries: 0,
      });
      await expect(
        malformedAgent.audio.transcriptions.create({
          model: modelIds[0],
          file: file(),
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(calls).toHaveLength(before);
      const foreign = await makeAgent({ agentType: "llm_proxy" });
      const foreignClient = new OpenAI({
        baseURL: `${origin}/v1/model-router/${foreign.id}`,
        apiKey: key.value,
        maxRetries: 0,
      });
      await expect(
        foreignClient.audio.transcriptions.create({
          model: modelIds[0],
          file: file(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(calls).toHaveLength(before);
      for (const model of modelIds) {
        before = calls.length;
        await expect(
          client.audio.speech.create({ model, input: "fail", voice: "alloy" }),
        ).rejects.toMatchObject({ status: 429 });
        expect(calls).toHaveLength(before + 1);
        const timeout = new OpenAI({
          baseURL,
          apiKey: key.value,
          timeout: 100,
          maxRetries: 0,
        });
        await expect(
          timeout.audio.speech.create({
            model,
            input: "timeout",
            voice: "alloy",
          }),
        ).rejects.toThrow();
      }
      await vi.waitFor(() =>
        expect([...cancelled].sort()).toEqual(["azure", "openai"]),
      );
      const accountingMode = config.llmProxy.usageAccountingMode;
      before = calls.length;
      try {
        config.llmProxy.usageAccountingMode = "enforce";
        for (const model of modelIds) {
          await expect(
            client.audio.speech.create({
              model,
              input: "Synthetic input.",
              voice: "alloy",
            }),
          ).rejects.toMatchObject({ status: 422 });
        }
        expect(calls).toHaveLength(before);
      } finally {
        config.llmProxy.usageAccountingMode = accountingMode;
      }
      const interactions = (
        await InteractionModel.getAllInteractionsForProfile(agent.id)
      ).filter(
        (row) => row.type === "azure:audio" || row.type === "openai:audio",
      );
      const successful = interactions.filter((row) => row.outputTokens === 2);
      expect(successful.length).toBeGreaterThan(0);
      expect(
        successful.every((row) => row.cost === null && row.inputTokens === 4),
      ).toBe(true);
      expect(
        interactions.some(
          (row) =>
            row.inputTokens === null &&
            row.outputTokens === null &&
            row.cost === null,
        ),
      ).toBe(true);
      const audit = JSON.stringify(interactions);
      expect(audit).not.toContain("Synthetic input.");
      expect(audit).not.toContain(TEXT);
      expect(audit).not.toContain("synthetic-azure-secret");
      expect(audit).not.toContain("synthetic-provider-secret-sensitive-echo");
      expect(audit).not.toContain(AUDIO.toString("base64"));
    } finally {
      app.server.closeAllConnections();
      await app.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

const JS_CLIENT = `
const {default: OpenAI} = await import(process.env.ARCHESTRA_MEDIA_SDK_JS);
const client = new OpenAI({baseURL: process.env.MEDIA_BASE_URL, apiKey: process.env.MEDIA_KEY, maxRetries: 0});
const audio = Buffer.from(process.env.MEDIA_AUDIO, 'base64');
let requests = 0;
for (const model of JSON.parse(process.env.MEDIA_MODELS)) {
  const speech = await client.audio.speech.create({model,input:'Synthetic input.',voice:'alloy',response_format:'wav'});
  if (!Buffer.from(await speech.arrayBuffer()).equals(audio)) throw Error('Binary mismatch');
  requests++;
  for (const operation of ['transcriptions','translations']) {
    const result = await client.audio[operation].create({model,file:new File([audio],'synthetic.wav',{type:'audio/wav'})});
    if (result.text !== 'Synthetic transcript.') throw Error('Transcript mismatch');
    requests++;
  }
  const events = await client.audio.transcriptions.create({model,file:new File([audio],'synthetic.wav',{type:'audio/wav'}),stream:true});
  let count=0; for await (const event of events) count++;
  if (count!==2) throw Error('SSE mismatch');
  requests++;
}
console.log(JSON.stringify({requests}));
`;
const PY_CLIENT = `
import os,json,base64,openai
client=openai.OpenAI(base_url=os.environ['MEDIA_BASE_URL'],api_key=os.environ['MEDIA_KEY'],max_retries=0)
audio=base64.b64decode(os.environ['MEDIA_AUDIO'])
requests=0
for model in json.loads(os.environ['MEDIA_MODELS']):
    with client.audio.speech.with_streaming_response.create(model=model,input='Synthetic input.',voice='alloy',response_format='wav') as response:
        assert b''.join(response.iter_bytes()) == audio
    requests+=1
    for operation in ('transcriptions','translations'):
        result=getattr(client.audio,operation).create(model=model,file=('synthetic.wav',audio,'audio/wav'))
        assert result.text=='Synthetic transcript.'
        requests+=1
    events=client.audio.transcriptions.create(model=model,file=('synthetic.wav',audio,'audio/wav'),stream=True)
    assert len(list(events))==2
    requests+=1
print(json.dumps({'requests':requests,'sdk':openai.__version__}))
`;
