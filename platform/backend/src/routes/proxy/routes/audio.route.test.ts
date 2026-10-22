import { execFile } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type OpenAI from "openai";
import type { AzureOpenAI } from "openai";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, VirtualApiKeyModel } from "@/models";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";

setupTestCacheManager();
const execFileAsync = promisify(execFile);

import azureRoutes from "./azure";
import openaiRoutes from "./openai";

const audio = Buffer.from(
  "RIFF\u0000\u0000\u0000\u0000WAVEfmt \u0000\u00ff",
  "latin1",
);

describe.each([
  "azure",
  "openai",
] as const)("%s standard audio SDK routes", (provider) => {
  for (const operation of [
    "speech",
    "transcriptions",
    "translations",
  ] as const) {
    test(`governs ${operation} with the real SDK and a controlled HTTP upstream`, async ({
      makeAgent,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const upstream = createServer((request, response) => {
        void serve(request, response).catch((error) => {
          response.writeHead(500).end(String(error));
        });
      });
      const received: Array<{
        path: string;
        apiVersion: string | null;
        model: string;
        filename?: string;
        bytes?: Buffer;
      }> = [];
      async function serve(request: IncomingMessage, response: ServerResponse) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks);
        const path = (request.url ?? "").split("?")[0];
        const apiVersion = new URL(
          request.url ?? "",
          "http://upstream.test",
        ).searchParams.get("api-version");
        expect(
          provider === "azure"
            ? request.headers["api-key"]
            : request.headers.authorization,
        ).toBe(
          provider === "azure"
            ? "synthetic-provider-key"
            : "Bearer synthetic-provider-key",
        );
        if (operation === "speech") {
          const body = JSON.parse(raw.toString());
          received.push({ path, apiVersion, model: body.model });
          response.writeHead(200, { "content-type": "audio/wav" });
          response.write(audio.subarray(0, 8));
          response.end(audio.subarray(8));
        } else {
          const form = await new Request("http://upstream.test", {
            method: "POST",
            headers: {
              "content-type": String(request.headers["content-type"]),
            },
            body: raw,
          }).formData();
          const file = form.get("file") as File;
          received.push({
            path,
            apiVersion,
            model: String(form.get("model")),
            filename: file.name,
            bytes: Buffer.from(await file.arrayBuffer()),
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              text: "Synthetic audio.",
              usage: {
                type: "tokens",
                input_tokens: 4,
                output_tokens: 2,
                total_tokens: 6,
              },
            }),
          );
        }
      }
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const address = upstream.address();
      if (!address || typeof address === "string")
        throw new Error("Missing upstream port");
      config.llm[provider].baseUrl =
        `http://127.0.0.1:${address.port}${provider === "azure" ? "/openai/v1" : "/v1"}`;
      config.llmProxy.plugins = [];
      const agent = await makeAgent({
        isDefault: true,
        agentType: "llm_proxy",
      });
      const user = await makeUser();
      await makeMember(user.id, agent.organizationId);
      const secret = await makeSecret({
        secret: { apiKey: "synthetic-provider-key" },
      });
      const providerKey = await makeLlmProviderApiKey(
        agent.organizationId,
        secret.id,
        { provider },
      );
      const { value: token } = await VirtualApiKeyModel.create({
        organizationId: agent.organizationId,
        name: "Audio SDK fixture",
        authorId: user.id,
        scope: "personal",
        providerApiKeys: [{ provider, providerApiKeyId: providerKey.id }],
      });
      const app = createFastifyInstance();
      await app.register(provider === "azure" ? azureRoutes : openaiRoutes);
      try {
        const url = await app.listen({ port: 0, host: "127.0.0.1" });
        const sdkModule = await import(
          process.env.ARCHESTRA_AUDIO_JS_SDK ?? "openai"
        );
        const SDK = sdkModule.default as typeof OpenAI;
        const AzureSDK = sdkModule.AzureOpenAI as typeof AzureOpenAI;
        let expectedRequests = 0;
        for (const withAgent of [false, true]) {
          const endpoint = `${url}/v1/${provider}${withAgent ? `/${agent.id}` : ""}`;
          const clients = [
            new SDK({ baseURL: endpoint, apiKey: token, maxRetries: 0 }),
          ];
          if (provider === "azure")
            clients.push(
              new AzureSDK({
                endpoint,
                deployment:
                  operation === "speech" ? "tts-alias" : "transcribe-alias",
                apiVersion: "2025-04-01-preview",
                apiKey: token,
                maxRetries: 0,
              }),
            );
          for (const client of clients) {
            if (operation === "speech") {
              const response = await client.audio.speech.create({
                model:
                  client instanceof AzureSDK
                    ? "spoofed-body-model"
                    : "tts-alias",
                input: "Synthetic audio.",
                voice: "alloy",
                response_format: "wav",
              });
              expect(response.headers.get("content-type")).toContain(
                "audio/wav",
              );
              expect(Buffer.from(await response.arrayBuffer())).toEqual(audio);
            } else {
              const parameters = {
                file: new File([audio], "synthetic.wav", { type: "audio/wav" }),
                model:
                  client instanceof AzureSDK
                    ? "spoofed-body-model"
                    : "transcribe-alias",
              };
              expect(
                await client.audio[operation].create(parameters),
              ).toMatchObject({ text: "Synthetic audio." });
            }
            expectedRequests++;
          }
        }
        if (process.env.ARCHESTRA_AUDIO_PYTHON) {
          const { stdout } = await execFileAsync(
            process.env.ARCHESTRA_AUDIO_PYTHON,
            [
              fileURLToPath(
                new URL(
                  "../../../test/fixtures/standard-audio-client.py",
                  import.meta.url,
                ),
              ),
              url,
              provider,
              agent.id,
              operation,
            ],
            {
              env: {
                ...process.env,
                ARCHESTRA_AUDIO_FIXTURE_KEY: token,
                ARCHESTRA_AUDIO_FIXTURE_BYTES: audio.toString("base64"),
              },
              timeout: 20000,
            },
          );
          const result = JSON.parse(stdout);
          expect(result.requests).toBe(provider === "azure" ? 4 : 2);
          expectedRequests += result.requests;
        }
        const otherProvider = provider === "azure" ? "openai" : "azure";
        const otherKey = await makeLlmProviderApiKey(
          agent.organizationId,
          secret.id,
          { provider: otherProvider },
        );
        const { value: wrongProviderToken } = await VirtualApiKeyModel.create({
          organizationId: agent.organizationId,
          name: "Provider isolation fixture",
          authorId: user.id,
          scope: "personal",
          providerApiKeys: [
            { provider: otherProvider, providerApiKeyId: otherKey.id },
          ],
        });
        const wrongProviderClient = new SDK({
          baseURL: `${url}/v1/${provider}`,
          apiKey: wrongProviderToken,
          maxRetries: 0,
        });
        await expect(
          operation === "speech"
            ? wrongProviderClient.audio.speech.create({
                model: "tts-alias",
                input: "Synthetic.",
                voice: "alloy",
              })
            : wrongProviderClient.audio[operation].create({
                model: "transcribe-alias",
                file: new File([audio], "synthetic.wav"),
              }),
        ).rejects.toMatchObject({ status: 400 });
        expect(received).toHaveLength(expectedRequests);
        expect(
          received.filter((request) =>
            request.path.startsWith("/openai/deployments/"),
          ).length,
        ).toBe(provider === "azure" ? expectedRequests / 2 : 0);
        for (const request of received) {
          expect(request.model).toBe(
            operation === "speech" ? "tts-alias" : "transcribe-alias",
          );
          if (request.path.startsWith("/openai/deployments/")) {
            expect(request.path).toBe(
              `/openai/deployments/${request.model}/audio/${operation}`,
            );
            expect(request.apiVersion).toBe("2025-04-01-preview");
          } else
            expect(request.path).toBe(
              `${provider === "azure" ? "/openai/v1" : "/v1"}/audio/${operation}`,
            );
          if (operation !== "speech") {
            expect(request.filename).toBe("synthetic.wav");
            expect(request.bytes).toEqual(audio);
          }
        }
        const rows = await InteractionModel.getAllInteractionsForProfile(
          agent.id,
        );
        expect(rows).toHaveLength(expectedRequests);
        expect(rows[0]).toMatchObject({
          type: `${provider}:audio`,
          cost: null,
        });
        expect(JSON.stringify(rows)).not.toContain(audio.toString("base64"));
        expect(JSON.stringify(rows)).not.toContain('"type":"Buffer"');
      } finally {
        await app.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
});
